//! Live log sources for the TUI, each a child process with a reader thread that
//! streams parsed rows back over a channel.
//!
//! - Traffic: `tcpdump` on the console's IP, all protocols, regardless of the
//!   filter state. This is the "Rede" tab.
//! - Blocks: `journalctl -k -f` filtered for the RDO_BLOCK prefix the log-drop
//!   chain emits. This is the "Solo" tab, and only fires while solo is on.

use crate::config::{self, Config};
use chrono::Local;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;

/// Enrichment workers resolving PTR/whois/geo in parallel. getent and whois are
/// slow, so a serial worker left most peers un-enriched in a busy session.
const ENRICH_WORKERS: usize = 4;

#[derive(Clone)]
pub struct NetRow {
    pub time: String,
    pub src: String,
    pub dst: String,
    pub info: String,
}

#[derive(Clone)]
pub struct BlockRow {
    pub time: String,
    pub ip: String,
    /// The game P2P port involved (6672 or 61455-61458), or 0 if not identifiable.
    pub port: u16,
    /// true = the peer was trying to reach the console (inbound, the real
    /// intrusion); false = the console was reaching out to the peer.
    pub incoming: bool,
}

pub struct NetLog {
    pub traffic_rx: Receiver<NetRow>,
    pub block_rx: Receiver<BlockRow>,
    /// Enrichment results: (ip, ptr, owner, geo). Empty ptr = looked up, no PTR;
    /// empty owner = whois unavailable; empty geo = no DB or nothing found.
    pub ptr_rx: Receiver<(String, String, String, String)>,
    ptr_req: mpsc::Sender<String>,
    children: Vec<Child>,
}

impl NetLog {
    /// Ask the background worker to reverse-resolve an IP. Cheap and fire and
    /// forget; the answer arrives on `ptr_rx`.
    pub fn request_ptr(&self, ip: &str) {
        let _ = self.ptr_req.send(ip.to_string());
    }
}

impl Drop for NetLog {
    fn drop(&mut self) {
        for c in &mut self.children {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl NetLog {
    pub fn spawn(cfg: &Config) -> Self {
        let mut children = Vec::new();
        let (traffic_tx, traffic_rx) = mpsc::channel::<NetRow>();
        let (block_tx, block_rx) = mpsc::channel::<BlockRow>();

        // --- tcpdump: all traffic to/from the console ---
        if let Ok(mut child) = Command::new("tcpdump")
            .args([
                "-i",
                &cfg.wan_if,
                "-nn",
                "-l",
                "-q",
                "host",
                &cfg.console_ip,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            if let Some(out) = child.stdout.take() {
                let tx = traffic_tx.clone();
                thread::spawn(move || {
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        if let Some(row) = parse_tcpdump(&line) {
                            if tx.send(row).is_err() {
                                break;
                            }
                        }
                    }
                });
            }
            children.push(child);
        }

        // --- journalctl: kernel RDO_BLOCK lines ---
        if let Ok(mut child) = Command::new("journalctl")
            .args(["-k", "-f", "-n", "0", "-o", "cat"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            if let Some(out) = child.stdout.take() {
                let tx = block_tx.clone();
                let console = cfg.console_ip.clone();
                thread::spawn(move || {
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        if let Some(row) = parse_block(&line, &console) {
                            if tx.send(row).is_err() {
                                break;
                            }
                        }
                    }
                });
            }
            children.push(child);
        }

        // --- reverse-DNS + whois + GeoIP worker pool ---
        // getent/whois use the system tools and the GeoIP reader is pure-Rust, so
        // no crate/TLS dependency and the static musl binary stays clean. The Geo
        // database is opened once and shared (read-only) across the pool. A shared
        // request queue feeds N workers so a busy session enriches in parallel
        // instead of stalling behind one slow whois.
        let (ptr_req, ptr_req_rx) = mpsc::channel::<String>();
        let (ptr_tx, ptr_rx) = mpsc::channel::<(String, String, String, String)>();
        let geo = Arc::new(crate::geo::Geo::load(cfg.geoip_db.as_deref()));
        let ptr_req_rx = Arc::new(Mutex::new(ptr_req_rx));
        for _ in 0..ENRICH_WORKERS {
            let rx = Arc::clone(&ptr_req_rx);
            let tx = ptr_tx.clone();
            let geo = Arc::clone(&geo);
            thread::spawn(move || loop {
                // Hold the lock only across recv, so workers process in parallel.
                let ip = {
                    let guard = match rx.lock() {
                        Ok(g) => g,
                        Err(_) => break,
                    };
                    guard.recv()
                };
                let ip = match ip {
                    Ok(i) => i,
                    Err(_) => break,
                };
                let name = reverse_dns(&ip);
                let owner = whois_owner(&ip);
                let loc = geo.lookup(&ip);
                if tx.send((ip, name, owner, loc)).is_err() {
                    break;
                }
            });
        }

        NetLog {
            traffic_rx,
            block_rx,
            ptr_rx,
            ptr_req,
            children,
        }
    }
}

/// `getent hosts <ip>` -> the hostname, or empty when there is no PTR. Wrapped in
/// `timeout` so a slow reverse-DNS lookup cannot stall a worker.
fn reverse_dns(ip: &str) -> String {
    let out = match Command::new("timeout")
        .args(["3", "getent", "hosts", ip])
        .output()
    {
        Ok(o) => o,
        Err(_) => return String::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    // "192.81.245.125   name.example" -> "name.example"
    text.split_whitespace().nth(1).unwrap_or("").to_string()
}

/// `whois <ip>` -> the owning org, or empty when whois is absent / nothing
/// found. Wrapped in `timeout` so a slow registry cannot stall a worker.
fn whois_owner(ip: &str) -> String {
    let out = match Command::new("timeout").args(["5", "whois", ip]).output() {
        Ok(o) => o,
        Err(_) => return String::new(), // timeout/whois not installed: degrade quietly
    };
    parse_whois_owner(&String::from_utf8_lossy(&out.stdout))
}

/// The first useful owner line from whois output. Pure, so it is unit-tested.
fn parse_whois_owner(text: &str) -> String {
    const KEYS: &[&str] = &[
        "orgname",
        "org-name",
        "organisation",
        "owner",
        "netname",
        "descr",
    ];
    for line in text.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            if KEYS.contains(&key.as_str()) {
                let v = v.trim();
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
    }
    String::new()
}

fn now_hms() -> String {
    Local::now().format("%H:%M:%S").to_string()
}

/// Parse a `tcpdump -q` line:
/// `18:20:46.481275 IP 192.168.1.250.52252 > 203.0.113.1.443: tcp 0`
fn parse_tcpdump(line: &str) -> Option<NetRow> {
    let mut it = line.split_whitespace();
    let ts = it.next()?; // 18:20:46.481275
    let time = ts.split('.').next().unwrap_or(ts).to_string();
    let kind = it.next()?; // IP / IP6 / ARP...
    if kind != "IP" && kind != "IP6" {
        // Keep non-IP lines (ARP etc.) with a compact form.
        return Some(NetRow {
            time,
            src: kind.to_string(),
            dst: String::new(),
            info: it.collect::<Vec<_>>().join(" "),
        });
    }
    let src = it.next()?.to_string();
    let arrow = it.next()?; // ">"
    if arrow != ">" {
        return None;
    }
    let dst = it.next()?.trim_end_matches(':').to_string();
    let info = it.collect::<Vec<_>>().join(" ");
    Some(NetRow {
        time,
        src,
        dst,
        info,
    })
}

fn is_game_port(p: u16) -> bool {
    p == 6672 || (61455..=61458).contains(&p)
}

/// From a kernel line carrying `RDO_BLOCK ... SRC=a DST=b ... SPT=x DPT=y`,
/// return the peer (the side that is not the console), its game port and
/// direction, unless it is a Rockstar relay.
fn parse_block(line: &str, console: &str) -> Option<BlockRow> {
    if !line.contains("RDO_BLOCK") {
        return None;
    }
    let (mut src, mut dst) = (None, None);
    let (mut spt, mut dpt) = (0u16, 0u16);
    for tok in line.split_whitespace() {
        if let Some(v) = tok.strip_prefix("SRC=") {
            src = Some(v.to_string());
        } else if let Some(v) = tok.strip_prefix("DST=") {
            dst = Some(v.to_string());
        } else if let Some(v) = tok.strip_prefix("SPT=") {
            spt = v.parse().unwrap_or(0);
        } else if let Some(v) = tok.strip_prefix("DPT=") {
            dpt = v.parse().unwrap_or(0);
        }
    }
    let (src, dst) = (src?, dst?);
    let incoming = dst == console;
    let peer = if src == console { dst } else { src };
    if config::is_rockstar(&peer) {
        return None;
    }
    // The game port is whichever side matched; prefer the destination.
    let port = if is_game_port(dpt) {
        dpt
    } else if is_game_port(spt) {
        spt
    } else {
        dpt
    };
    Some(BlockRow {
        time: now_hms(),
        ip: peer,
        port,
        incoming,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_whois_owner;

    #[test]
    fn picks_the_first_owner_line() {
        let who = "\
% ARIN WHOIS
NetRange:       192.81.240.0 - 192.81.247.255
NetName:        RSONET-NA1
Organization:   Rockstar
OrgName:        Take-Two Interactive
descr:          games";
        // NetName comes before OrgName in the key priority within a line scan;
        // the scan is top-down, so NetName's line wins here.
        assert_eq!(parse_whois_owner(who), "RSONET-NA1");
    }

    #[test]
    fn empty_when_nothing_matches() {
        assert_eq!(parse_whois_owner("no useful fields here\njust: text"), "");
        assert_eq!(parse_whois_owner(""), "");
    }

    #[test]
    fn reads_rir_style_descr() {
        let who = "inetnum: 1.2.3.0/24\ndescr: Contabo GmbH\ncountry: DE";
        assert_eq!(parse_whois_owner(who), "Contabo GmbH");
    }
}
