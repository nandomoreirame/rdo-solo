import { describe, it, expect } from "vitest";
import { signSession, verifySession, verifyPin } from "./session";

const SECRET = "test-secret-abc";

describe("session", () => {
  it("signs and verifies a fresh token", () => {
    const t = signSession(SECRET, 60_000, 1000);
    const p = verifySession(SECRET, t, 2000);
    expect(p).not.toBeNull();
    expect(p!.exp).toBe(61_000);
  });

  it("rejects a tampered token", () => {
    const t = signSession(SECRET, 60_000, 1000);
    const bad = t.slice(0, -2) + (t.endsWith("aa") ? "bb" : "aa");
    expect(verifySession(SECRET, bad, 2000)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const t = signSession("other", 60_000, 1000);
    expect(verifySession(SECRET, t, 2000)).toBeNull();
  });

  it("rejects an expired token", () => {
    const t = signSession(SECRET, 1000, 1000);
    expect(verifySession(SECRET, t, 5000)).toBeNull();
  });

  it("rejects empty or malformed tokens", () => {
    expect(verifySession(SECRET, "")).toBeNull();
    expect(verifySession(SECRET, null)).toBeNull();
    expect(verifySession(SECRET, "nodot")).toBeNull();
    expect(verifySession(SECRET, ".onlymac")).toBeNull();
  });
});

describe("verifyPin", () => {
  it("accepts the exact PIN and rejects wrong ones", () => {
    expect(verifyPin("2468", "2468")).toBe(true);
    expect(verifyPin("2468", "2469")).toBe(false);
    expect(verifyPin("2468", "246")).toBe(false);
    expect(verifyPin("2468", "24688")).toBe(false);
  });

  it("rejects when the configured PIN is empty", () => {
    expect(verifyPin("", "")).toBe(false);
    expect(verifyPin("", "anything")).toBe(false);
  });
});
