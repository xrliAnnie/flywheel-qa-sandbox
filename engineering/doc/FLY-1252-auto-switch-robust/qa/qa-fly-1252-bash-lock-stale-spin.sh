#!/usr/bin/env bash
# FLY-1252 QA — bash twin of advisory ③ (lock busy-loop), independent repro.
#
# The Node side of the shared mkdir lock was fixed (mkdir-lock.ts:286 fails loudly
# on non-EEXIST; every wait branch checks the deadline and sleeps). The BASH side
# of the SAME lock — added by this PR — did not get the same treatment:
#
#   while ! mkdir "$LOCK_DIR" 2>/dev/null; do
#     if lock_is_stale; then break_stale_lock || true; continue; fi   # <-- skips both
#     [[ $(now_ms) -ge $deadline ]] && fail "timeout acquiring lock $LOCK_DIR"
#     sleep 0.05
#   done
#
# The stale branch's `continue` bypasses BOTH the deadline check and the 50ms
# backoff. Any state where lock_is_stale stays true while break_stale_lock keeps
# failing is an unbounded, fork-heavy spin: LOCK_TIMEOUT_MS can never fire.
#
# Reachable trigger: break_stale_lock (:207-209) renames the holder marker to
# "$LOCK_DIR/.stale-break.$$.$RANDOM" and then rm -f's it. A breaker killed
# between the mv and the rm leaves that claim file orphaned. Afterwards no
# holder.* marker matches, the dir ages past staleMs -> lock_is_stale=true ->
# rmdir fails ENOTEMPTY forever -> infinite spin. Nothing reclaims .stale-break.*
# residue, so the lock is poisoned for bash AND Node until a human rm -rf's it.
#
# This script is a two-arm experiment. The CONTROL arm is what makes the WEDGED
# arm meaningful: without it, "the process didn't exit" could just mean the
# harness never reached the acquire loop at all.
#
#   CONTROL: lock held by a LIVE holder  -> must exit ~LOCK_TIMEOUT_MS with
#                                           "timeout acquiring lock" (deadline works,
#                                           and we PROVED we reach the loop).
#   WEDGED : lock poisoned with orphaned .stale-break.* + aged mtime
#                                        -> BUG: never exits (deadline unreachable).
#
# Exit 0 = both arms behaved correctly (bounded)  -> bug is FIXED.
# Exit 1 = wedged arm span past the budget         -> bug is PRESENT.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PROFILE_BIN="$REPO/packages/claude-runner/bin/flywheel-claude-profile"
BUDGET_S="${FLY1252_BASH_LOCK_BUDGET_S:-10}"
TIMEOUT_MS=2000

log() { echo "[FLY-1252 QA bash-lock] $*"; }

run_arm() { # $1=arm name, $2=scratch root; echoes "elapsed_ms|exit|cpu"
  local arm="$1" root="$2"
  local pool="$root/pool" lock="$root/accounts.lock"
  mkdir -p "$pool"
  # Minimal hermetic env: scratch pool/store/lock, stubbed side effects.
  cat > "$root/stub" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$root/stub"

  # FAKE `security` bin — MANDATORY (red line: never touch the real Keychain).
  # A fake SERVICE NAME is NOT enough: the script would still exec the real
  # /usr/bin/security and create a genuine login-keychain item under that name.
  # The script exposes FLYWHEEL_CLAUDE_SECURITY_BIN (:75) exactly for this.
  cat > "$root/fake-security" <<'EOF'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  find-generic-password)
    [[ -f "$FAKE_SEC_STATE" ]] || { echo "could not be found" >&2; exit 44; }
    cat "$FAKE_SEC_STATE"
    ;;
  -i)
    cmd=$(cat)
    val=$(printf '%s' "$cmd" | sed -n 's/.* -w \([^ ]*\).*/\1/p')
    [[ -z "$val" ]] && exit 1
    printf '%s' "$val" > "$FAKE_SEC_STATE"
    ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$root/fake-security"
  export FLYWHEEL_CLAUDE_SECURITY_BIN="$root/fake-security"
  export FAKE_SEC_STATE="$root/fake-sec-state"
  printf '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-QA-OLD","refreshToken":"r0"}}' \
    > "$FAKE_SEC_STATE"
  # Pool layout is pool/<name>/.credentials.json (flywheel-claude-profile:428-430).
  # Getting this wrong makes the script die with "pool profile not found" BEFORE it
  # ever reaches the acquire loop — which silently invalidates the control arm.
  mkdir -p "$pool/school"
  printf '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-QA","refreshToken":"r"}}' \
    > "$pool/school/.credentials.json"
  chmod 600 "$pool/school/.credentials.json"
  printf '{"generation":1,"activeAccount":"shopping","accounts":[{"name":"shopping","quotaExhaustedUntil":null},{"name":"school","quotaExhaustedUntil":null}]}' \
    > "$root/accounts.json"

  "$PROFILE_BIN" use school >"$root/out" 2>&1 &
  local pid=$!
  local start
  start=$(python3 -c 'import time;print(int(time.time()*1000))')
  local i=0 cpu=""
  while [ "$i" -lt "$((BUDGET_S * 10))" ]; do
    kill -0 "$pid" 2>/dev/null || break
    perl -e 'select(undef,undef,undef,0.1)'
    i=$((i + 1))
  done
  local elapsed exit_code
  elapsed=$(( $(python3 -c 'import time;print(int(time.time()*1000))') - start ))
  if kill -0 "$pid" 2>/dev/null; then
    cpu="$(ps -o %cpu= -p "$pid" 2>/dev/null | tr -d ' ')"
    # Kill the whole group: the script may have spawned children.
    kill -9 "$pid" 2>/dev/null || true
    pkill -9 -P "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    echo "SPINNING|-|${cpu:-?}"
  else
    wait "$pid" 2>/dev/null; exit_code=$?
    echo "${elapsed}|${exit_code}|-"
  fi
}

export FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS="$TIMEOUT_MS"
export FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE="QA-FLY1252-FAKE-BIN-ONLY"
export FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT="qa-testacct"

# ---------------- CONTROL: live holder ----------------
CTRL="$(mktemp -d "${TMPDIR:-/tmp}/fly1252-bashlock-ctrl.XXXXXX")"
mkdir -p "$CTRL/accounts.lock"
sleep 100000 & LIVE=$!            # a genuinely live holder PID
# MUST match the script's own process_start_time() byte-for-byte
# (flywheel-claude-profile:138-140 = `ps -o lstart=` + trim ONLY the ends).
# Using `tr -s ' '` here squeezes INTERNAL spaces, the stored start time then
# mismatches the live one, lock_is_stale() reads it as PID-reuse -> "stale" ->
# the control's holder gets broken and the control silently stops being a control.
START_T="$(ps -o lstart= -p $LIVE 2>/dev/null | sed 's/^ *//;s/ *$//')"
printf '{"pid":%d,"at":%d,"token":"ctrl","processStartTime":"%s"}' \
  "$LIVE" "$(python3 -c 'import time;print(int(time.time()*1000))')" "$START_T" \
  > "$CTRL/accounts.lock/holder.$LIVE.ctrl"
export FLYWHEEL_CLAUDE_ACCOUNTS_LOCK="$CTRL/accounts.lock"
export FLYWHEEL_CLAUDE_ACCOUNTS_PATH="$CTRL/accounts.json"
export FLYWHEEL_CLAUDE_PROFILES_DIR="$CTRL/pool"
export FLYWHEEL_CLAUDE_JSON_LOCK="$CTRL/claude.json.lock"
export FLYWHEEL_LEAD_ALERT_BIN="$CTRL/stub"
export FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN="$CTRL/stub"
export FLYWHEEL_CLAUDE_FRESHNESS_BIN="$CTRL/stub"
CTRL_RES="$(run_arm control "$CTRL")"
CTRL_OUT="$(cat "$CTRL/out" 2>/dev/null | tr '\n' ' ')"
kill -9 $LIVE 2>/dev/null || true
log "CONTROL (live holder): $CTRL_RES"
log "CONTROL says: ${CTRL_OUT:-<no output>}"
# The control is only a valid positive control if it settled BY HITTING THE LOCK
# DEADLINE. If it exits early for any other reason (bad pool, bad store, ...) it
# never reached the acquire loop and proves nothing about the wedged arm.
if [[ "$CTRL_OUT" != *"timeout acquiring lock"* ]]; then
  log "INVALID: the CONTROL arm did NOT fail with 'timeout acquiring lock' — it exited"
  log "         for an unrelated reason, so it does not prove the acquire loop is"
  log "         reachable. The wedged arm's result is therefore meaningless. Fix the harness."
  rm -rf "$CTRL"
  exit 2
fi

# ---------------- WEDGED: orphaned .stale-break residue ----------------
WEDGE="$(mktemp -d "${TMPDIR:-/tmp}/fly1252-bashlock-wedge.XXXXXX")"
mkdir -p "$WEDGE/accounts.lock"
# Exactly what a breaker killed between `mv` and `rm -f` leaves behind:
printf '{"pid":424242,"at":1,"token":"orphan"}' \
  > "$WEDGE/accounts.lock/.stale-break.424242.7"
# Age the dir past the 120s staleness fallback so lock_is_stale() stays true.
touch -t 202001010000 "$WEDGE/accounts.lock"
export FLYWHEEL_CLAUDE_ACCOUNTS_LOCK="$WEDGE/accounts.lock"
export FLYWHEEL_CLAUDE_ACCOUNTS_PATH="$WEDGE/accounts.json"
export FLYWHEEL_CLAUDE_PROFILES_DIR="$WEDGE/pool"
export FLYWHEEL_CLAUDE_JSON_LOCK="$WEDGE/claude.json.lock"
export FLYWHEEL_LEAD_ALERT_BIN="$WEDGE/stub"
export FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN="$WEDGE/stub"
export FLYWHEEL_CLAUDE_FRESHNESS_BIN="$WEDGE/stub"
WEDGE_RES="$(run_arm wedged "$WEDGE")"
log "WEDGED  (.stale-break orphan): $WEDGE_RES"

rm -rf "$CTRL" "$WEDGE"

# ---------------- verdict ----------------
if [[ "$CTRL_RES" == SPINNING* ]]; then
  log "INVALID: the CONTROL arm never settled either — the harness is not reaching"
  log "         the acquire loop, so the wedged arm proves nothing. Fix the harness."
  exit 2
fi
if [[ "$WEDGE_RES" == SPINNING* ]]; then
  log "FAIL: bash acquire loop SPINS FOREVER on orphaned .stale-break residue"
  log "      (control settled in ${CTRL_RES%%|*}ms via the deadline, so the loop IS reachable"
  log "       and LOCK_TIMEOUT_MS=${TIMEOUT_MS} DOES work on the non-stale path)."
  log "      Site: packages/claude-runner/bin/flywheel-claude-profile:379-383 —"
  log "      the stale branch's \`continue\` bypasses the deadline check AND sleep 0.05."
  log "      Same bug class as advisory ③, unfixed on the bash side of the same lock."
  exit 1
fi
log "PASS: both arms bounded — control=${CTRL_RES}, wedged=${WEDGE_RES}"
exit 0
