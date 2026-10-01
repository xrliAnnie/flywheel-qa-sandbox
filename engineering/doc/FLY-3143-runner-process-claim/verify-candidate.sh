#!/bin/sh
# FLY-3143 sandbox verification contract. READ-ONLY: never writes the candidate
# checkout, the state DB, or this repository.
#
#   sh verify-candidate.sh candidate [<candidate-checkout>]
#   sh verify-candidate.sh body <execution-id> [<state-db>]
#
# exit 0 = PASS · 1 = FAIL · 2 = UNVERIFIABLE (input missing / unreadable)
#      3 = STALE (candidate head is not the head this design verified)
#
# UNVERIFIABLE and STALE are never PASS: report them to the Lead, do not retry
# in a loop and do not edit the pins to make them green.

PIN_HEAD=d7d72733b101472bd82236b558906f9c90d0e4d4
PIN_PLAN_BLOB=5e27094f7a3ad0573b52e1d92f8e361525b3dafd
PIN_REVIEWED_PLAN_BLOB=0dbf0ea588adf1fe891f0e08078b27d71a32f9e8
PIN_2919_ORIGINAL=ef5899b514995b38f93c036f8d4a4f0fa17eb3b4
PIN_2919_RESTORE=4c6fb9a865b5403d6b6dfff7805756750193e4c7
PIN_REVERT=be24a1b57345291e3558c6afd8ac6c1a6fbb3eac
PLAN_PATH=engineering/doc/FLY-3143-runner-process-claim/plan.md
RESTORE_ONLY_DIFF=packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts

TL=packages/teamlead/src
CR=packages/claude-runner/src

unverifiable() {
	echo "UNVERIFIABLE: $1"
	exit 2
}

fails=0
unknowns=0
total=0

# record <id> <rc> <description>: rc 0 pass, 1 fail, anything else unverifiable.
record() {
	total=$((total + 1))
	case "$2" in
	0) echo "PASS $1 $3" ;;
	1)
		fails=$((fails + 1))
		echo "FAIL $1 $3"
		;;
	*)
		unknowns=$((unknowns + 1))
		echo "UNVERIFIABLE $1 $3 (rc=$2)"
		;;
	esac
}

# has <id> <path> <fixed-string> <description>: literal present at the pinned head.
has() {
	git -C "$C" grep -qF -e "$3" "$PIN_HEAD" -- "$2" 2>/dev/null
	record "$1" "$?" "$4"
}

finish() {
	echo "SUMMARY total=$total fail=$fails unverifiable=$unknowns"
	if [ "$fails" -gt 0 ]; then
		exit 1
	fi
	if [ "$unknowns" -gt 0 ]; then
		exit 2
	fi
	echo "VERDICT PASS"
	exit 0
}

candidate() {
	C=$1
	if [ -z "$C" ]; then
		case "${FLYWHEEL_COMM_CLI:-}" in
		*/packages/flywheel-comm/dist/index.js)
			C=${FLYWHEEL_COMM_CLI%/packages/flywheel-comm/dist/index.js}
			;;
		*) unverifiable "no candidate checkout given and FLYWHEEL_COMM_CLI does not point into one" ;;
		esac
	fi
	[ -d "$C" ] || unverifiable "candidate checkout is not a directory"
	head=$(git -C "$C" rev-parse --verify -q 'HEAD^{commit}') ||
		unverifiable "candidate checkout has no readable HEAD"
	echo "candidate_head=$head"
	if [ "$head" != "$PIN_HEAD" ]; then
		echo "STALE: expected $PIN_HEAD"
		exit 3
	fi

	# Identity of what is under test.
	dirty=$(GIT_OPTIONAL_LOCKS=0 git -C "$C" status --porcelain 2>/dev/null)
	rc=$?
	if [ "$rc" -eq 0 ] && [ -n "$dirty" ]; then
		rc=1
	fi
	record C1 "$rc" "candidate source tree is clean at the pinned head"

	blob=$(git -C "$C" rev-parse --verify -q "$PIN_HEAD:$PLAN_PATH")
	rc=$?
	if [ "$rc" -eq 0 ] && [ "$blob" != "$PIN_PLAN_BLOB" ]; then
		rc=1
	fi
	record C2 "$rc" "approved plan text at the head is blob $PIN_PLAN_BLOB"

	kind=$(git -C "$C" cat-file -t "$PIN_REVIEWED_PLAN_BLOB" 2>/dev/null)
	rc=$?
	if [ "$rc" -eq 0 ] && [ "$kind" != "blob" ]; then
		rc=1
	fi
	record C3 "$rc" "R3-reviewed plan blob $PIN_REVIEWED_PLAN_BLOB exists in history"

	# Baseline and mechanical restore (approved plan 3.1).
	git -C "$C" merge-base --is-ancestor "$PIN_REVERT" "$PIN_HEAD" 2>/dev/null
	record B1 "$?" "head is built on the revert of FLY-2919 + FLY-3123"

	names=$(GIT_OPTIONAL_LOCKS=0 git -C "$C" diff --name-only \
		"$PIN_2919_ORIGINAL" "$PIN_2919_RESTORE" -- packages scripts .github 2>/dev/null)
	rc=$?
	if [ "$rc" -eq 0 ] && [ "$names" != "$RESTORE_ONLY_DIFF" ]; then
		rc=1
	fi
	record B2 "$rc" "restore commit equals original FLY-2919 except the FLY-3123 fixture"

	# Approved plan 3.2: query fixes.
	has Q1 "$TL/StateStore.ts" "idx_workflow_run_event_body_death_pending" "workflow body-death replay index"
	has Q2 "$TL/StateStore.ts" "idx_session_events_body_death_pending" "session body-death replay index"
	has Q3 "$TL/StateStore.ts" "idx_lead_events_inbox_pending" "lead inbox expression index"

	# Approved plan 3.3: revert-gap owner reconciliation.
	has R1 "$TL/bridge/execution-process-owner.ts" "reconcile_required" "owner barrier column"
	has R2 "$TL/bridge/execution-body-liveness.ts" "owner_reconciliation_required" "barrier row reads as unknown"
	has R3 "$TL/bridge/process-owner-reconcile.ts" "export" "old-owner reconciler module"

	# Approved plan 4: typed bind diagnostics, window unchanged.
	has D1 "$TL/bridge/execution-process-controller.ts" "const SPAWN_BIND_WINDOW_MS = 30_000;" "bind window stays 30s"
	has D2 "$TL/bridge/execution-process-owner.ts" "last_bind_diagnostic_json" "owner diagnostic projection"
	has D3 "$TL/StateStore.ts" "diagnostic_json" "resume attempt diagnostic column"
	for reason in invalid_input host_boot_mismatch expected_leader_mismatch \
		process_group_empty process_group_too_large worker_unreadable \
		worker_executable_mismatch worker_cwd_mismatch candidate_missing \
		candidate_ambiguous probe_timeout probe_command_failed \
		probe_output_limit snapshot_unstable writers_incomplete \
		nonce_writer_missing daemon_absent daemon_unknown cancelled; do
		has "D4.$reason" "$CR/spawn-bind-diagnostic.ts" "\"$reason\"" "closed bind reason"
	done

	# Approved plan 6.2 / 7: bounded drain and preserved cause.
	has E1 "$CR/execution-process-inspector.ts" "capturePendingExecutionSpawnAbsenceResult" "typed pending-spawn absence proof"
	has E2 "packages/core/src/codex-recovery-failure.ts" "CodexRecoveryCause" "typed recovery cause"
	has E3 "$CR/codex-daemon-goal-runtime.ts" "codex_quota_pre_auth_rejected" "pre-auth rejection keeps its code"

	# Dispatch acceptance supplements 1-3 (shapes 1, 2, 3).
	has S1a "$TL/StateStore.ts" "resume_stale_terminal_revived" "resume takeover revives a stale failed label"
	has S1b "$TL/StateStore.ts" "resume_session_terminal" "non-revivable failed label refuses the resume before any write"
	has S1c "$TL/bridge/workflow-rework-coordinator.ts" "staleTerminalAlive" "rework delivery asks the body truth before returning a failed actor"
	has S1d "$TL/bridge/holder-wake-activation.ts" "wake_stale_terminal_revived" "holder wake revives a failed label only when alive"
	has S2 "$TL/bridge/execution-body-reader.ts" "proveParkedAbsence" "parked body without binding can be proved gone"
	has S3a "$CR/codex-phase-lifecycle.ts" "class ResidentHoldRefusedError" "resident hold refusal is typed"
	has S3b "packages/core/src/adapter-types.ts" "adoptionReleased" "refused adoption is released, not failed"
	has S3c "$TL/bridge/codex-session-reown.ts" "codex_adoption_unsupported" "refused adoption is recorded with its reason"

	# Root-cause regression tests exist at the head.
	has T1 "$TL/__tests__/StateStore.fly3143-query-indexes.test.ts" "idx_lead_events_inbox_pending" "query-plan regression test"
	has T2 "$TL/bridge/__tests__/process-owner-reconcile.test.ts" "reconcile" "revert-gap reconciliation test"

	finish
}

body() {
	id=$1
	DBP=${2:-${FLYWHEEL_STATE_DB_PATH:-}}
	printf '%s' "$id" |
		grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ||
		unverifiable "execution id is not a lowercase UUID"
	[ -n "$DBP" ] || unverifiable "no state DB given and FLYWHEEL_STATE_DB_PATH is unset"
	[ -r "$DBP" ] || unverifiable "state DB is not readable"
	command -v sqlite3 >/dev/null 2>&1 || unverifiable "sqlite3 is not installed"

	# Safe projection only: never selects owner_token, spawn_nonce or binding_json.
	out=$(sqlite3 -readonly "$DBP" "
		SELECT 'session_status=' || COALESCE(s.status, 'missing'),
		       'adapter=' || COALESCE(s.adapter_type, 'missing'),
		       'last_error=' || CASE WHEN COALESCE(s.last_error, '') = '' THEN 'empty' ELSE 'present' END,
		       'owner_generation=' || COALESCE(o.generation, 'none'),
		       'spawn_epoch=' || COALESCE(o.spawn_epoch, 'none'),
		       'binding_spawn_epoch=' || COALESCE(o.binding_spawn_epoch, 'none'),
		       'spawn_inflight=' || COALESCE(o.spawn_inflight, 'none'),
		       'close_requested=' || COALESCE(o.close_requested, 'none'),
		       'reconcile_required=' || COALESCE(o.reconcile_required, 'none'),
		       'bind_attempts=' || COALESCE(o.bind_attempt_count, 'none'),
		       'bind_last_stage=' || COALESCE(json_extract(o.last_bind_diagnostic_json, '\$.last.stage'), 'none'),
		       'bind_last_reason=' || COALESCE(json_extract(o.last_bind_diagnostic_json, '\$.last.reason'), 'none'),
		       'bind_elapsed_ms=' || COALESCE(json_extract(o.last_bind_diagnostic_json, '\$.last.elapsedMs'), 'none'),
		       'bind_os_ms=' || COALESCE(json_extract(o.last_bind_diagnostic_json, '\$.last.osMs'), 'none'),
		       'bind_schedule_lag_ms=' || COALESCE(json_extract(o.last_bind_diagnostic_json, '\$.last.scheduleLagMs'), 'none'),
		       'executable_observed=' || COALESCE(json_extract(o.last_bind_diagnostic_json, '\$.last.observed.executable'), 'none'),
		       'body_state=' || COALESCE(b.state, 'none'),
		       'body_generation=' || COALESCE(b.generation, 'none'),
		       'accepted=' || CASE
		           WHEN o.execution_id IS NOT NULL AND o.spawn_inflight = 0
		                AND o.binding_spawn_epoch IS o.spawn_epoch
		                AND o.close_requested = 0 AND o.reconcile_required = 0
		           THEN 'yes' ELSE 'no' END
		  FROM (SELECT '$id' AS execution_id) k
		  LEFT JOIN sessions s ON s.execution_id = k.execution_id
		  LEFT JOIN execution_process_owner o ON o.execution_id = k.execution_id
		  LEFT JOIN workflow_execution_process_body b ON b.execution_id = k.execution_id;
	" 2>/dev/null) || unverifiable "state DB query failed (schema older than the candidate?)"
	[ -n "$out" ] || unverifiable "state DB query returned nothing"
	echo "execution=$id"
	printf '%s\n' "$out" | tr '|' '\n'

	resumes=$(sqlite3 -readonly "$DBP" "
		SELECT 'resume_attempt id=' || id || ' generation=' || generation ||
		       ' state=' || state || ' reason=' || COALESCE(reason_code, 'none') ||
		       ' startup_ms=' || COALESCE(startup_ms, 'none')
		  FROM workflow_execution_resume_attempt
		 WHERE execution_id = '$id' ORDER BY id;
	" 2>/dev/null) || unverifiable "resume attempt query failed"
	if [ -n "$resumes" ]; then
		printf '%s\n' "$resumes"
	else
		echo "resume_attempt none"
	fi

	case "$out" in
	*"accepted=yes"*)
		record BODY 0 "current spawn of this body was claimed (strict binding accepted)"
		;;
	*)
		record BODY 1 "current spawn of this body was claimed (strict binding accepted)"
		;;
	esac
	finish
}

case "${1:-}" in
candidate) candidate "${2:-}" ;;
body) body "${2:-}" "${3:-}" ;;
*)
	echo "usage: sh verify-candidate.sh candidate [<checkout>] | body <execution-id> [<state-db>]"
	exit 2
	;;
esac
