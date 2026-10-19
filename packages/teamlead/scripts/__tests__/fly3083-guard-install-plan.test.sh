#!/bin/bash
# FLY-3083: runner-msg-guard install plan in the REAL claude-lead.sh (hermetic).
#
# Runs claude-lead.sh in dry-run (FLYWHEEL_LEAD_DRY_RUN=1) under an isolated HOME
# and asserts:
#   - dept + cos Leads: the launcher plans the Lead-LOCAL install into
#     <LEAD_WORKSPACE>/.claude/settings.local.json (--lock-held) and dry-run
#     writes no hook entry;
#   - companion / external Leads: install skipped (no Runners);
#   - missing installer (packaged-Lead precedent): WARN, launch plan still emitted;
#   - FLYWHEEL_LEAD_ALERT_SCRIPT pane env: set (and pointing at an existing
#     lead-alert.sh) for dept/cos, emptied for companion/external.
#
# Requires: built dist/ProjectConfig.js, node, jq. Never starts a real Lead.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEAD_SH="$(cd "${SCRIPT_DIR}/.." && pwd)/claude-lead.sh"
DIST="$(cd "${SCRIPT_DIR}/../../dist" && pwd 2>/dev/null || true)"

if [ ! -f "${DIST}/ProjectConfig.js" ]; then
  echo "SKIP: dist/ProjectConfig.js not built — run 'pnpm -C packages/teamlead build' first" >&2
  exit 0
fi

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

make_home() {
  local h; h=$(mktemp -d "/tmp/fly3083-plan.XXXXXX")
  mkdir -p "$h/proj/.lead/product-lead" "$h/proj/.lead/cos-lead" \
           "$h/proj/.lead/mufasa-lead" "$h/proj/.lead/anna-interviewer-lead"
  printf -- '---\nname: product-lead\n---\nPeter\n'  > "$h/proj/.lead/product-lead/identity.md"
  printf -- '---\nname: cos-lead\n---\nSimba\n'       > "$h/proj/.lead/cos-lead/identity.md"
  printf -- '---\nname: mufasa-lead\n---\nMufasa\n'   > "$h/proj/.lead/mufasa-lead/identity.md"
  printf -- '---\nname: anna-interviewer-lead\n---\nAnna\n' > "$h/proj/.lead/anna-interviewer-lead/agent.md"
  echo "$h"
}

fixture_projects() {
  local h="$1"
  cat <<JSON
[
 {"projectName":"proj","projectRoot":"${h}/proj","leads":[
   {"agentId":"product-lead","chatChannel":"222","match":{"labels":["Product"]},"botTokenEnv":"PETER_BOT_TOKEN","canSpawnRunners":true},
   {"agentId":"cos-lead","chatChannel":"333","match":{"labels":["PM"]},"botTokenEnv":"TEST_COS_BOT_TOKEN","canSpawnRunners":false},
   {"agentId":"mufasa-lead","chatChannel":"111","alertChannel":"111","match":{"labels":["growth"]},"botTokenEnv":"MUFASA_BOT_TOKEN","canSpawnRunners":false,"companion":true,"department":"growth"},
   {"agentId":"anna-interviewer-lead","chatChannel":"444","alertChannel":"999","match":{"labels":["external-interviews"]},"department":"external","botTokenEnv":"ANNA_BOT_TOKEN","alertBotTokenEnv":"ANNA_BOT_TOKEN","canSpawnRunners":false,"external":true}]}
]
JSON
}

run_dry() {
  local h="$1" proj="$2" lead="$3"; shift 3
  env -i HOME="$h" PATH="$PATH" \
    FLYWHEEL_LEAD_DRY_RUN=1 FLYWHEEL_PROJECTS="$proj" \
    DISCORD_BOT_TOKEN="canary" TEAMLEAD_API_TOKEN="canary" ANNA_BOT_TOKEN="canary" \
    "$@" \
    bash "$LEAD_SH" "$lead" "$h/proj" proj 2>&1
}

plan_of() { sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p'; }

H=$(make_home); P=$(fixture_projects "$H")

# ── T1/T2: dept + cos plan the Lead-local install under the lock
for lead in product-lead cos-lead; do
  OUT=$(run_dry "$H" "$P" "$lead")
  SETTINGS="$H/.flywheel/lead-workspace/${lead}/.claude/settings.local.json"
  printf '%s\n' "$OUT" | grep -qF "DRY-RUN: runner-msg-guard would install into ${SETTINGS} (--lock-held)" \
    && ok "$lead: install planned into its workspace settings.local.json" \
    || bad "$lead: install plan line missing"
  if [ -f "$SETTINGS" ] && grep -q "flywheel-runner-msg-guard" "$SETTINGS"; then
    bad "$lead: dry-run must not write the hook entry"
  else
    ok "$lead: dry-run wrote no hook entry"
  fi
  PLAN=$(printf '%s' "$OUT" | plan_of)
  printf '%s\n' "$PLAN" | grep -qF $'PANE_ENV\tFLYWHEEL_LEAD_ALERT_SCRIPT\tset' \
    && ok "$lead: FLYWHEEL_LEAD_ALERT_SCRIPT pane env set" \
    || bad "$lead: FLYWHEEL_LEAD_ALERT_SCRIPT pane env not set"
  ALERT_PATH=$(printf '%s\n' "$OUT" | sed -n 's/^.*FLYWHEEL_LEAD_ALERT_SCRIPT=\(\/.*lead-alert\.sh\)$/\1/p' | head -1)
  [ -n "$ALERT_PATH" ] && [ -f "$ALERT_PATH" ] \
    && ok "$lead: FLYWHEEL_LEAD_ALERT_SCRIPT points at an existing lead-alert.sh" \
    || bad "$lead: FLYWHEEL_LEAD_ALERT_SCRIPT path missing/nonexistent ('$ALERT_PATH')"
  printf '%s\n' "$PLAN" | grep -qF 'LAUNCH_PLAN_END' && ok "$lead: launch plan emitted" || bad "$lead: no launch plan"
done

# ── T3/T4: companion + external skip the install; alert env emptied
for pair in "mufasa-lead:Companion" "anna-interviewer-lead:External"; do
  lead="${pair%%:*}"; label="${pair#*:}"
  OUT=$(run_dry "$H" "$P" "$lead")
  printf '%s\n' "$OUT" | grep -qF "${label}: skipping runner-msg-guard install" \
    && ok "$lead: install skipped (${label})" || bad "$lead: skip line missing"
  printf '%s\n' "$OUT" | grep -qF "runner-msg-guard would install" \
    && bad "$lead: must not plan an install" || ok "$lead: no install planned"
  PLAN=$(printf '%s' "$OUT" | plan_of)
  if printf '%s\n' "$PLAN" | grep -qF $'PANE_ENV\tFLYWHEEL_LEAD_ALERT_SCRIPT\tset'; then
    bad "$lead: FLYWHEEL_LEAD_ALERT_SCRIPT must not be set"
  else
    ok "$lead: FLYWHEEL_LEAD_ALERT_SCRIPT not set"
  fi
done

# ── T5: missing installer → WARN, Lead still launches
OUT=$(run_dry "$H" "$P" product-lead FLYWHEEL_RUNNER_MSG_GUARD_INSTALLER="$H/nope/install-runner-msg-guard.sh")
printf '%s\n' "$OUT" | grep -qF "WARNING: install-runner-msg-guard.sh not found: $H/nope/install-runner-msg-guard.sh" \
  && ok "missing installer → WARN" || bad "missing installer WARN absent"
printf '%s\n' "$OUT" | grep -qF "runner-msg-guard would install" \
  && bad "missing installer must not plan an install" || ok "missing installer → no install planned"
printf '%s\n' "$OUT" | plan_of | grep -qF 'LAUNCH_PLAN_END' \
  && ok "missing installer → launch plan still emitted" || bad "missing installer blocked the launch"

rm -rf "$H"
echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
