#!/bin/bash
# FLY-1402: the real Claude Lead launcher must collapse every selected rules
# source into one immutable bundle before handing argv to Claude. This suite is
# hermetic: isolated HOME + projects config, launcher dry-run, no tmux/Claude.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEAD_SH="$(cd "${SCRIPT_DIR}/.." && pwd)/claude-lead.sh"
DIST="$(cd "${SCRIPT_DIR}/../../dist" && pwd 2>/dev/null || true)"
CHECKER="$(cd "${SCRIPT_DIR}/.." && pwd)/check-rules-truth.sh"
BUNDLE_LIB="$(cd "${SCRIPT_DIR}/.." && pwd)/lead-rules-bundle.sh"

if [ ! -f "${DIST}/ProjectConfig.js" ]; then
  echo "SKIP: dist/ProjectConfig.js not built — run 'pnpm -C packages/teamlead build' first" >&2
  exit 0
fi

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

make_home() {
  local h
  h=$(mktemp -d "/tmp/fly1402-launcher.XXXXXX")
  mkdir -p "$h/project/.lead/department-lead" \
    "$h/project/.lead/cos-lead" \
    "$h/project/.lead/companion-lead" \
    "$h/project/.lead/external-lead" \
    "$h/project/.lead/shared" \
    "$h/.flywheel"
  printf '%s\n' '{"granularity":"per-lead","setBy":"test","setAt":"2026-08-28T00:00:00.000Z"}' > "$h/.flywheel/summary-config.json"
  printf -- '---\nname: department-lead\n---\nDepartment Lead\n' \
    > "$h/project/.lead/department-lead/identity.md"
  printf -- '---\nname: cos-lead\n---\nChief of Staff\n' \
    > "$h/project/.lead/cos-lead/identity.md"
  printf -- '---\nname: companion-lead\n---\nCompanion\n' \
    > "$h/project/.lead/companion-lead/identity.md"
  printf -- '---\nname: external-lead\n---\nExternal\n' \
    > "$h/project/.lead/external-lead/agent.md"
  printf 'PROJECT_COMMON_SENTINEL\n' > "$h/project/.lead/shared/common-rules.md"
  printf 'PROJECT_DEPT_SENTINEL\n' > "$h/project/.lead/shared/department-lead-rules.md"
  echo "$h"
}

fixture_projects() {
  local h="$1"
  printf '%s\n' '[{"projectName":"fixture","projectRoot":"'"$h"'/project","leads":[' \
    '{"agentId":"department-lead","summaryRole":"producer","chatChannel":"1","match":{"labels":["dept"]},"canSpawnRunners":true},' \
    '{"agentId":"cos-lead","summaryRole":"aggregator","chatChannel":"2","match":{"labels":["cos"]},"canSpawnRunners":false},' \
    '{"agentId":"companion-lead","summaryRole":"producer","chatChannel":"3","match":{"labels":["companion"]},"canSpawnRunners":false,"companion":true},' \
    '{"agentId":"external-lead","summaryRole":"exempt","chatChannel":"4","match":{"labels":["external"]},"canSpawnRunners":false,"external":true}' \
    ']}]'
}

run_default_bundle_dry() {
  local h="$1" projects="$2" lead="${3:-department-lead}"
  # The outer poison + explicit env -u is deliberate: inherited rollout valves
  # must not silently turn this default-ON regression proof into legacy mode.
  env FLYWHEEL_LEAD_RULES_BUNDLE=legacy \
    env -u FLYWHEEL_LEAD_RULES_BUNDLE -i \
      HOME="$h" PATH="$PATH" \
      FLYWHEEL_LEAD_DRY_RUN=1 FLYWHEEL_PROJECTS="$projects" \
      DISCORD_BOT_TOKEN=test TEAMLEAD_API_TOKEN=test \
      bash "$LEAD_SH" "$lead" "$h/project" fixture 2>&1
}

run_legacy_dry() {
  local h="$1" projects="$2" lead="$3"
  env -i HOME="$h" PATH="$PATH" \
    FLYWHEEL_LEAD_DRY_RUN=1 FLYWHEEL_PROJECTS="$projects" \
    FLYWHEEL_LEAD_RULES_BUNDLE=' LeGaCy ' \
    DISCORD_BOT_TOKEN=test TEAMLEAD_API_TOKEN=test \
    bash "$LEAD_SH" "$lead" "$h/project" fixture 2>&1
}

run_invalid_mode_dry() {
  local h="$1" projects="$2" lead="$3"
  env -i HOME="$h" PATH="$PATH" \
    FLYWHEEL_LEAD_DRY_RUN=1 FLYWHEEL_PROJECTS="$projects" \
    FLYWHEEL_LEAD_RULES_BUNDLE=' typo-mode ' \
    DISCORD_BOT_TOKEN=test TEAMLEAD_API_TOKEN=test \
    bash "$LEAD_SH" "$lead" "$h/project" fixture 2>&1
}

plan_of() { sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p'; }
append_targets() {
  awk -F'\t' '
    $1 == "ARG" && previous == "--append-system-prompt-file" { print $2 }
    $1 == "ARG" { previous = $2 }
  '
}

H=$(make_home)
PROJECTS=$(fixture_projects "$H")
OUT=$(run_default_bundle_dry "$H" "$PROJECTS")
PLAN=$(printf '%s\n' "$OUT" | plan_of)
TARGETS=$(printf '%s\n' "$PLAN" | append_targets)
TARGET_COUNT=$(printf '%s\n' "$TARGETS" | grep -c . || true)

[ "$TARGET_COUNT" = "1" ] \
  && ok "default dept launch has exactly one append-system-prompt target" \
  || bad "default dept launch expected one target, got ${TARGET_COUNT}: ${TARGETS}"

BUNDLE_PATH="$TARGETS"
if [ -n "$BUNDLE_PATH" ] && [ -r "$BUNDLE_PATH" ]; then
  ok "dry-run bundle remains readable after launcher exit"
else
  bad "dry-run bundle remains readable after launcher exit (${BUNDLE_PATH:-no target})"
fi

if [ -r "$BUNDLE_PATH" ]; then
  grep -qF 'RULES_BUNDLE_SHA=' "$BUNDLE_PATH" \
    && ok "bundle carries version sentinel" || bad "bundle carries version sentinel"
  grep -qF 'base/department-lead-rules.md' "$BUNDLE_PATH" \
    && ok "dept arm is present" || bad "dept arm is present"
  grep -qF 'base/founder-only-authority.md' "$BUNDLE_PATH" \
    && ok "universal founder authority is present" || bad "universal founder authority is present"
  grep -qF 'base/cross-dept-channel-rules.md' "$BUNDLE_PATH" \
    && ok "cross-dept rules are present" || bad "cross-dept rules are present"
  grep -qF 'launcher/screencapture-l3-skill.md' "$BUNDLE_PATH" \
    && ok "launcher screencapture rules are present" || bad "launcher screencapture rules are present"
  grep -qF 'project/common-rules.md' "$BUNDLE_PATH" \
    && ok "project common rules are present" || bad "project common rules are present"
  grep -qF 'project/department-lead-rules.md' "$BUNDLE_PATH" \
    && ok "project dept rules are present" || bad "project dept rules are present"
  "$CHECKER" --bundle-file "$BUNDLE_PATH" --expect-role dept --strict >/dev/null 2>&1 \
    && ok "production truth checker accepts dry-run dept bundle" \
    || bad "production truth checker accepts dry-run dept bundle"
fi

[ ! -e "$H/.flywheel/lead-rules-bundles/fixture-department-lead.active.json" ] \
  && ok "dry-run writes no active receipt" || bad "dry-run writes no active receipt"

rm -rf "$H"

# The remaining role arms go through the same real launcher path. Each gets one
# bundle and the checker validates the role's positive and negative invariants.
for ROLE_CASE in 'cos-lead:cos' 'companion-lead:companion' 'external-lead:external'; do
  LEAD="${ROLE_CASE%%:*}"
  ROLE="${ROLE_CASE#*:}"
  H=$(make_home)
  PROJECTS=$(fixture_projects "$H")
  OUT=$(run_default_bundle_dry "$H" "$PROJECTS" "$LEAD")
  PLAN=$(printf '%s\n' "$OUT" | plan_of)
  TARGETS=$(printf '%s\n' "$PLAN" | append_targets)
  TARGET_COUNT=$(printf '%s\n' "$TARGETS" | grep -c . || true)
  [ "$TARGET_COUNT" = "1" ] \
    && ok "$ROLE arm has exactly one append-system-prompt target" \
    || bad "$ROLE arm expected one target, got ${TARGET_COUNT}: ${TARGETS}"
  [ -r "$TARGETS" ] \
    && ok "$ROLE dry-run bundle remains readable" \
    || bad "$ROLE dry-run bundle remains readable"
  if [ -r "$TARGETS" ]; then
    "$CHECKER" --bundle-file "$TARGETS" --expect-role "$ROLE" --strict >/dev/null 2>&1 \
      && ok "$ROLE bundle passes production truth checker" \
      || bad "$ROLE bundle passes production truth checker"
  fi
  [ ! -e "$H/.flywheel/lead-rules-bundles/fixture-${LEAD}.active.json" ] \
    && ok "$ROLE dry-run writes no active receipt" \
    || bad "$ROLE dry-run writes no active receipt"
  rm -rf "$H"
done

# Legacy preserves the selected raw argv sequence, creates no bundle/receipt,
# and logs loudly. Dry-run must never emit the production alert.
for LEGACY_CASE in 'department-lead:dept' 'external-lead:external'; do
  LEAD="${LEGACY_CASE%%:*}"
  ROLE="${LEGACY_CASE#*:}"
  H=$(make_home)
  PROJECTS=$(fixture_projects "$H")
  OUT=$(run_legacy_dry "$H" "$PROJECTS" "$LEAD")
  PLAN=$(printf '%s\n' "$OUT" | plan_of)
  TARGETS=$(printf '%s\n' "$PLAN" | append_targets)
  TARGET_COUNT=$(printf '%s\n' "$TARGETS" | grep -c . || true)
  if [ "$ROLE" = "external" ]; then
    [ "$TARGET_COUNT" = "1" ] && printf '%s' "$TARGETS" | grep -qF 'external-agent-contract.md' \
      && ok "external legacy keeps exactly its raw contract target" \
      || bad "external legacy keeps exactly its raw contract target"
  else
    [ "$TARGET_COUNT" -gt 1 ] \
      && ok "dept legacy preserves the ordered multi-flag shape" \
      || bad "dept legacy preserves the ordered multi-flag shape"
  fi
  printf '%s\n' "$OUT" | grep -qF 'WARNING: running LEGACY last-one-wins mode' \
    && ok "$ROLE legacy logs loudly" || bad "$ROLE legacy logs loudly"
  if find "$H/.flywheel/lead-rules-bundles" -name '*.md' -print -quit 2>/dev/null | grep -q .; then
    bad "$ROLE legacy created a bundle file"
  else
    ok "$ROLE legacy created no bundle file"
  fi
  [ ! -e "$H/.flywheel/lead-rules-bundles/fixture-${LEAD}.active.json" ] \
    && ok "$ROLE legacy dry-run writes no active receipt" \
    || bad "$ROLE legacy dry-run writes no active receipt"
  printf '%s\n' "$OUT" | grep -qF 'rules_bundle_legacy alert failed' \
    && bad "$ROLE legacy dry-run attempted an alert" \
    || ok "$ROLE legacy dry-run attempted no alert"
  rm -rf "$H"
done

H=$(make_home)
PROJECTS=$(fixture_projects "$H")
OUT=$(run_invalid_mode_dry "$H" "$PROJECTS" department-lead)
TARGETS=$(printf '%s\n' "$OUT" | plan_of | append_targets)
[ "$(printf '%s\n' "$TARGETS" | grep -c . || true)" = "1" ] \
  && ok "invalid mode falls back to one bundle target" \
  || bad "invalid mode falls back to one bundle target"
printf '%s\n' "$OUT" | grep -qF 'invalid FLYWHEEL_LEAD_RULES_BUNDLE=typo-mode; defaulting to bundle' \
  && ok "invalid mode emits a warning" || bad "invalid mode emits a warning"
rm -rf "$H"

# Production wiring sentinel: commit must remain before the one-shot child launch.
COMMIT_LINE=$(grep -n 'if ! _rules_bundle_commit_once' "$LEAD_SH" | tail -1 | cut -d: -f1)
LAUNCH_LINE=$(awk -v start="$COMMIT_LINE" 'NR > start && /_launch_claude/ { print NR; exit }' "$LEAD_SH")
if [ -n "$COMMIT_LINE" ] && [ -n "$LAUNCH_LINE" ] && [ "$COMMIT_LINE" -lt "$LAUNCH_LINE" ]; then
  ok "real launcher commits receipt before child launch"
else
  bad "real launcher commit wiring order is commit=${COMMIT_LINE:-?} launch=${LAUNCH_LINE:-?}"
fi

# Legacy lifecycle: one active receipt + one alert across repeated child launch
# attempts; no bundle file is created or deleted.
if (
  set -euo pipefail
  source "$BUNDLE_LIB"
  T=$(mktemp -d "/tmp/fly1402-legacy-life.XXXXXX")
  trap 'rm -rf "$T"' EXIT
  mkdir -p "$T/sources" "$T/state"
  printf 'EXTERNAL\n' > "$T/sources/external-agent-contract.md"
  ALERT_LOG="$T/alerts"
  ALERT_SH="$T/alert.sh"
  printf '%s\n' '#!/bin/bash' 'printf "%s\n" "$*" >> "$FLY1402_ALERT_LOG"' > "$ALERT_SH"
  chmod +x "$ALERT_SH"
  export FLY1402_ALERT_LOG="$ALERT_LOG"
  log() { :; }
  CLAUDE_ARGS=()
  RULES_BUNDLE_MODE=legacy
  RULES_BUNDLE_ROLE=external
  RULES_BUNDLE_PATH=""
  RULES_BUNDLE_SHA=""
  RULES_BUNDLE_GENERATION_NONCE=""
  RULES_BUNDLE_STATE_DIR="$T/state"
  RULES_BUNDLE_RECEIPT_PATH="$T/state/fixture-external-lead.active.json"
  RULES_BUNDLE_PROCESS_START='LIVE START'
  LEAD_ID=external-lead
  PROJECT_NAME=fixture
  LEAD_ALERT_SH="$ALERT_SH"
  _RULES_BUNDLE_COMMITTED=0
  rules_bundle_reset
  rules_bundle_add "$T/sources/external-agent-contract.md" base
  printf 'PRESERVE\n' > "$T/state/fixture-external-lead.999-lstart-dead.md"
  _rules_bundle_commit_once
  FIRST_RECEIPT=$(sha256sum "$RULES_BUNDLE_RECEIPT_PATH" | awk '{print $1}')
  _rules_bundle_commit_once
  SECOND_RECEIPT=$(sha256sum "$RULES_BUNDLE_RECEIPT_PATH" | awk '{print $1}')
  [ "$FIRST_RECEIPT" = "$SECOND_RECEIPT" ]
  [ "$(wc -l < "$ALERT_LOG" | tr -d ' ')" = "1" ]
  grep -qF -- '--kind rules_bundle_legacy --severity warning' "$ALERT_LOG"
  [ -f "$T/state/fixture-external-lead.999-lstart-dead.md" ]
  jq -e --arg source "$T/sources/external-agent-contract.md" '
    .mode == "legacy" and .bundlePath == null and .role == "external" and
    .files == 1 and .selectedSources[0].label == "base" and
    .selectedSources[0].basename == "external-agent-contract.md" and
    .selectedSources[0].path == $source and .appendTargets == [$source]
  ' "$RULES_BUNDLE_RECEIPT_PATH" >/dev/null
); then
  ok "legacy commit is idempotent, alerts once, preserves bundles, and writes exact receipt"
else
  bad "legacy commit lifecycle contract"
fi

# Bundle lifecycle: commit preserves this generation, removes only lstart-proven
# stale generations, never PID-only-deletes nonce generations, and writes the
# active bundle receipt atomically.
if (
  set -euo pipefail
  source "$BUNDLE_LIB"
  T=$(mktemp -d "/tmp/fly1402-bundle-life.XXXXXX")
  trap 'rm -rf "$T"' EXIT
  mkdir -p "$T/sources" "$T/state"
  printf 'DEPT\n' > "$T/sources/department-lead-rules.md"
  log() { :; }
  ps() {
    case "$2" in
      777) printf 'OTHER LIVE START\n' ;;
      778) return 1 ;;
      *) printf 'SELF START\n' ;;
    esac
  }
  CLAUDE_ARGS=()
  RULES_BUNDLE_MODE=bundle
  RULES_BUNDLE_ROLE=dept
  RULES_BUNDLE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  RULES_BUNDLE_GENERATION_NONCE=""
  RULES_BUNDLE_STATE_DIR="$T/state"
  RULES_BUNDLE_RECEIPT_PATH="$T/state/fixture-department-lead.active.json"
  RULES_BUNDLE_PROCESS_START='SELF START'
  LEAD_ID=department-lead
  PROJECT_NAME=fixture
  LEAD_ALERT_SH=""
  _RULES_BUNDLE_COMMITTED=0
  rules_bundle_reset
  rules_bundle_add "$T/sources/department-lead-rules.md" base
  RULES_BUNDLE_PATH="$T/state/fixture-department-lead.$$.lstart-current.md"
  rules_bundle_materialize "$RULES_BUNDLE_PATH" dept "$LEAD_ID" "$PROJECT_NAME" >/dev/null
  RULES_BUNDLE_SHA=$(sed -n 's/^RULES_BUNDLE_SHA=\([^ ]*\) FILES=.*/\1/p' "$RULES_BUNDLE_PATH")
  CORRECT_HASH=$(_rules_bundle_start_hash 'OTHER LIVE START')
  printf 'KEEP\n' > "$T/state/fixture-department-lead.777-lstart-${CORRECT_HASH}.md"
  printf 'DROP\n' > "$T/state/fixture-department-lead.777-lstart-wrong.md"
  printf 'DROP\n' > "$T/state/fixture-department-lead.778-lstart-dead.md"
  printf 'KEEP\n' > "$T/state/fixture-department-lead.779-nonce-abc123.md"
  _rules_bundle_commit_once
  [ -f "$RULES_BUNDLE_PATH" ]
  [ -f "$T/state/fixture-department-lead.777-lstart-${CORRECT_HASH}.md" ]
  [ ! -e "$T/state/fixture-department-lead.777-lstart-wrong.md" ]
  [ ! -e "$T/state/fixture-department-lead.778-lstart-dead.md" ]
  [ -f "$T/state/fixture-department-lead.779-nonce-abc123.md" ]
  jq -e --arg path "$RULES_BUNDLE_PATH" --arg sha "$RULES_BUNDLE_SHA" '
    .mode == "bundle" and .bundlePath == $path and .sha == $sha and
    .supervisorStart == "SELF START" and .appendTargets == [$path] and .files == 1
  ' "$RULES_BUNDLE_RECEIPT_PATH" >/dev/null
); then
  ok "bundle commit uses pid+lstart cleanup proof and writes exact active receipt"
else
  bad "bundle commit cleanup/receipt lifecycle contract"
fi

# Receipt failure is fail-stop: commit stays false, alert stays silent, and an
# uncommitted bundle is removed by the exact-path cleanup hook.
if (
  set -euo pipefail
  source "$BUNDLE_LIB"
  T=$(mktemp -d "/tmp/fly1402-fail-life.XXXXXX")
  trap 'rm -rf "$T"' EXIT
  mkdir -p "$T/sources" "$T/state" "$T/bin"
  printf 'DEPT\n' > "$T/sources/department-lead-rules.md"
  printf '%s\n' '#!/bin/bash' 'printf invoked > "$FLY1402_MV_MARKER"' 'exit 1' > "$T/bin/mv"
  chmod +x "$T/bin/mv"
  export FLY1402_MV_MARKER="$T/mv-invoked"
  log() { :; }
  CLAUDE_ARGS=()
  RULES_BUNDLE_MODE=bundle
  RULES_BUNDLE_ROLE=dept
  RULES_BUNDLE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  RULES_BUNDLE_GENERATION_NONCE=""
  RULES_BUNDLE_STATE_DIR="$T/state"
  RULES_BUNDLE_RECEIPT_PATH="$T/state/fixture-department-lead.active.json"
  RULES_BUNDLE_PROCESS_START='SELF START'
  LEAD_ID=department-lead
  PROJECT_NAME=fixture
  LEAD_ALERT_SH=""
  _RULES_BUNDLE_COMMITTED=0
  rules_bundle_reset
  rules_bundle_add "$T/sources/department-lead-rules.md" base
  RULES_BUNDLE_PATH="$T/state/fixture-department-lead.$$.lstart-current.md"
  printf 'UNCOMMITTED\n' > "$RULES_BUNDLE_PATH"
  PATH="$T/bin:$PATH"
  if _rules_bundle_commit_once; then exit 1; fi
  [ -f "$FLY1402_MV_MARKER" ]
  [ "$_RULES_BUNDLE_COMMITTED" = "0" ]
  [ ! -e "$RULES_BUNDLE_RECEIPT_PATH" ]
  _rules_bundle_uncommitted_cleanup
  [ ! -e "$RULES_BUNDLE_PATH" ]
); then
  ok "receipt write failure blocks commit and uncommitted bundle self-cleans"
else
  bad "receipt failure fail-stop contract"
fi

echo ""
echo "FLY-1402 single-bundle launcher test: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
