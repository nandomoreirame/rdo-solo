import { describe, it, expect } from "vitest";
import { isValidIp, parseSquadList, formatSquadList } from "./squad";

describe("squad helpers", () => {
  it("validates IPv4 and rejects junk/injection", () => {
    expect(isValidIp("45.184.53.184")).toBe(true);
    expect(isValidIp("999.1.1.1")).toBe(false);
    expect(isValidIp("1.2.3.4; rm -rf /")).toBe(false);
    expect(isValidIp("")).toBe(false);
  });
  it("parses list, skipping comments/invalid and deduping", () => {
    const body = "# captured_at=2026-09-30T10:00:00Z\n1.2.3.4\n1.2.3.4\nbad\n5.6.7.8\n";
    expect(parseSquadList(body)).toEqual({
      capturedAt: "2026-09-30T10:00:00Z",
      ips: ["1.2.3.4", "5.6.7.8"],
    });
  });
  it("formats roundtrip", () => {
    const body = formatSquadList(["1.2.3.4"], "2026-09-30T10:00:00Z");
    expect(parseSquadList(body).ips).toEqual(["1.2.3.4"]);
  });
});
