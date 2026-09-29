#!/usr/bin/env bash
# deploy.sh - build the static binary here and ship it to the homelab.
#
# Build target is x86_64-unknown-linux-musl (see .cargo/config.toml): a static
# binary that runs on the homelab's Ubuntu regardless of its glibc version.
#
# It does NOT clobber the shell rdo-solo or its systemd unit. It drops the binary
# at /usr/local/bin/rdo-solo-tui, which shares the same iptables chains and state
# file, so `rdo-solo-tui on/off` and the shell `rdo-solo on/off` are
# interchangeable. Run `sudo rdo-solo-tui install` on the homelab only when you
# want the Rust binary to take over the systemd unit.
#
# Do NOT use `set -u`: this environment's shell snapshot references an unset
# $ZSH_VERSION and the script would die before running anything.
set -eo pipefail

HOST="${RDO_HOMELAB_HOST:-homelab}"
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
BIN="$HERE/target/x86_64-unknown-linux-musl/release/rdo-solo-tui"

c_off=$'\033[0m'; c_ok=$'\033[32m'; c_dim=$'\033[2m'
[ -t 1 ] || { c_off=; c_ok=; c_dim=; }

echo "building (static musl)..."
( cd "$HERE" && cargo build --release )

file "$BIN" | grep -q "static" || { echo "error: binary is not static; refusing to deploy" >&2; exit 1; }
printf '%sbuilt %s (%s)%s\n' "$c_dim" "$BIN" "$(stat -c%s "$BIN" | numfmt --to=iec)" "$c_off"

echo "sending to $HOST..."
scp -q -o ConnectTimeout=8 "$BIN" "$HOST:/tmp/rdo-solo-tui.new"
ssh -t -o ConnectTimeout=8 "$HOST" "sudo install -m 0755 /tmp/rdo-solo-tui.new /usr/local/bin/rdo-solo-tui && rm -f /tmp/rdo-solo-tui.new && echo instalado: \$(command -v rdo-solo-tui)"

printf '%sok. no homelab: %ssudo rdo-solo-tui%s (TUI) ou %srdo-solo-tui help%s\n' \
  "$c_ok" "$c_off" "$c_ok" "$c_off" "$c_off"
