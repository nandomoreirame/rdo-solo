//! Pure heuristics for reading a blocked peer: is it a real player (residential
//! connection) or a datacenter/hosting IP (bot, relay, or a booter panel)? The
//! only input is the reverse-DNS name, which is cheap to fetch and a strong
//! tell. Kept dependency-free and unit-tested.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// PTR looks residential: almost certainly a real player.
    Player,
    /// PTR looks like hosting/cloud: suspicious for a solo session.
    Datacenter,
    /// No PTR or nothing conclusive.
    Unknown,
}

// Substrings that reverse-DNS names carry for consumer ISPs vs hosting.
const RESIDENTIAL: &[&str] = &[
    "dynamic",
    "dyn",
    "dsl",
    "cable",
    "broadband",
    "fibra",
    "fiber",
    "ftth",
    "res",
    "cliente",
    "client",
    "user",
    "pppoe",
    "gvt",
    "virtua",
    "vivo",
    "claro",
    "oi.com",
    "telecom",
    "net.br",
    "dialup",
    "wifi",
    "home",
];
const HOSTING: &[&str] = &[
    "amazonaws",
    "compute.amazonaws",
    "digitalocean",
    "ovh",
    "hetzner",
    "vultr",
    "linode",
    "contabo",
    "leaseweb",
    "choopa",
    "datacamp",
    "m247",
    "server",
    "cloud",
    "datacenter",
    "hosting",
    "colo",
    "vps",
    "azure",
    "googleusercontent",
    "gcp",
    "oracle",
    "scaleway",
];

/// Classify from a reverse-DNS name. `None` or empty means no PTR.
pub fn classify_ptr(ptr: Option<&str>) -> Kind {
    let name = match ptr {
        Some(n) if !n.is_empty() => n.to_ascii_lowercase(),
        _ => return Kind::Unknown,
    };
    // Hosting wins over residential when both somehow match (rare), because a
    // hosting keyword is the more alarming signal for a solo session.
    if HOSTING.iter().any(|k| name.contains(k)) {
        return Kind::Datacenter;
    }
    if RESIDENTIAL.iter().any(|k| name.contains(k)) {
        return Kind::Player;
    }
    Kind::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn residential_is_player() {
        assert_eq!(
            classify_ptr(Some("181.191.9-137.dynamic.ftthtelecom.com.br")),
            Kind::Player
        );
        assert_eq!(
            classify_ptr(Some("customer-cable-42.virtua.com.br")),
            Kind::Player
        );
        assert_eq!(classify_ptr(Some("host-home-8.vivo.com.br")), Kind::Player);
    }

    #[test]
    fn hosting_is_datacenter() {
        assert_eq!(
            classify_ptr(Some("ec2-1-2-3-4.compute.amazonaws.com")),
            Kind::Datacenter
        );
        assert_eq!(classify_ptr(Some("vps-1234.ovh.net")), Kind::Datacenter);
        assert_eq!(
            classify_ptr(Some("cloudserver.hetzner.de")),
            Kind::Datacenter
        );
    }

    #[test]
    fn no_ptr_is_unknown() {
        assert_eq!(classify_ptr(None), Kind::Unknown);
        assert_eq!(classify_ptr(Some("")), Kind::Unknown);
        assert_eq!(
            classify_ptr(Some("some-unlabeled-name.example")),
            Kind::Unknown
        );
    }

    #[test]
    fn hosting_beats_residential() {
        // A name carrying both signals resolves to the more alarming one.
        assert_eq!(
            classify_ptr(Some("dynamic-vps.cloud.example")),
            Kind::Datacenter
        );
    }
}
