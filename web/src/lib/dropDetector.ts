//! Detects a Red Dead Online session drop from the network side: the console
//! goes silent with Rockstar's service network (RSONET, 192.81.240.0/21) after
//! having sustained traffic with it. It does NOT read the game's 0x2100xxxx
//! error (that is encrypted app-layer); it infers the drop from the traffic
//! stopping. This works even while solo is on, because the filter blocks only
//! the P2P game ports — the console keeps talking to Rockstar's services until
//! the session actually drops.

export class DropDetector {
  private lastPktAt = 0;
  private streakStart = 0;
  private confirmed = false;
  private fired = false;

  /**
   * @param silenceMs idle time with RSONET that counts as a drop
   * @param confirmMs sustained RSONET traffic that confirms a real session
   *   (filters out a brief blip so we don't fire on noise)
   */
  constructor(
    private readonly silenceMs: number,
    private readonly confirmMs: number,
  ) {}

  /** Record one packet seen between the console and RSONET. */
  record(now: number): void {
    if (now - this.lastPktAt > this.silenceMs) {
      this.streakStart = now; // a gap resets the active streak
    }
    this.lastPktAt = now;
    if (now - this.streakStart >= this.confirmMs) {
      this.confirmed = true;
      this.fired = false; // (re)connected → rearm for the next drop
    }
  }

  /** True exactly once when a confirmed session goes silent (dropped). */
  poll(now: number): boolean {
    if (this.confirmed && !this.fired && now - this.lastPktAt >= this.silenceMs) {
      this.fired = true;
      this.confirmed = false;
      return true;
    }
    return false;
  }

  /** True while a confirmed session is still seeing RSONET traffic (not yet
   *  silent) — i.e. the console is in a live RDO session right now. Distinct from
   *  poll(), which fires once on the drop transition. */
  isActive(now: number): boolean {
    return this.confirmed && now - this.lastPktAt < this.silenceMs;
  }
}
