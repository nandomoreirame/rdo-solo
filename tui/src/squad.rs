// Squad allowlist: capture of current session peers + mode state.
// Ported 1:1 into homelab/rdo-solo (shell). No serde (keep the musl binary small).
// Not yet wired into main; keep clippy green until later tasks consume these APIs.
#![allow(dead_code)]
use std::fs;
use std::net::Ipv4Addr;
use std::path::Path;
use std::str::FromStr;

pub const SQUAD_FILE: &str = "/var/lib/rdo-solo/squad.list";

// Rockstar service ranges (RSONET). Mirror of the web's RDO_RSONET_NETS default.
// Always ACCEPT-ed in squad mode so the session host/relays survive.
pub const RSONET_NETS: &[&str] = &["192.81.240.0/21", "199.46.32.0/19", "104.255.104.0/21"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    Solo,
    Squad,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Solo => "solo",
            Mode::Squad => "squad",
        }
    }
    pub fn parse(s: &str) -> Mode {
        match s.trim() {
            "squad" => Mode::Squad,
            "solo" | "on" => Mode::Solo, // "on" = legacy solo
            _ => Mode::Off,
        }
    }
}

pub fn is_valid_ip(s: &str) -> bool {
    Ipv4Addr::from_str(s.trim()).is_ok()
}

/// Deduped, order-preserving list of valid IPs. '#'/blank lines ignored; invalid skipped.
pub fn parse_squad(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if is_valid_ip(t) && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    out
}

pub fn format_squad(ips: &[String], captured_at: &str) -> String {
    let mut s = format!("# captured_at={}\n", captured_at);
    for ip in ips {
        s.push_str(ip);
        s.push('\n');
    }
    s
}

pub fn read_squad() -> Vec<String> {
    fs::read_to_string(SQUAD_FILE)
        .map(|b| parse_squad(&b))
        .unwrap_or_default()
}

/// Replace semantics (REQ-001): overwrite with only the valid, deduped IPs.
pub fn write_squad(ips: &[String], captured_at: &str) -> std::io::Result<()> {
    let clean = parse_squad(&ips.join("\n"));
    fs::write(SQUAD_FILE, format_squad(&clean, captured_at))
}

pub fn clear_squad() -> std::io::Result<()> {
    if Path::new(SQUAD_FILE).exists() {
        fs::remove_file(SQUAD_FILE)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parse_and_legacy_on() {
        assert_eq!(Mode::parse("squad"), Mode::Squad);
        assert_eq!(Mode::parse("solo"), Mode::Solo);
        assert_eq!(Mode::parse("on"), Mode::Solo); // legacy
        assert_eq!(Mode::parse("off"), Mode::Off);
        assert_eq!(Mode::parse("garbage"), Mode::Off);
        assert_eq!(Mode::Squad.as_str(), "squad");
    }

    #[test]
    fn valid_ip_rejects_junk() {
        assert!(is_valid_ip("45.184.53.184"));
        assert!(!is_valid_ip("999.1.1.1"));
        assert!(!is_valid_ip("notanip"));
        assert!(!is_valid_ip("45.184.53.184; rm -rf")); // argv injection guard
    }

    #[test]
    fn parse_squad_dedupes_and_skips_invalid() {
        let body = "# captured_at=2026-09-30T10:00:00Z\n1.2.3.4\n1.2.3.4\n\nbad\n5.6.7.8\n";
        assert_eq!(parse_squad(body), vec!["1.2.3.4", "5.6.7.8"]);
    }

    #[test]
    fn format_roundtrips() {
        let ips = vec!["1.2.3.4".to_string(), "5.6.7.8".to_string()];
        let body = format_squad(&ips, "2026-09-30T10:00:00Z");
        assert!(body.starts_with("# captured_at=2026-09-30T10:00:00Z\n"));
        assert_eq!(parse_squad(&body), ips);
    }
}
