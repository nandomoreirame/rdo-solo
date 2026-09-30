//! Request-side auth helpers for the API routes. The session cookie is the same
//! one the WebSocket upgrade checks in server.ts.

import type { NextRequest } from "next/server";
import { getConfig, SESSION_COOKIE } from "./config";
import { verifySession } from "./session";

export function isAuthed(req: NextRequest): boolean {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return verifySession(getConfig().sessionSecret, token) !== null;
}

/** Best-effort client IP for rate-limiting PIN attempts. */
export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}
