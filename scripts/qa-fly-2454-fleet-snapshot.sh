#!/usr/bin/env bash
# FLY-2454: byte-stable production Codex socket and default-tmux window census.
set -euo pipefail

usage() {
  printf 'Usage: %s --out <file>\n' "$(basename "$0")" >&2
}

if [[ "$#" -ne 2 || "$1" != "--out" || -z "$2" ]]; then
  usage
  exit 2
fi

OUT="$2"
if [[ -L "$OUT" ]]; then
  printf 'Refusing symlink output: %s\n' "$OUT" >&2
  exit 2
fi
OUT_DIR=$(dirname "$OUT")
if [[ ! -d "$OUT_DIR" ]]; then
  printf 'Output directory does not exist: %s\n' "$OUT_DIR" >&2
  exit 2
fi

TMP_OUT="${OUT}.tmp.$$"
cleanup() {
  rm -f "$TMP_OUT"
}
trap cleanup EXIT INT TERM

{
  printf '[codex-app-servers]\n'
  LC_ALL=C ps -axo pid=,pgid=,etime=,command= \
    | awk '
      /(^|\/)codex[[:space:]]+app-server([[:space:]]|$)/ &&
      /--listen(=|[[:space:]]+)unix:\/\// {
        line = $0
        sub(/^.*--listen(=|[[:space:]]+)unix:\/\//, "", line)
        sub(/[[:space:]].*$/, "", line)
        print line
      }
    ' \
    | LC_ALL=C sort
  printf '[tmux-windows]\n'
  tmux -S "/private/tmp/tmux-$(id -u)/default" list-windows -a \
    -F '#{session_name}|#{window_id}|#{window_name}' \
    | LC_ALL=C sort
} > "$TMP_OUT"

chmod 600 "$TMP_OUT"
mv "$TMP_OUT" "$OUT"
trap - EXIT INT TERM
