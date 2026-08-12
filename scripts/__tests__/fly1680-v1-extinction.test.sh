#!/usr/bin/env bash
# FLY-1680: the retired Lead v1 launch carrier must not remain executable,
# selectable, installable, or recoverable from active repository code.
# Historical documents are evidence and are intentionally excluded.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d -t fly1680-v1-extinction-XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); echo "PASS: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL: $1" >&2; }

retired_paths=(
  scripts/flywheel-lead-wrapper.sh
  packages/teamlead/scripts/expect-dev-channels.exp
  packages/teamlead/scripts/lib/lead-launch-authority.sh
  packages/teamlead/scripts/lib/resume-recovery.sh
  packages/teamlead/scripts/lib/tmux-supervisor-guard.sh
  scripts/lib/restart-candidate.sh
  packages/teamlead/scripts/__tests__/claude-lead-manifest-preserve.test.sh
  packages/teamlead/scripts/__tests__/manifest-roundtrip.test.sh
  packages/teamlead/scripts/__tests__/lead-backend-dispatch.test.sh
  packages/teamlead/scripts/__tests__/tmux-integration.test.sh
  packages/teamlead/scripts/__tests__/claude-lead-resume-recovery.test.sh
  packages/teamlead/scripts/__tests__/expect-script.test.sh
  packages/teamlead/scripts/__tests__/fly1285-tmux-supervisor.test.sh
  packages/teamlead/scripts/__tests__/fly231-restart-candidate.test.sh
  packages/teamlead/scripts/__tests__/lead-launch-authority.test.sh
  scripts/__tests__/supervisor-adoption.test.sh
  scripts/__tests__/supervisor-storm-regression.test.sh
  scripts/__tests__/flywheel-lead-wrapper.test.sh
  scripts/__tests__/restart-storm-wrapper-wiring.test.sh
  scripts/__tests__/wrapper-host-config-revcompat.test.sh
  scripts/__tests__/fixtures/fly1659/pre-fix-prepare-lead-launch.sh
)

path_residue=()
for relative_path in "${retired_paths[@]}"; do
  [ ! -e "$REPO_ROOT/$relative_path" ] || path_residue+=("$relative_path")
done
if [ "${#path_residue[@]}" -eq 0 ]; then
  pass "retired Lead v1 carrier files and dedicated tests are absent"
else
  fail "retired paths remain (${#path_residue[@]}): ${path_residue[*]}"
fi

retired_symbols=(
  tmux_supervisor_process_start_identity
  _tmux_supervisor_process_command
  tmux_supervisor_archive_write
  tmux_supervisor_archive_read
  _tmux_supervisor_process_presence_state
  tmux_supervisor_archived_process_state
  tmux_supervisor_archived_process_matches
  tmux_supervisor_archived_process_alive
  tmux_supervisor_reap_archived_process
  _lead_launch_authority_process_check
  lead_launch_authority_prepare
  lead_launch_authority_refresh
  lead_launch_authority_recheck
  resume_recovery_decide
  resume_transcript_diagnose
  _prod_membership
  _classify_restart_manifest
  _lead_create_tmux_window
  _lead_prelaunch_isolation_gate
  _lead_reconcile_pending_launch
  createBlockedMarkerReader
  blockedMarkerReader
)
if [ "${#retired_paths[@]}" -eq 21 ] && [ "${#retired_symbols[@]}" -eq 22 ]; then
  pass "retired inventory count is frozen at 21 paths + 22 exact symbols"
else
  fail "retired inventory count drifted: paths=${#retired_paths[@]} symbols=${#retired_symbols[@]}"
fi

retired_path_regex='flywheel-lead-wrapper\.sh|expect-dev-channels\.exp|lead-launch-authority\.sh|resume-recovery\.sh|tmux-supervisor-guard\.sh|restart-candidate\.sh|claude-lead-manifest-preserve\.test\.sh|manifest-roundtrip\.test\.sh|lead-backend-dispatch\.test\.sh|tmux-integration\.test\.sh|claude-lead-resume-recovery\.test\.sh|expect-script\.test\.sh|fly1285-tmux-supervisor\.test\.sh|fly231-restart-candidate\.test\.sh|lead-launch-authority\.test\.sh|supervisor-adoption\.test\.sh|supervisor-storm-regression\.test\.sh|flywheel-lead-wrapper\.test\.sh|restart-storm-wrapper-wiring\.test\.sh|wrapper-host-config-revcompat\.test\.sh|pre-fix-prepare-lead-launch\.sh'
retired_symbol_regex="$(IFS='|'; printf '%s' "${retired_symbols[*]}")"
forbidden_regex="${retired_path_regex}|(^|[^[:alnum:]_])(${retired_symbol_regex})([^[:alnum:]_]|$)|FLYWHEEL_BLOCKED_DIR|\\.flywheel/blocked"
printf '%s\n' \
  'flywheel-lead-wrapper.sh' \
  'tmux_supervisor_archive_write' \
  '_lead_create_tmux_window' > "$TMP_ROOT/positive-control"
if grep -Eq "$forbidden_regex" "$TMP_ROOT/positive-control"; then
  pass "extinction matcher detects a frozen v1 positive control"
else
  fail "extinction matcher missed the frozen v1 positive control"
fi

printf '%s\n' \
  'tmux_generations_share_ambiguous_endpoint' \
  'tmux_server_generation' \
  '_GUARD_TMUX_GENERATION' \
  'runner_lead_pending_unhandled' > "$TMP_ROOT/negative-control"
if grep -Eq "$forbidden_regex" "$TMP_ROOT/negative-control"; then
  fail "extinction matcher overreaches into protected live identifiers"
else
  pass "extinction matcher preserves frozen live-identifier negative controls"
fi

residue="$(git -C "$REPO_ROOT" grep -nE "$forbidden_regex" -- . \
  ':(top,exclude)doc/**' \
  ':(top,exclude)docs/**' \
  ':(top,exclude)engineering/doc/**' \
  ':(top,exclude)product/doc/**' \
  ':(top,exclude)CLAUDE.md' \
  ':(top,exclude)scripts/__tests__/fly1680-v1-extinction.test.sh' 2>&1)"
residue_rc=$?
if [ "$residue_rc" -eq 1 ]; then
  pass "active repository surfaces contain zero retired v1 entrypoints and APIs"
elif [ "$residue_rc" -eq 0 ]; then
  fail "active retired-v1 references remain"
  printf '%s\n' "$residue" | sed -n '1,80p' >&2
else
  fail "tracked-file extinction scan failed (rc=$residue_rc)"
  printf '%s\n' "$residue" | sed -n '1,40p' >&2
fi

carrier_files=(
  scripts/flywheel-daemon.sh
  scripts/flywheel-fleet.sh
  scripts/flywheel-fleet-batch.sh
  scripts/provision-fleet-host.sh
  scripts/packaged/bootstrap-services.sh
  packages/teamlead/src/ProjectConfig.ts
  packages/teamlead/src/LeadWindowLocator.ts
  packages/teamlead/src/bridge/fleet-data.ts
  packages/teamlead/src/bridge/fleet-lead-locator.ts
)
# Ignore unrelated semantic-version prose such as "v1.27.2"; this assertion
# targets a standalone carrier selector/value.
carrier_residue="$(grep -nE '(^|[^[:alnum:]_])v1([^[:alnum:]_]|$)' "${carrier_files[@]/#/$REPO_ROOT/}" 2>&1 \
  | grep -vE 'v1\.[0-9]')"
carrier_rc=$?
if [ "$carrier_rc" -eq 1 ]; then
  pass "carrier selectors and observers expose no v1 state"
elif [ "$carrier_rc" -eq 0 ]; then
  fail "v1 carrier state remains selectable or observable"
  printf '%s\n' "$carrier_residue" | sed -n '1,80p' >&2
else
  fail "carrier-state extinction scan failed (rc=$carrier_rc)"
  printf '%s\n' "$carrier_residue" | sed -n '1,40p' >&2
fi

if grep -qF 'flywheel-lead-wrapper-v2.sh' "$REPO_ROOT/scripts/flywheel-daemon.sh" \
  && grep -qF 'FLYWHEEL_LEAD_BODY_V2=1' "$REPO_ROOT/packages/teamlead/scripts/lead-body.sh" \
  && grep -qF '_poll_dev_channels_dialog_v2' "$REPO_ROOT/packages/teamlead/scripts/claude-lead.sh" \
  && grep -qF 'flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh' "$REPO_ROOT/scripts/lib/lead-restart-lifecycle.sh" \
  && grep -qF 'flywheel-codex-lead-wrapper-codex-infra-bot.sh' "$REPO_ROOT/scripts/lib/lead-restart-lifecycle.sh"; then
  pass "v2 Claude and bespoke Codex launch paths remain protected"
else
  fail "a protected v2 Claude or bespoke Codex launch path is missing"
fi

echo "fly1680-v1-extinction: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
