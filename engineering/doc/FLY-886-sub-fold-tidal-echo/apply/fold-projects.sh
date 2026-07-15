#!/usr/bin/env bash
# FLY-886 activation step 2 — fold the sub project into tidal-echo in
# ~/.flywheel/projects.json.
#
# DRY-RUN BY DEFAULT (Codex R1 HIGH-1): a bare `bash fold-projects.sh` only shows
# the diff on a COPY and writes nothing. Pass --activate to actually apply, and
# ONLY inside the founder-present window (plan §4). Never run --activate tonight.
#
# Semantic diff (three actions, everything else byte-unchanged):
#   1. delete the projects[] entry with projectName=="sub"
#   2. append Asha's lead entry (verbatim field-for-field) to tidal-echo.leads[]
#   3. tidal-echo.memoryAllowedUsers += ["sub-lead","sub"]
#
# On --activate the entire read->transform->assert->rename->loadProjects->rollback
# critical section runs under ONE config_write_locked (Codex R1 #4 — no
# read-check-write race). Rollback also uses same-dir tmp + mv (atomic).
set -euo pipefail
PJ="$HOME/.flywheel/projects.json"
FLYWHEEL_REPO="${FLYWHEEL_REPO:-$HOME/Dev/flywheel}"

# The shared jq fold program (used identically by dry-run and the locked apply).
FOLD_JQ='
  (first(.[] | select(.projectName=="sub")) | .leads[0]) as $asha
  | map(select(.projectName != "sub"))
  | map(if .projectName == "tidal-echo"
      then .leads += [$asha]
         | .memoryAllowedUsers += ["sub-lead","sub"]
      else . end)
'

# Structural asserts (shared). $1 = candidate file. Fail = nothing applied.
assert_folded() {
  local T="$1"
  jq -e 'length == 6' "$T" >/dev/null
  jq -e '[.[] | select(.projectName=="sub")] | length == 0' "$T" >/dev/null
  jq -e 'first(.[] | select(.projectName=="tidal-echo")) | .leads | length == 3' "$T" >/dev/null
  jq -e 'first(.[] | select(.projectName=="tidal-echo")) | .leads[2]
         | .agentId=="sub-lead" and .botTokenEnv=="ASHA_BOT_TOKEN"
           and .chatChannel=="1511267947551653918" and .department=="content"
           and .canSpawnRunners==true and .model=="claude-opus-4-8[1m]"
           and .match.labels==["Sub"]' "$T" >/dev/null
  jq -e 'first(.[] | select(.projectName=="tidal-echo"))
         | .generalChannel=="1517041708855197908"
           and (.memoryAllowedUsers | index("sub-lead")) and (.memoryAllowedUsers | index("sub"))' "$T" >/dev/null
}

# ---- internal locked critical section (re-exec target; real write) ----
if [ "${1:-}" = "--locked" ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  BAK="$PJ.bak-fly886-$TS"
  TMP="$PJ.tmp-fly886-$$"          # same dir → rename(2) atomic
  RTMP="$PJ.restore-fly886-$$"
  trap 'rm -f "$TMP" "$RTMP"' EXIT

  cp "$PJ" "$BAK"; echo "backup: $BAK"
  jq "$FOLD_JQ" "$PJ" > "$TMP"
  assert_folded "$TMP"
  mv "$TMP" "$PJ"   # atomic swap, still under the lock

  # full-schema gate; atomic restore on failure (still under the lock)
  if ! node --input-type=module -e "
    import {loadProjects} from '$FLYWHEEL_REPO/packages/teamlead/dist/ProjectConfig.js';
    const p = loadProjects();
    if (p.length !== 6) throw new Error('expected 6 projects, got ' + p.length);
    console.log('loadProjects OK:', p.map(x => x.projectName).join(','));
  "; then
    cp "$BAK" "$RTMP" && mv "$RTMP" "$PJ"
    echo "FAILED loadProjects — atomically restored from $BAK" >&2
    exit 1
  fi
  echo "projects.json folded (sub → tidal-echo). Backup kept: $BAK"
  exit 0
fi

# ---- preflights (read-only, both modes) ----
[ -z "${FLYWHEEL_PROJECTS:-}" ] || { echo "refusing: FLYWHEEL_PROJECTS env override is set (loadProjects would validate it instead of the file)" >&2; exit 1; }
[ -f "$FLYWHEEL_REPO/packages/teamlead/dist/ProjectConfig.js" ] || { echo "refusing: teamlead dist missing — build flywheel first" >&2; exit 1; }

if [ "${1:-}" != "--activate" ]; then
  # ---- DRY-RUN (default): transform a copy, assert, show diff, write nothing ----
  TMP=$(mktemp -t fly886-pj.XXXXXX)
  trap 'rm -f "$TMP"' EXIT
  jq "$FOLD_JQ" "$PJ" > "$TMP"
  assert_folded "$TMP"
  echo "== DRY-RUN: structural asserts PASS. Diff (current -> folded), nothing written: =="
  diff <(jq -S . "$PJ") <(jq -S . "$TMP") || true
  echo "== pass --activate inside the founder window to apply (adds lock + backup + loadProjects gate) =="
  exit 0
fi

# ---- --activate: preflight the lock, then re-exec the locked critical section ----
source "$FLYWHEEL_REPO/scripts/flywheel-config-lock.sh"
rc=0
config_write_locked "${FLEET_CONFIG_LOCK_FILE:-$PJ.cfglock}" 30 \
  env FLYWHEEL_REPO="$FLYWHEEL_REPO" bash "$0" --locked || rc=$?
[ "$rc" -eq 75 ] && echo "config lock busy (EX_TEMPFAIL 75) — retry later, do NOT force" >&2
exit "$rc"
