import { describe, it, expect } from "vitest";
import { peerIp } from "./monitor";

describe("peerIp", () => {
  const line =
    "IN=eth0 OUT=eth0 SRC=203.0.113.10 DST=192.168.1.250 LEN=60 PROTO=UDP SPT=61455 DPT=61455";

  it("returns the non-console side (inbound)", () => {
    expect(peerIp(line, "192.168.1.250")).toBe("203.0.113.10");
  });

  it("returns the destination when the console is the source", () => {
    const out = "SRC=192.168.1.250 DST=203.0.113.20 PROTO=UDP";
    expect(peerIp(out, "192.168.1.250")).toBe("203.0.113.20");
  });

  it("returns null when there is no address pair", () => {
    expect(peerIp("nothing here", "192.168.1.250")).toBeNull();
  });
});
