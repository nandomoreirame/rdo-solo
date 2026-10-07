//! A tiny in-memory sliding-window rate limiter, used to throttle PIN attempts
//! per client IP. Process-local (resets on restart), which is fine for one gateway.

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Drop keys whose timestamps have all aged out, so the map stays bounded. */
  private prune(now: number): void {
    for (const [k, ts] of this.hits) {
      if (!ts.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
  }

  /** Record an attempt for `key`; return false when it exceeds the window budget. */
  allow(key: string, now: number = Date.now()): boolean {
    this.prune(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Clear the budget for a key (e.g. after a successful login). */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Number of tracked keys (introspection / tests). */
  get size(): number {
    return this.hits.size;
  }
}
