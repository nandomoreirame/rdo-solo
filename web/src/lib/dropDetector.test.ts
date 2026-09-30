import { describe, it, expect } from "vitest";
import { DropDetector } from "./dropDetector";

describe("DropDetector", () => {
  it("fires once after a confirmed session goes silent", () => {
    const d = new DropDetector(15_000, 8_000);
    for (let t = 0; t <= 10_000; t += 1_000) d.record(t); // 10s of traffic
    expect(d.poll(10_000)).toBe(false); // still active
    expect(d.poll(20_000)).toBe(false); // idle 10s < 15s
    expect(d.poll(26_000)).toBe(true); // idle 16s >= 15s → drop
    expect(d.poll(30_000)).toBe(false); // only fires once
  });

  it("does not fire for a brief blip that never confirmed a session", () => {
    const d = new DropDetector(15_000, 8_000);
    d.record(0);
    d.record(2_000); // only 2s of traffic < 8s confirm window
    expect(d.poll(20_000)).toBe(false);
  });

  it("rearms and fires again after a reconnect", () => {
    const d = new DropDetector(15_000, 8_000);
    for (let t = 0; t <= 10_000; t += 1_000) d.record(t);
    expect(d.poll(26_000)).toBe(true); // first drop
    for (let t = 30_000; t <= 40_000; t += 1_000) d.record(t); // reconnect
    expect(d.poll(56_000)).toBe(true); // second drop
  });
});

describe("DropDetector.isActive", () => {
  it("is active while a confirmed session keeps seeing traffic", () => {
    const d = new DropDetector(15_000, 8_000);
    for (let t = 0; t <= 10_000; t += 1_000) d.record(t); // 10s of traffic → confirmed
    expect(d.isActive(10_500)).toBe(true);
  });

  it("is not active before a session is confirmed", () => {
    const d = new DropDetector(15_000, 8_000);
    d.record(0);
    d.record(2_000); // only 2s of traffic < 8s confirm window
    expect(d.isActive(2_500)).toBe(false);
  });

  it("is not active once a confirmed session has gone silent", () => {
    const d = new DropDetector(15_000, 8_000);
    for (let t = 0; t <= 10_000; t += 1_000) d.record(t);
    expect(d.isActive(30_000)).toBe(false); // 20s idle >= 15s silence
  });
});
