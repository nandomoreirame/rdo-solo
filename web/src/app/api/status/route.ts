import { type NextRequest, NextResponse } from "next/server";
import { isAuthed } from "@/lib/authGuard";
import { readStatus } from "@/lib/rdo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Base snapshot used on page load (auth check + initial state). The live
// block/IP counters arrive over the WebSocket, which owns the journal tail.
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthed(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    const status = await readStatus();
    return NextResponse.json({ ok: true, status: { ...status, blocked: 0, unique_ips: 0 } });
  } catch {
    return NextResponse.json({ ok: false, error: "gateway indisponível" }, { status: 500 });
  }
}
