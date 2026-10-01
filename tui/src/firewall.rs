//! The firewall/routing logic, ported 1:1 from scripts/homelab/rdo-solo.
//!
//! Every rule and ordering choice here mirrors the shell script, including the
//! hard-won ones: hook into DOCKER-USER (survives docker, wins over its DROP
//! policy), the ip rule 5200 that pulls the console out of Tailscale's table 52,
//! send_redirects=0, and the log-then-drop chain.

use crate::config::*;
use crate::squad::Mode;
use anyhow::{Context, Result};
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

/// Run a command, returning Ok(()) only on success. `ignore_fail` swallows a
/// non-zero exit (used where the shell had `|| true`). stdout/stderr are
/// discarded: iptables is silent on success, and letting it write would corrupt
/// the TUI's alternate screen when a toggle runs mid-render. Failure still
/// surfaces via the exit status.
fn run(bin: &str, args: &[&str], ignore_fail: bool) -> Result<()> {
    let status = Command::new(bin)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("failed to spawn {bin}"))?;
    if !status.success() && !ignore_fail {
        anyhow::bail!("{bin} {:?} exited with {status}", args);
    }
    Ok(())
}

/// Capture stdout of a command as a String (trimmed). Empty on failure.
fn capture(bin: &str, args: &[&str]) -> String {
    Command::new(bin)
        .args(args)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// True if the command exits 0. stdout/stderr discarded (an iptables -C/-L probe
/// writes to stderr when the rule/chain is absent, which would corrupt the TUI).
fn ok(bin: &str, args: &[&str]) -> bool {
    Command::new(bin)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn is_root() -> bool {
    // getuid via `id -u` keeps us off libc; on musl this avoids an FFI dependency.
    capture("id", &["-u"]) == "0"
}

/// Docker sets the FORWARD policy to DROP and jumps to DOCKER-USER first, so
/// hooking there survives docker restarts and wins over the DROP policy.
fn hook_chain() -> &'static str {
    if ok("iptables", &["-n", "-L", "DOCKER-USER"]) {
        "DOCKER-USER"
    } else {
        "FORWARD"
    }
}

/// Idempotent insert at the top of a chain: -C then -I 1.
fn ensure_rule(chain: &str, rule: &[&str]) -> Result<()> {
    let mut check = vec!["-C", chain];
    check.extend_from_slice(rule);
    if ok("iptables", &check) {
        return Ok(());
    }
    let mut ins = vec!["-I", chain, "1"];
    ins.extend_from_slice(rule);
    run("iptables", &ins, false)
}

// --- routing -----------------------------------------------------------------

pub fn route_fix(cfg: &Config) -> Result<()> {
    let _ = run(
        "ip",
        &[
            "rule",
            "del",
            "from",
            &cfg.console_ip,
            "lookup",
            "main",
            "priority",
            RULE_PRIO,
        ],
        true,
    );
    run(
        "ip",
        &[
            "rule",
            "add",
            "from",
            &cfg.console_ip,
            "lookup",
            "main",
            "priority",
            RULE_PRIO,
        ],
        false,
    )
}

pub fn route_unfix(cfg: &Config) -> Result<()> {
    run(
        "ip",
        &[
            "rule",
            "del",
            "from",
            &cfg.console_ip,
            "lookup",
            "main",
            "priority",
            RULE_PRIO,
        ],
        true,
    )
}

// --- filter ------------------------------------------------------------------

fn install_chains(cfg: &Config) -> Result<()> {
    let hook = hook_chain();
    if !ok("iptables", &["-n", "-L", CHAIN]) {
        run("iptables", &["-N", CHAIN], false)?;
    }
    // Reverse order so the final order is: jump to CHAIN, then the ACCEPTs.
    ensure_rule(hook, &["-d", &cfg.console_ip, "-j", "ACCEPT"])?;
    ensure_rule(hook, &["-s", &cfg.console_ip, "-j", "ACCEPT"])?;
    ensure_rule(hook, &["-j", CHAIN])?;
    Ok(())
}

/// Log-then-drop chain: a counter cannot say WHO was blocked. Rate limited so a
/// flood cannot fill the journal.
fn ensure_logdrop() -> Result<()> {
    if !ok("iptables", &["-n", "-L", LOG_CHAIN]) {
        run("iptables", &["-N", LOG_CHAIN], false)?;
    }
    run("iptables", &["-F", LOG_CHAIN], false)?;
    run(
        "iptables",
        &[
            "-A",
            LOG_CHAIN,
            "-m",
            "limit",
            "--limit",
            "10/min",
            "--limit-burst",
            "5",
            "-j",
            "LOG",
            "--log-prefix",
            "RDO_BLOCK ",
            "--log-level",
            "6",
        ],
        false,
    )?;
    run("iptables", &["-A", LOG_CHAIN, "-j", "DROP"], false)?;
    Ok(())
}

/// Pure rule builder for the RDO_SOLO chain. Each inner Vec is the argv of one
/// `iptables -A RDO_SOLO ...` rule WITHOUT the leading `-A RDO_SOLO`.
///
/// Squad: ACCEPT squad IPs + RSONET nets first, then the port DROP block.
/// Solo: only the port DROP block. Off: empty.
pub fn squad_rules(cfg: &Config, mode: Mode, squad_ips: &[String]) -> Vec<Vec<String>> {
    match mode {
        Mode::Off => Vec::new(),
        Mode::Solo => port_drop_rules(cfg),
        Mode::Squad => {
            let mut rules = Vec::new();
            for ip in squad_ips {
                rules.push(vec!["-s".into(), ip.clone(), "-j".into(), "ACCEPT".into()]);
                rules.push(vec!["-d".into(), ip.clone(), "-j".into(), "ACCEPT".into()]);
            }
            for net in crate::squad::RSONET_NETS {
                rules.push(vec![
                    "-s".into(),
                    (*net).into(),
                    "-j".into(),
                    "ACCEPT".into(),
                ]);
                rules.push(vec![
                    "-d".into(),
                    (*net).into(),
                    "-j".into(),
                    "ACCEPT".into(),
                ]);
            }
            rules.extend(port_drop_rules(cfg));
            rules
        }
    }
}

fn port_drop_rules(cfg: &Config) -> Vec<Vec<String>> {
    let mut rules = Vec::new();
    for side in ["-s", "-d"] {
        for port_flag in ["--sport", "--dport"] {
            for game in [GAME_PORT_SINGLE, GAME_PORT_RANGE] {
                rules.push(vec![
                    side.into(),
                    cfg.console_ip.clone(),
                    "-p".into(),
                    "udp".into(),
                    port_flag.into(),
                    game.into(),
                    "-j".into(),
                    LOG_CHAIN.into(),
                ]);
            }
        }
    }
    rules
}

/// Flush RDO_SOLO and reload rules for the given mode (squad allowlist + drops).
pub fn load_drops(cfg: &Config, mode: Mode) -> Result<()> {
    run("iptables", &["-F", CHAIN], false)?;
    ensure_logdrop()?;
    let squad = crate::squad::read_squad();
    for rule in squad_rules(cfg, mode, &squad) {
        let mut args: Vec<&str> = Vec::with_capacity(2 + rule.len());
        args.push("-A");
        args.push(CHAIN);
        for a in &rule {
            args.push(a.as_str());
        }
        run("iptables", &args, false)?;
    }
    Ok(())
}

fn flush_filter() {
    let _ = run("iptables", &["-F", CHAIN], true);
}

pub fn read_state_at(path: &Path) -> Mode {
    fs::read_to_string(path)
        .map(|s| Mode::parse(&s))
        .unwrap_or(Mode::Off)
}

pub fn write_state_at(path: &Path, mode: Mode) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(path, format!("{}\n", mode.as_str())).context("writing state file")
}

pub fn read_state() -> Mode {
    read_state_at(Path::new(STATE_FILE))
}

fn write_state(mode: Mode) -> Result<()> {
    write_state_at(Path::new(STATE_FILE), mode)
}

pub fn apply_state(cfg: &Config) -> Result<()> {
    match read_state() {
        Mode::Solo => load_drops(cfg, Mode::Solo),
        Mode::Squad => load_drops(cfg, Mode::Squad),
        Mode::Off => {
            flush_filter();
            Ok(())
        }
    }
}

// --- public commands ---------------------------------------------------------

pub fn cmd_on(cfg: &Config) -> Result<()> {
    if !ok("iptables", &["-n", "-L", CHAIN]) {
        install_chains(cfg)?;
    }
    load_drops(cfg, Mode::Solo)?;
    write_state(Mode::Solo)?;
    Ok(())
}

pub fn cmd_off(_cfg: &Config) -> Result<()> {
    flush_filter();
    write_state(Mode::Off)?;
    Ok(())
}

pub fn cmd_boot(cfg: &Config) -> Result<()> {
    run("sysctl", &["-q", "--system"], true)?;
    route_fix(cfg)?;
    install_chains(cfg)?;
    apply_state(cfg)?;
    // Persist NAT too: the modem drops the console's forwarded packets unless
    // their source is masqueraded to this host, so nat-on must be restored here
    // (it is otherwise not reapplied on boot).
    cmd_nat_on(cfg)?;
    Ok(())
}

pub fn cmd_nat_on(cfg: &Config) -> Result<()> {
    if !ok("iptables", &["-t", "nat", "-n", "-L", NAT_CHAIN]) {
        run("iptables", &["-t", "nat", "-N", NAT_CHAIN], false)?;
    }
    if !ok(
        "iptables",
        &["-t", "nat", "-C", "POSTROUTING", "-j", NAT_CHAIN],
    ) {
        run(
            "iptables",
            &["-t", "nat", "-I", "POSTROUTING", "1", "-j", NAT_CHAIN],
            false,
        )?;
    }
    if !ok(
        "iptables",
        &[
            "-t",
            "nat",
            "-C",
            NAT_CHAIN,
            "-s",
            &cfg.console_ip,
            "-o",
            &cfg.wan_if,
            "-j",
            "MASQUERADE",
        ],
    ) {
        run(
            "iptables",
            &[
                "-t",
                "nat",
                "-A",
                NAT_CHAIN,
                "-s",
                &cfg.console_ip,
                "-o",
                &cfg.wan_if,
                "-j",
                "MASQUERADE",
            ],
            false,
        )?;
    }
    Ok(())
}

pub fn cmd_nat_off() -> Result<()> {
    run("iptables", &["-t", "nat", "-F", NAT_CHAIN], true)
}

pub fn cmd_install(cfg: &Config) -> Result<()> {
    if !ok("iptables", &["--version"]) {
        anyhow::bail!("iptables not found");
    }
    if cfg.wan_if.is_empty() {
        anyhow::bail!("could not detect the default-route interface");
    }

    fs::create_dir_all(STATE_DIR).ok();
    if !Path::new(STATE_FILE).exists() {
        write_state(Mode::Off)?;
    }

    if !std::path::Path::new(CONF_PATH).exists() {
        fs::write(
            CONF_PATH,
            format!(
                "# rdo-solo configuration\nCONSOLE_IP={}\nWAN_IF={}\n",
                cfg.console_ip, cfg.wan_if
            ),
        )?;
    }

    // send_redirects MUST be 0 or the console learns to talk to the modem
    // directly and every rule becomes decorative.
    fs::write(
        SYSCTL_PATH,
        format!(
            "net.ipv4.ip_forward=1\n\
             net.ipv4.conf.all.send_redirects=0\n\
             net.ipv4.conf.default.send_redirects=0\n\
             net.ipv4.conf.{}.send_redirects=0\n",
            cfg.wan_if
        ),
    )?;
    run("sysctl", &["-q", "--system"], true)?;

    route_fix(cfg)?;
    install_chains(cfg)?;
    apply_state(cfg)?;

    // Ordered after docker (DOCKER-USER exists) and tailscaled (our ip rule is
    // not clobbered by its setup).
    fs::write(
        UNIT_PATH,
        format!(
            "[Unit]\n\
             Description=rdo-solo firewall rules for the game console\n\
             After=network-online.target docker.service tailscaled.service\n\
             Wants=network-online.target\n\n\
             [Service]\n\
             Type=oneshot\n\
             RemainAfterExit=yes\n\
             ExecStart={INSTALL_PATH} boot\n\n\
             [Install]\n\
             WantedBy=multi-user.target\n"
        ),
    )?;
    run("systemctl", &["daemon-reload"], true)?;
    run("systemctl", &["enable", "-q", "rdo-solo.service"], true)?;

    // Self-install so the unit and future runs use a stable path.
    let exe = std::env::current_exe().context("current_exe")?;
    let exe_real = fs::canonicalize(&exe).unwrap_or(exe);
    if exe_real.to_string_lossy() != INSTALL_PATH {
        run(
            "install",
            &["-m", "0755", &exe_real.to_string_lossy(), INSTALL_PATH],
            false,
        )?;
    }
    Ok(())
}

pub fn cmd_uninstall(cfg: &Config) -> Result<()> {
    let hook = hook_chain();
    let _ = run("iptables", &["-D", hook, "-j", CHAIN], true);
    let _ = run(
        "iptables",
        &["-D", hook, "-s", &cfg.console_ip, "-j", "ACCEPT"],
        true,
    );
    let _ = run(
        "iptables",
        &["-D", hook, "-d", &cfg.console_ip, "-j", "ACCEPT"],
        true,
    );
    let _ = run("iptables", &["-F", CHAIN], true);
    let _ = run("iptables", &["-X", CHAIN], true);
    let _ = run("iptables", &["-F", LOG_CHAIN], true);
    let _ = run("iptables", &["-X", LOG_CHAIN], true);
    let _ = cmd_nat_off();
    let _ = run(
        "iptables",
        &["-t", "nat", "-D", "POSTROUTING", "-j", NAT_CHAIN],
        true,
    );
    let _ = run("iptables", &["-t", "nat", "-X", NAT_CHAIN], true);
    let _ = route_unfix(cfg);
    let _ = run("systemctl", &["disable", "-q", "rdo-solo.service"], true);
    let _ = fs::remove_file(UNIT_PATH);
    let _ = fs::remove_file(SYSCTL_PATH);
    let _ = run("systemctl", &["daemon-reload"], true);
    Ok(())
}

/// Whether the ip rule 5200 (the Tailscale table-52 escape) is present.
pub fn route_rule_present() -> bool {
    let rules = capture("ip", &["rule", "show"]);
    rules
        .lines()
        .any(|l| l.trim_start().starts_with(&format!("{RULE_PRIO}:")))
}

/// Whether the console is in the ARP/neighbour table (a rough "is it on").
pub fn console_present(cfg: &Config) -> bool {
    let n = capture("ip", &["neigh", "show"]);
    n.lines()
        .any(|l| l.contains(&format!("{} ", cfg.console_ip)))
}

/// A snapshot of everything that must be true for the filter to actually bite.
/// A pretty "SOLO ATIVO" screen means nothing if any of these is wrong.
#[derive(Clone, Default)]
pub struct Health {
    pub forwarding: bool,        // net.ipv4.ip_forward == 1
    pub redirects_ok: bool,      // send_redirects == 0 on the WAN iface
    pub route_rule: bool,        // ip rule 5200 present (Tailscale table-52 escape)
    pub console_present: bool,   // console is in the ARP/neigh table
    pub gateway_pkts: u64,       // packets the console pushed through our ACCEPT rule
    pub console_ipv6: bool,      // console has a global IPv6 (bypasses the v4 filter)
    pub ip_mismatch: bool,       // console's live IPv4 != CONSOLE_IP (filter decorative)
    pub live_ip: Option<String>, // console's current IPv4 when resolvable by MAC
}

impl Health {
    /// The filter can only work if all the plumbing is in place.
    pub fn ok(&self) -> bool {
        self.forwarding
            && self.redirects_ok
            && self.route_rule
            && self.console_present
            && !self.ip_mismatch
    }
}

pub fn health(cfg: &Config) -> Health {
    let forwarding = capture("sysctl", &["-n", "net.ipv4.ip_forward"]) == "1";
    let redirects_ok = capture(
        "sysctl",
        &[
            "-n",
            &format!("net.ipv4.conf.{}.send_redirects", cfg.wan_if),
        ],
    ) == "0";
    let hook = hook_chain();
    let table = capture("iptables", &["-L", hook, "-v", "-n", "-x"]);

    let (mut console_ipv6, mut ip_mismatch, mut live_ip) = (false, false, None);
    if let Some(mac) = &cfg.console_mac {
        let neigh4 = capture("ip", &["neigh", "show"]);
        if let Some(ip) = parse_neigh_ipv4_for_mac(&neigh4, mac) {
            ip_mismatch = ip != cfg.console_ip;
            live_ip = Some(ip);
        }
        let neigh6 = capture("ip", &["-6", "neigh", "show"]);
        console_ipv6 = neigh_has_global_v6_for_mac(&neigh6, mac);
    }

    Health {
        forwarding,
        redirects_ok,
        route_rule: route_rule_present(),
        console_present: console_present(cfg),
        gateway_pkts: parse_accept_pkts(&table, &cfg.console_ip),
        console_ipv6,
        ip_mismatch,
        live_ip,
    }
}

/// From `ip neigh show`, the IPv4 currently bound to `mac` (lowercased match).
pub fn parse_neigh_ipv4_for_mac(neigh: &str, mac: &str) -> Option<String> {
    let mac = mac.to_ascii_lowercase();
    for line in neigh.lines() {
        if line.to_ascii_lowercase().contains(&mac) {
            if let Some(ip) = line.split_whitespace().next() {
                if ip.contains('.') {
                    return Some(ip.to_string());
                }
            }
        }
    }
    None
}

/// True if `mac` has a global-scope IPv6 (starts 2/3) in `ip -6 neigh`. A
/// link-local fe80:: address does not count: it never leaves the LAN.
pub fn neigh_has_global_v6_for_mac(neigh6: &str, mac: &str) -> bool {
    let mac = mac.to_ascii_lowercase();
    neigh6.lines().any(|line| {
        if !line.to_ascii_lowercase().contains(&mac) {
            return false;
        }
        match line.split_whitespace().next() {
            Some(addr) => {
                let a = addr.to_ascii_lowercase();
                (a.starts_with('2') || a.starts_with('3')) && a.contains(':')
            }
            None => false,
        }
    })
}

/// Sum the packet counters of the ACCEPT rules that name the console, from
/// `iptables -L <hook> -v -n -x` output. Pure, so it is unit-tested.
pub fn parse_accept_pkts(table: &str, console_ip: &str) -> u64 {
    table
        .lines()
        .filter(|l| l.contains("ACCEPT") && l.contains(console_ip))
        .filter_map(|l| l.split_whitespace().next())
        .filter_map(|n| n.parse::<u64>().ok())
        .sum()
}

/// A human-readable status block, mirroring the shell `status`.
pub fn status_lines(cfg: &Config) -> Vec<String> {
    let hook = hook_chain();
    let mut out = Vec::new();
    out.push(format!("estado:     {}", read_state().as_str()));
    out.push(format!("console:    {}", cfg.console_ip));
    out.push(format!("interface:  {}   hook: {hook}", cfg.wan_if));
    out.push(String::new());
    out.push("-- pré-requisitos de rota --".into());
    out.push(format!(
        "  ip_forward       = {}",
        capture("sysctl", &["-n", "net.ipv4.ip_forward"])
    ));
    out.push(format!(
        "  send_redirects   = {} (tem que ser 0)",
        capture(
            "sysctl",
            &[
                "-n",
                &format!("net.ipv4.conf.{}.send_redirects", cfg.wan_if)
            ]
        )
    ));
    out.push(format!(
        "  ip rule {RULE_PRIO}     = {} (tem que existir, senão o tráfego vai pro tailscale0)",
        if route_rule_present() {
            "presente"
        } else {
            "AUSENTE"
        }
    ));
    out.push(String::new());
    out.push("-- o console passa por este host? (contadores ACCEPT) --".into());
    let hook_rules = capture("iptables", &["-L", hook, "-v", "-n", "--line-numbers"]);
    for l in hook_rules.lines() {
        if l.starts_with("num") || l.contains(&cfg.console_ip) {
            out.push(format!("  {l}"));
        }
    }
    out.push(String::new());
    out.push(format!(
        "  console na rede: {}",
        if console_present(cfg) {
            "sim"
        } else {
            "NÃO (desligado ou outro IP)"
        }
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::{
        neigh_has_global_v6_for_mac, parse_accept_pkts, parse_neigh_ipv4_for_mac, read_state_at,
        squad_rules, write_state_at,
    };
    use crate::config::Config;
    use crate::squad::Mode;

    #[test]
    fn squad_rules_accept_squad_and_rsonet_before_drops() {
        use crate::squad::RSONET_NETS;
        let cfg = Config::test_default();
        let squad = vec!["45.184.53.184".to_string()];
        let rules = squad_rules(&cfg, Mode::Squad, &squad);
        assert!(rules
            .iter()
            .any(|r| r == &vec!["-s", "45.184.53.184", "-j", "ACCEPT"]));
        assert!(rules
            .iter()
            .any(|r| r == &vec!["-d", "45.184.53.184", "-j", "ACCEPT"]));
        for net in RSONET_NETS {
            assert!(rules.iter().any(|r| r == &vec!["-s", *net, "-j", "ACCEPT"]));
        }
        assert!(rules.iter().any(|r| {
            r.iter().any(|a| a == "6672") && r.last().map(|s| s.as_str()) == Some("RDO_LOGDROP")
        }));
        let first_accept = rules
            .iter()
            .position(|r| r.last().map(|s| s.as_str()) == Some("ACCEPT"))
            .unwrap();
        let first_drop = rules
            .iter()
            .position(|r| r.last().map(|s| s.as_str()) == Some("RDO_LOGDROP"))
            .unwrap();
        assert!(first_accept < first_drop);
    }

    #[test]
    fn squad_rules_solo_has_no_accepts() {
        let rules = squad_rules(&Config::test_default(), Mode::Solo, &[]);
        assert!(rules
            .iter()
            .all(|r| r.last().map(|s| s.as_str()) != Some("ACCEPT")));
        assert!(!rules.is_empty());
    }

    #[test]
    fn state_file_roundtrips_mode_and_legacy_on() {
        assert_eq!(Mode::parse("on"), Mode::Solo); // legacy content
        assert_eq!(Mode::parse("squad"), Mode::Squad);
        assert_eq!(Mode::Squad.as_str(), "squad");

        let p = std::env::temp_dir().join(format!("rdo_state_test_{}", std::process::id()));
        let _ = std::fs::remove_file(&p);
        write_state_at(&p, Mode::Squad).unwrap();
        assert_eq!(read_state_at(&p), Mode::Squad);

        // Legacy "on" body must read as Solo.
        std::fs::write(&p, "on\n").unwrap();
        assert_eq!(read_state_at(&p), Mode::Solo);

        // Absent file defaults to Off.
        let _ = std::fs::remove_file(&p);
        assert_eq!(read_state_at(&p), Mode::Off);
    }

    #[test]
    fn finds_live_ipv4_by_mac() {
        let neigh = "\
192.168.1.1 dev eth0 lladdr 02:11:22:33:44:55 REACHABLE
192.168.1.248 dev eth0 lladdr de:ad:be:ef:12:34 STALE";
        assert_eq!(
            parse_neigh_ipv4_for_mac(neigh, "DE:AD:BE:EF:12:34"),
            Some("192.168.1.248".to_string())
        );
        assert_eq!(parse_neigh_ipv4_for_mac(neigh, "aa:bb:cc:dd:ee:ff"), None);
    }

    #[test]
    fn global_v6_detected_but_not_link_local() {
        let mac = "de:ad:be:ef:12:34";
        let global =
            "2001:db8:1234:5678:0211:22ff:fe33:4455 dev eth0 lladdr de:ad:be:ef:12:34 REACHABLE";
        let link_local = "fe80::211:22ff:fe33:4455 dev eth0 lladdr de:ad:be:ef:12:34 REACHABLE";
        assert!(neigh_has_global_v6_for_mac(global, mac));
        assert!(!neigh_has_global_v6_for_mac(link_local, mac));
        assert!(!neigh_has_global_v6_for_mac("", mac));
    }

    #[test]
    fn sums_accept_counters_for_the_console() {
        let table = "\
Chain DOCKER-USER (1 references)
    pkts      bytes target     prot opt in     out     source               destination
    1158   116K RDO_SOLO   all  --  *      *       0.0.0.0/0            0.0.0.0/0
      69    255 ACCEPT     all  --  *      *       192.168.1.250       0.0.0.0/0
     218    776 ACCEPT     all  --  *      *       0.0.0.0/0            192.168.1.250";
        assert_eq!(parse_accept_pkts(table, "192.168.1.250"), 69 + 218);
    }

    #[test]
    fn zero_when_console_absent_or_no_flow() {
        let table = "\
Chain DOCKER-USER (1 references)
    0      0 ACCEPT     all  --  *      *       192.168.1.250       0.0.0.0/0";
        assert_eq!(parse_accept_pkts(table, "192.168.1.250"), 0);
        assert_eq!(parse_accept_pkts(table, "192.168.1.99"), 0);
    }
}
