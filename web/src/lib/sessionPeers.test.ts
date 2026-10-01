import { describe, it, expect, beforeEach } from "vitest";
import { publishSessionPeers, readSessionPeers, SESSION_PEERS_KEY } from "./sessionPeers";

describe("sessionPeers bridge", () => {
  beforeEach(() => publishSessionPeers([]));

  it("starts empty", () => {
    expect(readSessionPeers()).toEqual([]);
  });

  it("roundtrips published ips", () => {
    publishSessionPeers(["190.2.70.106", "1.2.3.4"]);
    expect(readSessionPeers()).toEqual(["190.2.70.106", "1.2.3.4"]);
  });

  it("overwrites on republish", () => {
    publishSessionPeers(["1.1.1.1"]);
    publishSessionPeers(["2.2.2.2"]);
    expect(readSessionPeers()).toEqual(["2.2.2.2"]);
  });

  // The whole point of the bridge: a value stored by one module instance is
  // visible to another via the shared process globalThis (how the running
  // monitor reaches the Next route handler, which imports a separate instance).
  it("stores on the shared globalThis under a stable Symbol.for key", () => {
    publishSessionPeers(["9.9.9.9"]);
    const g = globalThis as unknown as Record<symbol, { ips: string[] } | undefined>;
    expect(g[SESSION_PEERS_KEY]?.ips).toEqual(["9.9.9.9"]);
  });
});
