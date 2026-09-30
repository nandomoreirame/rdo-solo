import { describe, it, expect } from "vitest";
import { parseStatusJson, formatUptime, soloGate } from "./status";

describe("parseStatusJson", () => {
  it("parses a full snapshot", () => {
    const raw = JSON.stringify({
      solo: true,
      state: "on",
      since_epoch: 1727620000,
      console_ip: "192.168.1.250",
      console_label: "XBOX-ONE",
      health: {
        forwarding: true,
        redirects_ok: true,
        route_rule: true,
        console_present: true,
        ip_mismatch: false,
        console_ipv6: false,
        gateway_pkts: 4321,
        ok: true,
      },
    });
    const s = parseStatusJson(raw);
    expect(s.solo).toBe(true);
    expect(s.since_epoch).toBe(1727620000);
    expect(s.console_ip).toBe("192.168.1.250");
    expect(s.console_label).toBe("XBOX-ONE");
    expect(s.health.gateway_pkts).toBe(4321);
    expect(s.health.ok).toBe(true);
  });

  it("returns safe defaults on invalid JSON", () => {
    const s = parseStatusJson("not json");
    expect(s.solo).toBe(false);
    expect(s.since_epoch).toBeNull();
    expect(s.health.ok).toBe(false);
  });

  it("fills missing fields defensively", () => {
    const s = parseStatusJson(JSON.stringify({ solo: true }));
    expect(s.solo).toBe(true);
    expect(s.since_epoch).toBeNull();
    expect(s.console_ip).toBe("");
    expect(s.health.forwarding).toBe(false);
    expect(s.health.gateway_pkts).toBe(0);
  });
});

describe("formatUptime", () => {
  it("formats seconds, minutes and hours like the Rust side", () => {
    expect(formatUptime(12_000)).toBe("12s");
    expect(formatUptime(187_000)).toBe("3m07s");
    expect(formatUptime(3_720_000)).toBe("1h02m");
    expect(formatUptime(-5)).toBe("0s");
  });
});

describe("soloGate", () => {
  it("blocks enabling solo when the console is not in a session", () => {
    const g = soloGate({ session_active: false });
    expect(g.blocked).toBe(true);
    expect(g.reason).not.toBe("");
  });

  it("allows enabling solo when a session is active", () => {
    expect(soloGate({ session_active: true }).blocked).toBe(false);
  });

  it("does not block while the session state is still unknown", () => {
    expect(soloGate({}).blocked).toBe(false);
    expect(soloGate(null).blocked).toBe(false);
  });
});
