"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { formatUptime, soloGate, type PanelStatus, type Mode } from "@/lib/status";
import {
  MOCK,
  initialMock,
  mockSetMode,
  mockCapture,
  mockClearSquad,
  mockRemoveSquadIp,
  mockPeersJoin,
} from "@/lib/mockStatus";
import { enteredWhileAlone } from "@/lib/sessionAlert";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Phase = "loading" | "login" | "ready";

interface WsMessage {
  type?: string;
  data?: PanelStatus;
}

/** 2-letter country code -> flag emoji ("" if unknown). */
function flag(cc: string): string {
  if (!/^[A-Za-z]{2}$/.test(cc)) return "";
  return cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

/** Shared outer-container classes (single column, centered, ~480px). */
const WRAP =
  "mx-auto flex min-h-[100dvh] max-w-[480px] flex-col justify-center gap-[18px] px-4 pt-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]";

type UiState = "solo" | "squad" | "players" | "none";

/** State border color shared by the frame and every card. */
function stateBorderClass(s: UiState): string {
  if (s === "solo") return "border-solo";
  if (s === "squad") return "border-bando";
  if (s === "players") return "border-ok";
  return "border-border";
}

/** Inset ring, used on the controls card to echo the active state. */
function stateRingClass(s: UiState): string {
  if (s === "solo") return "ring-1 ring-inset ring-solo";
  if (s === "squad") return "ring-1 ring-inset ring-bando";
  if (s === "players") return "ring-1 ring-inset ring-ok";
  return "";
}

/** Full-viewport frame color + inset glow per state. */
function frameClass(s: UiState): string {
  if (s === "solo")
    return "border-solo shadow-[inset_0_0_0_1px_rgba(255,140,0,0.35),inset_0_0_26px_rgba(255,140,0,0.12)]";
  if (s === "squad")
    return "border-bando shadow-[inset_0_0_0_1px_rgba(47,123,255,0.35),inset_0_0_26px_rgba(47,123,255,0.12)]";
  // players
  return "border-ok shadow-[inset_0_0_0_1px_rgba(53,199,89,0.35),inset_0_0_26px_rgba(53,199,89,0.12)]";
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<PanelStatus | null>(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [, setLive] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [forced, setForced] = useState(false);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  const [pulseUntil, setPulseUntil] = useState(0);
  const prevPeersCountRef = useRef<number | null>(null);
  const seededAlertRef = useRef(false);
  // Auto-dismiss the capture feedback after 4s.
  useEffect(() => {
    if (!captureMsg) return;
    const t = setTimeout(() => setCaptureMsg(null), 4000);
    return () => clearTimeout(t);
  }, [captureMsg]);
  // Border alert: pulse when, in Normal mode, the session goes from you alone to
  // a player entering. Seeds the baseline on first observation so opening the
  // page with players already present does not pulse.
  useEffect(() => {
    if (!status) return;
    const count = status.peers?.length ?? 0;
    const prev = prevPeersCountRef.current;
    prevPeersCountRef.current = count;
    if (status.mode !== "off" || !seededAlertRef.current) {
      seededAlertRef.current = true;
      return;
    }
    if (enteredWhileAlone(prev ?? count, count)) setPulseUntil(Date.now() + 6000);
  }, [status]);
  // DEV-ONLY (mock): stay alone for 30s counting up, then players enter — so the
  // border alert (pulse + green frame) can be seen locally without the gateway.
  useEffect(() => {
    if (!MOCK) return;
    let elapsed = 0;
    const iv = setInterval(() => {
      elapsed += 1000;
      if (elapsed < 30_000) {
        setStatus((s) => (s ? { ...s, alone_ms: elapsed } : s));
      } else {
        clearInterval(iv);
        setStatus((s) => (s ? mockPeersJoin(s) : s));
      }
    }, 1000);
    return () => clearInterval(iv);
  }, []);
  const wsRef = useRef<WebSocket | null>(null);
  const mounted = useRef(true);
  const readyRef = useRef(false);

  // The mode we just asked the gateway for. The monitor only re-reads the mode
  // on its 4s poll, so between our request and the next poll it emits WS frames
  // carrying the OLD mode. While a change is pending we keep the expected mode
  // and ignore those stale frames, so the optimistic flip doesn't revert.
  const expectedModeRef = useRef<Mode | null>(null);
  const expectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearExpected = useCallback(() => {
    expectedModeRef.current = null;
    if (expectedTimerRef.current) {
      clearTimeout(expectedTimerRef.current);
      expectedTimerRef.current = null;
    }
  }, []);
  const armExpected = useCallback((m: Mode) => {
    expectedModeRef.current = m;
    if (expectedTimerRef.current) clearTimeout(expectedTimerRef.current);
    // Safety valve: never ignore the server indefinitely if it never converges.
    expectedTimerRef.current = setTimeout(() => {
      expectedModeRef.current = null;
      expectedTimerRef.current = null;
    }, 10_000);
  }, []);

  const connectWs = useCallback(() => {
    if (wsRef.current || !readyRef.current) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => {
      if (mounted.current) setLive(true);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsMessage;
        if (msg.type !== "status" || !msg.data) return;
        const data = msg.data;
        const exp = expectedModeRef.current;
        if (exp !== null && data.mode !== exp) {
          // Change still propagating: keep the expected mode and our running
          // uptime, take every other live field (peers, blocked, health).
          setStatus((prev) => (prev ? { ...data, mode: exp, since_epoch: prev.since_epoch } : { ...data, mode: exp }));
          return;
        }
        if (exp !== null && data.mode === exp) clearExpected();
        setStatus(data);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      wsRef.current = null;
      if (!mounted.current) return;
      setLive(false);
      setTimeout(() => {
        if (mounted.current && readyRef.current) connectWs();
      }, 2000);
    };
    ws.onerror = () => ws.close();
  }, [clearExpected]);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      if (MOCK) {
        setStatus(initialMock());
        readyRef.current = true;
        setPhase("ready");
        setLive(true);
        return;
      }
      try {
        const r = await fetch("/api/status", { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as { status: PanelStatus };
          if (!mounted.current) return;
          setStatus(j.status);
          readyRef.current = true;
          setPhase("ready");
          connectWs();
        } else {
          setPhase("login");
        }
      } catch {
        setPhase("login");
      }
    })();
    return () => {
      mounted.current = false;
      wsRef.current?.close();
    };
  }, [connectWs]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (r.ok && j.ok) {
        setPin("");
        readyRef.current = true;
        const s = await fetch("/api/status", { cache: "no-store" });
        if (s.ok) setStatus(((await s.json()) as { status: PanelStatus }).status);
        setPhase("ready");
        connectWs();
      } else {
        setErr(j.error ?? "PIN incorreto");
      }
    } catch {
      setErr("erro de conexão");
    } finally {
      setBusy(false);
    }
  }

  async function postSoloAction(action: "on" | "off" | "squad") {
    if (!status || busy) return;
    const target: Mode = action === "on" ? "solo" : action === "squad" ? "squad" : "off";
    if (MOCK) {
      setStatus((s) => (s ? mockSetMode(s, target) : s));
      setForced(false);
      setCaptureMsg(null);
      return;
    }
    // Optimistic: flip the button + borders now, and remember the target so
    // stale WS frames don't revert it while the gateway catches up.
    const prevMode = status.mode;
    const prevSince = status.since_epoch;
    armExpected(target);
    setStatus((s) =>
      s
        ? { ...s, mode: target, since_epoch: target === "off" ? null : Math.floor(Date.now() / 1000) }
        : s,
    );
    setBusy(true);
    setErr("");
    setCaptureMsg(null);
    const revert = () =>
      setStatus((s) => (s ? { ...s, mode: prevMode, since_epoch: prevSince } : s));
    try {
      const r = await fetch("/api/solo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string; status?: PanelStatus };
      if (r.ok && j.ok && j.status) {
        const confirmed = j.status;
        armExpected(confirmed.mode);
        setStatus((prev) => ({
          ...confirmed,
          blocked: prev?.blocked ?? 0,
          unique_ips: prev?.unique_ips ?? 0,
        }));
        setForced(false);
      } else if (r.status === 401) {
        clearExpected();
        revert();
        readyRef.current = false;
        setPhase("login");
      } else {
        clearExpected();
        revert();
        setErr(j.error ?? "falha ao executar");
      }
    } catch {
      clearExpected();
      revert();
      setErr("erro de conexão");
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    if (!status) return;
    const current = status.mode ?? "off";
    await postSoloAction(current === "solo" ? "off" : "on");
  }

  async function toggleSquad() {
    const current = status?.mode ?? "off";
    await postSoloAction(current === "squad" ? "off" : "squad");
  }

  async function captureSquad() {
    if (busy) return;
    if (MOCK) {
      if (!status) return;
      const next = mockCapture(status);
      const flags = next.squad.ips
        .map((ip) => {
          const p = status.peers.find((pp) => pp.ip === ip);
          return p ? flag(p.cc) : "";
        })
        .filter(Boolean)
        .join(" ");
      setCaptureMsg(
        `${next.squad.ips.length} IP(s) salvos${flags ? " " + flags : ""}`,
      );
      setStatus(next);
      return;
    }
    setBusy(true);
    setErr("");
    setCaptureMsg(null);
    try {
      const r = await fetch("/api/squad", { method: "POST" });
      if (r.status === 409) {
        setCaptureMsg("Capture só no modo Normal");
        return;
      }
      if (r.status === 401) {
        readyRef.current = false;
        setPhase("login");
        return;
      }
      const j = (await r.json()) as {
        ips?: string[];
        count?: number;
        ok?: boolean;
        error?: string;
      };
      if (r.ok && Array.isArray(j.ips)) {
        const ips = j.ips as string[];
        const count = typeof j.count === "number" ? j.count : ips.length;
        const flags = ips
          .map((ip) => {
            const peer = status?.peers?.find((p) => p.ip === ip);
            return peer ? flag(peer.cc) : "";
          })
          .filter(Boolean)
          .join(" ");
        setCaptureMsg(
          flags
            ? `${count} IP(s) salvos ${flags}`
            : `${count} IP(s) salvos`,
        );
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                squad: {
                  ips,
                  captured_at: new Date().toISOString(),
                },
              }
            : prev,
        );
      } else {
        setErr(j.error ?? "falha ao capturar");
      }
    } catch {
      setErr("erro de conexão");
    } finally {
      setBusy(false);
    }
  }

  async function removeSquadIp(ip: string) {
    if (busy) return;
    if (MOCK) {
      setStatus((s) => (s ? mockRemoveSquadIp(s, ip) : s));
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/squad?ip=${encodeURIComponent(ip)}`, { method: "DELETE" });
      if (r.status === 401) {
        readyRef.current = false;
        setPhase("login");
        return;
      }
      const j = (await r.json()) as { ok?: boolean; ips?: string[]; error?: string };
      if (r.ok && j.ok && Array.isArray(j.ips)) {
        const ips = j.ips;
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                squad: { ips, captured_at: ips.length === 0 ? null : prev.squad.captured_at },
              }
            : prev,
        );
      } else {
        setErr(j.error ?? "falha ao remover");
      }
    } catch {
      setErr("erro de conexão");
    } finally {
      setBusy(false);
    }
  }

  async function clearSavedSquad() {
    if (busy) return;
    if (MOCK) {
      setStatus((s) => (s ? mockClearSquad(s) : s));
      return;
    }
    setBusy(true);
    setErr("");
    setCaptureMsg(null);
    try {
      const r = await fetch("/api/squad", { method: "DELETE" });
      if (r.status === 401) {
        readyRef.current = false;
        setPhase("login");
        return;
      }
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (r.ok && j.ok) {
        setStatus((prev) =>
          prev ? { ...prev, squad: { ips: [], captured_at: null } } : prev,
        );
      } else {
        setErr(j.error ?? "falha ao limpar");
      }
    } catch {
      setErr("erro de conexão");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "loading") {
    return (
      <main className={WRAP}>
        <p className="text-center text-xs text-muted-foreground">carregando…</p>
      </main>
    );
  }

  if (phase === "login") {
    return (
      <main className={WRAP}>
        <form className="my-auto flex flex-col gap-4 text-center" onSubmit={login}>
          <div className="flex items-baseline justify-center gap-2">
            <h1 className="text-xl font-semibold tracking-wide">rdo-solo</h1>
          </div>
          <p className="text-muted-foreground">digite o PIN para controlar o modo solo</p>
          <Input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            autoFocus
            className="h-auto rounded-xl py-4 text-center text-2xl tracking-[0.4em] md:text-2xl"
          />
          <Button
            type="submit"
            disabled={busy || pin.length === 0}
            className="h-auto rounded-xl bg-bando py-4 text-base font-bold text-bando-foreground hover:bg-bando/90"
          >
            {busy ? "verificando…" : "entrar"}
          </Button>
          <div className="min-h-[18px] text-sm text-destructive">{err}</div>
        </form>
      </main>
    );
  }

  const mode = status?.mode ?? "off";
  const squad = status?.squad ?? { ips: [], captured_at: null };
  const h = status?.health;
  const gate = soloGate(status);
  const gateBlocked = mode === "off" && gate.blocked;
  const peers = status?.peers ?? [];
  const peerByIp = new Map(peers.map((p) => [p.ip, p]));
  const squadActive = mode === "squad";
  const filterOn = mode !== "off";
  const playersPresent = mode === "off" && peers.length > 0;
  const framePulsing = playersPresent && pulseUntil > now;
  // Drives the state color shared by the frame and every card border.
  const uiState: UiState = squadActive ? "squad" : mode === "solo" ? "solo" : playersPresent ? "players" : "none";
  // Modes are mutually exclusive: one active disables the other's switch.
  const soloDisabled = busy || !status || squadActive || (gateBlocked && !forced);
  const bandoDisabled = busy || !status || mode === "solo";
  const emptySquadWarn = squadActive && squad.ips.length === 0;
  const uptime =
    filterOn && status?.since_epoch
      ? formatUptime(now - status.since_epoch * 1000)
      : "—";
  const capturedLabel = squad.captured_at
    ? (() => {
        const t = Date.parse(squad.captured_at);
        return Number.isFinite(t) ? new Date(t).toLocaleString() : squad.captured_at;
      })()
    : null;

  let warn: { text: string; soft?: boolean } | null = null;
  if (h?.ip_mismatch) warn = { text: "⚠ console está em outro IP — o filtro mira outro endereço" };
  else if (filterOn && h?.console_present && h.gateway_pkts === 0)
    warn = { text: "⚠ o console não passa pelo gateway (bloqueio sem efeito)" };
  else if (h?.console_ipv6) warn = { text: "⚠ Xbox com IPv6 — o filtro não cobre IPv6", soft: true };

  const softAlert =
    "rounded-lg border border-solo/40 bg-solo/10 px-3 py-2.5 text-sm text-[#ffd39b]";
  const hardAlert =
    "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-[#ffb4ae]";
  const sectionLabel =
    "text-xs font-medium uppercase tracking-wide text-muted-foreground";

  return (
    <main className={WRAP} data-state={uiState}>
      {uiState !== "none" && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none fixed inset-[5px] z-50 rounded-lg border-[3px] md:inset-[10px]",
            frameClass(uiState),
            (filterOn || (uiState === "players" && framePulsing)) && "animate-frame-pulse",
          )}
        />
      )}

      {status?.dropped_at && now - status.dropped_at < 120_000 && (
        <div className="rounded-xl bg-destructive px-4 py-3.5 text-center text-sm font-extrabold text-foreground">
          ⚠ SESSÃO CAIU há {formatUptime(now - status.dropped_at)}
          {mode === "off" && " — filtro desligado, pode reconectar"}
        </div>
      )}

      {status?.vpn ? (
        <p className="text-center text-xs text-muted-foreground tabular-nums">
          Xbox via VPN · {flag(status.vpn.cc)} {status.vpn.exit_ip}
          {status.vpn.country ? ` · ${status.vpn.country}` : ""}
        </p>
      ) : status?.vpn === null ? (
        <p className="text-center text-xs text-solo/80">Xbox sem VPN (saída direta)</p>
      ) : null}

      <section className="flex flex-col gap-3.5">
        <Card
          className={cn(
            "gap-3 p-5",
            stateBorderClass(uiState),
            filterOn ? "animate-border-pulse" : stateRingClass(uiState),
          )}
        >
          <div className="flex flex-col gap-3">
            <Button
              type="button"
              onClick={toggle}
              disabled={soloDisabled}
              aria-pressed={mode === "solo"}
              aria-busy={busy}
              aria-label={mode === "solo" ? "Desligar modo solo" : "Ligar modo solo"}
              size="lg"
              className={cn(
                "w-full rounded-xl border",
                mode === "solo"
                  ? "border-transparent bg-solo text-solo-foreground hover:bg-solo/90"
                  : "border-solo/50 bg-transparent text-solo hover:bg-solo/10",
              )}
            >
              SESSÃO SOLO
            </Button>
            <Button
              type="button"
              onClick={toggleSquad}
              disabled={bandoDisabled}
              aria-pressed={squadActive}
              aria-busy={busy}
              aria-label={squadActive ? "Parar de isolar o bando" : "Isolar o bando"}
              size="lg"
              className={cn(
                "w-full rounded-xl border",
                squadActive
                  ? "border-transparent bg-bando text-bando-foreground hover:bg-bando/90"
                  : "border-bando/50 bg-transparent text-bando hover:bg-bando/10",
              )}
            >
              SESSÃO EM BANDO
            </Button>
          </div>
          <p className="min-h-5 text-center text-sm tabular-nums text-muted-foreground">
            {mode === "solo" || squadActive
              ? `há ${uptime}`
              : status?.alone_ms != null
                ? `sozinho ${formatUptime(status.alone_ms)}`
                : " "}
          </p>
          {emptySquadWarn && (
            <div className={softAlert} role="status">
              Bando vazio: isso expulsa todos os players (só os relays ficam)
            </div>
          )}
          {gateBlocked && (
            <div className={softAlert}>
              {gate.reason}{" "}
              {!forced && (
                <button
                  type="button"
                  className="cursor-pointer bg-transparent p-0 font-[inherit] text-bando underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  onClick={() => setForced(true)}
                >
                  ligar mesmo assim
                </button>
              )}
            </div>
          )}
          {warn && <div className={warn.soft ? softAlert : hardAlert}>{warn.text}</div>}
        </Card>
      </section>

      <aside id="panel" className="flex flex-col gap-3.5" aria-label="Informações">
        {squad.ips.length > 0 && (
          <Card className={cn("gap-3 p-5", stateBorderClass(uiState), filterOn && "animate-border-pulse")}>
            <div className="flex items-center justify-between gap-2">
              <div className={sectionLabel}>Bando salvo</div>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-muted-foreground underline hover:text-destructive"
                onClick={clearSavedSquad}
                disabled={busy}
                aria-label="Limpar bando salvo"
              >
                limpar
              </Button>
            </div>
            {capturedLabel && (
              <p className="text-xs text-muted-foreground">capturado: {capturedLabel}</p>
            )}
            <ul className="flex flex-col gap-1.5">
              {squad.ips.map((ip) => {
                const peer = peerByIp.get(ip);
                return (
                  <li key={ip} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 truncate text-foreground">
                      {peer ? (
                        <>
                          {flag(peer.cc)} {peer.country || "país desconhecido"}
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                    <span className="text-muted-foreground tabular-nums">{ip}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-5 shrink-0 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => removeSquadIp(ip)}
                      disabled={busy}
                      aria-label={`Remover ${ip} do bando`}
                      title="remover do bando"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {peers.length > 0 && (
          <Card className={cn("gap-3 p-5", stateBorderClass(uiState), filterOn && "animate-border-pulse")}>
            <div className={sectionLabel}>
              {filterOn ? "tentando entrar (bloqueados)" : "na sua sessão"}
            </div>
            <ul className="flex flex-col gap-1.5">
              {peers.slice(0, 10).map((p) => (
                <li key={p.ip} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate text-foreground">
                    {flag(p.cc)} {p.country || "país desconhecido"}
                  </span>
                  <span className="text-muted-foreground tabular-nums">{p.ip}</span>
                  <span className="min-w-7 text-right text-muted-foreground tabular-nums">
                    {p.count}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex flex-col items-center gap-2 border-t border-border pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={captureSquad}
                disabled={busy || mode !== "off"}
                aria-label="Capturar IPs dos peers ativos"
              >
                Capturar IPs
              </Button>
              {captureMsg && (
                <p className="text-center text-sm text-ok" role="status">
                  {captureMsg}
                </p>
              )}
            </div>
          </Card>
        )}
      </aside>

      {err && (
        <div className="text-center text-xs text-muted-foreground">
          <div className="min-h-[18px] text-sm text-destructive">{err}</div>
        </div>
      )}
    </main>
  );
}
