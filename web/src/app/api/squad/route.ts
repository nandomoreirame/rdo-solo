import { type NextRequest, NextResponse } from "next/server";
import { isAuthed } from "@/lib/authGuard";
import { captureSquad, clearSquad, readSquad, readStatus } from "@/lib/rdo";
import { readSessionPeers } from "@/lib/sessionPeers";
import { isValidIp, removeIp } from "@/lib/squad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthed(req)) {
    return NextResponse.json({ ok: false, error: "não autenticado" }, { status: 401 });
  }

  try {
    const status = await readStatus();
    if (status.mode !== "off") {
      return NextResponse.json({ error: "capture only in Normal mode" }, { status: 409 });
    }

    // The session peers are published by the RUNNING monitor (server.ts) to the
    // cross-instance bridge; this route's own monitor instance is never started
    // and would always report zero. See lib/sessionPeers.ts.
    const ips = [...new Set(readSessionPeers().filter(isValidIp))];
    // captureSquad rejects empty lists; clearSquad still writes an empty squad.
    if (ips.length === 0) {
      await clearSquad();
    } else {
      await captureSquad(ips);
    }
    return NextResponse.json({ ips, count: ips.length });
  } catch {
    return NextResponse.json(
      { ok: false, error: "falha ao executar no gateway" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthed(req)) {
    return NextResponse.json({ ok: false, error: "não autenticado" }, { status: 401 });
  }

  try {
    return NextResponse.json({ ips: await readSquad() });
  } catch {
    return NextResponse.json(
      { ok: false, error: "falha ao executar no gateway" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  if (!isAuthed(req)) {
    return NextResponse.json({ ok: false, error: "não autenticado" }, { status: 401 });
  }

  const ip = req.nextUrl.searchParams.get("ip");
  if (ip !== null && !isValidIp(ip)) {
    return NextResponse.json({ ok: false, error: "IP inválido" }, { status: 400 });
  }

  try {
    // No ip → clear the whole squad (original behavior). With a valid ip →
    // remove just that one: re-set the remaining list, or clear if it empties.
    if (ip === null) {
      await clearSquad();
      return NextResponse.json({ ok: true, ips: [] });
    }
    const remaining = removeIp(await readSquad(), ip);
    if (remaining.length === 0) {
      await clearSquad();
    } else {
      await captureSquad(remaining);
    }
    return NextResponse.json({ ok: true, ips: remaining });
  } catch {
    return NextResponse.json(
      { ok: false, error: "falha ao executar no gateway" },
      { status: 500 },
    );
  }
}
