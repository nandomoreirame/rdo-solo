//! Custom Node server: serves the Next app and hosts the WebSocket on the same
//! port (/ws), which App-Router Next cannot do on its own. The socket is gated
//! by the same signed session cookie the HTTP side uses, so an unauthenticated
//! client cannot even subscribe to status.

import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import { getConfig, SESSION_COOKIE } from "./src/lib/config";
import { verifySession } from "./src/lib/session";
import { monitor } from "./src/lib/monitor";

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

async function main(): Promise<void> {
  const cfg = getConfig(); // validates PIN/secret early, before we bind
  const dev = process.env.NODE_ENV !== "production";
  const app = next({ dev });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = createServer((req, res) => {
    handle(req, res, parse(req.url || "/", true));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url || "");
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!verifySession(cfg.sessionSecret, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "status", data: monitor.snapshot() }));
  });

  monitor.on("update", (snap: unknown) => {
    const msg = JSON.stringify({ type: "status", data: snap });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });
  monitor.start();

  server.listen(cfg.port, cfg.bind, () => {
    // eslint-disable-next-line no-console
    console.log(`rdo-solo-web listening on http://${cfg.bind}:${cfg.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
