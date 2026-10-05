//! Single source of live truth for the panel. Polls the gateway binary for the
//! solo state + route health, reads the block counter straight from iptables,
//! tails the console's P2P ports to list the session players / blocked intruders
//! (enriched with GeoIP), and tails RSONET traffic to detect a session drop. On
//! a drop it can auto-off solo and alert Discord. Emits "update" whenever the
//! snapshot changes so the WebSocket layer can fan it out.

import { EventEmitter } from "node:events";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "./config";
import { readStatus, toggleSolo } from "./rdo";
import { parseStatusJson, type PanelStatus, type PanelPeer, type SoloStatus, type VpnInfo } from "./status";
import { DropDetector } from "./dropDetector";
import { notifyDiscord } from "./notify";
import { publishSessionPeers } from "./sessionPeers";
import { parseVpnProbe, vpnProbeArgs, vpnEqual } from "./vpn";

const execFileP = promisify(execFile);

const POLL_MS = 4000;
const COUNTER_FLUSH_MS = 1000;
/** The VPN exit only changes on a tunnel restart (daily country rotation), so a
 *  slow probe is plenty. */
const VPN_PROBE_MS = 300_000;
/** iptables chain that logs+drops the blocked P2P packets (matches the shell script). */
const LOG_CHAIN = "RDO_LOGDROP";
/** The game's peer-to-peer UDP ports; traffic here (minus Rockstar relays) is players. */
const GAME_PORTS = "port 6672 or portrange 61455-61458";
/** A peer stays in the list until it has been silent for this long. */
const PEER_TTL_MS = 90_000;

/** Rockstar / Take-Two service networks (RDO/GTAO): RSONET-NA1 plus the
 *  Take-Two and Rockstar Games ranges the console actually talks to. Sustained
 *  traffic with any means an active session; silence means a drop. Override with
 *  RDO_RSONET_NETS (comma-separated CIDRs) if Rockstar changes ranges. */
const RSONET_NETS = (
  process.env.RDO_RSONET_NETS ?? "192.81.240.0/21,199.46.32.0/19,104.255.104.0/21"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Build the tcpdump filter matching the console's traffic with any RSONET net. */
export function rsonetFilter(consoleIp: string, nets: string[]): string {
  const expr = nets.map((n) => `net ${n}`).join(" or ");
  return `host ${consoleIp} and (${expr})`;
}

/** Parse the DROP rule packet count from `iptables -L RDO_LOGDROP -v -x -n`. This
 *  is the real block count and works in the container (unlike journalctl). */
export function parseBlockedCount(out: string): number {
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+\d+\s+DROP\b/);
    if (m) return Number(m[1]);
  }
  return 0;
}

function ipToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const x = Number(o);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = n * 256 + x;
  }
  return n >>> 0;
}

/** True if the IPv4 is inside any CIDR (used to hide Rockstar relays from players). */
export function inNets(ip: string, nets: string[]): boolean {
  const n = ipToInt(ip);
  if (n === null) return false;
  for (const cidr of nets) {
    const [net, bitsStr] = cidr.split("/");
    const base = ipToInt(net);
    const bits = Number(bitsStr);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((base & mask) >>> 0)) return true;
  }
  return false;
}

/** The non-console IPv4 in a P2P tcpdump -q line, or null. */
export function p2pPeerIp(line: string, consoleIp: string): string | null {
  const ips = line.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g);
  if (!ips) return null;
  for (const ip of ips) if (ip !== consoleIp) return ip;
  return null;
}

/** Milliseconds alone in the session after turning solo off: counts up until the
 *  first player joins, then freezes. Null while solo is on. */
export function aloneMs(
  soloOff: boolean,
  aloneSince: number | null,
  firstPlayerAt: number | null,
  now: number,
): number | null {
  if (!soloOff || aloneSince === null) return null;
  return (firstPlayerAt ?? now) - aloneSince;
}

interface Peer {
  ip: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  country?: string;
  cc?: string;
}

const DEFAULT_STATUS: SoloStatus = parseStatusJson("");

class SoloMonitor extends EventEmitter {
  private status: SoloStatus = DEFAULT_STATUS;
  private blocked = 0;
  private peers = new Map<string, Peer>();
  /** GeoIP results, cached per IP (null = looked up and failed/unknown). */
  private geo = new Map<string, { country: string; cc: string } | null>();
  private firstPlayerAt: number | null = null;
  private vpn: VpnInfo | null = null;
  private pollTimer?: ReturnType<typeof setInterval>;
  private flushTimer?: ReturnType<typeof setInterval>;
  private vpnTimer?: ReturnType<typeof setInterval>;
  private p2pTail?: ChildProcess;
  private rockstarTail?: ChildProcess;
  private detector?: DropDetector;
  private droppedAt: number | null = null;
  private started = false;
  private countersDirty = false;
  private lastActive = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    const cfg = getConfig();
    this.detector = new DropDetector(cfg.dropSilenceMs, cfg.dropConfirmMs);
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    void this.probeVpn();
    this.vpnTimer = setInterval(() => void this.probeVpn(), VPN_PROBE_MS);
    // Coalesce high-rate peer/counter changes into at most one emit per second,
    // and check the drop detector on the same beat.
    this.flushTimer = setInterval(() => {
      if (this.detector?.poll(Date.now())) void this.handleDrop();
      // Emit promptly when the session comes or goes, so the toggle gate on the
      // client enables/disables within a second of the console joining/leaving.
      const active = this.detector?.isActive(Date.now()) ?? false;
      if (active !== this.lastActive) {
        this.lastActive = active;
        this.emit("update", this.snapshot());
      }
      if (this.countersDirty) {
        this.countersDirty = false;
        this.emit("update", this.snapshot());
      }
      this.publishPeers();
    }, COUNTER_FLUSH_MS);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.vpnTimer) clearInterval(this.vpnTimer);
    for (const t of [this.p2pTail, this.rockstarTail]) t?.kill();
    this.p2pTail = undefined;
    this.rockstarTail = undefined;
    this.started = false;
  }

  snapshot(): PanelStatus {
    const now = Date.now();
    this.prunePeers(now);
    const soloOff = !this.status.solo;
    const aloneSince = soloOff && this.status.since_epoch ? this.status.since_epoch * 1000 : null;
    const peers: PanelPeer[] = [...this.peers.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 30)
      .map((p) => ({
        ip: p.ip,
        count: p.count,
        country: p.country ?? "",
        cc: p.cc ?? "",
        last_seen: p.lastSeen,
      }));
    return {
      ...this.status,
      blocked: this.blocked,
      unique_ips: this.peers.size,
      dropped_at: this.droppedAt,
      session_active: this.detector?.isActive(now) ?? false,
      peers,
      alone_ms: aloneMs(soloOff, aloneSince, this.firstPlayerAt, now),
      vpn: this.vpn,
    };
  }

  /** Read the public IP the console exits from by probing ip-api BOUND to the
   *  tunnel interface (a plain request would report the home WAN IP). A failure
   *  — tunnel down, curl missing — means no VPN, surfaced as null. */
  private async probeVpn(): Promise<void> {
    const { vpnIface } = getConfig();
    let next: VpnInfo | null = null;
    try {
      const { stdout } = await execFileP("curl", vpnProbeArgs(vpnIface), { timeout: 8000 });
      next = parseVpnProbe(stdout);
    } catch {
      next = null; // no tunnel / no curl → console is on the WAN, no VPN
    }
    if (!vpnEqual(next, this.vpn)) {
      this.vpn = next;
      this.emit("update", this.snapshot());
    }
  }

  private async poll(): Promise<void> {
    const next = await readStatus().catch(() => this.status);
    const wasSolo = this.status.solo;
    this.status = next;
    // Start the tails once we know the console IP (both run regardless of solo:
    // RSONET for drop detection, P2P for the players/intruders list).
    if (next.console_ip && !this.rockstarTail) this.startRockstarTail(next.console_ip);
    if (next.console_ip && !this.p2pTail) this.startP2pTail(next.console_ip);
    // On a solo flip the audience changes (players vs blocked intruders), so
    // start the peer list fresh and (re)arm the "alone" timer.
    if (next.solo !== wasSolo) {
      this.peers.clear();
      this.firstPlayerAt = null;
    }
    await this.readBlocked();
    this.publishPeers();
    this.emit("update", this.snapshot());
  }

  /** Real block count from the iptables DROP counter (works in the container,
   *  where journalctl is unavailable). Runs unprivileged as root in the container;
   *  on a non-root host deploy it may fail and the last value is kept. */
  private async readBlocked(): Promise<void> {
    try {
      const { stdout } = await execFileP("iptables", ["-L", LOG_CHAIN, "-v", "-x", "-n"]);
      this.blocked = parseBlockedCount(stdout);
    } catch {
      // no privilege / chain missing → keep the last value
    }
  }

  /** tcpdump the console's P2P ports; each non-Rockstar peer is a player (solo
   *  off) or a blocked intruder (solo on). Rockstar relays (RSONET) are hidden. */
  private startP2pTail(consoleIp: string): void {
    if (this.p2pTail) return;
    const filter = `host ${consoleIp} and udp and (${GAME_PORTS})`;
    this.p2pTail = this.spawnTail(filter, (line) => this.recordPeer(line, consoleIp), (c) => {
      if (this.p2pTail === c) this.p2pTail = undefined;
    });
  }

  /** tcpdump traffic between the console and RSONET; each packet feeds the drop
   *  detector. If it cannot capture, drops just won't be detected. */
  private startRockstarTail(consoleIp: string): void {
    if (this.rockstarTail) return;
    const filter = rsonetFilter(consoleIp, RSONET_NETS);
    this.rockstarTail = this.spawnTail(
      filter,
      (line) => {
        if (line.includes(" IP")) this.detector?.record(Date.now());
      },
      (c) => {
        if (this.rockstarTail === c) this.rockstarTail = undefined;
      },
    );
  }

  private spawnTail(
    filter: string,
    onLine: (line: string) => void,
    onGone: (child: ChildProcess) => void,
  ): ChildProcess {
    const child = spawn("tcpdump", ["-i", "any", "-nn", "-q", "-l", filter]);
    child.stdout?.setEncoding("utf8");
    let buf = "";
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line);
      }
    });
    child.on("error", () => onGone(child));
    child.on("exit", () => onGone(child));
    return child;
  }

  private recordPeer(line: string, consoleIp: string): void {
    const ip = p2pPeerIp(line, consoleIp);
    if (!ip || inNets(ip, RSONET_NETS)) return; // skip Rockstar's own relays
    const now = Date.now();
    let peer = this.peers.get(ip);
    if (!peer) {
      peer = { ip, count: 0, firstSeen: now, lastSeen: now };
      this.peers.set(ip, peer);
      void this.enrich(peer);
      // First real player to show up after solo went off freezes the timer.
      if (!this.status.solo && this.firstPlayerAt === null) this.firstPlayerAt = now;
    }
    peer.count += 1;
    peer.lastSeen = now;
    this.countersDirty = true;
  }

  private prunePeers(now: number): void {
    for (const [ip, p] of this.peers) if (now - p.lastSeen > PEER_TTL_MS) this.peers.delete(ip);
  }

  /** Publish the current session peer IPs to the cross-instance bridge so the
   *  Next route handlers (which import a separate, never-started monitor
   *  instance) can read them. Only the started instance runs the timers/tails
   *  that call this, so the empty route instance never clobbers the list. */
  private publishPeers(now = Date.now()): void {
    this.prunePeers(now);
    publishSessionPeers([...new Set([...this.peers.values()].map((p) => p.ip))]);
  }

  /** Best-effort country lookup via a public GeoIP API (no local mmdb here).
   *  Only the peer IP is sent; results are cached. Failure leaves the peer
   *  without a country. */
  private async enrich(peer: Peer): Promise<void> {
    const cached = this.geo.get(peer.ip);
    if (cached !== undefined) {
      if (cached) {
        peer.country = cached.country;
        peer.cc = cached.cc;
      }
      return;
    }
    try {
      const res = await fetch(
        `http://ip-api.com/json/${peer.ip}?fields=status,country,countryCode`,
        { signal: AbortSignal.timeout(4000) },
      );
      const j = (await res.json()) as {
        status?: string;
        country?: string;
        countryCode?: string;
      };
      if (j.status === "success" && j.country) {
        const g = { country: j.country, cc: j.countryCode ?? "" };
        this.geo.set(peer.ip, g);
        peer.country = g.country;
        peer.cc = g.cc;
        this.countersDirty = true;
      } else {
        this.geo.set(peer.ip, null);
      }
    } catch {
      this.geo.set(peer.ip, null);
    }
  }

  /** A confirmed session went silent: alert Discord and, if configured, turn
   *  solo off so the console can reconnect (the filter would block it otherwise). */
  private async handleDrop(): Promise<void> {
    this.droppedAt = Date.now();
    const cfg = getConfig();
    const wasSolo = this.status.solo;
    let msg = "🔴 rdo-solo: sua sessão do Red Dead Online caiu (perdeu contato com a Rockstar).";
    if (wasSolo && cfg.autoOff) {
      try {
        await toggleSolo(false);
        msg += " Modo solo DESLIGADO automaticamente para você reconectar.";
      } catch {
        msg += " ATENÇÃO: falhei ao desligar o solo — desligue manualmente para reconectar!";
      }
    } else if (wasSolo) {
      msg += " O modo solo está LIGADO — desligue para conseguir reconectar.";
    }
    void notifyDiscord(cfg.discordWebhook, msg);
    this.status = await readStatus().catch(() => this.status);
    this.emit("update", this.snapshot());
  }
}

export const monitor = new SoloMonitor();
