import { describe, it, expect, beforeEach, vi } from "vitest";
import { readPanelOpen, writePanelOpen, PANEL_KEY } from "./panelState";

// The node test env has no localStorage; provide a minimal in-memory stub.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

describe("panelState", () => {
  it("returns the fallback when nothing is stored", () => {
    expect(readPanelOpen(true)).toBe(true);
    expect(readPanelOpen(false)).toBe(false);
  });

  it("roundtrips the stored value", () => {
    writePanelOpen(false);
    expect(readPanelOpen(true)).toBe(false);
    writePanelOpen(true);
    expect(readPanelOpen(false)).toBe(true);
  });

  it("falls back when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readPanelOpen(true)).toBe(true);
    expect(() => writePanelOpen(false)).not.toThrow();
  });

  it("uses a stable key", () => {
    expect(PANEL_KEY).toBe("rdo_panel_open");
  });
});
