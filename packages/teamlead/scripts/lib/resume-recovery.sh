#!/bin/bash
# FLY-1389 P0-b/P0-c: resume-recovery decision + transcript diagnostic for
# the claude-lead.sh supervisor loop.
#
# Incident (529 Room, 2026-07-20): a stale session-id made every
# `claude --resume` fail deterministically in 10-15s. The old inline
# heuristic only counted resume failures with DURATION < 10 — a 10-15s
# deterministic failure fell into the else branch, RESET the counter, and
# the fresh-start fallback never fired. The Lead resumed the poisoned
# session 9 times with 0 successes while test-deploy's lease wait timed out.
#
# Fix: the resume-failure window is 60s, aligned with the CRASH_COUNT
# health line ("ran >60s" = healthy run). A deterministic resume failure now
# reaches the fresh-start fallback after RESUME_FAIL_THRESHOLD consecutive
# quick deaths (worst case ~3 minutes including backoff).
#
# Pure functions only — no sleeps, no timers, no state. claude-lead.sh
# sources this file and drives it from the supervisor loop; the hermetic
# suite (packages/teamlead/scripts/__tests__/claude-lead-resume-recovery.test.sh)
# drives it with fake durations and includes a mutation guard pinning the
# 60s window. Bash 3.2 compatible.

# Resume failures faster than this are treated as possible deterministic
# resume corruption. Same constant as the supervisor's "healthy run" line —
# runs LONGER than this reset the crash counter.
RESUME_FAIL_WINDOW_SECONDS=60

# resume_recovery_decide <is_resume> <duration_s> <resume_fail_count> \
#                        <resume_fail_threshold> <crash_count>
#
# <crash_count> is the ALREADY-INCREMENTED count for this crash (the caller
# increments + logs before deciding, keeping its log output unchanged).
#
# stdout: "<action> <new_resume_fail_count> <new_crash_count>"
#   action ∈ delete_session     — threshold reached: caller removes the
#                                 session-id file (fresh start next loop)
#            count_resume_fail  — quick resume failure counted, under
#                                 threshold
#            reset_resume_fail  — not a quick resume failure: reset counter
resume_recovery_decide() {
	local is_resume="$1" duration="$2" fail_count="$3" threshold="$4" crash_count="$5"
	local action
	if [ "$is_resume" -eq 1 ] && [ "$duration" -lt "$RESUME_FAIL_WINDOW_SECONDS" ]; then
		fail_count=$((fail_count + 1))
		if [ "$fail_count" -ge "$threshold" ]; then
			action="delete_session"
			fail_count=0
		else
			action="count_resume_fail"
		fi
	else
		action="reset_resume_fail"
		fail_count=0
	fi
	# Healthy-run crash-window reset (verbatim supervisor semantics: >60s).
	if [ "$duration" -gt 60 ]; then
		crash_count=1
	fi
	echo "$action $fail_count $crash_count"
}

# resume_transcript_diagnose <claude_config_dir> <workspace> <session_id>
#
# DIAGNOSTIC ONLY (P0-b): computes the transcript path `claude --resume`
# will need — <config>/projects/<slug(workspace physical abs path)>/<id>.jsonl,
# slug = '/' and '.' replaced by '-' — and reports its existence in ONE log
# line. The slug rule is a Claude Code internal convention with no stable
# contract, so this NEVER deletes or mutates anything (deletion authority
# lives with the P0-c counter above and test-deploy's P0-d pre-delete).
# Always rc=0.
resume_transcript_diagnose() {
	local cfg="${1:-}" ws="${2:-}" sid="${3:-}"
	[ -n "$cfg" ] || cfg="${HOME}/.claude"
	if ! printf '%s' "$sid" | grep -qE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
		echo "resume-precheck: session id is not a UUID ('${sid}') — skipping transcript existence check"
		return 0
	fi
	local ws_phys
	if ! ws_phys="$(cd "$ws" 2>/dev/null && pwd -P)"; then
		echo "resume-precheck: workspace '${ws}' not resolvable — skipping transcript existence check"
		return 0
	fi
	local slug path
	slug="$(printf '%s' "$ws_phys" | tr '/.' '--')"
	path="${cfg}/projects/${slug}/${sid}.jsonl"
	if [ -f "$path" ]; then
		echo "resume-precheck: transcript present: ${path}"
	else
		echo "resume-precheck: transcript MISSING: ${path} — resume will likely fail; deterministic failures fall back to fresh start after ${RESUME_FAIL_THRESHOLD:-3} quick deaths (FLY-1389)"
	fi
	return 0
}
