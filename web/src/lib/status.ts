//! The shape of a live status snapshot and a defensive parser for the JSON the
//! gateway binary emits (`rdo-solo-tui status --json`). Parsing is total: bad or
//! partial input yields safe defaults rather than throwing, so a hiccup on the
//! gateway never crashes the panel.

export interface RouteHealth {
  forwarding: boolean;
  redirects_ok: boolean;
  route_rule: boolean;
  console_present: boolean;
  ip_mismatch: boolean;
  console_ipv6: boolean;
  gateway_pkts: number;
  ok: boolean;
}

export interface SoloStatus {
  solo: boolean;
  /** Epoch seconds of the last on/off change (state-file mtime), or null. */
  since_epoch: number | null;
  console_ip: string;
  /** Friendly console name (CONSOLE_LABEL), shown instead of the IP. "" if unset. */
  console_label: string;
  health: RouteHealth;
}

/** Counters the panel tracks itself by tailing the kernel log while solo is on. */
export interface LiveCounters {
  blocked: number;
  unique_ips: number;
}

export interface PanelStatus extends SoloStatus, LiveCounters {
  /** Epoch ms of the last detected session drop, or null. */
  dropped_at: number | null;
  /** True when the console is in an RDO session now (sustained RSONET traffic). */
  session_active: boolean;
}

const EMPTY_HEALTH: RouteHealth = {
  forwarding: false,
  redirects_ok: false,
  route_rule: false,
  console_present: false,
  ip_mismatch: false,
  console_ipv6: false,
  gateway_pkts: 0,
  ok: false,
};

function bool(v: unknown): boolean {
  return v === true;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function parseStatusJson(raw: string): SoloStatus {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      solo: false,
      since_epoch: null,
      console_ip: "",
      console_label: "",
      health: { ...EMPTY_HEALTH },
    };
  }
  const h = (obj.health ?? {}) as Record<string, unknown>;
  const since = obj.since_epoch;
  return {
    solo: bool(obj.solo),
    since_epoch: typeof since === "number" && Number.isFinite(since) ? since : null,
    console_ip: str(obj.console_ip),
    console_label: str(obj.console_label),
    health: {
      forwarding: bool(h.forwarding),
      redirects_ok: bool(h.redirects_ok),
      route_rule: bool(h.route_rule),
      console_present: bool(h.console_present),
      ip_mismatch: bool(h.ip_mismatch),
      console_ipv6: bool(h.console_ipv6),
      gateway_pkts: num(h.gateway_pkts),
      ok: bool(h.ok),
    },
  };
}

/** Whether turning solo ON should be blocked: the console is confirmed OUT of a
 *  session. Unknown state (no live snapshot yet) does NOT block, so the panel
 *  never locks the button before it has heard from the monitor. */
export function soloGate(
  status: { session_active?: boolean } | null,
): { blocked: boolean; reason: string } {
  if (status?.session_active === false) {
    return {
      blocked: true,
      reason: "Xbox fora de sessão do RDO. Abra o jogo e entre numa sessão.",
    };
  }
  return { blocked: false, reason: "" };
}

/** Human uptime, matching the Rust `fmt_dur`: "12s", "3m07s", "1h02m". */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
