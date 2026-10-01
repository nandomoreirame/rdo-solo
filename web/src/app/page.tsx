"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { formatUptime, soloGate, type PanelStatus } from "@/lib/status";
import { MOCK, initialMock, mockSetMode, mockCapture, mockClearSquad } from "@/lib/mockStatus";
import { readPanelOpen, writePanelOpen } from "@/lib/panelState";

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

export default function Home() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<PanelStatus | null>(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [, setLive] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [forced, setForced] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  useEffect(() => {
    setPanelOpen(readPanelOpen(true));
  }, []);
  // Auto-dismiss the capture feedback after 4s.
  useEffect(() => {
    if (!captureMsg) return;
    const t = setTimeout(() => setCaptureMsg(null), 4000);
    return () => clearTimeout(t);
  }, [captureMsg]);
  const togglePanel = useCallback(() => {
    setPanelOpen((v) => {
      const next = !v;
      writePanelOpen(next);
      return next;
    });
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && panelOpen) togglePanel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, togglePanel]);

  const wsRef = useRef<WebSocket | null>(null);
  const mounted = useRef(true);
  const readyRef = useRef(false);

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
        if (msg.type === "status" && msg.data) setStatus(msg.data);
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
  }, []);

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
    if (MOCK) {
      const mode = action === "on" ? "solo" : action === "squad" ? "squad" : "off";
      setStatus((s) => (s ? mockSetMode(s, mode) : s));
      setForced(false);
      setCaptureMsg(null);
      return;
    }
    setBusy(true);
    setErr("");
    setCaptureMsg(null);
    try {
      const r = await fetch("/api/solo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string; status?: PanelStatus };
      if (r.ok && j.ok && j.status) {
        setStatus((prev) => ({
          ...(j.status as PanelStatus),
          blocked: prev?.blocked ?? 0,
          unique_ips: prev?.unique_ips ?? 0,
        }));
        setForced(false);
      } else if (r.status === 401) {
        readyRef.current = false;
        setPhase("login");
      } else {
        setErr(j.error ?? "falha ao executar");
      }
    } catch {
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
      <main className="wrap">
        <p className="conn">carregando…</p>
      </main>
    );
  }

  if (phase === "login") {
    return (
      <main className="wrap">
        <form className="login" onSubmit={login}>
          <div className="brand" style={{ justifyContent: "center" }}>
            <h1>rdo-solo</h1>
          </div>
          <p>digite o PIN para controlar o modo solo</p>
          <input
            className="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            autoFocus
          />
          <button className="btn" type="submit" disabled={busy || pin.length === 0}>
            {busy ? "verificando…" : "entrar"}
          </button>
          <div className="err">{err}</div>
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

  return (
    <main className="wrap">
      {filterOn && (
        <div className={`solo-frame${squadActive ? " squad" : ""}`} aria-hidden="true" />
      )}
      <button
        type="button"
        className="panel-toggle"
        aria-expanded={panelOpen}
        aria-controls="panel"
        onClick={togglePanel}
      >
        {panelOpen ? "fechar" : "painel"}
      </button>

      {status?.dropped_at && now - status.dropped_at < 120_000 && (
        <div className="drop">
          ⚠ SESSÃO CAIU há {formatUptime(now - status.dropped_at)}
          {mode === "off" && " — filtro desligado, pode reconectar"}
        </div>
      )}

      <section className="controls">
      <div className={`card ${mode === "solo" ? "solo" : ""} ${squadActive ? "squad" : ""}`}>
        <div className="btns">
          <button
            type="button"
            className={`toggle ${mode === "solo" ? "on" : "off"}`}
            onClick={toggle}
            disabled={busy || !status || (gateBlocked && !forced)}
            aria-pressed={mode === "solo"}
            aria-label={mode === "solo" ? "Desligar modo solo" : "Ligar modo solo"}
          >
            {busy ? "…" : "MODO SOLO"}
          </button>
          <button
            type="button"
            className={`toggle squad-toggle ${squadActive ? "on" : "off"}`}
            onClick={toggleSquad}
            disabled={busy || !status}
            aria-pressed={squadActive}
            aria-label={squadActive ? "Parar de isolar o bando" : "Isolar o bando"}
          >
            {busy ? "…" : "ISOLAR BANDO"}
          </button>
        </div>
        <p className="ctl-meta">
          {mode === "solo" || squadActive
            ? `há ${uptime}`
            : status?.alone_ms != null
              ? `sozinho ${formatUptime(status.alone_ms)}`
              : " "}
        </p>
        {emptySquadWarn && (
          <div className="squad-warn" role="status">
            Bando vazio: isso expulsa todos os players (só os relays ficam)
          </div>
        )}
        {gateBlocked && (
          <div className="warn soft">
            {gate.reason}{" "}
            {!forced && (
              <button type="button" className="force" onClick={() => setForced(true)}>
                ligar mesmo assim
              </button>
            )}
          </div>
        )}
        {warn && <div className={`warn ${warn.soft ? "soft" : ""}`}>{warn.text}</div>}
      </div>
      </section>

      <aside id="panel" className="panel" data-open={panelOpen} aria-label="Informações">
          <div className="card squad-list">
            <div className="squad-list-head">
              <div className="k">Bando salvo</div>
              <div className="squad-actions">
                <button
                  type="button"
                  className="squad-capture"
                  onClick={captureSquad}
                  disabled={busy || mode !== "off"}
                  aria-label="Capturar IPs dos peers ativos"
                >
                  Capturar IPs
                </button>
                <button
                  type="button"
                  className="squad-clear"
                  onClick={clearSavedSquad}
                  disabled={busy || (squad.ips.length === 0 && !squad.captured_at)}
                  aria-label="Limpar bando salvo"
                >
                  limpar
                </button>
              </div>
            </div>
            {capturedLabel && <p className="squad-captured">capturado: {capturedLabel}</p>}
            {squad.ips.length === 0 ? (
              <p className="squad-empty">nenhum IP salvo</p>
            ) : (
              <ul className="peerlist">
                {squad.ips.map((ip) => {
                  const peer = peerByIp.get(ip);
                  return (
                    <li key={ip}>
                      <span className="pc">
                        {peer ? (
                          <>
                            {flag(peer.cc)} {peer.country || "país desconhecido"}
                          </>
                        ) : (
                          "—"
                        )}
                      </span>
                      <span className="pip">{ip}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {captureMsg && (
              <p className="squad-msg" role="status">
                {captureMsg}
              </p>
            )}
          </div>

          <div className="grid">
            <div className="metric">
              <div className="k">bloqueios</div>
              <div className="v">{status?.blocked ?? 0}</div>
            </div>
            <div className="metric">
              <div className="k">IPs distintos</div>
              <div className="v">{status?.unique_ips ?? 0}</div>
            </div>
          </div>

          {peers.length > 0 && (
            <div className="card">
              <div className="k">
                {filterOn ? "tentando entrar (bloqueados)" : "na sua sessão"}
              </div>
              <ul className="peerlist">
                {peers.slice(0, 10).map((p) => (
                  <li key={p.ip}>
                    <span className="pc">
                      {flag(p.cc)} {p.country || "país desconhecido"}
                    </span>
                    <span className="pip">{p.ip}</span>
                    <span className="pn">{p.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card">
            <div className="health">
              <span className={`dot ${h?.forwarding ? "ok" : ""}`}>encaminha</span>
              <span className={`dot ${h?.redirects_ok ? "ok" : ""}`}>redirec.</span>
              <span className={`dot ${h?.route_rule ? "ok" : ""}`}>rota</span>
              <span className={`dot ${h?.console_present && !h?.ip_mismatch ? "ok" : ""}`}>console</span>
            </div>
          </div>
      </aside>

      <div className="panel-backdrop" hidden={!panelOpen} onClick={togglePanel} />

      {err && (
        <div className="conn">
          <div className="err">{err}</div>
        </div>
      )}
    </main>
  );
}
