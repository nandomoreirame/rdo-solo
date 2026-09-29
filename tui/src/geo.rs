//! Offline GeoIP: turn an IP into "City, CC" using a MaxMind GeoLite2 City
//! database. Pure-Rust reader, so the static musl build stays clean. The DB is
//! not shipped (MaxMind requires a free account); when it is absent, lookups
//! return "" and the UI just omits the location.

use maxminddb::{geoip2, Reader};
use std::net::IpAddr;

/// Default places to look for the City database, in order.
const DB_CANDIDATES: &[&str] = &[
    "/var/lib/rdo-solo/GeoLite2-City.mmdb",
    "/usr/share/GeoIP/GeoLite2-City.mmdb",
    "/usr/share/GeoIP/GeoLite2-city.mmdb",
];

pub struct Geo {
    reader: Option<Reader<Vec<u8>>>,
}

impl Geo {
    /// Open the first database found (an explicit `path` wins). Missing DB is not
    /// an error: it just disables geo.
    pub fn load(path: Option<&str>) -> Self {
        let mut tried: Vec<String> = Vec::new();
        if let Some(p) = path {
            tried.push(p.to_string());
        }
        tried.extend(DB_CANDIDATES.iter().map(|s| s.to_string()));
        for p in tried {
            if let Ok(reader) = Reader::open_readfile(&p) {
                return Geo {
                    reader: Some(reader),
                };
            }
        }
        Geo { reader: None }
    }

    /// "Cidade, BR", or "BR", or "" when unknown / no DB.
    pub fn lookup(&self, ip: &str) -> String {
        let reader = match &self.reader {
            Some(r) => r,
            None => return String::new(),
        };
        let addr: IpAddr = match ip.parse() {
            Ok(a) => a,
            Err(_) => return String::new(),
        };
        let city: geoip2::City = match reader.lookup(addr) {
            Ok(c) => c,
            Err(_) => return String::new(),
        };
        let city_name = city
            .city
            .as_ref()
            .and_then(|c| c.names.as_ref())
            .and_then(|n| n.get("pt").or_else(|| n.get("en")).copied());
        let cc = city.country.as_ref().and_then(|c| c.iso_code);
        format_geo(city_name, cc)
    }
}

/// Format a (city, country-code) pair. Pure, so it is unit-tested.
pub fn format_geo(city: Option<&str>, cc: Option<&str>) -> String {
    match (city, cc) {
        (Some(c), Some(code)) => format!("{c}, {code}"),
        (None, Some(code)) => code.to_string(),
        (Some(c), None) => c.to_string(),
        (None, None) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::format_geo;

    #[test]
    fn formats_city_and_country() {
        assert_eq!(format_geo(Some("São Paulo"), Some("BR")), "São Paulo, BR");
    }
    #[test]
    fn country_only() {
        assert_eq!(format_geo(None, Some("US")), "US");
    }
    #[test]
    fn empty_when_nothing() {
        assert_eq!(format_geo(None, None), "");
        assert_eq!(format_geo(Some("X"), None), "X");
    }
}
