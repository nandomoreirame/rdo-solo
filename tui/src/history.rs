//! Persistent record of blocked intruders across sessions. Everything is
//! cleared from memory on each solo toggle, so without this you cannot answer
//! "who hit me last night". One append-only tab-separated log; the parser is
//! pure and unit-tested.

use crate::config::HISTORY_PATH;
use chrono::Local;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryRow {
    pub time: String,
    pub ip: String,
    pub kind: String,
    pub ptr: String,
}

/// Append one intruder sighting. Best-effort: a failure to write history must
/// never break the live tool.
pub fn record_intruder(ip: &str, kind: &str, ptr: &str) {
    let ts = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    // Sanitize tabs/newlines out of the PTR so one field cannot corrupt the row.
    let ptr = ptr.replace(['\t', '\n', '\r'], " ");
    let line = format!("{ts}\t{ip}\t{kind}\t{ptr}\n");
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(HISTORY_PATH)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Load the most recent `limit` rows, newest first.
pub fn load(limit: usize) -> Vec<HistoryRow> {
    let f = match std::fs::File::open(HISTORY_PATH) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let mut rows: Vec<HistoryRow> = BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| parse_line(&l))
        .collect();
    rows.reverse();
    rows.truncate(limit);
    rows
}

/// Parse one `time\tip\tkind\tptr` line. Pure.
pub fn parse_line(line: &str) -> Option<HistoryRow> {
    let mut it = line.splitn(4, '\t');
    let time = it.next()?.to_string();
    let ip = it.next()?.to_string();
    let kind = it.next()?.to_string();
    let ptr = it.next().unwrap_or("").to_string();
    if time.is_empty() || ip.is_empty() {
        return None;
    }
    Some(HistoryRow {
        time,
        ip,
        kind,
        ptr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_row() {
        let r = parse_line("2026-09-28 10:02:14\t203.0.113.10\tplayer\tdyn.example.net").unwrap();
        assert_eq!(r.ip, "203.0.113.10");
        assert_eq!(r.kind, "player");
        assert_eq!(r.ptr, "dyn.example.net");
    }

    #[test]
    fn tolerates_missing_ptr() {
        let r = parse_line("2026-09-28 10:02:14\t203.0.113.9\tdatacenter\t").unwrap();
        assert_eq!(r.ptr, "");
    }

    #[test]
    fn rejects_blank_or_malformed() {
        assert!(parse_line("").is_none());
        assert!(parse_line("\t\tplayer\t").is_none());
        assert!(parse_line("onlyonefield").is_none());
    }
}
