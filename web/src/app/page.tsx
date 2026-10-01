"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { formatUptime, soloGate, type PanelStatus } from "@/lib/status";

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
  const [live, setLive] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [forced, setForced] = useState(false);
  const [clean, setClean] = useState(false);
  useEffect(() => {
    try {
      setClean(localStorage.getItem("rdo_clean") === "1");
    } catch {
      /* storage may be unavailable */
    }
  }, []);
  const toggleClean = useCallback(() => {
    setClean((c) => {
      const next = !c;
      try {
        localStorage.setItem("rdo_clean", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

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

  async function toggle() {
    if (!status || busy) return;
    setBusy(true);
    setErr("");
    const action = status.solo ? "off" : "on";
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

  const solo = !!status?.solo;
  const h = status?.health;
  const gate = soloGate(status);
  const gateBlocked = !solo && gate.blocked;
  const peers = status?.peers ?? [];
  const uptime =
    solo && status?.since_epoch ? formatUptime(now - status.since_epoch * 1000) : "—";

  let warn: { text: string; soft?: boolean } | null = null;
  if (h?.ip_mismatch) warn = { text: "⚠ console está em outro IP — o filtro mira outro endereço" };
  else if (solo && h?.console_present && h.gateway_pkts === 0)
    warn = { text: "⚠ o console não passa pelo gateway (bloqueio sem efeito)" };
  else if (h?.console_ipv6) warn = { text: "⚠ Xbox com IPv6 — o filtro não cobre IPv6", soft: true };

  return (
    <main className="wrap">
      {solo && <div className="solo-frame" aria-hidden="true" />}
      <div className="brand">
        <h1>rdo-solo</h1>
        <span className="ip">console: {status?.console_label || status?.console_ip || "—"}</span>
      </div>

      {status?.dropped_at && now - status.dropped_at < 120_000 && (
        <div className="drop">
          ⚠ SESSÃO CAIU há {formatUptime(now - status.dropped_at)}
          {!solo && " — solo desligado, pode reconectar"}
        </div>
      )}

      <div className={`card ${solo ? "solo" : ""}`}>
        <button
          className={`toggle ${solo ? "on" : "off"}`}
          onClick={toggle}
          disabled={busy || !status || (gateBlocked && !forced)}
        >
          {busy ? "…" : solo ? "DESLIGAR MODO SOLO" : "LIGAR MODO SOLO"}
        </button>
        <p className="state">
          <b className={solo ? "on" : "off"}>{solo ? "SOLO ATIVO" : "SOLO INATIVO"}</b>
          {solo ? `há ${uptime}` : "jogando normalmente"}
        </p>
        {!solo && status?.alone_ms != null && (
          <p className="alone">
            Tempo sozinho na sessão: <b>{formatUptime(status.alone_ms)}</b>
          </p>
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

      {!clean && (
        <>
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
              <div className="k">{solo ? "tentando entrar (bloqueados)" : "na sua sessão"}</div>
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
        </>
      )}

      <div className="conn">
        {live ? <span className="live">● ao vivo</span> : <span className="down">● reconectando…</span>}
        {" · "}
        <button type="button" className="clean-toggle" onClick={toggleClean}>
          {clean ? "modo completo" : "modo limpo"}
        </button>
        {err && <div className="err">{err}</div>}
      </div>
    </main>
  );
}
