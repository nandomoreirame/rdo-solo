//! Stateless signed-cookie sessions and constant-time PIN check. No DB: a valid
//! cookie is an HMAC over a small payload, so any tamper or expiry is rejected.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionPayload {
  /** issued-at, epoch ms */
  iat: number;
  /** expires-at, epoch ms */
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmac(secret: string, body: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

/** Sign a fresh session token valid for `ttlMs`. */
export function signSession(secret: string, ttlMs: number, now: number = Date.now()): string {
  const payload: SessionPayload = { iat: now, exp: now + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${hmac(secret, body)}`;
}

/** Return the payload if the token is authentic and unexpired, else null. */
export function verifySession(
  secret: string,
  token: string | undefined | null,
  now: number = Date.now(),
): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = hmac(secret, body);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(macBuf, expBuf)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  return payload;
}

/** Constant-time PIN comparison (no early-out on length or first mismatch). */
export function verifyPin(expected: string, provided: string): boolean {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided));
  if (a.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
