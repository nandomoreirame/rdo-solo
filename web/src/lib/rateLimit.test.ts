import { describe, it, expect } from "vitest";
import { RateLimiter } from "./rateLimit";

describe("RateLimiter", () => {
  it("allows up to max within the window, then blocks", () => {
    const rl = new RateLimiter(3, 1000);
    expect(rl.allow("ip", 0)).toBe(true);
    expect(rl.allow("ip", 100)).toBe(true);
    expect(rl.allow("ip", 200)).toBe(true);
    expect(rl.allow("ip", 300)).toBe(false);
  });

  it("frees budget once the window slides past old hits", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.allow("ip", 0)).toBe(true);
    expect(rl.allow("ip", 500)).toBe(true);
    expect(rl.allow("ip", 900)).toBe(false);
    expect(rl.allow("ip", 1600)).toBe(true); // the hit at 0 expired
  });

  it("tracks keys independently and resets", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.allow("a", 0)).toBe(true);
    expect(rl.allow("b", 0)).toBe(true);
    expect(rl.allow("a", 0)).toBe(false);
    rl.reset("a");
    expect(rl.allow("a", 0)).toBe(true);
  });

  it("evicts keys whose window has fully expired (bounded map)", () => {
    const rl = new RateLimiter(5, 1000);
    expect(rl.allow("a", 0)).toBe(true);
    expect(rl.size).toBe(1);
    // By t=2000 'a's only hit (at 0) has aged out; touching 'b' prunes 'a'.
    expect(rl.allow("b", 2000)).toBe(true);
    expect(rl.size).toBe(1);
  });
});
