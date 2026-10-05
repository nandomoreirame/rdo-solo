//! Dev-only mock data for the panel. Enabled by NEXT_PUBLIC_RDO_MOCK=1 so the UI
//! can be previewed on localhost WITHOUT the gateway (no tcpdump/iptables/console).
//! The client (page.tsx) seeds `status` from here and mutates it locally, so the
//! Solo/Squad/Capture buttons work for layout testing. Never affects production:
//! when the env flag is unset, none of this runs.

import type { Mode, PanelStatus } from "./status";

export const MOCK = process.env.NEXT_PUBLIC_RDO_MOCK === "1";

const nowSec = () => Math.floor(Date.now() / 1000);

const MOCK_PEERS = [
  { ip: "177.10.174.107", count: 42, country: "Brazil", cc: "BR", last_seen: Date.now() },
  { ip: "45.184.53.184", count: 18, country: "Brazil", cc: "BR", last_seen: Date.now() },
  { ip: "200.142.6.9", count: 7, country: "Brazil", cc: "BR", last_seen: Date.now() },
  { ip: "73.92.14.201", count: 3, country: "United States", cc: "US", last_seen: Date.now() },
];

/** Snapshot starting ALONE in a Normal-mode session (no players yet). The dev
 *  simulation ticks `alone_ms` and then calls mockPeersJoin to trigger the
 *  border alert. */
export function initialMock(): PanelStatus {
  return {
    solo: false,
    mode: "off",
    since_epoch: null,
    console_ip: "192.168.1.100",
    console_label: "XBOX-ONE",
    health: {
      forwarding: true,
      redirects_ok: true,
      route_rule: true,
      console_present: true,
      ip_mismatch: false,
      console_ipv6: false,
      gateway_pkts: 1234,
      ok: true,
    },
    squad: { ips: [], captured_at: null },
    blocked: 332,
    unique_ips: 0,
    dropped_at: null,
    session_active: true,
    peers: [],
    alone_ms: 0,
    vpn: { exit_ip: "198.44.133.115", cc: "US", country: "United States" },
  };
}

/** Dev simulation: players enter the session (freezes the "alone" timer). */
export function mockPeersJoin(s: PanelStatus): PanelStatus {
  return {
    ...s,
    peers: MOCK_PEERS.map((p) => ({ ...p })),
    unique_ips: MOCK_PEERS.length,
  };
}

/** Flip the mock mode (what the Solo/Squad buttons do locally). */
export function mockSetMode(s: PanelStatus, mode: Mode): PanelStatus {
  const active = mode !== "off";
  return {
    ...s,
    mode,
    solo: active,
    since_epoch: active ? nowSec() : null,
    alone_ms: active ? null : 25_000,
  };
}

/** Capture: save the current session peers as the squad (what Capturar does). */
export function mockCapture(s: PanelStatus): PanelStatus {
  const ips = s.peers.map((p) => p.ip);
  return { ...s, squad: { ips, captured_at: new Date().toISOString() } };
}

export function mockClearSquad(s: PanelStatus): PanelStatus {
  return { ...s, squad: { ips: [], captured_at: null } };
}

export function mockRemoveSquadIp(s: PanelStatus, ip: string): PanelStatus {
  const ips = s.squad.ips.filter((x) => x !== ip);
  return {
    ...s,
    squad: { ips, captured_at: ips.length === 0 ? null : s.squad.captured_at },
  };
}
