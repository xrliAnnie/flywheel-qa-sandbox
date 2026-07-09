#!/usr/bin/env bash
# FLY-1023 M1: AgentCliProvider — Claude Code (the MVP provider).
#
# Contract: scripts/lib/agent-cli-providers/CONTRACT.md — every function
# prints EXACTLY one JSON line on stdout, human/progress text goes to stderr,
# exit codes are semantic (0 ok / 1 fail / 3 needs-guidance).
#
# Auth model: the instance owner's OWN Claude subscription via the CLI's own
# login flow. This module NEVER touches keys/tokens — login runs the vendor
# CLI in the foreground on the caller's TTY, and the smoke test is one
# minimal --print invocation on the user's subscription.
#
# Implementation-period verification (plan §8.1): install command form,
# --print/--output-format json/--append-system-prompt-file/--resume flag
# combos are pinned here as the SINGLE point that absorbs vendor drift; the
# QA stage re-verifies them against a real authenticated CLI.

ACP_CLAUDE_BIN="${FLYWHEEL_CLAUDE_BIN:-claude}"
# brain calls are bounded (FLY-494 lesson: an unauthenticated CLI can hang on
# a device-code prompt forever — fail closed instead).
ACP_TIMEOUT_SECS="${FLYWHEEL_AGENT_CLI_TIMEOUT_SECS:-120}"

_acp_emit() { jq -nc "$@"; }

# _acp_bounded <secs> <cmd...> — run <cmd> with stdin passed through, kill it
# after <secs>. Portable (macOS has no coreutils timeout). Prints the child's
# stdout; returns its exit code, or 124/143 when the watchdog fired (SIGTERM).
# Details that matter: background jobs get /dev/null stdin in non-job-control
# shells, so the child re-binds <&0 explicitly; the watchdog's stdout is
# detached so an orphaned sleep can never hold the capture pipe open.
_acp_bounded() {
  local secs="$1"; shift
  local out rc
  out="$("$@" <&0 & child=$!
    ( sleep "$secs"; kill -TERM "$child" 2>/dev/null ) >/dev/null 2>&1 & watcher=$!
    wait "$child"; rc=$?
    kill -TERM "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
    exit "$rc")"
  rc=$?
  printf '%s' "$out"
  return "$rc"
}

# _acp_timed_out <rc> — did _acp_bounded's watchdog fire?
_acp_timed_out() { [ "$1" -eq 124 ] || [ "$1" -eq 143 ]; }

provider_id() { _acp_emit '{ok:true, provider:"claude"}'; }

provider_detect() {
  if ! command -v "$ACP_CLAUDE_BIN" >/dev/null 2>&1; then
    _acp_emit '{ok:false, provider:"claude", found:false, error_code:"not_found"}'
    return 1
  fi
  local ver
  ver="$("$ACP_CLAUDE_BIN" --version 2>/dev/null </dev/null | head -1)"
  _acp_emit --arg v "${ver:-unknown}" '{ok:true, provider:"claude", found:true, version:$v}'
}

# provider_install — idempotent: already-present CLI short-circuits. Channel
# preference: npm global (preflight guarantees Node) → official installer
# script → guided manual (exit 3).
provider_install() {
  if command -v "$ACP_CLAUDE_BIN" >/dev/null 2>&1; then
    provider_detect
    return $?
  fi
  if command -v npm >/dev/null 2>&1; then
    echo "[claude-provider] installing Claude Code via npm…" >&2
    npm install -g @anthropic-ai/claude-code >&2 2>&1 \
      || { _acp_emit '{ok:false, provider:"claude", error_code:"install_failed", hint:"npm install -g @anthropic-ai/claude-code failed — see the log"}'; return 1; }
  elif command -v curl >/dev/null 2>&1; then
    echo "[claude-provider] installing Claude Code via the official installer…" >&2
    curl -fsSL https://claude.ai/install.sh | bash >&2 2>&1 \
      || { _acp_emit '{ok:false, provider:"claude", error_code:"install_failed", hint:"official installer failed — see the log"}'; return 1; }
  else
    _acp_emit '{ok:false, provider:"claude", error_code:"manual_install_required", hint:"install Claude Code manually: https://claude.com/claude-code — then re-run"}'
    return 3
  fi
  if ! command -v "$ACP_CLAUDE_BIN" >/dev/null 2>&1; then
    _acp_emit '{ok:false, provider:"claude", error_code:"install_failed", hint:"installed but the claude command is not on PATH — open a new shell or fix PATH, then re-run"}'
    return 1
  fi
  provider_detect
}

# provider_login_guide — drive the CLI's OWN login flow in the foreground.
# The caller (Buddy shell / bootstrap) owns the TTY; the CLI opens the
# browser itself and prints a copyable URL when it cannot (its own fallback,
# which covers WSL2 loopback). We collect nothing.
provider_login_guide() {
  command -v "$ACP_CLAUDE_BIN" >/dev/null 2>&1 \
    || { _acp_emit '{ok:false, provider:"claude", error_code:"not_found", hint:"install the CLI first"}'; return 1; }
  if _acp_logged_in; then
    _acp_emit '{ok:true, provider:"claude", login:"ok"}'
    return 0
  fi
  if [ ! -r /dev/tty ]; then
    _acp_emit '{ok:false, provider:"claude", error_code:"login_pending", hint:"no TTY to run the login flow — run in an interactive terminal"}'
    return 3
  fi
  echo "[claude-provider] launching the Claude login flow (finish in the browser, then exit the CLI)…" >&2
  # foreground, attached to the caller's TTY: first run enters login.
  "$ACP_CLAUDE_BIN" /login </dev/tty >/dev/tty 2>&1 || true
  if _acp_logged_in; then
    _acp_emit '{ok:true, provider:"claude", login:"ok"}'
  else
    _acp_emit '{ok:false, provider:"claude", error_code:"login_pending", hint:"login did not complete — finish the browser flow, then re-run"}'
    return 3
  fi
}

# login heuristic WITHOUT spending a model call: the CLI keeps its state
# under ~/.claude. The authoritative proof is provider_smoke (one real call).
_acp_logged_in() {
  [ -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ]
}

provider_smoke() {
  command -v "$ACP_CLAUDE_BIN" >/dev/null 2>&1 \
    || { _acp_emit '{ok:false, provider:"claude", error_code:"not_found"}'; return 1; }
  local out rc
  out="$(_acp_bounded "$ACP_TIMEOUT_SECS" "$ACP_CLAUDE_BIN" --print 'reply with exactly: ok' </dev/null 2>/dev/null)"
  rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
    _acp_emit '{ok:true, provider:"claude", smoke:"ok"}'
  elif _acp_timed_out "$rc"; then
    _acp_emit '{ok:false, provider:"claude", error_code:"smoke_timeout", hint:"the CLI did not answer in time — is the login complete?"}'
    return 1
  else
    _acp_emit '{ok:false, provider:"claude", error_code:"smoke_failed", hint:"a minimal claude --print call failed — re-run the login"}'
    return 1
  fi
}

# _acp_brain_call [--resume <sid>] <persona-file> <prompt-file> — one headless
# invocation. Prompt travels via STDIN, persona via --append-system-prompt-file
# (TmuxAdapter precedent: file transport keeps long text out of argv).
_acp_brain_call() {
  local -a args=(--print --output-format json)
  if [ "$1" = "--resume" ]; then
    args+=(--resume "$2"); shift 2
  fi
  local persona="$1" prompt="$2"
  [ -f "$prompt" ] || { _acp_emit '{ok:false, provider:"claude", error_code:"bad_usage", hint:"prompt file missing"}'; return 1; }
  if [ -n "$persona" ]; then
    [ -f "$persona" ] || { _acp_emit '{ok:false, provider:"claude", error_code:"bad_usage", hint:"persona file missing"}'; return 1; }
    args+=(--append-system-prompt-file "$persona")
  fi
  local out rc reply sid
  out="$(_acp_bounded "$ACP_TIMEOUT_SECS" "$ACP_CLAUDE_BIN" "${args[@]}" < "$prompt" 2>/dev/null)"
  rc=$?
  if _acp_timed_out "$rc"; then
    _acp_emit '{ok:false, provider:"claude", error_code:"brain_timeout", hint:"the model call timed out"}'
    return 1
  fi
  reply="$(jq -r '.result // empty' <<<"$out" 2>/dev/null)"
  sid="$(jq -r '.session_id // empty' <<<"$out" 2>/dev/null)"
  if [ "$rc" -ne 0 ] || [ -z "$reply" ]; then
    _acp_emit '{ok:false, provider:"claude", error_code:"brain_failed", hint:"headless call returned no usable result"}'
    return 1
  fi
  _acp_emit --arg r "$reply" --arg s "${sid:-}" '{ok:true, provider:"claude", reply:$r, session_id:$s}'
}

provider_start_buddy() { # <persona-file> <prompt-file>
  _acp_brain_call "${1:-}" "${2:-}"
}

provider_resume() { # <session-id> <prompt-file>
  local sid="${1:-}"
  printf '%s' "$sid" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]*$' \
    || { _acp_emit '{ok:false, provider:"claude", error_code:"bad_usage", hint:"session id must be alphanumeric/hyphen"}'; return 1; }
  _acp_brain_call --resume "$sid" "" "${2:-}"
}

# provider_repair — a broken login is re-driven through login_guide; the
# smoke call is the authoritative before/after probe.
provider_repair() {
  if provider_smoke >/dev/null 2>&1; then
    _acp_emit '{ok:true, provider:"claude", repaired:false}'
    return 0
  fi
  echo "[claude-provider] login looks broken — re-running the login flow" >&2
  provider_login_guide >/dev/null 2>&1 || {
    _acp_emit '{ok:false, provider:"claude", error_code:"repair_failed", hint:"login re-run did not complete"}'
    return 1
  }
  if provider_smoke >/dev/null 2>&1; then
    _acp_emit '{ok:true, provider:"claude", repaired:true}'
  else
    _acp_emit '{ok:false, provider:"claude", error_code:"repair_failed", hint:"login re-ran but the smoke call still fails"}'
    return 1
  fi
}
