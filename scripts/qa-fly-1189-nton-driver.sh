#!/usr/bin/env bash
# FLY-1189 H3: N-to-N scenario driver + TRAP OWNER.
#
# The fault injector (qa-fly-1189-fault-inject.sh) deliberately registers NO
# EXIT trap — a one-shot injector self-recovering on exit would SIGCONT and
# destroy the scenario. So the DRIVER owns the recovery lifecycle (plan §A):
# it registers an idempotent EXIT/INT/TERM trap BEFORE any mutation and calls
# the injector's `recover-from-journal` on death, so a killed driver never
# leaves a real runner frozen or its worktree moved.
#
# The driver provides the primitives the QA-phase session composes into the
# §D scenario matrix (inject / poll_assert / recover), plus:
#   - `selftest`  — proves the trap + injector wiring with no real runner.
#   - `s1-detect` — a worked, parameterized real scenario (inject a fault on a
#                   named execId, poll for its detection episode, recover) that
#                   the QA session copies/parameterizes per matrix row.
#
# Evidence lands in --campaign-root (OUTSIDE any SLOT_DIR — teardown wipes
# SLOT_DIR). Real work needs a deployed slot Bridge + real test runners; those
# are provided by the QA-phase deploy, not by this driver.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INJECTOR="${QA1189_INJECTOR:-${SCRIPT_DIR}/qa-fly-1189-fault-inject.sh}"

# shellcheck source=lib/qa-fly-1189-assert.sh
source "${SCRIPT_DIR}/lib/qa-fly-1189-assert.sh"

log() { echo "[qa-fly-1189-driver] $(date +%H:%M:%S 2>/dev/null || echo now) $*" >&2; }
die() { echo "[qa-fly-1189-driver] ERROR: $*" >&2; exit 1; }

# ── Args ───────────────────────────────────────────────────────────────────
SCENARIO=""
CAMPAIGN_ROOT="${QA1189_CAMPAIGN_ROOT:-}"
TARGET_EXEC=""
INJECT_VERB="freeze"
ASSERT_TIMEOUT_S=180
while [[ $# -gt 0 ]]; do
	case "$1" in
		--scenario)       SCENARIO="${2:?}"; shift 2 ;;
		--scenario=*)     SCENARIO="${1#*=}"; shift ;;
		--campaign-root)  CAMPAIGN_ROOT="${2:?}"; shift 2 ;;
		--campaign-root=*) CAMPAIGN_ROOT="${1#*=}"; shift ;;
		--exec)           TARGET_EXEC="${2:?}"; shift 2 ;;
		--exec=*)         TARGET_EXEC="${1#*=}"; shift ;;
		--inject)         INJECT_VERB="${2:?}"; shift 2 ;;
		--inject=*)       INJECT_VERB="${1#*=}"; shift ;;
		--assert-timeout) ASSERT_TIMEOUT_S="${2:?}"; shift 2 ;;
		--assert-timeout=*) ASSERT_TIMEOUT_S="${1#*=}"; shift ;;
		-h|--help) sed -n '2,30p' "$0"; exit 0 ;;
		*) die "unknown argument '$1'" ;;
	esac
done

[[ -n "$CAMPAIGN_ROOT" ]] || die "--campaign-root is required (evidence must land outside SLOT_DIR)"
[[ -n "$SCENARIO" ]] || die "--scenario is required"
mkdir -p "$CAMPAIGN_ROOT"
export QA1189_CAMPAIGN_ROOT="$CAMPAIGN_ROOT"

# ── Injector delegation (all mutations go through the S1-locked injector) ──
# QA1189_COMM_DB (the slot's CommDB, holding the authoritative tmux_window per
# execId) is passed through to the injector's resolver. The QA phase sets it to
# the slot's comm.db; without it the injector cannot resolve a real target and
# fail-closes (present=false).
inject() { # verb execId
	local verb="$1" execId="${2:-}"
	log "inject ${verb} ${execId}"
	QA1189_COMM_DB="${QA1189_COMM_DB:-}" bash "$INJECTOR" "$verb" "$execId"
}

# ── TRAP OWNER (plan §A) ───────────────────────────────────────────────────
# Registered BEFORE any mutation; idempotent so an explicit recover + the EXIT
# trap firing again is a safe no-op. Calls the injector's recover-from-journal,
# which restores frozen/broken targets using ONLY journaled identities and
# re-verifies start-time before SIGCONT (never resumes a recycled PID).
_QA1189_RECOVERED=0
driver_recover() {
	(( _QA1189_RECOVERED == 1 )) && return 0
	log "recovering via injector recover-from-journal (trap owner)"
	# Codex R1 HIGH #5: set the recovered latch ONLY after recovery actually
	# succeeds, and PROPAGATE failure. Marking recovered=1 before the call (as
	# before) meant a FAILED recovery both exited 0 AND suppressed the EXIT
	# trap's retry — leaving a real runner frozen. Now a failure keeps the trap
	# armed so a subsequent EXIT firing retries.
	if bash "$INJECTOR" recover-from-journal; then
		_QA1189_RECOVERED=1
		return 0
	fi
	log "WARN: recover-from-journal FAILED — recovery latch left OFF for retry"
	return 1
}
register_recovery_trap() {
	trap 'driver_recover' EXIT INT TERM
}

# ── Poll an assertion until PASS or timeout ────────────────────────────────
# Args: timeoutSeconds assertFn [args...]
poll_assert() {
	local timeout="$1"; shift
	local waited=0 out
	while (( waited < timeout )); do
		out=$("$@" 2>/dev/null || true)
		if grep -q "^PASS" <<<"$out"; then
			echo "$out"
			return 0
		fi
		sleep 3
		waited=$((waited + 3))
	done
	# Final attempt (emit the FAIL evidence).
	out=$("$@" 2>/dev/null || true)
	echo "$out"
	grep -q "^PASS" <<<"$out"
}

# ── Scenarios ──────────────────────────────────────────────────────────────

# selftest: proves the trap + injector wiring with NO real runner. Registers
# the recovery trap, then calls the injector's blocking op (freeze). Against
# the real injector on a non-existent execId this fails the anchor and returns
# fast; against the test stub it blocks so the harness can SIGINT and observe
# the trap firing recover-from-journal.
scenario_selftest() {
	register_recovery_trap
	log "selftest: entering injector freeze (interruptible)"
	inject freeze "${TARGET_EXEC:-selftest-exec}" || true
	# Normal completion → explicit recover (idempotent with the EXIT trap).
	# Codex R2 #6: PROPAGATE a recovery failure as a non-zero scenario exit
	# (the trap keeps retrying; the caller must see the failure).
	driver_recover || die "selftest: recovery FAILED"
	log "selftest complete"
}

# s1-detect: worked, parameterized real scenario the QA session reuses per §D
# row. Injects a fault on --exec, polls for the detection episode, then
# recovers. Requires a deployed slot Bridge (QA1189_SLOT_DIR/teamlead.db).
scenario_s1_detect() {
	[[ -n "$TARGET_EXEC" ]] || die "s1-detect requires --exec <execId>"
	local db="${QA1189_SLOT_DIR:?QA1189_SLOT_DIR required}/teamlead.db"
	register_recovery_trap
	log "s1-detect: injecting ${INJECT_VERB} on ${TARGET_EXEC}"
	inject "$INJECT_VERB" "$TARGET_EXEC" || die "injection refused (S1 anchor) for ${TARGET_EXEC}"

	# Codex R2 #7: POLL for the detection episode to APPEAR (fingerprint read
	# back from the server row) within the timeout. The old one-shot read meant
	# a not-yet-landed detection produced an empty fingerprint → the assert was
	# skipped → recover → exit 0 = FALSE GREEN. Now: if no episode ever lands,
	# that is a detection FAILURE (rc=1). Once it lands we assert it reaches at
	# least LEAD_NOTIFIED.
	log "s1-detect: polling for detection episode (timeout ${ASSERT_TIMEOUT_S}s)"
	local waited=0 fp="" rc=0
	while (( waited < ASSERT_TIMEOUT_S )); do
		fp=$(sqlite3 "file:${db}?mode=ro" \
			"SELECT episode_fingerprint FROM detection_escalations WHERE target_key='${TARGET_EXEC}' ORDER BY first_detected_at_ms DESC LIMIT 1;" 2>/dev/null || echo "")
		[[ -n "$fp" ]] && break
		sleep 3
		waited=$((waited + 3))
	done
	if [[ -z "$fp" ]]; then
		echo "FAIL s1-detect detection episode never landed for ${TARGET_EXEC} within ${ASSERT_TIMEOUT_S}s"
		rc=1
	else
		local out
		out=$(poll_assert "$ASSERT_TIMEOUT_S" assert_episode "$db" "$TARGET_EXEC" detection_stuck_confirmed "$fp" LEAD_NOTIFIED)
		echo "$out"
		grep -q "^PASS" <<<"$out" || rc=1
	fi
	driver_recover || { die "s1-detect: recovery FAILED"; }
	log "s1-detect complete"
	return "$rc"
}

# s11-taint: the E5 zero-production-impact gate (plan §D S11). Runs BOTH the
# production-taint attribution scan (assert_prod_taint, from the sourced assert
# lib) AND the injector's journal all-in-safe-root invariant. Prod DB paths +
# campaign markers come from env (the QA-phase deploy provides them). No fault
# injection — read-only.
scenario_s11_taint() {
	# Codex R3: REQUIRE explicit production DB paths — a wrong/absent default
	# would silently skip the production CommDB scan (absent DB = "clean"). The
	# QA phase passes the real prod StateStore + CommDB paths.
	local state_db="${QA1189_PROD_STATE_DB:?s11-taint requires QA1189_PROD_STATE_DB (real prod StateStore)}"
	local comm_db="${QA1189_PROD_COMM_DB:?s11-taint requires QA1189_PROD_COMM_DB (real prod CommDB)}"
	local out rc=0
	log "s11-taint: production attribution scan (state=${state_db} comm=${comm_db})"
	out=$(assert_prod_taint "$state_db" "$comm_db" \
		"${QA1189_CAMPAIGN_ID:-unknown}" "${QA1189_TEST_PROJECT:-test-slot}" \
		${QA1189_TAINT_MARKERS:-})
	echo "$out"
	grep -q "^PASS" <<<"$out" || rc=1
	log "s11-taint: journal all-in-safe-root invariant"
	if bash "$INJECTOR" verify-safe-root; then
		echo "PASS safe_root journal all-in-safe-root invariant holds"
	else
		echo "FAIL safe_root a journaled path is outside the slot/quarantine safe roots"
		rc=1
	fi
	return "$rc"
}

case "$SCENARIO" in
	selftest)  scenario_selftest ;;
	s1-detect) scenario_s1_detect ;;
	s11-taint) scenario_s11_taint ;;
	*) die "unknown scenario '${SCENARIO}' (known: selftest, s1-detect, s11-taint; the QA session composes the remaining §D rows from the inject/poll_assert/recover primitives + the assert lib)" ;;
esac
# Propagate the scenario's verdict as the script exit code (Codex R2 #6): a
# failed assertion / failed detection / failed recovery must surface non-zero.
exit $?
