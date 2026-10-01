---
feature: squad-mode
phase: implement-complete
spec_path: docs/specs/squad-mode/SPEC.md
plan_path: docs/plans/2026-09-30-squad-mode.md
started_at: "2026-09-30"
updated_at: "2026-10-01"
current_section: ""
language: pt-BR
decisions:
  - "One-button capture: snapshot ALL current session peers into the squad allowlist (user guarantees only friends are present at capture time)"
  - "Kick mode uses saved allowlist: drop every P2P peer NOT in the allowlist; RSONET (Rockstar infra) always allowed"
  - "Blocklist is a secondary mode: ban specific attacker IPs"
blockers:
  - "CRITICAL: an allow/posse whitelist already existed and was REMOVED on 2026-09-28 (see homelab/rdo-solo.md:103,112). Reason: whitelisting only friends drops the session HOST (a stranger) + Rockstar relays, which are invisible to the peer capture (hidden as RSONET). The mesh survives minutes then dies at the next host migration (error 0x50060190). The literal 'capture peers, kick the rest' idea reproduces this exact failure."
  - "Fix direction: allowlist must ALWAYS keep RSONET allowed (relays) and accept that YOU become the host of a clean session. Blocklist (ban specific attacker IPs) is surgical and keeps the session alive — better fit for 'being attacked'. Both share the per-IP rule plumbing."
  - "Enforcement is port-only today (RDO_SOLO matches console+ports, no peer IP). Per-peer RETURN/DROP must be added to load_drops (homelab/rdo-solo:140, tui/src/firewall.rs:176)."
  - "Untrusted input: passing attacker/friend IPs as argv is the first non-literal arg on the privileged bridge — validate server-side. Sudoers (rdo-solo-web.sudoers:9) only allows on/off/status; new subcommands need entries. Web uses the Rust binary (RDO_BIN=rdo-solo-tui), so Rust is authoritative; shell must mirror."
  - "Persistence: no JSON on host today; state is plain-text /var/lib/rdo-solo/state. squad/blocklist list lives in /var/lib/rdo-solo/ (mounted RW into the web container). IPv4-only; friend IPs rotate -> consider TTL."
transitions:
  - "2026-09-30: research started"
  - "2026-09-30: architecture mapped; discovered prior removed whitelist (posse) + host/relay trap"
  - "2026-09-30: spec approved and saved; direction = corrected squad allowlist + live validation; proceeding to plan"
  - "2026-10-01: implemented tasks 1-12 via CLI pipeline (Grok impl, Claude review/gate/commit; Codex out of quota). All gates green: Rust 41 tests + clippy/fmt; web 41 tests + tsc + next build; shell shellcheck."
  - "PENDING: Task 13 (REQ-011 live validation) — needs a real RDO session with 1 friend + deploy to the homelab (rebuild rdo-solo-tui musl + web container, install shell). NOT done autonomously."
---
