#!/bin/bash
# FLY-2296 feasibility probe runner.
# usage: probe.sh <run-name> <seconds> [canned.json] [extra-config-toml-lines-file]
set -euo pipefail

usage() {
  echo "usage: $0 <run-name> <seconds:1-300> [canned.json] [extra-config-toml-lines-file]" >&2
  exit 64
}

[ "$#" -ge 2 ] && [ "$#" -le 4 ] || usage
P=/private/tmp/fly2296
[ -d /private/tmp ] && [ -w /private/tmp ] || P=/tmp/fly2296
RUN="$1"; SECS="$2"; CANNED="${3:-}"; EXTRA="${4:-}"
[[ "$RUN" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]] || usage
[[ "$SECS" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$SECS" -le 300 ] || usage
for input in "$CANNED" "$EXTRA"; do
  [ -z "$input" ] || { [ -f "$input" ] && [ ! -L "$input" ] && [ -r "$input" ]; } || usage
done
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 69; }
command -v tmux >/dev/null 2>&1 || { echo "tmux is required" >&2; exit 69; }
command -v codex >/dev/null 2>&1 || { echo "codex is required" >&2; exit 69; }

D="$P/run-$RUN"
SOCK="$P/$RUN.sock"
SESS="fly2296-$RUN"
SPID=""

cleanup() {
  env -u TMUX tmux kill-session -t "$SESS" >/dev/null 2>&1 || true
  if [ -n "$SPID" ]; then
    kill -TERM "$SPID" >/dev/null 2>&1 || true
    wait "$SPID" >/dev/null 2>&1 || true
  fi
  rm -f -- "$SOCK"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

mkdir -p "$P"
rm -rf -- "$D"
mkdir -p "$D/home" "$D/cwd"
rm -f -- "$SOCK"
printf '[projects."%s"]\ntrust_level = "trusted"\n' "$D/cwd" > "$D/home/config.toml"
if [ -n "$EXTRA" ]; then cat "$EXTRA" >> "$D/home/config.toml"; fi
node "$P/server.cjs" "$SOCK" "$D/server.log" "$CANNED" &
SPID=$!
READY=0
for _ in $(seq 1 100); do
  if [ -S "$SOCK" ]; then READY=1; break; fi
  kill -0 "$SPID" >/dev/null 2>&1 \
    || { echo "fake server exited before creating $SOCK" >&2; exit 1; }
  sleep 0.05
done
[ "$READY" -eq 1 ] \
  || { echo "fake server socket was not ready: $SOCK" >&2; exit 1; }
TID="$(uuidgen | tr 'A-Z' 'a-z')"
[[ "$TID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
  || { echo "uuidgen returned an invalid thread id" >&2; exit 1; }
printf -v TUI_COMMAND 'env CODEX_HOME=%q codex resume --remote %q -C %q %q 2>%q; rc=$?; printf "EXIT=%%s\\n" "$rc" >> %q; sleep 60' \
  "$D/home" "unix://$SOCK" "$D/cwd" "$TID" "$D/tui.err" "$D/tui.err"
env -u TMUX tmux kill-session -t "$SESS" >/dev/null 2>&1 || true
env -u TMUX tmux new-session -d -s "$SESS" -x 140 -y 40 "$TUI_COMMAND"
sleep "$SECS"
env -u TMUX tmux capture-pane -p -t "$SESS" \
  | grep -v '^[[:space:]]*$' > "$D/pane.txt"
echo "--- pane ($RUN)"; head -45 "$D/pane.txt"
echo "--- server.log"; cut -c1-300 "$D/server.log" | head -60
echo "--- tui.err"; head -c 1500 "$D/tui.err"; echo
