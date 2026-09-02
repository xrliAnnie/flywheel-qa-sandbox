#!/usr/bin/env bash

_flywheel_kill_ledger_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_flywheel_kill_ledger_node=""
if [ -n "${FLYWHEEL_NODE_BIN:-}" ] && [ -x "${FLYWHEEL_NODE_BIN}" ]; then
  _flywheel_kill_ledger_node="${FLYWHEEL_NODE_BIN}"
else
  _flywheel_kill_ledger_node="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$_flywheel_kill_ledger_node" ]; then
  for _flywheel_node_candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$_flywheel_node_candidate" ]; then
      _flywheel_kill_ledger_node="$_flywheel_node_candidate"
      break
    fi
  done
fi

_flywheel_kill_ledger_mutate() {
  local signal="$1" target_kind="$2" target="$3"
  case "$target_kind" in
    pid) kill -s "$signal" -- "$target" ;;
    pgid) kill -s "$signal" -- "-$target" ;;
    tmux-window) tmux kill-window -t "$target" ;;
    *)
      echo "flywheel_audited_signal: invalid target kind: $target_kind" >&2
      return 2
      ;;
  esac
}

# Append+fsync one receipt before mutating a pid/pgid/tmux window.
# Usage: flywheel_audited_signal SOURCE SIGNAL KIND TARGET EXEC_ID REASON [FAILURE_MODE]
flywheel_audited_signal() {
  if [ "$#" -lt 6 ] || [ "$#" -gt 7 ]; then
    echo "flywheel_audited_signal: expected 6 or 7 arguments" >&2
    return 2
  fi
  local source="$1" signal="$2" target_kind="$3" target="$4"
  local exec_id="$5" reason="$6" failure_mode="${7:-fail-closed}"
  local state_root="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel/state}"
  local ledger_root="${FLYWHEEL_KILL_LEDGER_ROOT:-${state_root}/kill-ledger}"
  local append_script="${_flywheel_kill_ledger_dir}/kill-ledger-append.mjs"

  if [ -z "$_flywheel_kill_ledger_node" ]; then
    echo "flywheel_audited_signal: node unavailable; ledger append failed" >&2
    return 1
  fi
  if ! "$_flywheel_kill_ledger_node" "$append_script" --append "$ledger_root" "$source" "$signal" \
      "$target_kind" "$target" "$exec_id" "$reason"; then
    if [ "$failure_mode" != "forced-shutdown-fail-open" ]; then
      echo "flywheel_audited_signal: ledger append failed; signal refused" >&2
      return 1
    fi
    local fallback_entry
    fallback_entry="$("$_flywheel_kill_ledger_node" "$append_script" --stdout "$ledger_root" "$source" \
      "$signal" "$target_kind" "$target" "$exec_id" "$reason")" || return 1
    printf '{"kind":"KILL_LEDGER_FALLBACK","entry":%s,"ledgerError":"append_failed"}\n' \
      "$fallback_entry" >&2
  fi

  _flywheel_kill_ledger_mutate "$signal" "$target_kind" "$target"
}
