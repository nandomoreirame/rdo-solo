import { describe, it, expect } from "vitest";
import { parseVpnProbe, vpnProbeArgs } from "./vpn";

describe("parseVpnProbe", () => {
  it("parses a successful ip-api response", () => {
    expect(
      parseVpnProbe(
        '{"status":"success","query":"198.44.133.115","country":"United States","countryCode":"US"}',
      ),
    ).toEqual({ exit_ip: "198.44.133.115", cc: "US", country: "United States" });
  });

  it("returns null when ip-api reports a failure", () => {
    expect(parseVpnProbe('{"status":"fail","message":"private range"}')).toBeNull();
  });

  it("returns null on malformed or empty input", () => {
    expect(parseVpnProbe("not json")).toBeNull();
    expect(parseVpnProbe("")).toBeNull();
  });

  it("returns null when the exit IP is missing or invalid", () => {
    expect(
      parseVpnProbe('{"status":"success","country":"United States","countryCode":"US"}'),
    ).toBeNull();
    expect(parseVpnProbe('{"status":"success","query":"999.1.1.1"}')).toBeNull();
  });

  it("tolerates missing country fields", () => {
    expect(parseVpnProbe('{"status":"success","query":"1.2.3.4"}')).toEqual({
      exit_ip: "1.2.3.4",
      cc: "",
      country: "",
    });
  });
});

describe("vpnProbeArgs", () => {
  it("binds curl to the given interface and targets ip-api", () => {
    const a = vpnProbeArgs("wg-vpn");
    expect(a).toContain("--interface");
    expect(a[a.indexOf("--interface") + 1]).toBe("wg-vpn");
    expect(a.some((x) => x.includes("ip-api.com"))).toBe(true);
  });
});
