//! Single source of live truth for the panel. Polls the gateway binary for the
//! solo state + route health, tails the kernel log (while solo is on) to count
//! blocked packets and intruder IPs, and tails RSONET traffic to detect a
//! session drop. On a drop it can auto-off solo and alert Discord. Emits
//! "update" whenever the snapshot changes so the WebSocket layer can fan it out.

import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { getConfig } from "./config";
import { readStatus, toggleSolo } from "./rdo";
import { parseStatusJson, type PanelStatus, type SoloStatus } from "./status";
import { DropDetector } from "./dropDetector";
import { notifyDiscord } from "./notify";

const POLL_MS = 4000;
const COUNTER_FLUSH_MS = 1000;
/** Rockstar's online service network (RSONET-NA1). */
const RSONET = "192.81.240.0/21";

const DEFAULT_STATUS: SoloStatus = parseStatusJson("");

class SoloMonitor extends EventEmitter {
  private status: SoloStatus = DEFAULT_STATUS;
  private blocked = 0;
  private ips = new Set<string>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private flushTimer?: ReturnType<typeof setInterval>;
  private tail?: ChildProcess;
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
    // Coalesce high-rate counter changes into at most one emit per second, and
    // check the drop detector on the same beat.
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
    }, COUNTER_FLUSH_MS);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.stopTail();
    if (this.rockstarTail) {
      this.rockstarTail.kill();
      this.rockstarTail = undefined;
    }
    this.started = false;
  }

  snapshot(): PanelStatus {
    return {
      ...this.status,
      blocked: this.blocked,
      unique_ips: this.ips.size,
      dropped_at: this.droppedAt,
      session_active: this.detector?.isActive(Date.now()) ?? false,
    };
  }

  private async poll(): Promise<void> {
    const next = await readStatus().catch(() => this.status);
    const wasSolo = this.status.solo;
    this.status = next;
    // Start the RSONET tail once we know the console IP.
    if (next.console_ip && !this.rockstarTail) {
      this.startRockstarTail(next.console_ip);
    }
    if (next.solo && !wasSolo) {
      this.resetCounters();
      this.startTail();
    } else if (!next.solo && wasSolo) {
      this.stopTail();
    }
    this.emit("update", this.snapshot());
  }

  private resetCounters(): void {
    this.blocked = 0;
    this.ips.clear();
  }

  private startTail(): void {
    if (this.tail) return;
    // No sudo here: the service user should be in the `systemd-journal` group so
    // it can read the kernel log directly (see web/README.md). If it cannot, the
    // spawn errors out and counters simply stay at 0.
    const args = ["-k", "-f", "-n", "0", "-o", "cat"];
    const child = spawn("journalctl", args);
    child.stdout?.setEncoding("utf8");
    let buf = "";
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.consumeLogLine(line);
      }
    });
    // If the journal can't be tailed (permissions), counters just stay at 0.
    child.on("error", () => this.stopTail());
    child.on("exit", () => {
      if (this.tail === child) this.tail = undefined;
    });
    this.tail = child;
  }

  private stopTail(): void {
    if (this.tail) {
      this.tail.kill();
      this.tail = undefined;
    }
  }

  /** tcpdump every packet between the console and RSONET; each feeds the drop
   *  detector. Needs host networking (it has it) and tcpdump in the image. If it
   *  cannot capture, drops just won't be detected — nothing else breaks. */
  private startRockstarTail(consoleIp: string): void {
    if (this.rockstarTail) return;
    const filter = `host ${consoleIp} and net ${RSONET}`;
    const child = spawn("tcpdump", ["-i", "any", "-nn", "-q", "-l", filter]);
    child.stdout?.setEncoding("utf8");
    let buf = "";
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.includes(" IP")) this.detector?.record(Date.now());
      }
    });
    child.on("error", () => {
      if (this.rockstarTail === child) this.rockstarTail = undefined;
    });
    child.on("exit", () => {
      if (this.rockstarTail === child) this.rockstarTail = undefined;
    });
    this.rockstarTail = child;
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

  private consumeLogLine(line: string): void {
    const cfg = getConfig();
    if (!line.includes(cfg.blockTag)) return;
    this.blocked += 1;
    const ip = peerIp(line, this.status.console_ip);
    if (ip) this.ips.add(ip);
    this.countersDirty = true;
  }
}

/** Extract the non-console peer IP from a kernel `SRC=.. DST=..` block line. */
export function peerIp(line: string, consoleIp: string): string | null {
  let src: string | null = null;
  let dst: string | null = null;
  for (const tok of line.split(/\s+/)) {
    if (tok.startsWith("SRC=")) src = tok.slice(4);
    else if (tok.startsWith("DST=")) dst = tok.slice(4);
  }
  if (src && src !== consoleIp) return src;
  if (dst && dst !== consoleIp) return dst;
  return null;
}

export const monitor = new SoloMonitor();
