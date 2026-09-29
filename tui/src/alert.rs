//! Push notification via ntfy, so a serious attempt reaches your phone even
//! when you are not looking at the TUI. Gated on NTFY_URL in the config; a
//! no-op when unset. Uses curl (present on the homelab), keeping the static
//! binary free of an HTTP/TLS dependency.

use std::process::{Command, Stdio};

/// Fire-and-forget POST to the ntfy topic. Never blocks the UI meaningfully
/// (5s cap) and never fails loudly.
pub fn notify(url: &str, title: &str, body: &str) {
    let _ = Command::new("curl")
        .args([
            "-s",
            "-m",
            "5",
            "-H",
            &format!("Title: {title}"),
            "-H",
            "Priority: high",
            "-H",
            "Tags: warning",
            "-d",
            body,
            url,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}
