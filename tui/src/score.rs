//! Threat scoring: synthesize the raw signals (recent activity, direction, and
//! what the peer looks like) into one number and a level, so the table can sort
//! the real attackers to the top instead of leaving you to eyeball columns.
//! Pure and unit-tested.

use crate::classify::Kind;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Level {
    Low,
    Medium,
    High,
}

impl Level {
    pub fn label(self) -> &'static str {
        match self {
            Level::Low => "baixo",
            Level::Medium => "médio",
            Level::High => "ALTO",
        }
    }
}

/// A booter panel hits from hosting infra, inbound, hard. That is what earns a
/// high score:
/// - `recent`: packets seen in the rolling window (raw aggressiveness).
/// - inbound traffic (the peer reaching the console) counts double; outbound
///   (the console reaching out) is far less alarming.
/// - a datacenter source is the strongest single tell; unknown is mildly
///   suspicious; a residential player barely moves the needle.
pub fn threat_score(recent: usize, incoming: bool, kind: Kind) -> u32 {
    let activity = recent as u32;
    let directional = if incoming { activity } else { 0 };
    let origin = match kind {
        Kind::Datacenter => 50,
        Kind::Unknown => 10,
        Kind::Player => 0,
    };
    activity + directional + origin
}

/// A flood always reads High; otherwise the score decides.
pub fn threat_level(score: u32, flooding: bool) -> Level {
    if flooding || score >= 60 {
        Level::High
    } else if score >= 20 {
        Level::Medium
    } else {
        Level::Low
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datacenter_inbound_flood_is_high() {
        let s = threat_score(45, true, Kind::Datacenter);
        assert!(s >= 60, "score was {s}");
        assert_eq!(threat_level(s, true), Level::High);
    }

    #[test]
    fn residential_trickle_is_low() {
        let s = threat_score(3, true, Kind::Player);
        assert_eq!(threat_level(s, false), Level::Low);
    }

    #[test]
    fn inbound_counts_double() {
        let inbound = threat_score(20, true, Kind::Unknown);
        let outbound = threat_score(20, false, Kind::Unknown);
        assert!(inbound > outbound);
        assert_eq!(inbound - outbound, 20);
    }

    #[test]
    fn flooding_forces_high_regardless_of_score() {
        // Even an otherwise-low score is High when the flood flag is set.
        assert_eq!(threat_level(0, true), Level::High);
    }

    #[test]
    fn datacenter_outbound_low_activity_is_medium() {
        // 50 from origin alone lands in the medium band.
        let s = threat_score(2, false, Kind::Datacenter);
        assert_eq!(threat_level(s, false), Level::Medium);
    }
}
