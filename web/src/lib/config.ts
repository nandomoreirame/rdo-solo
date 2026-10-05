//! Server configuration from the environment (.env.local). Validated once at
//! startup so a missing PIN or secret fails loud instead of silently allowing
//! everyone in.

export interface AppConfig {
  port: number;
  bind: string;
  pin: string;
  sessionSecret: string;
  sessionTtlMs: number;
  bin: string;
  sudo: boolean;
  blockTag: string;
  /** Discord webhook for session-drop alerts. "" disables Discord. */
  discordWebhook: string;
  /** Turn solo off automatically when the session drops (so you can reconnect). */
  autoOff: boolean;
  /** Idle time with RSONET that counts as a drop. */
  dropSilenceMs: number;
  /** Sustained RSONET traffic that confirms a real session before arming. */
  dropConfirmMs: number;
  /** Interface the console is routed through; probed to show the VPN exit IP. */
  vpnIface: string;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const pin = process.env.RDO_PIN ?? "";
  const sessionSecret = process.env.RDO_SESSION_SECRET ?? "";
  const missing: string[] = [];
  if (!pin || pin === "change-me") missing.push("RDO_PIN");
  if (!sessionSecret || sessionSecret.startsWith("change-me")) missing.push("RDO_SESSION_SECRET");
  if (missing.length) {
    throw new Error(
      `rdo-solo-web: set ${missing.join(", ")} in .env.local before starting (see .env.example)`,
    );
  }

  const hours = Number(process.env.RDO_SESSION_HOURS ?? "720");
  cached = {
    port: Number(process.env.PORT ?? "3737"),
    bind: process.env.RDO_BIND ?? "0.0.0.0",
    pin,
    sessionSecret,
    sessionTtlMs: (Number.isFinite(hours) && hours > 0 ? hours : 720) * 3600_000,
    bin: process.env.RDO_BIN ?? "rdo-solo-tui",
    sudo: (process.env.RDO_SUDO ?? "1") !== "0",
    blockTag: process.env.RDO_BLOCK_TAG ?? "RDO_BLOCK",
    discordWebhook: process.env.RDO_DISCORD_WEBHOOK ?? "",
    autoOff: (process.env.RDO_AUTO_OFF ?? "1") !== "0",
    dropSilenceMs: (Number(process.env.RDO_DROP_SILENCE_SECS ?? "45") || 45) * 1000,
    dropConfirmMs: (Number(process.env.RDO_DROP_CONFIRM_SECS ?? "8") || 8) * 1000,
    vpnIface: process.env.RDO_VPN_IFACE ?? "wg-vpn",
  };
  return cached;
}

export const SESSION_COOKIE = "rdo_session";
