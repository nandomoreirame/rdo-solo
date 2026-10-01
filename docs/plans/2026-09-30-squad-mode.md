# Plan: Squad Mode (allowlist de sessão + expulsar outros)

> **Spec:** docs/specs/squad-mode/SPEC.md

**Goal:** Capturar os peers ativos da sessão em 1 clique e, no modo Squad, dropar todo P2P fora do squad sempre preservando os relays da Rockstar (RSONET).
**Architecture:** O binário Rust (`tui/`) é a autoridade: novo módulo `squad.rs` (Mode + lista + validação de IP), `firewall.rs::load_drops` ganha um ramo Squad que faz ACCEPT por IP do squad + RSONET antes dos DROP por porta, e o estado passa de `{off,on}` para `{off,solo,squad}`. O shell (`homelab/rdo-solo`) espelha 1:1. O web lê o monitor do próprio processo para capturar, grava via `rdo-solo-tui squad-set`, e expõe captura/toggle/lista no painel.
**Tech Stack:** Rust (musl, sem serde) + Bash + Next.js 15 (App Router, custom server) + vitest.
**Total Tasks:** 13 (P1) + 3 follow-up (P2)
**Estimated Complexity:** large (9+)

**Convenção de commit:** cada task termina em `/git commit` (skill `git-commit`, emoji + Conventional Commits em inglês). NUNCA push. Em `--agentic` o commit é por task.

**Ordem de dependência:** 1 → 2 → 3 → 4 → 5 → 6 (Rust em cadeia). 7 (shell) depende de 1-6 fechadas (porta 1:1). 8 independente. 9 → 10 → 11 → 12 (web em cadeia, dependem do binário das tasks 5-6 para o contrato de subcomando/JSON). 13 depende de tudo.

---

### Task 1: Rust — módulo `squad.rs` (Mode, validação de IP, lista, RSONET)

**Requirement:** REQ-001, REQ-006, REQ-010
**Files:**
- Create: `tui/src/squad.rs`
- Modify: `tui/src/main.rs:1-20` (declarar `mod squad;`)
- Test: inline `#[cfg(test)] mod tests` em `tui/src/squad.rs`

**Team:**
- Track: infra
- Implementer: infra-engineer (skills: `rust-cli-conventions`, `test-driven-development`)
- Reviewers: type-safety-reviewer, security-reviewer, test-reviewer

**Step 1: Write the failing test** (inline em `tui/src/squad.rs`)
```rust
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
```

**Step 2: Run test to verify it fails**
Run: `cd tui && cargo test squad::`
Expected: FAIL — `cannot find module squad` / unresolved items.

**Step 3: Write minimal implementation** (`tui/src/squad.rs`)
```rust
// Squad allowlist: capture of current session peers + mode state.
// Ported 1:1 into homelab/rdo-solo (shell). No serde (keep the musl binary small).
use std::fs;
use std::net::Ipv4Addr;
use std::path::Path;
use std::str::FromStr;

pub const SQUAD_FILE: &str = "/var/lib/rdo-solo/squad.list";

// Rockstar service ranges (RSONET). Mirror of the web's RDO_RSONET_NETS default.
// Always ACCEPT-ed in squad mode so the session host/relays survive (see
// docs/specs/squad-mode/SPEC.md REQ-004; post-mortem homelab/rdo-solo.md:112).
pub const RSONET_NETS: &[&str] = &[
    "192.81.240.0/21",
    "199.46.32.0/19",
    "104.255.104.0/21",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode { Off, Solo, Squad }

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self { Mode::Off => "off", Mode::Solo => "solo", Mode::Squad => "squad" }
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
        if t.is_empty() || t.starts_with('#') { continue; }
        if is_valid_ip(t) && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    out
}

pub fn format_squad(ips: &[String], captured_at: &str) -> String {
    let mut s = format!("# captured_at={}\n", captured_at);
    for ip in ips { s.push_str(ip); s.push('\n'); }
    s
}

pub fn read_squad() -> Vec<String> {
    fs::read_to_string(SQUAD_FILE).map(|b| parse_squad(&b)).unwrap_or_default()
}

/// Replace semantics (REQ-001): overwrite with only the valid, deduped IPs.
pub fn write_squad(ips: &[String], captured_at: &str) -> std::io::Result<()> {
    let clean = parse_squad(&ips.join("\n"));
    fs::write(SQUAD_FILE, format_squad(&clean, captured_at))
}

pub fn clear_squad() -> std::io::Result<()> {
    if Path::new(SQUAD_FILE).exists() { fs::remove_file(SQUAD_FILE)?; }
    Ok(())
}
```
Add `mod squad;` near the other `mod` declarations at the top of `tui/src/main.rs`.

**Step 4: Run test to verify it passes**
Run: `cd tui && cargo test squad::`
Expected: PASS (4 tests).

**Step 5: Commit**
Run: `/git commit`

---

### Task 2: Rust — estado `{off,solo,squad}` em `firewall.rs`

**Requirement:** REQ-006
**Files:**
- Modify: `tui/src/firewall.rs:222-233` (`read_state`, `write_state`, `apply_state`)
- Test: inline tests em `tui/src/firewall.rs` (já há `#[cfg(test)]` no arquivo)

**Team:**
- Track: infra
- Implementer: infra-engineer (skills: `rust-cli-conventions`, `test-driven-development`)
- Reviewers: type-safety-reviewer, consequences-reviewer, test-reviewer

**Step 1: Write the failing test**
```rust
#[test]
fn state_roundtrips_mode_with_legacy_on() {
    // write/read go through the STATE_FILE; use a tmp override if the fns take a path,
    // otherwise assert the pure mapping used by read_state:
    use crate::squad::Mode;
    assert_eq!(Mode::parse("on"), Mode::Solo);      // legacy file content
    assert_eq!(Mode::parse("squad"), Mode::Squad);
    assert_eq!(Mode::Squad.as_str(), "squad");
}
```
(If `read_state`/`write_state` hardcode `STATE_FILE`, refactor them to `read_state_at(path)`/`write_state_at(path, mode)` with thin wrappers, and test the `_at` variants against a `tempfile`.)

**Step 2: Run test to verify it fails**
Run: `cd tui && cargo test firewall::`
Expected: FAIL — `read_state` still returns `bool`/string, `Mode` not wired.

**Step 3: Write minimal implementation**
Change `read_state` to return `squad::Mode` (parse the file body via `Mode::parse`, default `Off` when absent). Change `write_state(mode: Mode)` to write `mode.as_str()` + `\n`. Keep `STATE_FILE` constant. Backward compat is automatic because `Mode::parse("on") == Solo`.

**Step 4: Run test to verify it passes**
Run: `cd tui && cargo test firewall::`
Expected: PASS.

**Step 5: Commit**
Run: `/git commit`

---

### Task 3: Rust — `load_drops` ganha o ramo Squad (ACCEPT squad + RSONET, depois DROP)

**Requirement:** REQ-003, REQ-004
**Files:**
- Modify: `tui/src/firewall.rs:176-220` (`load_drops`)
- Test: inline tests em `tui/src/firewall.rs`

**Team:**
- Track: infra
- Implementer: infra-engineer (skills: `rust-cli-conventions`, `bash-linux`, `test-driven-development`)
- Reviewers: security-reviewer, consequences-reviewer, type-safety-reviewer, test-reviewer

**Design:** refatorar o `load_drops` para construir a lista de argumentos de regra numa função pura testável `squad_rules(cfg, mode, squad_ips) -> Vec<Vec<String>>` (cada item = argv de um `iptables -A RDO_SOLO ...`), e o `load_drops` apenas executa. Assim o teste valida a SEQUÊNCIA sem rodar iptables.

**Regras geradas:**
- `Mode::Solo` → só os DROP por porta (comportamento atual; relays caem também).
- `Mode::Squad` → para cada IP do squad: `-s <ip> -j ACCEPT` e `-d <ip> -j ACCEPT`; para cada net em `RSONET_NETS`: `-s <net> -j ACCEPT` e `-d <net> -j ACCEPT`; **depois** os mesmos DROP por porta. (ACCEPT por IP vem antes do DROP por porta → squad/relays passam, resto cai.)
- `Mode::Off` → vazio.

**Step 1: Write the failing test**
```rust
#[test]
fn squad_rules_accept_squad_and_rsonet_before_drops() {
    use crate::squad::{Mode, RSONET_NETS};
    let cfg = Config::test_default(); // CONSOLE_IP = "192.168.1.250"
    let squad = vec!["45.184.53.184".to_string()];
    let rules = squad_rules(&cfg, Mode::Squad, &squad);

    // squad ACCEPT present, both directions
    assert!(rules.iter().any(|r| r == &vec!["-s","45.184.53.184","-j","ACCEPT"]));
    assert!(rules.iter().any(|r| r == &vec!["-d","45.184.53.184","-j","ACCEPT"]));
    // every RSONET net accepted
    for net in RSONET_NETS {
        assert!(rules.iter().any(|r| r == &vec!["-s", net, "-j", "ACCEPT"]));
    }
    // and the port drops still exist
    assert!(rules.iter().any(|r| r.contains(&"6672".to_string()) && r.last() == Some(&"RDO_LOGDROP".to_string())));

    // the first ACCEPT must come BEFORE the first LOGDROP
    let first_accept = rules.iter().position(|r| r.last() == Some(&"ACCEPT".to_string())).unwrap();
    let first_drop = rules.iter().position(|r| r.last() == Some(&"RDO_LOGDROP".to_string())).unwrap();
    assert!(first_accept < first_drop);
}

#[test]
fn squad_rules_solo_has_no_accepts() {
    use crate::squad::Mode;
    let cfg = Config::test_default();
    let rules = squad_rules(&cfg, Mode::Solo, &[]);
    assert!(rules.iter().all(|r| r.last() != Some(&"ACCEPT".to_string())));
    assert!(!rules.is_empty());
}
```
(Add a `Config::test_default()` helper under `#[cfg(test)]` if none exists.)

**Step 2: Run test to verify it fails**
Run: `cd tui && cargo test firewall::squad_rules`
Expected: FAIL — `squad_rules` not defined.

**Step 3: Write minimal implementation**
Extract `squad_rules(cfg, mode, squad_ips)` returning `Vec<Vec<String>>` per the design above (port-drop block identical to today's `-s/-d CONSOLE × --sport/--dport × single/range → RDO_LOGDROP`). Rewrite `load_drops(cfg, mode)` to `for r in squad_rules(cfg, mode, &squad::read_squad()) { run("iptables", ["-A","RDO_SOLO"].iter().chain(r)...) }`.

**Step 4: Run test to verify it passes**
Run: `cd tui && cargo test firewall::`
Expected: PASS.

**Step 5: Commit**
Run: `/git commit`

---

### Task 4: Rust — `apply_state` + comandos `cmd_squad_on` / `cmd_off`

**Requirement:** REQ-003, REQ-005
**Files:**
- Modify: `tui/src/firewall.rs:233-258` (`apply_state`, `cmd_on`, `cmd_off`, add `cmd_squad_on`)
- Test: cobertura via Task 3 (lógica pura) + smoke manual na Task 13

**Team:**
- Track: infra
- Implementer: infra-engineer (skills: `rust-cli-conventions`, `bash-linux`)
- Reviewers: consequences-reviewer, security-reviewer, test-reviewer

**Step 1/2:** sem teste novo de unidade (efeito colateral iptables). A garantia vem de Task 3 (sequência de regras) + Task 13 (ao vivo). Pular direto ao Step 3.

**Step 3: Write minimal implementation**
- `apply_state(cfg)`: `flush RDO_SOLO`; `match read_state() { Off => {}, Solo => load_drops(cfg, Solo), Squad => load_drops(cfg, Squad) }`.
- `cmd_on(cfg)` → `write_state(Solo); apply_state(cfg)`.
- `cmd_squad_on(cfg)` → `write_state(Squad); apply_state(cfg)`.
- `cmd_off(cfg)` → `write_state(Off); iptables -F RDO_SOLO`.

**Step 4:** Run: `cd tui && cargo build` → compila sem erro.

**Step 5: Commit**
Run: `/git commit`

---

### Task 5: Rust — dispatch dos subcomandos + validação de IP

**Requirement:** REQ-001, REQ-009, REQ-010, REQ-013
**Files:**
- Modify: `tui/src/main.rs:54-120` (função `run`)
- Test: inline test de validação de argv em `tui/src/main.rs` ou `squad.rs`

**Team:**
- Track: infra
- Implementer: infra-engineer (skills: `rust-cli-conventions`, `test-driven-development`)
- Reviewers: security-reviewer, type-safety-reviewer, test-reviewer

**Novos subcomandos** (args após o subcomando são os IPs, quando aplicável):
- `squad-set <ip> [ip...]` → valida cada IP (`squad::is_valid_ip`); se algum inválido, imprime erro em stderr e sai `2` (REQ-010); senão `squad::write_squad(&ips, &now_iso())`.
- `squad-on` → `firewall::cmd_squad_on(cfg)`.
- `squad-off` → `firewall::cmd_off(cfg)`.
- `squad-list` → imprime `squad::read_squad()` (1 IP por linha) ou `--json` (ver Task 6).
- `squad-clear` → `squad::clear_squad()`.

**Step 1: Write the failing test**
```rust
#[test]
fn squad_set_rejects_any_invalid_ip() {
    use crate::squad::is_valid_ip;
    let args = vec!["1.2.3.4", "oops"];
    assert!(!args.iter().all(|a| is_valid_ip(a))); // dispatch must reject the whole call
}
```

**Step 2:** Run: `cd tui && cargo test` → FAIL até o helper/validação existir (ou trivial-pass; o real gate é a integração na Task 13).

**Step 3: Write minimal implementation**
Add the match arms to `run`. Add `fn now_iso()` (format `%Y-%m-%dT%H:%M:%SZ` em UTC sem serde/chrono se já houver helper de tempo no projeto; senão usar `std::time::SystemTime` + formatação simples). Reject `squad-set` unless `args.iter().all(is_valid_ip)`.

**Step 4:** Run: `cd tui && cargo test && cargo build` → PASS/compila.

**Step 5: Commit**
Run: `/git commit`

---

### Task 6: Rust — `status --json` emite `mode` + `squad`

**Requirement:** REQ-002, REQ-006
**Files:**
- Modify: `tui/src/main.rs:153-200` (`print_status_json`)
- Test: inline test do fragmento JSON (string contains)

**Team:**
- Track: infra
- Implementer: infra-engineer (skills: `rust-cli-conventions`, `test-driven-development`)
- Reviewers: type-safety-reviewer, test-reviewer

**Step 1: Write the failing test**
```rust
#[test]
fn status_json_includes_mode_and_squad() {
    let json = render_status_json_for_test("squad", &["1.2.3.4".to_string()], "2026-09-30T10:00:00Z");
    assert!(json.contains("\"mode\":\"squad\""));
    assert!(json.contains("\"squad\":[\"1.2.3.4\"]"));
    assert!(json.contains("\"squad_captured_at\":\"2026-09-30T10:00:00Z\""));
}
```
(Extract the JSON body building into a pure `render_status_json_for_test(mode, ips, captured_at) -> String` the emitter also uses.)

**Step 2:** Run: `cd tui && cargo test status_json` → FAIL.

**Step 3: Write minimal implementation**
In `print_status_json`, read `Mode` + `read_squad()` + captured_at (parse the `# captured_at=` header of `squad.list`), and add the fields (hand-rolled JSON; escape the IP strings — they are validated IPv4 so no escaping needed, but keep the array builder generic). Keep the existing fields (`solo` boolean stays for back-compat: `solo = mode != off`).

**Step 4:** Run: `cd tui && cargo test` → PASS.

**Step 5: Commit**
Run: `/git commit`

---

### Task 7: Shell — paridade 1:1 em `homelab/rdo-solo`

**Requirement:** REQ-001..REQ-010 (shell)
**Files:**
- Modify: `homelab/rdo-solo:140-160` (`load_drops`, `apply_state`), `:291-310` (`cmd_on`/`cmd_off`), `:378-400` (dispatch)
- Test: `shellcheck homelab/rdo-solo` + smoke `rdo-solo status`

**Team:**
- Track: infra
- Implementer: infra-engineer (skills: `bash-linux`, `rust-cli-conventions` [para paridade])
- Reviewers: security-reviewer, consequences-reviewer

**Step 3: Write minimal implementation** (sem TDD de unidade em bash; `shellcheck` é o gate)
- Estado: `STATE_FILE` passa a conter `off|solo|squad` (ler `on` legado como `solo`).
- `SQUAD_FILE="$STATE_DIR/squad.list"`; `RSONET_NETS=(192.81.240.0/21 199.46.32.0/19 104.255.104.0/21)`.
- `is_valid_ip()` via regex/`ipcalc`/`grep -E` de octetos 0-255.
- `read_squad()` (grep linhas não-`#`, filtra válidos, dedup `awk '!seen[$0]++'`).
- `load_drops()`: quando modo=squad, antes do bloco de DROP por porta, emitir:
  ```bash
  for ip in $(read_squad); do
    iptables -A "$CHAIN" -s "$ip" -j ACCEPT
    iptables -A "$CHAIN" -d "$ip" -j ACCEPT
  done
  for net in "${RSONET_NETS[@]}"; do
    iptables -A "$CHAIN" -s "$net" -j ACCEPT
    iptables -A "$CHAIN" -d "$net" -j ACCEPT
  done
  ```
  (o bloco de DROP por porta permanece idêntico ao atual).
- Dispatch (`case`): adicionar `squad-set|squad-on|squad-off|squad-list|squad-clear`. `squad-set` valida cada IP com `is_valid_ip` e sai `2` se algum falhar.

**Step 4:** Run: `shellcheck homelab/rdo-solo` → zero warnings; `sudo rdo-solo status` em dev/homelab não quebra.

**Step 5: Commit**
Run: `/git commit`

---

### Task 8: Web — helper puro `squad.ts` + testes

**Requirement:** REQ-010
**Files:**
- Create: `web/src/lib/squad.ts`
- Test: `web/src/lib/squad.test.ts`

**Team:**
- Track: backend
- Implementer: backend-engineer (skills: `typescript-backend`, `test-driven-development`)
- Reviewers: type-safety-reviewer, security-reviewer, test-reviewer

**Step 1: Write the failing test** (`web/src/lib/squad.test.ts`)
```ts
import { describe, it, expect } from "vitest";
import { isValidIp, parseSquadList, formatSquadList } from "./squad";

describe("squad helpers", () => {
  it("validates IPv4 and rejects junk/injection", () => {
    expect(isValidIp("45.184.53.184")).toBe(true);
    expect(isValidIp("999.1.1.1")).toBe(false);
    expect(isValidIp("1.2.3.4; rm -rf /")).toBe(false);
    expect(isValidIp("")).toBe(false);
  });
  it("parses list, skipping comments/invalid and deduping", () => {
    const body = "# captured_at=2026-09-30T10:00:00Z\n1.2.3.4\n1.2.3.4\nbad\n5.6.7.8\n";
    expect(parseSquadList(body)).toEqual({ capturedAt: "2026-09-30T10:00:00Z", ips: ["1.2.3.4", "5.6.7.8"] });
  });
  it("formats roundtrip", () => {
    const body = formatSquadList(["1.2.3.4"], "2026-09-30T10:00:00Z");
    expect(parseSquadList(body).ips).toEqual(["1.2.3.4"]);
  });
});
```

**Step 2:** Run: `cd web && npx vitest run src/lib/squad.test.ts`
Expected: FAIL — module missing.

**Step 3: Write minimal implementation** (`web/src/lib/squad.ts`)
```ts
export function isValidIp(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return false;
  return m.slice(1).every((o) => { const n = Number(o); return n >= 0 && n <= 255 && String(n) === o; });
}

export interface SquadList { capturedAt: string | null; ips: string[]; }

export function parseSquadList(body: string): SquadList {
  let capturedAt: string | null = null;
  const ips: string[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) {
      const m = /captured_at=(.+)$/.exec(t);
      if (m) capturedAt = m[1].trim();
      continue;
    }
    if (isValidIp(t) && !ips.includes(t)) ips.push(t);
  }
  return { capturedAt, ips };
}

export function formatSquadList(ips: string[], capturedAt: string): string {
  const clean = ips.filter((ip, i) => isValidIp(ip) && ips.indexOf(ip) === i);
  return `# captured_at=${capturedAt}\n${clean.join("\n")}\n`;
}
```

**Step 4:** Run: `cd web && npx vitest run src/lib/squad.test.ts` → PASS.

**Step 5: Commit**
Run: `/git commit`

---

### Task 9: Web — `status.ts` ganha `mode` + `squad`

**Requirement:** REQ-002, REQ-006
**Files:**
- Modify: `web/src/lib/status.ts:17-115` (`PanelStatus`, `parseStatusJson`)
- Test: `web/src/lib/status.test.ts` (já existe)

**Team:**
- Track: backend
- Implementer: backend-engineer (skills: `typescript-backend`, `test-driven-development`)
- Reviewers: type-safety-reviewer, test-reviewer, business-logic-reviewer

**Step 1: Write the failing test** (adicionar a `status.test.ts`)
```ts
it("parses mode and squad from status json", () => {
  const raw = JSON.stringify({ solo: true, mode: "squad", squad: ["1.2.3.4"], squad_captured_at: "2026-09-30T10:00:00Z", console_ip: "192.168.1.250" });
  const s = parseStatusJson(raw);
  expect(s.mode).toBe("squad");
  expect(s.squad.ips).toEqual(["1.2.3.4"]);
  expect(s.squad.captured_at).toBe("2026-09-30T10:00:00Z");
});
it("defaults mode to off and squad empty when absent", () => {
  const s = parseStatusJson(JSON.stringify({ solo: false }));
  expect(s.mode).toBe("off");
  expect(s.squad.ips).toEqual([]);
});
```

**Step 2:** Run: `cd web && npx vitest run src/lib/status.test.ts` → FAIL.

**Step 3: Write minimal implementation**
- `type Mode = "off" | "solo" | "squad";`
- `interface SquadInfo { ips: string[]; captured_at: string | null; }`
- `PanelStatus` ganha `mode: Mode;` e `squad: SquadInfo;`.
- `parseStatusJson`: ler `mode` (default: `raw.solo ? "solo" : "off"` para back-compat), `squad` (array de IPs válidos via `isValidIp`), `squad_captured_at`.

**Step 4:** Run: `cd web && npx vitest run src/lib/status.test.ts` → PASS.

**Step 5: Commit**
Run: `/git commit`

---

### Task 10: Web — wrappers em `rdo.ts` (setMode, capture, list, clear)

**Requirement:** REQ-010, REQ-005
**Files:**
- Modify: `web/src/lib/rdo.ts:1-30`
- Test: `web/src/lib/rdo.test.ts` (criar; mock de `execFile`)

**Team:**
- Track: backend
- Implementer: backend-engineer (skills: `typescript-backend`, `test-driven-development`)
- Reviewers: security-reviewer, type-safety-reviewer, test-reviewer

**Step 1: Write the failing test** (`web/src/lib/rdo.test.ts`)
```ts
import { describe, it, expect, vi } from "vitest";
// mock node:child_process execFile and assert the argv built by captureSquad rejects invalid IPs
import { buildSquadSetArgs } from "./rdo";

describe("rdo squad argv", () => {
  it("builds squad-set argv from valid IPs only", () => {
    expect(buildSquadSetArgs(["1.2.3.4", "5.6.7.8"])).toEqual(["squad-set", "1.2.3.4", "5.6.7.8"]);
  });
  it("throws on any invalid IP (no injection reaches execFile)", () => {
    expect(() => buildSquadSetArgs(["1.2.3.4", "x; rm -rf /"])).toThrow();
  });
});
```

**Step 2:** Run: `cd web && npx vitest run src/lib/rdo.test.ts` → FAIL.

**Step 3: Write minimal implementation**
- Export `buildSquadSetArgs(ips: string[]): string[]` — throws if any `!isValidIp` (REQ-010), else `["squad-set", ...ips]`.
- `export async function setMode(mode: "off"|"solo"|"squad")` → `execFile(resolve, [map])` where map = `off→off`, `solo→on`, `squad→squad-on`.
- `export async function captureSquad(ips: string[])` → `execFile(resolve, buildSquadSetArgs(ips))`.
- `export async function readSquad()` → `execFile(resolve, ["squad-list"])` → `parseSquadList`.
- `export async function clearSquad()` → `execFile(resolve, ["squad-clear"])`.
(`resolve` já existe em `rdo.ts:13` e prefixa `sudo -n` quando `cfg.sudo`.)

**Step 4:** Run: `cd web && npx vitest run src/lib/rdo.test.ts` → PASS.

**Step 5: Commit**
Run: `/git commit`

---

### Task 11: Web — API: `/api/solo` estendido + novo `/api/squad`

**Requirement:** REQ-008, REQ-009
**Files:**
- Modify: `web/src/app/api/solo/route.ts:8-30`
- Create: `web/src/app/api/squad/route.ts`
- Test: cobertura via Task 10 (argv) + smoke na Task 13

**Team:**
- Track: backend
- Implementer: backend-engineer (skills: `typescript-backend`)
- Reviewers: security-reviewer, business-logic-reviewer, type-safety-reviewer

**Step 3: Write minimal implementation**
- `/api/solo` `POST`: aceitar `action ∈ {"off","solo","squad"}` (manter `"on"`→solo por compat), chamar `setMode(action)`. Rejeitar outros com 400. Manter o `authGuard`.
- `/api/squad` (novo), todos atrás de `isAuthed`:
  - `POST` (capturar, REQ-001/REQ-008): ler `monitor.snapshot()` do processo (import `{ monitor }` de `@/lib/monitor`); se `status.mode !== "off"` → `409` com mensagem "capture only in Normal" (REQ-008); extrair os IPs dos `peers` (já sem RSONET), validar via `isValidIp`, `captureSquad(ips)`, responder `{ ips, captured_at }`.
  - `GET` → `readSquad()`.
  - `DELETE` → `clearSquad()`.

**Step 4:** Run: `cd web && npx tsc --noEmit` (via bin local) → sem erros; `npm run build` compila as rotas.

**Step 5: Commit**
Run: `/git commit`

---

### Task 12: Web/UI — botão Capturar, toggle Squad, lista + avisos

**Requirement:** REQ-002, REQ-007, REQ-008, REQ-009
**Files:**
- Modify: `web/src/app/page.tsx:137-310`, `web/src/app/globals.css`
- Test: manual/visual + `npm run build` (sem teste unitário de página)

**Team:**
- Track: frontend
- Implementer: frontend-engineer (skills: `frontend-design`, `nextjs-fsd-conventions`)
- Reviewers: type-safety-reviewer, test-reviewer, accessibility-guardrails

**Step 3: Write minimal implementation**
- Ler `mode` e `squad` de `status` (WS). Toggle de modo: botão "MODO SQUAD" que faz `POST /api/solo {action: mode==="squad" ? "off" : "squad"}` (mantém o toggle Solo existente).
- Botão **"Capturar esquadrão"** (`POST /api/squad`): habilitado só quando `mode === "off"` (REQ-008); no sucesso mostra toast com nº de IPs + país (reusar `flag(cc)`); no `409` mostra o aviso de capturar-só-em-Normal.
- Seção **Squad salvo**: lista `squad.ips` (com `flag`/país quando disponível via peers), horário `squad.captured_at`, botão "limpar" (`DELETE /api/squad`).
- Aviso REQ-007: quando `mode==="squad"` e `squad.ips.length===0`, banner "Squad vazio: isso expulsa todos os players (só os relays ficam)".
- A11y: botões com `aria-pressed`/`aria-label`, foco visível (classe existente `.toggle`); banner com `role="status"`.
- CSS: classes `.squad`, `.squad-capture`, `.squad-list` seguindo o padrão de `.clean-toggle`/`.peerlist`.

**Step 4:** Run: `cd web && npm run build` → compila; abrir o painel e validar o fluxo capturar→squad→limpar na Task 13.

**Step 5: Commit**
Run: `/git commit`

---

### Task 13: Infra — deploy no homelab + validação ao vivo (REQ-011)

**Requirement:** REQ-011
**Files:**
- Deploy: binário `rdo-solo-tui` (musl) + container web no homelab
- Test: sessão real com 1 amigo

**Team:**
- Track: infra
- Implementer: infra-engineer (skills: `bash-linux`, `cloud-cli`)
- Reviewers: consequences-reviewer, security-reviewer

**Passos (sem commit de código novo; é operação + aceite):**
1. Build release: `cd tui && cargo build --release --target x86_64-unknown-linux-musl`.
2. Rebuild web: `cd web && docker build --network host -t rdo-solo-web .` (no homelab).
3. Deploy do binário pro homelab (`/usr/local/bin/rdo-solo-tui`, com backup `*.bak-<ts>`), shell pro `/usr/local/bin/rdo-solo`, e `docker compose up -d` do web. Sudoers só se for install bare-metal (no Docker, `RDO_SUDO=0` dispensa).
4. Smoke: `rdo-solo-tui status --json` mostra `mode`/`squad`; `squad-set <ip>` grava; `iptables -S RDO_SOLO` após `squad-on` tem os ACCEPT de squad + RSONET antes dos LOGDROP.
5. **Validação ao vivo (REQ-011):** entrar numa sessão com 1 amigo, Normal → "Capturar esquadrão" → ativar Squad → confirmar que você + amigo permanecem e os estranhos saem; observar a migração de host (erro `0x50060190` = reprovou). Registrar o resultado em `docs/specs/squad-mode/STATE.md`.

**Nota:** se a validação reprovar (você cai na migração), NÃO remover o rdo-solo; registrar o comportamento e reavaliar (ex.: manter também o host atual na allowlist por uma janela — ideia "doorman" do `homelab/rdo-solo.md:202`).

---

## Follow-up (P2 — fora do MVP, planejar depois)

- **REQ-012 — Paridade na TUI interativa:** keybind em `tui/src/app.rs` (`toggle_solo` → ciclo Normal/Solo/Squad) + ação de captura a partir de `session_peers` (`app.rs:84`), já que a TUI tem seu próprio netlog.
- **REQ-013 — Remover IP individual:** `squad-del <ip>` no binário/shell + botão por linha na lista do painel.
- **REQ-014 — Idade da captura:** exibir "capturado há Xmin" a partir de `squad_captured_at` e sugerir recaptura acima de um limite.

## P3 (nice to have — ver SPEC)
- REQ-015 apelidos por IP · REQ-016 blocklist de atacantes · REQ-017 captura self-contained via tcpdump no binário.
