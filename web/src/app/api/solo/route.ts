import { type NextRequest, NextResponse } from "next/server";
import { isAuthed } from "@/lib/authGuard";
import { toggleSolo, readStatus } from "@/lib/rdo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthed(req)) {
    return NextResponse.json({ ok: false, error: "não autenticado" }, { status: 401 });
  }

  let action = "";
  try {
    action = String(((await req.json()) as { action?: unknown })?.action ?? "");
  } catch {
    // handled by the validation below
  }
  if (action !== "on" && action !== "off") {
    return NextResponse.json({ ok: false, error: "ação inválida" }, { status: 400 });
  }

  try {
    await toggleSolo(action === "on");
    const status = await readStatus();
    return NextResponse.json({ ok: true, status });
  } catch {
    // Never leak the gateway command/stack to the client.
    return NextResponse.json(
      { ok: false, error: "falha ao executar no gateway" },
      { status: 500 },
    );
  }
}
