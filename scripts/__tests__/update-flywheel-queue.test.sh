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
# real ~/.flywheel/.env — else the production bot token + core channel leak into
# this shell and severe_alert→notify_discord would POST real 🚨 alerts to the
# production Discord channel on a configured dev machine (FLY-218/220 spam zone).
# Defense in depth: (c) point ENV_FILE at /dev/null; (b) sandbox HOME; + neutralize
# the notify vars so notify_discord is a guaranteed no-op even if env leaks.
export ENV_FILE=/dev/null
export HOME="${TMP}/home"; mkdir -p "$HOME"
export DISCORD_CORE_CHANNEL="" SIMBA_BOT_TOKEN="" DISCORD_BOT_TOKEN="" NOTIFY_BOT_TOKEN=""
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
rm -rf "$SELF_SHIP_PENDING_DIR" "$SELF_SHIP_BLOCKED_DIR"; ssq_init_dirs
mf="$(ssq_enqueue "$FOREIGN_SHA" "270" "foreign")"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok process_due_markers >/dev/null 2>&1
if [[ "$(ssq_pending_count)" == "0" ]]; then pass "T5 deploy-ok + foreign target → blocked immediately (not transient retry)"; else
  cls="$(ssq_marker_field "$mf" lastErrorClass 2>/dev/null)"
  fail "T5 marker still pending (lastErrorClass=$cls — would retry forever)"; fi
bn="$(find "$SELF_SHIP_BLOCKED_DIR" -name '*.json' | wc -l | tr -d ' ')"
if [[ "$bn" == "1" ]]; then pass "T5b foreign-SHA marker landed in blocked dir"; else fail "T5b blocked count=$bn"; fi

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

echo ""
echo "update-flywheel-queue: PASSED=$PASSED FAILED=$FAILED"
[[ "$FAILED" -eq 0 ]]
