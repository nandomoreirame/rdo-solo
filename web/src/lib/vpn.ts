//! Probe the VPN exit the console is routed through. The web container shares the
//! host network but egresses via the home WAN by default (only the console is
//! policy-routed through wg-vpn), so the probe MUST bind to the tunnel interface
//! to report the VPN's public IP instead of the home IP. Parsing is pure and
//! unit-tested here; the monitor owns the actual curl.

import { isValidIp } from "./squad";
import type { VpnInfo } from "./status";

/** curl argv that egresses through the tunnel and asks ip-api for the exit IP +
 *  its country. We shell out to curl precisely because Node's fetch cannot bind
 *  to an interface (SO_BINDTODEVICE). */
export function vpnProbeArgs(iface: string): string[] {
  return [
    "-s",
    "--interface",
    iface,
    "--max-time",
    "6",
    "http://ip-api.com/json/?fields=status,query,country,countryCode",
  ];
}

/** Parse the ip-api probe into VpnInfo, or null when the tunnel is down / the
 *  lookup failed / the payload is malformed (rendered as "no VPN" upstream). */
export function parseVpnProbe(raw: string): VpnInfo | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.status !== "success") return null;
  const exit_ip = typeof obj.query === "string" ? obj.query : "";
  if (!isValidIp(exit_ip)) return null;
  return {
    exit_ip,
    cc: typeof obj.countryCode === "string" ? obj.countryCode : "",
    country: typeof obj.country === "string" ? obj.country : "",
  };
}

/** Structural equality, so the monitor only emits a WS frame when the exit changes. */
export function vpnEqual(a: VpnInfo | null, b: VpnInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.exit_ip === b.exit_ip && a.cc === b.cc && a.country === b.country;
}
