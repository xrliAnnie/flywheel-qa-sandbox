#!/usr/bin/env bash
# Kill one previously captured QA PID from a tmux-spawned, unsandboxed helper.
# The command fingerprint is verified before sending any signal.
set -euo pipefail

pid="${1:?usage: tmux-exact-kill.sh PID EXPECTED_SUBSTRING MODE OUTPUT}"
expected="${2:?usage: tmux-exact-kill.sh PID EXPECTED_SUBSTRING MODE OUTPUT}"
mode="${3:?usage: tmux-exact-kill.sh PID EXPECTED_SUBSTRING MODE OUTPUT}"
output="${4:?usage: tmux-exact-kill.sh PID EXPECTED_SUBSTRING MODE OUTPUT}"
timeout_seconds="${FLY1439_KILL_TIMEOUT_SECONDS:-30}"

if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] || (( pid <= 1 )); then
  printf 'refusing invalid pid: %s\n' "$pid" >&2
  exit 64
fi

mkdir -p "$(dirname "$output")"
tmp="${output}.$$"
trap 'rm -f "$tmp"' EXIT

command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
ppid="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)"
if [[ -z "$command_line" ]]; then
  printf 'target pid %s is not alive\n' "$pid" >&2
  exit 1
fi
if [[ "$command_line" != *"$expected"* ]]; then
  printf 'target command mismatch for pid %s\n' "$pid" >&2
  exit 1
fi

if [[ "${FLY1439_REQUIRE_PARENT_DEAD:-0}" == 1 ]] &&
   [[ -n "$ppid" ]] &&
   ps -p "$ppid" >/dev/null 2>&1; then
  printf 'target parent %s is still alive; refusing orphan cleanup\n' "$ppid" >&2
  exit 1
fi

{
  printf 'pid=%s\n' "$pid"
  printf 'ppid=%s\n' "${ppid:-unknown}"
  printf 'command=%s\n' "$command_line"
  printf 'mode=%s\n' "$mode"
  printf 'signal_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} >"$tmp"

case "$mode" in
  kill9)
    kill -KILL "$pid"
    ;;
  term)
    kill -TERM "$pid"
    ;;
  term-kill)
    kill -TERM "$pid"
    ;;
  *)
    printf 'unknown kill mode: %s\n' "$mode" >&2
    exit 64
    ;;
esac

deadline=$((SECONDS + timeout_seconds))
while ps -p "$pid" >/dev/null 2>&1 && (( SECONDS < deadline )); do
  sleep 0.1
done

if ps -p "$pid" >/dev/null 2>&1 && [[ "$mode" == term-kill ]]; then
  printf 'escalated_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$tmp"
  kill -KILL "$pid"
  deadline=$((SECONDS + 5))
  while ps -p "$pid" >/dev/null 2>&1 && (( SECONDS < deadline )); do
    sleep 0.1
  done
fi

if ps -p "$pid" >/dev/null 2>&1; then
  printf 'dead=false\n' >>"$tmp"
  mv "$tmp" "$output"
  trap - EXIT
  exit 1
fi

printf 'dead=true\n' >>"$tmp"
printf 'confirmed_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$tmp"
mv "$tmp" "$output"
trap - EXIT
