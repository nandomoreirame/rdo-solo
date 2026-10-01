import { describe, it, expect } from "vitest";
import { buildSquadSetArgs } from "./rdo";

describe("rdo squad argv", () => {
  it("builds squad-set argv from valid IPs", () => {
    expect(buildSquadSetArgs(["1.2.3.4", "5.6.7.8"])).toEqual(["squad-set", "1.2.3.4", "5.6.7.8"]);
  });
  it("throws on empty list", () => {
    expect(() => buildSquadSetArgs([])).toThrow();
  });
  it("throws on any invalid IP (no injection reaches execFile)", () => {
    expect(() => buildSquadSetArgs(["1.2.3.4", "x; rm -rf /"])).toThrow();
  });
});
