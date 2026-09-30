import { type NextRequest, NextResponse } from "next/server";
import { getConfig, SESSION_COOKIE } from "@/lib/config";
import { signSession, verifyPin } from "@/lib/session";
import { RateLimiter } from "@/lib/rateLimit";
import { clientIp } from "@/lib/authGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Throttle PIN guessing: 5 attempts per minute per client IP.
const limiter = new RateLimiter(5, 60_000);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cfg = getConfig();
  const ip = clientIp(req);
  if (!limiter.allow(ip)) {
    return NextResponse.json(
      { ok: false, error: "muitas tentativas, aguarde um minuto" },
      { status: 429 },
    );
  }

  let pin = "";
  try {
    pin = String(((await req.json()) as { pin?: unknown })?.pin ?? "");
  } catch {
    // fall through to the PIN check, which will reject an empty pin
  }

  if (!verifyPin(cfg.pin, pin)) {
    return NextResponse.json({ ok: false, error: "PIN incorreto" }, { status: 401 });
  }

  limiter.reset(ip);
  const token = signSession(cfg.sessionSecret, cfg.sessionTtlMs);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Served over plain HTTP on the LAN/Tailscale; flip to true behind TLS.
    secure: false,
    path: "/",
    maxAge: Math.floor(cfg.sessionTtlMs / 1000),
  });
  return res;
}
