export const PANEL_KEY = "rdo_panel_open";

/** Last persisted panel-open preference, or `fallback` when unavailable. */
export function readPanelOpen(fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(PANEL_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

export function writePanelOpen(open: boolean): void {
  try {
    localStorage.setItem(PANEL_KEY, open ? "1" : "0");
  } catch {
    /* private mode / blocked storage: ignore */
  }
}
