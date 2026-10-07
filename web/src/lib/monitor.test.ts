import { describe, it, expect } from "vitest";
import { rsonetFilter, parseBlockedCount, inNets, p2pPeerIp, aloneMs } from "./monitor";

describe("rsonetFilter", () => {
  it("builds a host-scoped OR of every RSONET net", () => {
    expect(rsonetFilter("192.168.1.250", ["192.81.240.0/21", "199.46.32.0/19"])).toBe(
      "host 192.168.1.250 and (net 192.81.240.0/21 or net 199.46.32.0/19)",
    );
  });

  it("wraps a single net in parentheses too", () => {
    expect(rsonetFilter("10.0.0.1", ["1.2.3.0/24"])).toBe("host 10.0.0.1 and (net 1.2.3.0/24)");
  });
});

describe("parseBlockedCount", () => {
  it("reads the DROP rule packet count from iptables -L RDO_LOGDROP -v -x", () => {
    const out = [
      "Chain RDO_LOGDROP (8 references)",
      "    pkts      bytes target     prot opt in     out     source               destination",
      "      21     1722 LOG        0    --  *      *       0.0.0.0/0            0.0.0.0/0            LOG",
      "    1243   233851 DROP       0    --  *      *       0.0.0.0/0            0.0.0.0/0",
    ].join("\n");
    expect(parseBlockedCount(out)).toBe(1243);
  });
  it("is 0 when there is no DROP rule", () => {
    expect(parseBlockedCount("Chain RDO_LOGDROP (0 references)\n")).toBe(0);
  });

  it("sums the count across multiple DROP rules", () => {
    const out = [
      "Chain RDO_LOGDROP (8 references)",
      " pkts bytes target     prot opt in     out     source               destination",
      "   10      100 DROP       0    --  *      *       0.0.0.0/0            0.0.0.0/0",
      "    5       50 DROP       0    --  *      *       0.0.0.0/0            0.0.0.0/0",
    ].join("\n");
    expect(parseBlockedCount(out)).toBe(15);
  });
});

describe("inNets", () => {
  it("matches an IP inside a CIDR (Rockstar relay)", () => {
    expect(inNets("192.81.245.125", ["192.81.240.0/21"])).toBe(true);
  });
  it("rejects an IP outside every CIDR", () => {
    expect(inNets("8.8.8.8", ["192.81.240.0/21", "199.46.32.0/19"])).toBe(false);
  });
});

describe("p2pPeerIp", () => {
  it("returns the non-console side of a P2P line", () => {
    expect(
      p2pPeerIp("IP 192.168.1.100.6672 > 203.0.113.9.61455: UDP, length 40", "192.168.1.100"),
    ).toBe("203.0.113.9");
  });
});

describe("aloneMs", () => {
  it("counts up while alone (solo off, no player yet)", () => {
    expect(aloneMs(true, 1000, null, 6000)).toBe(5000);
  });
  it("freezes at the moment the first player joined", () => {
    expect(aloneMs(true, 1000, 4000, 9000)).toBe(3000);
  });
  it("is null while solo is on", () => {
    expect(aloneMs(false, 1000, null, 6000)).toBeNull();
  });
});
