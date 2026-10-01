//! Runtime configuration, ported from the shell script's /etc/rdo-solo.conf
//! plus its compile-time defaults.

use std::fs;
use std::net::Ipv4Addr;
use std::process::Command;

pub const CONF_PATH: &str = "/etc/rdo-solo.conf";
pub const STATE_DIR: &str = "/var/lib/rdo-solo";
pub const STATE_FILE: &str = "/var/lib/rdo-solo/state";
pub const HISTORY_PATH: &str = "/var/lib/rdo-solo/history.log";
pub const UNIT_PATH: &str = "/etc/systemd/system/rdo-solo.service";
pub const SYSCTL_PATH: &str = "/etc/sysctl.d/99-rdo-solo.conf";
pub const INSTALL_PATH: &str = "/usr/local/bin/rdo-solo-tui";

pub const CHAIN: &str = "RDO_SOLO";
pub const LOG_CHAIN: &str = "RDO_LOGDROP";
pub const NAT_CHAIN: &str = "RDO_NAT";
pub const RULE_PRIO: &str = "5200";

// The game's peer-to-peer UDP ports. A single port and a contiguous range.
pub const GAME_PORT_SINGLE: &str = "6672";
pub const GAME_PORT_RANGE: &str = "61455:61458";

#[derive(Clone, Debug)]
pub struct Config {
    pub console_ip: String,
    pub wan_if: String,
    /// Optional MAC of the console. When set, an IP mismatch (Xbox took a new
    /// DHCP lease) can be detected instead of silently blocking nothing.
    pub console_mac: Option<String>,
    /// Optional ntfy topic URL. When set, a high-threat attempt triggers a push.
    pub ntfy_url: Option<String>,
    /// Optional path to a MaxMind GeoLite2 City .mmdb. When set (or found in a
    /// default location), peers are enriched with "City, CC".
    pub geoip_db: Option<String>,
    /// Optional friendly name for the console, shown instead of its IP.
    pub console_label: Option<String>,
}

impl Config {
    /// Load /etc/rdo-solo.conf, falling back to the same defaults the shell used.
    pub fn load() -> Self {
        let mut console_ip = String::from("192.168.1.250");
        let mut wan_if = String::new();
        let mut console_mac = None;
        let mut ntfy_url = None;
        let mut geoip_db = None;
        let mut console_label = None;

        if let Ok(text) = fs::read_to_string(CONF_PATH) {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some(v) = line.strip_prefix("CONSOLE_IP=") {
                    console_ip = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("WAN_IF=") {
                    wan_if = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("CONSOLE_MAC=") {
                    let v = v.trim();
                    if !v.is_empty() {
                        console_mac = Some(v.to_ascii_lowercase());
                    }
                } else if let Some(v) = line.strip_prefix("NTFY_URL=") {
                    let v = v.trim();
                    if !v.is_empty() {
                        ntfy_url = Some(v.to_string());
                    }
                } else if let Some(v) = line.strip_prefix("GEOIP_DB=") {
                    let v = v.trim();
                    if !v.is_empty() {
                        geoip_db = Some(v.to_string());
                    }
                } else if let Some(v) = line.strip_prefix("CONSOLE_LABEL=") {
                    let v = v.trim();
                    if !v.is_empty() {
                        console_label = Some(v.to_string());
                    }
                }
            }
        }

        if wan_if.is_empty() {
            wan_if = detect_wan_if().unwrap_or_default();
        }

        Config {
            console_ip,
            wan_if,
            console_mac,
            ntfy_url,
            geoip_db,
            console_label,
        }
    }

    #[cfg(test)]
    pub fn test_default() -> Self {
        Config {
            console_ip: String::from("192.168.1.250"),
            wan_if: String::from("eth0"),
            console_mac: None,
            ntfy_url: None,
            geoip_db: None,
            console_label: None,
        }
    }
}

/// The interface of the default route: `ip -4 route show default | awk '{print $5}'`.
pub fn detect_wan_if() -> Option<String> {
    let out = Command::new("ip")
        .args(["-4", "route", "show", "default"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next()?;
    // "default via X dev eth0 proto ..." -> field after "dev"
    let mut it = first.split_whitespace();
    while let Some(tok) = it.next() {
        if tok == "dev" {
            return it.next().map(str::to_string);
        }
    }
    None
}

/// True when the address is inside Rockstar's NA online network, RSONET-NA1
/// (192.81.240.0/21 = 192.81.240.0 .. 192.81.247.255). These relays knock
/// constantly and are hidden from the display, though still blocked.
pub fn is_rockstar(ip: &str) -> bool {
    match ip.parse::<Ipv4Addr>() {
        Ok(a) => {
            let o = a.octets();
            o[0] == 192 && o[1] == 81 && (240..=247).contains(&o[2])
        }
        Err(_) => false,
    }
}
