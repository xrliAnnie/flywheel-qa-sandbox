#!/usr/bin/env bash
# FLY-1674: the retired three-stage dispatcher must not remain executable,
# configurable, or describable as a live path. Historical docs are evidence
# and are intentionally excluded. A few compatibility strings remain because
# DAG consumers still own their persisted names.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d -t fly1674-residue-XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); echo "PASS: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL: $1" >&2; }

# Exact path + token exceptions. Each entry is also checked for existence so a
# deleted compatibility seam cannot leave a widening dead exemption behind.
allowed_hits=(
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_THREE_STAGE'
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_THREE_STAGE_KEEPALIVE'
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_THREE_STAGE_QA_RESPAWN'
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT'
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_THREE_STAGE_CODEX_DESIGN'
  'packages/config/package.json|three-stage-phases'
  'packages/teamlead/package.json|three-stage-qa'
  'packages/teamlead/package.json|three-stage-dedup'
  'packages/teamlead/package.json|three-stage-policy'
  'packages/flywheel-comm/src/__tests__/worktree-turn.test.ts|three_stage_turn'
  'packages/flywheel-comm/src/commands/turn.ts|three_stage_turn'
  'packages/flywheel-comm/src/db.ts|three_stage_turn'
  'packages/teamlead/lead-rules-base/runner-patrol-rules.md|three_stage_turn'
  'packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts|three_stage_turn'
  'scripts/lead-patrol-snapshot.sh|three_stage_turn'
  'scripts/__tests__/lead-patrol-snapshot.test.sh|three_stage_turn'
  'CLAUDE.md|no-three-stage'
  'CLAUDE.md|three-stage-policy'
  'CLAUDE.md|three_stage'
  '.flywheel/config.yaml|no-three-stage'
  'packages/teamlead/src/StateStore.ts|no-three-stage'
  'packages/teamlead/src/__tests__/StateStore.workflow-route-decision.test.ts|no-three-stage'
  'packages/teamlead/src/__tests__/fly1436-pr-b-assets.test.ts|no-three-stage'
  'packages/teamlead/src/__tests__/work-kind.test.ts|no-three-stage'
  'packages/teamlead/src/bridge/__tests__/runs-route.dag-entry.test.ts|no-three-stage'
  'packages/teamlead/src/bridge/runs-route.ts|no-three-stage'
  'packages/teamlead/src/work-kind.ts|no-three-stage'
  'scripts/__tests__/test-pm-executor-contract.sh|no-three-stage'
  'packages/teamlead/src/LeadAlertNotifier.ts|three_stage_stuck'
  'packages/teamlead/src/bridge/alert-kind-copy.ts|three_stage_stuck'
  '.lead/claude-infra-bot-lead/identity.md|three_stage_stuck'
  'packages/teamlead/src/bridge/__tests__/founder-thread-notifier.test.ts|three_stage_stuck'
  'packages/teamlead/src/bridge/__tests__/infra-alert-wiring.test.ts|three_stage_stuck'
  'packages/teamlead/src/bridge/__tests__/infra-event-router.test.ts|three_stage_stuck'
  'packages/teamlead/src/bridge/event-route.ts|three_stage_stuck'
  'packages/teamlead/src/bridge/founder-thread-notifier.ts|three_stage_stuck'
  'packages/teamlead/src/bridge/infra-event-router.ts|three_stage_stuck'
  'packages/teamlead/src/bridge/kind-contract.ts|three_stage_stuck'
  'packages/teamlead/src/bridge/pane-live-region.ts|three_stage_stuck'
  'packages/teamlead/src/bridge/plugin.ts|three_stage_stuck'
  'packages/teamlead/src/LeadAlertNotifier.ts|three_stage_takeover_failed'
  'packages/teamlead/src/bridge/alert-kind-copy.ts|three_stage_takeover_failed'
  'packages/teamlead/src/bridge/infra-event-router.ts|three_stage_takeover_failed'
  'packages/teamlead/src/bridge/kind-contract.ts|three_stage_takeover_failed'
  'packages/teamlead/src/bridge/plugin.ts|three_stage_takeover_failed'
  'scripts/lead-alert.sh|three_stage_takeover_failed'
)

printf '%s\n' 'Three-stage' 'THREE_STAGE' 'ThreeStage' > "$TMP_ROOT/positive-control"
if grep -qiE 'three[-_ ]?stage' "$TMP_ROOT/positive-control"; then
  pass "case-insensitive matcher detects hyphen, underscore, and camel-case controls"
else
  fail "case-insensitive matcher missed a positive control"
fi

for entry in "${allowed_hits[@]}"; do
  path="${entry%%|*}"
  token="${entry#*|}"
  if grep -Fq "$token" "$REPO_ROOT/$path" 2>/dev/null; then
    pass "compatibility exemption remains live: $path :: $token"
  else
    fail "dead compatibility exemption: $path :: $token"
  fi
done

for package_json in packages/config/package.json packages/teamlead/package.json; do
  if grep -Fq '"build": "rm -rf dist' "$REPO_ROOT/$package_json"; then
    fail "package build destroys the last-known-good dist before compilation: $package_json"
  else
    pass "package build preserves the last-known-good dist until compilation succeeds: $package_json"
  fi
done

if grep -Fq 'tsc && rm -f dist/three-stage-phases.* dist/__tests__/three-stage-phases.test.*' \
  "$REPO_ROOT/packages/config/package.json"; then
  pass "config build prunes retired compiled artifacts after successful compilation"
else
  fail "config build lacks post-success retired-artifact pruning"
fi

teamlead_build="$REPO_ROOT/packages/teamlead/package.json"
for retired_artifact in \
  'dist/bridge/phase-orchestrator.*' \
  'dist/bridge/three-stage-policy.*' \
  'dist/bridge/workflow-shadow-writer.*' \
  'dist/bridge/retest-head-delta.*'; do
  if grep -Fq "$retired_artifact" "$teamlead_build"; then
    pass "teamlead build prunes retired compiled artifact: $retired_artifact"
  else
    fail "teamlead build can retain retired compiled artifact: $retired_artifact"
  fi
done

is_allowed_hit() {
  local candidate_path="$1"
  local candidate_text="$2"
  local entry path token
  for entry in "${allowed_hits[@]}"; do
    path="${entry%%|*}"
    token="${entry#*|}"
    if [ "$candidate_path" = "$path" ] \
      && printf '%s\n' "$candidate_text" | grep -Fqi "$token"; then
      return 0
    fi
  done
  return 1
}

raw_hits="$TMP_ROOT/raw-hits"
(
  cd "$REPO_ROOT" || exit 2
  rg -n -o -i --hidden '[[:alnum:]_-]*three[-_ ]?stage[[:alnum:]_-]*' . \
    -g '!doc/**' \
    -g '!docs/**' \
    -g '!engineering/doc/**' \
    -g '!product/doc/**' \
    -g '!dist/**' \
    -g '!**/dist/**' \
    -g '!scripts/__tests__/fly1674-residue.test.sh'
) \
  > "$raw_hits" 2>&1
scan_rc=$?
if [ "$scan_rc" -gt 1 ]; then
  fail "tracked-file residue scan failed (rc=$scan_rc)"
fi

unexpected="$TMP_ROOT/unexpected"
: > "$unexpected"
while IFS=: read -r path line text; do
	[ -n "$path" ] || continue
	path="${path#./}"
  if ! is_allowed_hit "$path" "$text"; then
    printf '%s:%s:%s\n' "$path" "$line" "$text" >> "$unexpected"
  fi
done < "$raw_hits"

if [ ! -s "$unexpected" ]; then
  pass "active tracked files contain only exact compatibility strings"
else
  fail "active three-stage references remain"
  sed -n '1,120p' "$unexpected" >&2
fi

path_hits="$(
  cd "$REPO_ROOT" || exit 2
  rg --files --hidden \
    -g '!.git/**' \
    -g '!doc/**' \
    -g '!docs/**' \
    -g '!engineering/doc/**' \
    -g '!product/doc/**' \
    -g '!dist/**' \
    -g '!**/dist/**' \
    -g '!scripts/__tests__/fly1674-residue.test.sh' \
    | grep -iE 'three[-_ ]?stage'
)"
path_rc=$?
if [ "$path_rc" -eq 1 ]; then
  pass "active file names contain no retired three-stage path"
elif [ "$path_rc" -eq 0 ]; then
  fail "active three-stage file names remain"
  printf '%s\n' "$path_hits" | sed -n '1,120p' >&2
else
  fail "file-name residue scan failed (rc=$path_rc)"
fi

forbidden_symbols='resolvePhaseDispatch|BUILTIN_PHASE_DISPATCH|DEFAULT_PHASE_DISPATCH|PhaseOrchestrator|resolveThreeStageEntry|WorkflowShadowWriter'
symbol_hits="$(
  cd "$REPO_ROOT" || exit 2
  rg -n --hidden "$forbidden_symbols" . \
    -g '*.ts' \
    -g '!doc/**' \
    -g '!engineering/doc/**' \
    -g '!product/doc/**' \
    -g '!**/dist/**' 2>&1
)"
symbol_rc=$?
if [ "$symbol_rc" -eq 1 ]; then
  pass "retired dispatcher and shadow-writer symbols are absent"
elif [ "$symbol_rc" -eq 0 ]; then
  fail "retired dispatcher or shadow-writer symbols remain"
  printf '%s\n' "$symbol_hits" | sed -n '1,120p' >&2
else
  fail "symbol residue scan failed (rc=$symbol_rc)"
fi

echo "fly1674-residue: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
