//! Bridge for the live session peer IPs across module-instance boundaries.
//!
//! The custom server (server.ts) and the Next App-Router route handlers run in
//! the SAME process but in SEPARATE module registries, so the `monitor`
//! singleton each imports is a DIFFERENT instance. Only server.ts calls
//! `monitor.start()`, so its instance is the one with the tcpdump tails and the
//! populated peer map; the route handlers' instance stays empty forever. A
//! route that read `monitor.snapshot().peers` always saw zero peers (the
//! "Capturar IPs" bug: panel showed a peer via the WS, capture saved 0).
//!
//! globalThis is shared across both registries (one V8 isolate), so the running
//! monitor publishes its current peer IPs here and the route handler reads them.

export const SESSION_PEERS_KEY = Symbol.for("rdo.sessionPeers");

interface Store {
  ips: string[];
}

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  return (g[SESSION_PEERS_KEY] ??= { ips: [] });
}

/** Called by the running monitor whenever its peer set changes. */
export function publishSessionPeers(ips: string[]): void {
  store().ips = ips;
}

/** Current session peer IPs as seen by the running monitor, or [] if none. */
export function readSessionPeers(): string[] {
  return store().ips;
}
