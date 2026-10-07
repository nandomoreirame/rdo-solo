//! Request-side auth helpers for the API routes. The session cookie is the same
//! one the WebSocket upgrade checks in server.ts.

import type { NextRequest } from "next/server";
import { getConfig, SESSION_COOKIE } from "./config";
import { verifySession } from "./session";

export function isAuthed(req: NextRequest): boolean {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return verifySession(getConfig().sessionSecret, token) !== null;
}

/** Rate-limit key for PIN attempts. The app runs on a bare Node server with no
 *  trusted proxy by default, so X-Forwarded-For / X-Real-IP are client-controlled
 *  and MUST NOT be trusted — spoofing them would hand each request a fresh bucket
 *  and defeat the brute-force cap. Default to ONE global bucket; only honour the
 *  forwarded headers when RDO_TRUST_PROXY=1 (behind a proxy that actually sets them). */
export function clientIp(req: NextRequest): string {
  if (!getConfig().trustProxy) return "global";
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}
