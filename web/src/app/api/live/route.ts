import { type NextRequest, NextResponse } from "next/server";
import { isAuthed } from "@/lib/authGuard";
import { readSnapshot } from "@/lib/sessionPeers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Full live snapshot (mode, uptime, peers + geo, blocked, unique_ips,
// session_active, squad, vpn, console/health). The running monitor in server.ts
// publishes it to the cross-instance bridge; this route (a separate, never-started
// monitor instance) just serves the last one. Unlike /api/status, this carries the
// live counters the WebSocket owns — used by the Noctalia bar plugin panel.
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthed(req)) {
    return NextResponse.json({ ok: false, error: "não autenticado" }, { status: 401 });
  }
  const status = readSnapshot();
  if (!status) {
    return NextResponse.json({ ok: false, error: "sem snapshot ainda" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, status });
}
