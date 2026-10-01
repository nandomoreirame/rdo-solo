#!/usr/bin/env bash
#
# deploy.sh - Build and deploy rdo-solo to the homelab gateway.
#
# Builds the Rust gateway binary (static musl) and ships three pieces to the
# homelab over SSH (Tailscale):
#   1. the Rust binary  -> /usr/local/bin/rdo-solo-tui   (root; sudo prompt)
#   2. the shell script -> /usr/local/bin/rdo-solo       (root; sudo prompt)
#   3. the web panel     -> ~/rdo-solo-web on the host, rebuilt as a container
#
# Run it from a REAL terminal (not a pipe): the SSH/Tailscale re-auth and the
# `sudo` password prompt both need a TTY.
#
#   ./deploy.sh                # build + deploy everything
#   ./deploy.sh --gateway-only # only the Rust binary + shell + service restart
#   ./deploy.sh --web-only     # only the web container
#   ./deploy.sh --skip-build   # reuse the existing target/ binary
#   ./deploy.sh --dry-run      # print what would run, change nothing
#
# Env overrides: RDO_HOMELAB_HOST (default: homelab),
#                RDO_REMOTE_WEB_DIR (default: rdo-solo-web, relative to $HOME).
#
set -euo pipefail

# --- config ------------------------------------------------------------------
HOST="${RDO_HOMELAB_HOST:-homelab}"
SSH_OPTS=(-o ConnectTimeout=8 -o ServerAliveInterval=8 -o ServerAliveCountMax=3)
REMOTE_BIN="/usr/local/bin/rdo-solo-tui"
REMOTE_SH="/usr/local/bin/rdo-solo"
REMOTE_WEB_DIR="${RDO_REMOTE_WEB_DIR:-rdo-solo-web}"   # relative to the homelab $HOME
SERVICE="rdo-solo.service"

REPO="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
MUSL_TARGET="x86_64-unknown-linux-musl"
MUSL_BIN="$REPO/tui/target/$MUSL_TARGET/release/rdo-solo-tui"

DO_GATEWAY=yes
DO_WEB=yes
DO_BUILD=yes
DRY_RUN=no

# --- colors (only on a tty) --------------------------------------------------
if [ -t 1 ]; then
  c_off=$'\033[0m'; c_b=$'\033[1m'; c_ok=$'\033[32m'; c_bad=$'\033[31m'; c_warn=$'\033[33m'
else
  c_off=; c_b=; c_ok=; c_bad=; c_warn=
fi
step() { printf '%s==>%s %s\n' "$c_b" "$c_off" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_warn" "$c_off" "$*" >&2; }
die()  { printf '%sERRO%s %s\n' "$c_bad" "$c_off" "$*" >&2; exit 1; }

# run a command, or just print it under --dry-run
run() {
  if [ "$DRY_RUN" = yes ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi
}

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# --- args --------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --gateway-only) DO_WEB=no ;;
    --web-only)     DO_GATEWAY=no ;;
    --skip-build)   DO_BUILD=no ;;
    --dry-run)      DRY_RUN=yes ;;
    -h|--help)      usage 0 ;;
    *) die "opção desconhecida: $1 (use --help)" ;;
  esac
  shift
done

# --- ssh reachability (Tailscale re-auth if needed) --------------------------
ensure_ssh() {
  if [ "$DRY_RUN" = yes ]; then printf '   [dry-run] verificaria SSH para %s\n' "$HOST"; return 0; fi
  # Tailscale SSH can require an "additional check" that prints an auth URL and
  # blocks; cap the non-interactive probe so we fall through to the interactive
  # path instead of hanging forever.
  step "conectando ao homelab ($HOST)..."
  # -T: the host's ssh config forces RequestTTY; without -T a non-interactive probe
  # allocates a PTY, goes raw-mode in an interactive terminal, swallows Ctrl+C and hangs.
  if timeout 12 ssh -T "${SSH_OPTS[@]}" -o BatchMode=yes "$HOST" true 2>/dev/null; then ok "SSH ok"; return 0; fi
  [ -t 1 ] || die "sem SSH para $HOST e sem terminal para autenticar. Rode 'ssh $HOST' primeiro."
  warn "O Tailscale SSH precisa de aprovação. Uma URL vai aparecer ABAIXO — abra no navegador e aprove."
  warn "(se precisar cancelar: Ctrl+C funciona; esta conexão NÃO aloca PTY)"
  # No -tt / no </dev/tty on purpose: a forced PTY puts the terminal in raw mode and
  # swallows Ctrl+C. A plain ssh prints the Tailscale auth URL, waits for the browser
  # approval, then exits — and stays interruptible.
  ssh -T "${SSH_OPTS[@]}" -o ConnectTimeout=30 "$HOST" true || true
  timeout 12 ssh -T "${SSH_OPTS[@]}" -o BatchMode=yes "$HOST" true 2>/dev/null \
    || die "ainda não alcanço $HOST por SSH. Aprove a URL do Tailscale e tente 'ssh $HOST' manualmente."
}

# run a root snippet on the homelab (sudo over ssh -t; prompts in your terminal)
remote_root() {
  if [ "$DRY_RUN" = yes ]; then printf '   [dry-run] ssh -t %s sudo bash -c <<SNIPPET\n%s\nSNIPPET\n' "$HOST" "$1"; return 0; fi
  ssh -t "${SSH_OPTS[@]}" "$HOST" "sudo bash -c $(printf '%q' "$1")"
}

# --- build -------------------------------------------------------------------
build_rust() {
  [ "$DO_BUILD" = yes ] || { step "pulando build (--skip-build)"; return 0; }
  step "building rdo-solo-tui (release, static $MUSL_TARGET)"
  run cargo build --release --manifest-path "$REPO/tui/Cargo.toml"
  [ "$DRY_RUN" = yes ] && return 0
  [ -f "$MUSL_BIN" ] || die "binário não encontrado em $MUSL_BIN (o target musl está instalado? 'rustup target add $MUSL_TARGET')"
  # musl Rust binaries are static-pie: `file` says "static-pie linked", `ldd` says
  # "statically linked". Accept either; only warn if truly dynamic.
  if command -v file >/dev/null && ! file "$MUSL_BIN" | grep -qE 'statically linked|static-pie'; then
    warn "o binário não parece estático; o glibc do Ubuntu pode divergir. Confirme o target musl."
  fi
  ok "$(basename "$MUSL_BIN") pronto"
}

# --- gateway deploy (binary + shell + service) -------------------------------
deploy_gateway() {
  # Guard against a stale build (cargo sometimes keeps an outdated artifact): the
  # binary MUST understand the squad subcommands before we ship it. squad-list is
  # read-only and needs no root — stale binaries exit non-zero ("unknown command").
  if [ "$DRY_RUN" != yes ]; then
    [ -x "$MUSL_BIN" ] || die "binário ausente em $MUSL_BIN — rode sem --skip-build."
    "$MUSL_BIN" squad-list >/dev/null 2>&1 \
      || die "o binário em target/ NÃO tem os subcomandos squad (build stale). Rode 'cd tui && touch src/main.rs && cargo build --release' e tente de novo (sem --skip-build)."
  fi
  step "enviando binário + shell para $HOST:/tmp"
  run scp "${SSH_OPTS[@]}" "$MUSL_BIN" "$HOST:/tmp/rdo-solo-tui.new"
  run scp "${SSH_OPTS[@]}" "$REPO/homelab/rdo-solo" "$HOST:/tmp/rdo-solo.new"

  step "instalando em $HOST (sudo — vai pedir sua senha)"
  remote_root "set -e
ts=\$(date +%Y%m%d-%H%M%S)
[ -f $REMOTE_BIN ] && cp -a $REMOTE_BIN $REMOTE_BIN.bak-\$ts && echo 'backup: $REMOTE_BIN.bak-'\$ts
[ -f $REMOTE_SH ]  && cp -a $REMOTE_SH  $REMOTE_SH.bak-\$ts  && echo 'backup: $REMOTE_SH.bak-'\$ts
install -m 0755 /tmp/rdo-solo-tui.new $REMOTE_BIN
install -m 0755 /tmp/rdo-solo.new $REMOTE_SH
rm -f /tmp/rdo-solo-tui.new /tmp/rdo-solo.new
# install re-creates the sysctl + systemd unit; it does NOT overwrite an existing
# /etc/rdo-solo.conf (guarded), so your CONSOLE_IP/WAN_IF/label are preserved.
$REMOTE_SH install
systemctl restart $SERVICE
echo 'service:' && systemctl is-active $SERVICE || true"
  ok "gateway atualizado (binário + shell + $SERVICE reiniciado)"
}

# --- web deploy (rsync source + rebuild container) ---------------------------
deploy_web() {
  step "verificando o .env remoto (segredos ficam no homelab, nunca aqui)"
  # shellcheck disable=SC2029  # $REMOTE_WEB_DIR is a local constant; expanding it here is intended
  if [ "$DRY_RUN" != yes ] && ! ssh -T "${SSH_OPTS[@]}" "$HOST" "test -f $REMOTE_WEB_DIR/.env" 2>/dev/null; then
    warn "não achei $REMOTE_WEB_DIR/.env no homelab — o container não sobe sem ele."
    warn "crie a partir de web/.env.example (PORT, RDO_PIN, RDO_SESSION_SECRET...) e rode de novo."
    die  "abortando o deploy web para não subir sem segredos."
  fi

  step "sincronizando web/ -> $HOST:$REMOTE_WEB_DIR (sem node_modules/.next/.env)"
  run rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
    --exclude='.env' --exclude='node_modules/' --exclude='.next/' \
    --exclude='.git/' --exclude='*.tsbuildinfo' \
    "$REPO/web/" "$HOST:$REMOTE_WEB_DIR/"

  step "rebuild da imagem + recriação do container no $HOST (docker — 1-3 min; logs abaixo)"
  if [ "$DRY_RUN" = yes ]; then
    printf '   [dry-run] ssh %s "cd %s && docker build --network host -t rdo-solo-web:latest . && docker compose up -d --force-recreate"\n' "$HOST" "$REMOTE_WEB_DIR"
  else
    # Remove any pre-existing container with the fixed name first: a container created
    # by a different compose project (or CasaOS) collides on container_name and makes
    # `compose up` fail with a name conflict. rm -f then up = clean recreate from the new image.
    ssh -T "${SSH_OPTS[@]}" "$HOST" "cd $REMOTE_WEB_DIR && docker build --progress=plain --network host -t rdo-solo-web:latest . && { docker rm -f rdo-solo-web >/dev/null 2>&1 || true; } && docker compose up -d"
  fi
  ok "web atualizado (imagem rebuildada, container recriado)"
}

# --- validate ----------------------------------------------------------------
validate() {
  [ "$DRY_RUN" = yes ] && return 0
  step "validando no $HOST: status --json"
  # shellcheck disable=SC2029  # $REMOTE_BIN is a local constant; expanding it here is intended
  if out="$(ssh -T "${SSH_OPTS[@]}" "$HOST" "$REMOTE_BIN status --json" 2>/dev/null)"; then
    printf '%s\n' "$out" | grep -oE '"mode":"[a-z]+"|"squad":\[[^]]*\]|"console_ip":"[^"]*"' || true
    ok "gateway responde ao novo contrato (mode/squad presentes)"
  else
    warn "não consegui ler status --json (precisa de root? rode no painel ou 'rdo-solo status')."
  fi
}

# --- main --------------------------------------------------------------------
step "rdo-solo deploy -> $HOST${c_off}  (gateway=$DO_GATEWAY web=$DO_WEB build=$DO_BUILD dry-run=$DRY_RUN)"
[ "$DO_GATEWAY" = yes ] && build_rust
ensure_ssh
[ "$DO_GATEWAY" = yes ] && deploy_gateway
[ "$DO_WEB" = yes ]     && deploy_web
validate

cat <<EOF

${c_ok}pronto.${c_off} Próximo passo (Task 13 / REQ-011, validação ao vivo):
  1. entre numa sessão de RDO com 1 amigo, só vocês visíveis;
  2. no painel (http://$HOST:3737), em modo Normal, toque "Capturar esquadrão";
  3. ligue "Modo Squad" e confirme que vocês ficam e os outros saem;
  4. se você cair na migração de host (erro 0x50060190): NÃO remova o rdo-solo,
     registre o comportamento — partimos pro plano B ("doorman").
EOF
