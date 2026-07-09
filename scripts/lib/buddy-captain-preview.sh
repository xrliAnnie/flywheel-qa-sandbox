#!/usr/bin/env bash
# FLY-1023 M5-a: Captain preview — the "early chat" launcher (PRD step 5) and
# the LEAD LAUNCH CONTRACT closeout for the buddy path.
#
# The real Lead launcher is packages/teamlead/scripts/claude-lead.sh. Its hard
# startup gates, each closed EXPLICITLY here (plan M5-a, one decision per
# gate, test-locked):
#   1. role detection needs the project/lead entry in ~/.flywheel/projects.json
#      → PRECONDITION: the config step must have landed (checked, readable
#      failure when missing — the Buddy shell then degrades honestly: the
#      early chat moves to after placement).
#   2. .lead/<lead-id>/identity.md must exist → PRECONDITION: skeleton step
#      (checked the same way).
#   3. ~/.flywheel/bin/{check,update}-discord-plugin.sh must exist or the
#      launcher aborts. These have NO source in this repository (they are
#      operator-machine setup artifacts, GEO-296). DECISION: on a machine
#      where they are ABSENT we install no-op GUARD STUBS (0700) that
#      document the customer-mode degradation (no plugin-fork enforcement);
#      existing scripts are NEVER overwritten, so operator machines keep
#      their real enforcement.
#   4. mailbox transport: agent-team-transport on PATH is fail-closed for the
#      default backend. DECISION: the preview launches with
#      FLYWHEEL_COMM_BACKEND=commdb (the launcher's own no-transport path,
#      non-fatal by design) unless the caller already chose a backend.
#
# buddy_captain_preview_start <state-dir> [identity-flags…]
#   → 0 launched (pid recorded) · 1 gates/launch failed (reason on stderr).
#   FLYWHEEL_BUDDY_PREVIEW_DRY_RUN=1 runs the launcher's FLY-231 dry-run and
#   succeeds on a complete LAUNCH_PLAN — the hermetic contract test's mode.
# buddy_captain_preview_stop <state-dir>
#   → best-effort stop of a recorded preview (placement replaces it).

_BCP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_BCP_REPO_ROOT="$(cd "$_BCP_SCRIPT_DIR/../.." && pwd)"
_BCP_LEAD_SH="${FLYWHEEL_BUDDY_LEAD_SH:-$_BCP_REPO_ROOT/packages/teamlead/scripts/claude-lead.sh}"

_bcp_log() { echo "[captain-preview] $*" >&2; }

# gate 3: converge the two bin guards WHEN ABSENT (never overwrite).
_bcp_converge_bin() {
  local bin="$1"
  mkdir -p "$bin" 2>/dev/null
  local f
  for f in check-discord-plugin.sh update-discord-plugin.sh; do
    [ -e "$bin/$f" ] && continue
    cat > "$bin/$f" <<'STUB'
#!/bin/bash
# Installed by flywheel onboarding (FLY-1023 M5-a) because this machine has no
# operator-managed Discord-plugin fork tooling (GEO-296). Customer mode: the
# stock plugin is accepted as-is — bot-to-bot relay features that need the
# fork degrade gracefully. Replace with the real scripts to enforce the fork.
exit 0
STUB
    chmod 700 "$bin/$f"
    _bcp_log "installed customer-mode guard stub: $bin/$f"
  done
}

# resolve <state-dir> <project-name> → sets BCP_LEAD_ID / BCP_PROJECT_ROOT /
# BCP_PROJECT_NAME from the landed projects.json (gate 1).
_bcp_resolve() {
  local state_dir="$1" project="$2"
  local pj="$state_dir/projects.json"
  if [ ! -f "$pj" ]; then
    _bcp_log "cannot start the Captain yet: the team册子还没落好(config 那步没完成)"
    return 1
  fi
  local entry
  entry="$(jq -c --arg p "$project" '.[] | select(.projectName == $p)' "$pj" 2>/dev/null | head -1)"
  if [ -z "$entry" ]; then
    _bcp_log "cannot start the Captain yet: 册子里还没有「$project」这个团队"
    return 1
  fi
  BCP_PROJECT_NAME="$project"
  BCP_PROJECT_ROOT="$(jq -r '.projectRoot' <<<"$entry")"
  BCP_LEAD_ID="$(jq -r '[.leads[] | select(.agentId != "cos-lead")][0].agentId // empty' <<<"$entry")"
  BCP_TOKEN_ENV="$(jq -r '[.leads[] | select(.agentId != "cos-lead")][0].botTokenEnv // empty' <<<"$entry")"
  if [ -z "$BCP_LEAD_ID" ]; then
    _bcp_log "cannot start the Captain yet: 册子里没有可用的 Captain 记录"
    return 1
  fi
  # gate 2: identity file
  if [ ! -f "$BCP_PROJECT_ROOT/.lead/$BCP_LEAD_ID/identity.md" ]; then
    _bcp_log "cannot start the Captain yet: 工作区里还没有 Captain 的名片(skeleton 那步没完成)"
    return 1
  fi
  return 0
}

buddy_captain_preview_start() {
  local state_dir="$1"; shift
  # identity flags → project name (only --project matters here; journal falls back)
  local project=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project) project="$2"; shift 2 ;;
      --*) shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -z "$project" ] && [ -f "$state_dir/setup-state.json" ]; then
    project="$(jq -r '.buddy.identity.project // empty' "$state_dir/setup-state.json" 2>/dev/null)"
  fi
  [ -n "$project" ] || { _bcp_log "no project identity available"; return 1; }
  [ -f "$_BCP_LEAD_SH" ] || { _bcp_log "lead launcher missing: $_BCP_LEAD_SH"; return 1; }

  # the launcher hardcodes several ~/.flywheel paths (bin, claude-sessions,
  # blocked, alert-queue, alerts) and creates them EARLY — a preview from a
  # custom --state-dir (QA sandbox on an operator machine) must therefore
  # refuse BEFORE the launcher runs, or it would mutate the real home
  # (Codex R1#3 + R2#2). Honest degrade: the early chat moves to after
  # placement.
  if [ "$state_dir" != "$HOME/.flywheel" ]; then
    _bcp_log "custom state dir ($state_dir) — the Captain preview only runs on the real customer root; skipping (early chat moves after placement)"
    return 1
  fi
  _bcp_resolve "$state_dir" "$project" || return 1
  _bcp_converge_bin "$HOME/.flywheel/bin"

  # secrets: load the live .env into THIS process env only (never echoed),
  # then hand the launcher the Captain's OWN token — claude-lead.sh expects
  # its caller to provide DISCORD_BOT_TOKEN (launchd wrappers do the same);
  # it does not self-resolve from projects.json (Codex R1#2).
  if [ -f "$state_dir/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$state_dir/.env"
    set +a
  fi
  if [ -n "${BCP_TOKEN_ENV:-}" ]; then
    export DISCORD_BOT_TOKEN="${!BCP_TOKEN_ENV:-}"
  fi
  if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
    _bcp_log "cannot start the Captain yet: 它的工牌钥匙还没配好(bots 那步没完成)"
    return 1
  fi
  export FLYWHEEL_COMM_BACKEND="${FLYWHEEL_COMM_BACKEND:-commdb}"

  local log="$state_dir/captain-preview.log"
  ( umask 077; : >> "$log" )

  local -a lead_args=("$BCP_LEAD_ID" "$BCP_PROJECT_ROOT" "$BCP_PROJECT_NAME")
  [ -n "${BCP_TOKEN_ENV:-}" ] && lead_args+=(--bot-token-env "$BCP_TOKEN_ENV")

  if [ "${FLYWHEEL_BUDDY_PREVIEW_DRY_RUN:-0}" = "1" ]; then
    # contract mode: the launcher's own FLY-231 dry-run must reach a complete
    # launch plan — proof all four gates pass on this machine state.
    if FLYWHEEL_LEAD_DRY_RUN=1 bash "$_BCP_LEAD_SH" "${lead_args[@]}" >>"$log" 2>&1 \
       && grep -q 'LAUNCH_PLAN_END' "$log"; then
      _bcp_log "dry-run launch plan complete (gates green)"
      return 0
    fi
    _bcp_log "dry-run launch plan did NOT complete — see $log"
    return 1
  fi

  # LIVE preview is explicit opt-in (Codex R2#1): the launcher's pane-env
  # mechanism passes DISCORD_BOT_TOKEN by VALUE through tmux argv — a
  # fleet-wide trait of claude-lead.sh that violates the customer-product
  # argv red line, and fixing it is a launcher-wide follow-up, not a buddy
  # patch. Until that lands, the default is the plan's sanctioned honest
  # degrade: the early chat moves to after placement.
  if [ "${FLYWHEEL_BUDDY_PREVIEW_LIVE:-0}" != "1" ]; then
    _bcp_log "live preview deferred (launcher pane-env argv hygiene follow-up) — early chat moves after placement"
    return 1
  fi

  nohup bash "$_BCP_LEAD_SH" "${lead_args[@]}" >>"$log" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" > "$state_dir/captain-preview.pid"
  # bounded aliveness check — a launcher that dies in its gates dies fast.
  local i
  for i in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || { _bcp_log "preview exited early — see $log"; rm -f "$state_dir/captain-preview.pid"; return 1; }
    sleep 1
  done
  _bcp_log "preview launcher running (pid $pid)"
  return 0
}

buddy_captain_preview_stop() {
  local state_dir="$1"
  local pf="$state_dir/captain-preview.pid" pid
  [ -f "$pf" ] || return 0
  pid="$(cat "$pf" 2>/dev/null)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
    sleep 1
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pf"
  return 0
}
