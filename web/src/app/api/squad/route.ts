import { type NextRequest, NextResponse } from "next/server";
import { isAuthed } from "@/lib/authGuard";
import { monitor } from "@/lib/monitor";
import { captureSquad, clearSquad, readSquad, readStatus } from "@/lib/rdo";
import { isValidIp } from "@/lib/squad";

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

    const ips = [
      ...new Set(monitor.snapshot().peers.map((p) => p.ip).filter(isValidIp)),
    ];
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

  try {
    await clearSquad();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { ok: false, error: "falha ao executar no gateway" },
      { status: 500 },
    );
  }
}
