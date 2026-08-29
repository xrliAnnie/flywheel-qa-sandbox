#!/usr/bin/env bash
# FLY-270: tests for update-flywheel.sh queue loop (deploy step stubbed via
# SELF_SHIP_DEPLOY_CMD; ack uses a real tiny git repo as FLYWHEEL_DIR).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/upd.XXXXXX")"
export SELF_SHIP_PENDING_DIR="${TMP}/pending.d"
export SELF_SHIP_BLOCKED_DIR="${TMP}/blocked.d"
export SELF_SHIP_TMP_DIR="${TMP}/tmp"
export SELF_SHIP_LOCK_DIR="${TMP}/lock.d"
export SELF_SHIP_MAX_ATTEMPTS=2
export SELF_SHIP_BASE_BACKOFF=5
export DEPLOYED_SHA_FILE="${TMP}/deployed-sha"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# Tiny git repo whose single commit SHA we use as both marker target and deployed.
export FLYWHEEL_DIR="${TMP}/repo"
git -C / init -q "$FLYWHEEL_DIR" 2>/dev/null || git init -q "$FLYWHEEL_DIR"
git -C "$FLYWHEEL_DIR" config user.email t@t; git -C "$FLYWHEEL_DIR" config user.name t
echo x > "$FLYWHEEL_DIR/x"; git -C "$FLYWHEEL_DIR" add x; git -C "$FLYWHEEL_DIR" commit -qm c1
SHA1="$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)"
# Simulate an origin/main ref at SHA1 so ssq_target_on_origin can be exercised.
git -C "$FLYWHEEL_DIR" update-ref refs/remotes/origin/main "$SHA1"
FOREIGN_SHA="0123456789012345678901234567890123456789"  # valid 40hex, not in repo

# Stub deploys (rc + counter controlled by env).
DEPLOY_CALLS="${TMP}/deploy.calls"; : > "$DEPLOY_CALLS"
stub_deploy_ok()   { echo call >> "$DEPLOY_CALLS"; echo "$SHA1" > "$DEPLOYED_SHA_FILE"; return 0; }
stub_deploy_det()  { echo call >> "$DEPLOY_CALLS"; return 3; }

export UPDATE_FLYWHEEL_SOURCED=1
# HERMETIC GUARD (qa-fly-270 finding): keep update-flywheel.sh from sourcing the
# real ~/.flywheel/.env — else production sender/seam env leaks into this shell
# and severe_alert→lead-alert.sh could POST real 🚨 alerts to the production
# alert channel on a configured dev machine (FLY-218/220 spam zone).
# Defense in depth: (c) point ENV_FILE at /dev/null; (b) sandbox HOME; +
# neutralize the FLY-927/1081 seam family so no real token can resolve even if
# env leaks; and (a) severe_alert hits a FAKE ${FLYWHEEL_DIR}/scripts/
# lead-alert.sh (records argv) — the real alert pipeline never runs here.
export ENV_FILE=/dev/null
export HOME="${TMP}/home"; mkdir -p "$HOME"
export FLYWHEEL_ALERT_SENDER_TOKEN_ENV="" FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="" \
       FLYWHEEL_FOUNDER_USER_ID="" FLYWHEEL_ALERT_TICKETS="" FLYWHEEL_ALERT_RATE_PER_MIN=""
mkdir -p "${FLYWHEEL_DIR}/scripts"
export LA_CALLS="${TMP}/la-calls"; : > "$LA_CALLS"
cat > "${FLYWHEEL_DIR}/scripts/lead-alert.sh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${LA_CALLS}"
exit 0
FAKE
chmod +x "${FLYWHEEL_DIR}/scripts/lead-alert.sh"
# FLY-954: update_main now converges <state>/bin (mount b). A runner-born
# production FLYWHEEL_STATE_DIR would outrank the sandboxed HOME above and the
# converger would "repair" the REAL ~/.flywheel/bin from THIS (possibly branch)
# checkout — exactly the escape shape this issue root-cures for the provision
# suites. Pin the state root inside the sandbox (same defense family as the
# provision suites' _assert_sandboxed_home).
export FLYWHEEL_STATE_DIR="${HOME}/.flywheel"; mkdir -p "$FLYWHEEL_STATE_DIR"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/update-flywheel.sh"

# ── T1: due marker + successful deploy → deploy runs once, marker acked, exit ─
rm -rf "$SELF_SHIP_PENDING_DIR" "$SELF_SHIP_BLOCKED_DIR"; ssq_init_dirs; : > "$DEPLOY_CALLS"
ssq_enqueue "$SHA1" "270" "ok" >/dev/null
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1
calls="$(grep -c call "$DEPLOY_CALLS" || true)"
if [[ "$calls" == "1" ]]; then pass "T1 deploy invoked exactly once"; else fail "T1 deploy calls=$calls"; fi
if [[ "$(ssq_pending_count)" == "0" ]]; then pass "T1b marker acked + cleared after successful deploy"; else fail "T1b marker still pending"; fi

# ── T2: deterministic failure below threshold → marker backed off, still pending ─
rm -rf "$SELF_SHIP_PENDING_DIR" "$SELF_SHIP_BLOCKED_DIR"; ssq_init_dirs
m="$(SELF_SHIP_NOW=1000 ssq_enqueue "$SHA1" "270" "det")"
SELF_SHIP_NOW=1000 SELF_SHIP_DEPLOY_CMD=stub_deploy_det process_due_markers >/dev/null 2>&1
att="$(ssq_marker_field "$m" attempts)"
if [[ "$att" == "1" && -f "$m" ]]; then pass "T2 deterministic failure → attempts=1, marker retained (below threshold)"; else fail "T2 attempts=$att present=$([[ -f $m ]] && echo y || echo n)"; fi

# ── T3: a second due retry reaching threshold → marker blocked (out of watched dir) ─
# Advance pinned time past the backoff so the marker is due again.
SELF_SHIP_NOW=2000 SELF_SHIP_DEPLOY_CMD=stub_deploy_det process_due_markers >/dev/null 2>&1   # attempts→2 == MAX → block
if [[ "$(ssq_pending_count)" == "0" ]]; then pass "T3 marker blocked at threshold (left watched dir → no hot-loop)"; else fail "T3 marker still in watched dir"; fi
bn="$(find "$SELF_SHIP_BLOCKED_DIR" -name '*.json' | wc -l | tr -d ' ')"
if [[ "$bn" == "1" ]]; then pass "T3b blocked marker landed in blocked dir"; else fail "T3b blocked count=$bn"; fi

# ── T4: lock unavailable (held by a live updater) → update_main no-ops, no deploy ─
rm -rf "$SELF_SHIP_PENDING_DIR"; ssq_init_dirs; : > "$DEPLOY_CALLS"
ssq_enqueue "$SHA1" "270" "locked" >/dev/null
_orig_lock_acquire="$(declare -f ssq_lock_acquire)"   # save the real (sourced) fn
ssq_lock_acquire() { return 75; }   # simulate "another live updater holds it"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
eval "$_orig_lock_acquire"          # RESTORE the real fn (unset -f would delete it, not restore)
calls="$(grep -c call "$DEPLOY_CALLS" || true)"
if [[ "$rc" == "0" && "$calls" == "0" ]]; then pass "T4 lock-held → update_main exits 0 without deploying"; else fail "T4 rc=$rc deploy_calls=$calls (expected 0/0)"; fi

# ── T5: deploy OK but target NOT on origin/main (bad/foreign SHA) → blocked NOW,
#        not retried forever as transient (code-review R1 / §2.3#8) ──────────
rm -rf "$SELF_SHIP_PENDING_DIR" "$SELF_SHIP_BLOCKED_DIR"; ssq_init_dirs; : > "$LA_CALLS"
mf="$(ssq_enqueue "$FOREIGN_SHA" "270" "foreign")"
T5_ERR="${TMP}/t5.err"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok process_due_markers >/dev/null 2>"$T5_ERR"
if [[ "$(ssq_pending_count)" == "0" ]]; then pass "T5 deploy-ok + foreign target → blocked immediately (not transient retry)"; else
  cls="$(ssq_marker_field "$mf" lastErrorClass 2>/dev/null)"
  fail "T5 marker still pending (lastErrorClass=$cls — would retry forever)"; fi
bn="$(find "$SELF_SHIP_BLOCKED_DIR" -name '*.json' | wc -l | tr -d ' ')"
if [[ "$bn" == "1" ]]; then pass "T5b foreign-SHA marker landed in blocked dir"; else fail "T5b blocked count=$bn"; fi
# FLY-1081: the blocked-marker severe_alert rides lead-alert.sh with the
# updater system identity + a marker-scoped slug; founder env is EMPTY here →
# no --mention-user flag + a stderr WARNING trace (Codex R2#2).
if grep -q -- "--project flywheel --lead updater --kind deploy_failed --severity severe" "$LA_CALLS"; then
  pass "T5c blocked marker → lead-alert.sh deploy_failed with --lead updater"
else
  fail "T5c lead-alert args wrong: $(cat "$LA_CALLS")"
fi
grep -q -- "--signature marker-not-on-origin-" "$LA_CALLS" \
  && pass "T5d slug carries the marker basename context" || fail "T5d marker slug missing: $(cat "$LA_CALLS")"
grep -q -- "--mention-user" "$LA_CALLS" \
  && fail "T5e founder env empty but --mention-user passed" || pass "T5e founder env empty → no --mention-user flag"
grep -qi "WARNING.*FLYWHEEL_FOUNDER_USER_ID" "$T5_ERR" \
  && pass "T5f founder env empty → stderr WARNING trace" || fail "T5f no stderr WARNING: $(cat "$T5_ERR")"

# ── T6: watched dir with ONLY invalid entries → update_main quarantines them,
#        ends with pending empty + no deploy (no QueueDirectories hot-loop) ────
#        (code-review R2 HIGH-1) ─────────────────────────────────────────────
rm -rf "$SELF_SHIP_PENDING_DIR" "$SELF_SHIP_BLOCKED_DIR" "$SELF_SHIP_LOCK_DIR"; ssq_init_dirs; : > "$DEPLOY_CALLS"
echo "{ not valid json" > "${SELF_SHIP_PENDING_DIR}/corrupt.json"
touch "${SELF_SHIP_PENDING_DIR}/.DS_Store"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1
calls="$(grep -c call "$DEPLOY_CALLS" || true)"
if [[ "$(ssq_pending_count)" == "0" ]]; then pass "T6 invalid-only dir → quarantined, pending empty (no hot-loop)"; else fail "T6 invalid entries left in watched dir"; fi
if [[ "$calls" == "0" ]]; then pass "T6b invalid-only dir → no deploy attempted"; else fail "T6b deploy ran on invalid-only dir ($calls)"; fi
cj="$(find "$SELF_SHIP_BLOCKED_DIR" -type f | wc -l | tr -d ' ')"
if (( cj >= 1 )); then pass "T6c corrupt entry quarantined to blocked dir"; else fail "T6c corrupt not quarantined"; fi

# ── T7 (QA FLY-739 regression guard): a SATISFIED marker is acked EVEN WHEN the
#        deployment-event report is not durable. The report is a secondary best-effort
#        side-effect; it must never wedge the self-ship pipeline or severe_alert Annie
#        (the prior "keep the marker + block+alert on report failure" was the bug that
#        broke every self-ship deploy in prod because the updater env had no bridge url).
rm -rf "$SELF_SHIP_PENDING_DIR" "$SELF_SHIP_BLOCKED_DIR"; ssq_init_dirs
ssq_enqueue "$SHA1" "727" "reportfail" >/dev/null
_orig_report="$(declare -f report_deployment)"      # save the real (sourced) fn
report_deployment() { return 1; }                   # simulate a non-durable report
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok process_due_markers >/dev/null 2>&1
eval "$_orig_report"                                 # RESTORE the real fn
if [[ "$(ssq_pending_count)" == "0" ]]; then pass "T7 satisfied marker acked despite a non-durable deployment report"; else fail "T7 marker wedged on report failure"; fi
bn="$(find "$SELF_SHIP_BLOCKED_DIR" -name '*.json' | wc -l | tr -d ' ')"
if [[ "$bn" == "0" ]]; then pass "T7b non-durable report did NOT block the marker (no severe_alert)"; else fail "T7b marker blocked on report failure ($bn)"; fi

echo ""
echo "update-flywheel-queue: PASSED=$PASSED FAILED=$FAILED"
[[ "$FAILED" -eq 0 ]]
