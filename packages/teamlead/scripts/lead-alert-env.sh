#!/bin/bash
# FLY-3083: export FLYWHEEL_LEAD_ALERT_SCRIPT — the absolute path of
# scripts/lead-alert.sh that the Runner channel contract's
# mailbox_channel_fault template calls.
#
# Why a dedicated env: FLYWHEEL_ROOT is only a launcher-local export — it is not
# in the Claude pane's tmux `-e` list and the Codex full-access runtime's
# positive env allowlist filters it out. Every Runner-capable Lead entry point
# (claude-lead.sh, codex-lead.sh full-access, the direct-exec Codex TUI / headless
# full-access launchers) sources this file and calls the ONE function below, so
# the resolution rule cannot drift between them.
#
# Sourced, functions only, no side effects at source time. Safe under
# `set -euo pipefail`.
#
# Packaged (npm) trees: scripts/lead-alert.sh is deliberately NOT shipped
# (FLY-1062 packaged-path audit, "included-guarded"). A missing target is a
# WARN, the variable stays unset, the launcher keeps starting, and the
# contract's `${FLYWHEEL_LEAD_ALERT_SCRIPT:?…}` guard sends the Lead to the
# issue-thread fallback.

# export_lead_alert_script_env <teamlead-scripts-dir>
#   resolves <dir>/../../../scripts/lead-alert.sh to an absolute physical path.
#   found + readable → export FLYWHEEL_LEAD_ALERT_SCRIPT=<abs>
#   otherwise        → unset it (no stale inherited value) + WARN on stderr
#   Always returns 0.
export_lead_alert_script_env() {
  local script_dir="${1:-}"
  local candidate="${script_dir}/../../../scripts/lead-alert.sh"
  local dir abs=""
  if [ -n "$script_dir" ] && [ -f "$candidate" ] && [ -r "$candidate" ]; then
    dir="$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P)" || dir=""
    [ -n "$dir" ] && abs="${dir}/lead-alert.sh"
  fi
  if [ -n "$abs" ]; then
    export FLYWHEEL_LEAD_ALERT_SCRIPT="$abs"
    echo "[lead-alert-env] FLYWHEEL_LEAD_ALERT_SCRIPT=${abs}" >&2
  else
    unset FLYWHEEL_LEAD_ALERT_SCRIPT
    echo "[lead-alert-env] WARNING: lead-alert.sh not found at ${candidate}; FLYWHEEL_LEAD_ALERT_SCRIPT not exported (the contract's alert template falls back to the issue thread)" >&2
  fi
  return 0
}
