import { describe, it, expect } from "vitest";
import { enteredWhileAlone } from "./sessionAlert";

describe("enteredWhileAlone", () => {
  it("true when going from alone (0) to at least one player", () => {
    expect(enteredWhileAlone(0, 1)).toBe(true);
    expect(enteredWhileAlone(0, 4)).toBe(true);
  });
  it("false when players were already present (later arrivals don't re-alert)", () => {
    expect(enteredWhileAlone(2, 3)).toBe(false);
    expect(enteredWhileAlone(1, 1)).toBe(false);
  });
  it("false when still alone or a player left", () => {
    expect(enteredWhileAlone(0, 0)).toBe(false);
    expect(enteredWhileAlone(3, 0)).toBe(false);
  });
});
