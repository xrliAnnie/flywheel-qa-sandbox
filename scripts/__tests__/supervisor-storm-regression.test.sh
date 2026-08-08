#!/bin/bash
# FLY-1659: steady-state supervisor paths stay bounded and lock-free.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEAD_SH="$ROOT/packages/teamlead/scripts/claude-lead.sh"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$*" >&2; }

echo "[TEST] frozen pre-fix takeover reproduces the three-supervisor hold storm"
PREF_FIXTURE="$ROOT/scripts/__tests__/fixtures/fly1659/pre-fix-prepare-lead-launch.sh"
PREF_EXPECTED_SHA=56c879bf53f8dcef800747562501c8d3213e9f4e9d4453fb26ded3baa83fa46e
if [ ! -f "$PREF_FIXTURE" ]; then
  fail "frozen pre-fix fixture is missing"
else
  PREF_BODY="$(sed -n '/^_prepare_lead_launch()/,/^}/p' "$PREF_FIXTURE")"
  PREF_ACTUAL_SHA="$(printf '%s\n' "$PREF_BODY" | shasum -a 256 | awk '{print $1}')"
  PREF_ROOT="$(mktemp -d -t fly1659-pref.XXXXXX)"
  PREF_RESULTS="$PREF_ROOT/results"
  : > "$PREF_RESULTS"
  for supervisor in 1 2 3; do
    (
      # shellcheck disable=SC1090
      source "$PREF_FIXTURE"
      PROJECT_NAME=flywheel
      LEAD_ID="lead-${supervisor}"
      TMUX_ARCHIVE_FILE="$PREF_ROOT/${supervisor}.tmux"
      : > "$TMUX_ARCHIVE_FILE"
      TMUX_RELAUNCH_PROVEN=0
      TMUX_SERVER_PID=4100
      tmux_supervisor_archive_read() {
        TMUX_ARCHIVE_SERVER_PID=4100
        return 0
      }
      tmux_supervisor_archived_process_alive() { return 0; }
      tmux_supervisor_reap_archived_process() { return 9; }
      _tmux_generation_is_current() { return 0; }
      _tmux() { return 1; }
      for iteration in 1 2; do
        pref_rc=0
        _prepare_lead_launch || pref_rc=$?
        printf '%s\t%s\t%s\t%s\t%s\n' \
          "$supervisor" "$iteration" "$pref_rc" "$ENSURE_HOLD_KIND" \
          "$([ -f "$TMUX_ARCHIVE_FILE" ] && echo preserved || echo lost)" \
          >> "$PREF_RESULTS"
      done
    ) &
  done
  wait
  PREF_BAD="$(awk -F '\t' '$3 != 3 || $4 != "ambiguous" || $5 != "preserved" {n++} END {print n+0}' "$PREF_RESULTS")"
  PREF_COUNT="$(wc -l < "$PREF_RESULTS" | tr -d ' ')"
  if grep -q 'source-commit: 4857d999e353c7f3c0ed043208402943f4a0e9b8' "$PREF_FIXTURE" \
    && [ "$PREF_ACTUAL_SHA" = "$PREF_EXPECTED_SHA" ] \
    && [ "$PREF_COUNT" -eq 6 ] \
    && [ "$PREF_BAD" -eq 0 ]; then
    pass "three cold supervisors deterministically repeat the archived-live hold"
  else
    fail "positive control drifted checksum=$PREF_ACTUAL_SHA rows=$PREF_COUNT bad=$PREF_BAD"
  fi
  rm -rf "$PREF_ROOT"
fi

GEN_SRC="$(sed -n '/^_tmux_generation_probe()/,/^}/p' "$LEAD_SH")"
if [ -z "$GEN_SRC" ]; then
  fail "production launcher is missing the bounded generation probe"
  printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi
eval "$GEN_SRC"

PROBE_MODE=same
_tmux_socket_path() { printf '/tmp/fly1659.sock\n'; }
_tmux_rescue_effective_timeout() { printf '1\n'; }
tmux_rescue_probe() {
  case "$PROBE_MODE" in
    same) printf '4100\n'; return 0 ;;
    changed) printf '4200\n'; return 0 ;;
    malformed) printf 'not-a-pid\n'; return 0 ;;
    error) return 124 ;;
  esac
}

echo "[TEST] bounded generation probe has typed same/changed/indeterminate exits"
PROBE_MODE=same
_tmux_generation_probe 4100 >/dev/null
SAME_RC=$?
PROBE_MODE=changed
_tmux_generation_probe 4100 >/dev/null
CHANGED_RC=$?
PROBE_MODE=malformed
_tmux_generation_probe 4100 >/dev/null
MALFORMED_RC=$?
PROBE_MODE=error
_tmux_generation_probe 4100 >/dev/null
ERROR_RC=$?
if [ "$SAME_RC" -eq 0 ] \
  && [ "$CHANGED_RC" -eq 1 ] \
  && [ "$MALFORMED_RC" -eq 2 ] \
  && [ "$ERROR_RC" -eq 2 ]; then
  pass "cheap generation evidence distinguishes drift from transport noise"
else
  fail "generation probe exits drifted: same=$SAME_RC changed=$CHANGED_RC malformed=$MALFORMED_RC error=$ERROR_RC"
fi

echo "[TEST] reserved-ledger probes distinguish dead generations from sensor noise"
GEN_STATE_SRC="$(sed -n '/^_lead_tmux_generation_state()/,/^}/p' "$LEAD_SH")"
RESERVED_SNAPSHOT_SRC="$(sed -n '/^_lead_reserved_snapshot()/,/^}/p' "$LEAD_SH")"
RESERVED_WINDOW_SRC="$(sed -n '/^_lead_reserved_window_probe()/,/^}/p' "$LEAD_SH")"
RESERVED_ANY_SRC="$(sed -n '/^_lead_reserved_any_probe()/,/^}/p' "$LEAD_SH")"
if [ -z "$GEN_STATE_SRC" ] || [ -z "$RESERVED_SNAPSHOT_SRC" ] \
  || [ -z "$RESERVED_WINDOW_SRC" ] || [ -z "$RESERVED_ANY_SRC" ]; then
  fail "production launcher is missing typed dead-generation ledger probes"
else
  eval "$GEN_STATE_SRC"
  eval "$RESERVED_SNAPSHOT_SRC"
  eval "$RESERVED_WINDOW_SRC"
  eval "$RESERVED_ANY_SRC"
  PROJECT_NAME=flywheel
  LEAD_ID=eng-lead
  LEAD_PENDING_EXPECTED_SERVER_PID=4100
  PRESENCE_MODE=live
  _tmux_supervisor_process_presence_state() {
    [ "$PRESENCE_MODE" = dead ] && return 1
    [ "$PRESENCE_MODE" = error ] && return 2
    return 0
  }
  PROBE_MODE=changed
  _lead_reserved_window_probe n-dead >/dev/null 2>&1
  RESERVED_CHANGED_RC=$?
  PROBE_MODE=error
  PRESENCE_MODE=dead
  _lead_reserved_window_probe n-dead >/dev/null 2>&1
  RESERVED_DEAD_RC=$?
  PRESENCE_MODE=live
  _lead_reserved_any_probe 4100 >/dev/null 2>&1
  RESERVED_LIVE_NOISE_RC=$?
  if [ "$RESERVED_CHANGED_RC" -eq 1 ] \
    && [ "$RESERVED_DEAD_RC" -eq 1 ] \
    && [ "$RESERVED_LIVE_NOISE_RC" -eq 2 ]; then
    pass "generation drift/death proves absence while a live PID plus IPC noise holds"
  else
    fail "reserved generation states collapsed: changed=$RESERVED_CHANGED_RC dead=$RESERVED_DEAD_RC live_noise=$RESERVED_LIVE_NOISE_RC"
  fi
fi

echo "[TEST] exact cleanup treats a positively dead tmux generation as absent"
CLEANUP_EXACT_SRC="$(sed -n '/^_lead_cleanup_exact_tuple()/,/^}/p' "$LEAD_SH")"
if [ -z "$GEN_STATE_SRC" ] || [ -z "$CLEANUP_EXACT_SRC" ]; then
  fail "production launcher is missing typed exact-tuple cleanup"
else
  eval "$GEN_STATE_SRC"
  eval "$CLEANUP_EXACT_SRC"
  PROBE_MODE=changed
  PRESENCE_MODE=live
  CLEANUP_TMUX_CALLS=0
  _tmux() { CLEANUP_TMUX_CALLS=$((CLEANUP_TMUX_CALLS + 1)); return 1; }
  _lead_cleanup_exact_tuple 4100 @7 4300 pane-start >/dev/null 2>&1
  DEAD_GENERATION_CLEANUP_RC=$?
  if [ "$DEAD_GENERATION_CLEANUP_RC" -eq 0 ] \
    && [ "$CLEANUP_TMUX_CALLS" -eq 0 ]; then
    pass "dead generation retires the tuple without a kill attempt"
  else
    fail "dead generation cleanup stayed wedged: rc=$DEAD_GENERATION_CLEANUP_RC tmux=$CLEANUP_TMUX_CALLS"
  fi
fi

echo "[TEST] full archive matcher fails closed on indeterminate body identity"
FULL_MATCH_SRC="$(sed -n '/^_tmux_target_matches_archive()/,/^}/p' "$LEAD_SH")"
eval "$FULL_MATCH_SRC"
TMUX_ARCHIVE_FILE=/tmp/fly1659-full.tmux
TMUX_ARCHIVE_SERVER_PID=4100
TMUX_ARCHIVE_PANE_PID=4300
TMUX_ARCHIVE_WINDOW_ID=@7
LEAD_ID=eng-lead
tmux_supervisor_archive_read() { return 0; }
_tmux_generation_is_current() { return 0; }
_tmux() { printf '4300\n'; }
ARCHIVED_STATE_CALLS=0
tmux_supervisor_archived_process_state() {
  ARCHIVED_STATE_CALLS=$((ARCHIVED_STATE_CALLS + 1))
  return 2
}
# The historical boolean helper deliberately says "alive" here. The matcher
# must ignore it because it collapses process-sensor failure into a decision.
tmux_supervisor_archived_process_alive() { return 0; }
_tmux_target_matches_archive @7 true >/dev/null 2>&1
FULL_INDETERMINATE_RC=$?
if [ "$FULL_INDETERMINATE_RC" -ne 0 ] && [ "$ARCHIVED_STATE_CALLS" -eq 1 ]; then
  pass "forensic matcher consumes typed body evidence and preserves uncertainty"
else
  fail "full matcher used collapsed liveness: rc=$FULL_INDETERMINATE_RC typed_calls=$ARCHIVED_STATE_CALLS"
fi

echo "[TEST] fast archive matcher scans no process table on a healthy generation"
FAST_SRC="$(sed -n '/^_tmux_target_matches_archive_fast()/,/^}/p' "$LEAD_SH")"
if [ -z "$FAST_SRC" ]; then
  fail "production launcher is missing the fast archive matcher"
else
  eval "$FAST_SRC"
  TMUX_ARCHIVE_FILE=/tmp/fly1659-fast.tmux
  TMUX_ARCHIVE_SERVER_PID=4100
  TMUX_ARCHIVE_PANE_PID=4300
  TMUX_ARCHIVE_PANE_START=pane-start
  TMUX_ARCHIVE_WINDOW_ID=@7
  FULL_MATCH_CALLS=0
  FULL_MATCH_RC=0
  tmux_supervisor_archive_read() { return 0; }
  tmux_supervisor_archived_process_alive() { return 0; }
  _tmux_target_matches_archive() {
    FULL_MATCH_CALLS=$((FULL_MATCH_CALLS + 1))
    return "$FULL_MATCH_RC"
  }
  tmux_rescue_probe() {
    case " $* " in
      *" display-message "*)
        case "$PROBE_MODE" in same) printf '4100\n' ;; changed) printf '4200\n' ;; *) return 124 ;; esac
        ;;
      *" list-panes "*) printf '4300\n' ;;
      *) return 2 ;;
    esac
  }
  PROBE_MODE=same
  _tmux_target_matches_archive_fast @7 false
  FAST_SAME_RC=$?
  FAST_SAME_FULL=$FULL_MATCH_CALLS
  PROBE_MODE=changed
  _tmux_target_matches_archive_fast @7 false
  FAST_CHANGED_RC=$?
  FAST_CHANGED_FULL=$FULL_MATCH_CALLS
  PROBE_MODE=error
  _tmux_target_matches_archive_fast @7 false
  FAST_FALLBACK_RC=$?
  if [ "$FAST_SAME_RC" -eq 0 ] \
    && [ "$FAST_SAME_FULL" -eq 0 ] \
    && [ "$FAST_CHANGED_RC" -ne 0 ] \
    && [ "$FAST_CHANGED_FULL" -eq 0 ] \
    && [ "$FAST_FALLBACK_RC" -eq 0 ] \
    && [ "$FULL_MATCH_CALLS" -eq 1 ]; then
    pass "healthy reads are cheap while indeterminate transport falls back once"
  else
    fail "fast matcher drifted: same=$FAST_SAME_RC/$FAST_SAME_FULL changed=$FAST_CHANGED_RC/$FAST_CHANGED_FULL fallback=$FAST_FALLBACK_RC/$FULL_MATCH_CALLS"
  fi
fi

echo "[TEST] ensure fast path mirrors enabled and disabled keepalive postconditions"
ENSURE_SRC="$(sed -n '/^ensure_tmux_session()/,/^}/p' "$LEAD_SH")"
eval "$ENSURE_SRC"
LOCK_CALLS=0
POLICY_PROBES=0
CALL_LOG="$(mktemp -t fly1659-ensure-calls.XXXXXX)"
SESSION_RC=0
KEEPALIVE_ENABLED=1
PROBE_MODE=same
tmux_rescue_probe() {
  case " $* " in
    *" display-message "*) printf '4100\n' ;;
    *" has-session -t =flywheel-keepalive "*) printf 'policy\n' >> "$CALL_LOG"; return 0 ;;
    *" has-session -t =flywheel "*) return "$SESSION_RC" ;;
    *" show-options -sv exit-empty "*) printf 'policy\n' >> "$CALL_LOG"; printf 'off\n' ;;
    *) return 2 ;;
  esac
}
_tmux_rescue_keepalive_enabled() { [ "$KEEPALIVE_ENABLED" -eq 1 ]; }
tmux_socket_ensure() {
  printf 'lock\n' >> "$CALL_LOG"
  printf '{"action":"verified","reachablePid":4100}\n'
  return 0
}
_tmux_rescue_json_field() {
  [ "$2" = reachablePid ] && printf '4100\n'
}

TMUX_SERVER_PID=""
: > "$CALL_LOG"
ensure_tmux_session
ENABLED_RC=$?
ENABLED_LOCKS="$(grep -c '^lock$' "$CALL_LOG" || true)"
ENABLED_POLICY="$(grep -c '^policy$' "$CALL_LOG" || true)"
KEEPALIVE_ENABLED=0
TMUX_SERVER_PID=""
: > "$CALL_LOG"
ensure_tmux_session
DISABLED_RC=$?
DISABLED_LOCKS="$(grep -c '^lock$' "$CALL_LOG" || true)"
DISABLED_POLICY="$(grep -c '^policy$' "$CALL_LOG" || true)"
KEEPALIVE_ENABLED=1
SESSION_RC=1
TMUX_SERVER_PID=""
: > "$CALL_LOG"
ensure_tmux_session
FALLBACK_RC=$?
FALLBACK_LOCKS="$(grep -c '^lock$' "$CALL_LOG" || true)"
if [ "$ENABLED_RC" -eq 0 ] \
  && [ "$ENABLED_LOCKS" -eq 0 ] \
  && [ "$ENABLED_POLICY" -eq 2 ] \
  && [ "$DISABLED_RC" -eq 0 ] \
  && [ "$DISABLED_LOCKS" -eq 0 ] \
  && [ "$DISABLED_POLICY" -eq 0 ] \
  && [ "$FALLBACK_RC" -eq 0 ] \
  && [ "$FALLBACK_LOCKS" -eq 1 ]; then
  pass "healthy ensure is zero-lock and policy drift alone enters guarded repair"
else
  fail "ensure lock split drifted: enabled=$ENABLED_RC/$ENABLED_LOCKS/$ENABLED_POLICY disabled=$DISABLED_RC/$DISABLED_LOCKS/$DISABLED_POLICY fallback=$FALLBACK_RC/$FALLBACK_LOCKS"
fi
rm -f "$CALL_LOG"

echo "[TEST] a live expected server never enters locked recovery for window noise"
WAIT_SRC="$(sed -n '/^_wait_tmux_window()/,/^}/p' "$LEAD_SH")"
POLL_SRC="$(sed -n '/^_poll_dev_channels_dialog()/,/^}/p' "$LEAD_SH")"
eval "$WAIT_SRC"
LEAD_WINDOW_ID=@7
LEAD_ID=eng-lead
TMUX_ARCHIVE_FILE=/tmp/fly1659-wait.tmux
TMUX_ARCHIVE_SERVER_PID=4100
TMUX_RELAUNCH_PROVEN=0
SHOULD_EXIT=0
RECOVER_CALLS=0
RECOVER_LOG="$(mktemp -t fly1659-recover-calls.XXXXXX)"
ENSURE_HOLD_KIND=""
ENSURE_HOLD_EVIDENCE=""
_tmux_target_matches_archive() { return 1; }
_tmux_target_matches_archive_fast() { return 1; }
tmux_supervisor_archived_process_state() {
  TMUX_SUPERVISOR_ARCHIVED_STATE=live_exact
  return 0
}
_tmux_generation_probe() { return 0; }
tmux_socket_recover() { printf 'recover\n' >> "$RECOVER_LOG"; return 4; }
_tmux_socket_path() { printf '/tmp/fly1659.sock\n'; }
_tmux_report_hold() { return 0; }
_tmux_report_hold_resolved() { return 0; }
interruptible_sleep() { SHOULD_EXIT=1; }
_hold_sleep_and_advance() { SHOULD_EXIT=1; }
log() { :; }
_wait_tmux_window
RECOVER_CALLS="$(grep -c '^recover$' "$RECOVER_LOG" || true)"
if [ "$RECOVER_CALLS" -eq 0 ] \
  && [ "$TMUX_RELAUNCH_PROVEN" -eq 0 ] \
  && [ "$ENSURE_HOLD_KIND" = unknown ] \
  && printf '%s\n' "$POLL_SRC" | rg -q '_tmux_target_matches_archive_fast'; then
  pass "healthy expected generation converts pane noise to a lock-free hold"
else
  fail "monitor still rescues healthy generation: recover=$RECOVER_CALLS relaunch=$TMUX_RELAUNCH_PROVEN hold=$ENSURE_HOLD_KIND"
fi
rm -f "$RECOVER_LOG"

echo "[TEST] all hold retries jitter and advance through one bounded helper"
JITTER_SRC="$(sed -n '/^_hold_sleep_and_advance()/,/^}/p' "$LEAD_SH")"
if [ -z "$JITTER_SRC" ]; then
  fail "production launcher is missing the jittered hold helper"
else
  eval "$JITTER_SRC"
  LAST_SLEEP=-1
  interruptible_sleep() { LAST_SLEEP="$1"; }
  TMUX_HOLD_BACKOFF=3
  _hold_sleep_and_advance
  FIRST_SLEEP=$LAST_SLEEP
  FIRST_NEXT=$TMUX_HOLD_BACKOFF
  TMUX_HOLD_BACKOFF=30
  _hold_sleep_and_advance
  CAPPED_SLEEP=$LAST_SLEEP
  CAPPED_NEXT=$TMUX_HOLD_BACKOFF
  DIRECT_HOLD_SLEEPS="$(rg -c 'interruptible_sleep "\$TMUX_HOLD_BACKOFF"|hold_backoff' "$LEAD_SH" || true)"
  DIRECT_HOLD_SLEEPS="${DIRECT_HOLD_SLEEPS:-0}"
  if [ "$FIRST_SLEEP" -ge 1 ] && [ "$FIRST_SLEEP" -le 4 ] \
    && [ "$FIRST_NEXT" -eq 6 ] \
    && [ "$CAPPED_SLEEP" -ge 15 ] && [ "$CAPPED_SLEEP" -le 45 ] \
    && [ "$CAPPED_NEXT" -eq 30 ] \
    && [ "$DIRECT_HOLD_SLEEPS" -eq 0 ]; then
    pass "hold retries jitter inside bounds, advance, cap, and share one path"
  else
    fail "hold jitter drifted: first=$FIRST_SLEEP/$FIRST_NEXT capped=$CAPPED_SLEEP/$CAPPED_NEXT direct=$DIRECT_HOLD_SLEEPS"
  fi
fi

echo "[TEST] pending intent and client fence round-trip independent validated tuples"
PENDING_WRITE_SRC="$(sed -n '/^_lead_pending_write()/,/^}/p' "$LEAD_SH")"
PENDING_READ_SRC="$(sed -n '/^_lead_pending_read()/,/^}/p' "$LEAD_SH")"
PENDING_FILE_SRC="$(sed -n '/^_lead_pending_file()/,/^}/p' "$LEAD_SH")"
FIELD_SAFE_SRC="$(sed -n '/^_lead_record_field_safe()/,/^}/p' "$LEAD_SH")"
FENCE_WRITE_SRC="$(sed -n '/^_lead_fence_write()/,/^}/p' "$LEAD_SH")"
FENCE_READ_SRC="$(sed -n '/^_lead_fence_read()/,/^}/p' "$LEAD_SH")"
FENCE_PATH_SRC="$(sed -n '/^_lead_fence_path()/,/^}/p' "$LEAD_SH")"
if [ -z "$PENDING_WRITE_SRC" ] || [ -z "$PENDING_READ_SRC" ] \
  || [ -z "$PENDING_FILE_SRC" ] || [ -z "$FIELD_SAFE_SRC" ] \
  || [ -z "$FENCE_WRITE_SRC" ] || [ -z "$FENCE_READ_SRC" ] \
  || [ -z "$FENCE_PATH_SRC" ]; then
  fail "production launcher is missing durable pending/fence record helpers"
else
  eval "$PENDING_FILE_SRC"
  eval "$FENCE_PATH_SRC"
  eval "$FIELD_SAFE_SRC"
  eval "$PENDING_WRITE_SRC"
  eval "$PENDING_READ_SRC"
  eval "$FENCE_WRITE_SRC"
  eval "$FENCE_READ_SRC"
  RECORD_DIR="$(mktemp -d -t fly1659-records.XXXXXX)"
  TMUX_ARCHIVE_FILE="$RECORD_DIR/lead.tmux"
  _lead_pending_write client-recorded n-1 100 4100 5000 creator-start \
    5100 client-start /tmp/fly1659.sock - - - -
  PENDING_WRITE_RC=$?
  _lead_pending_read
  PENDING_READ_RC=$?
  _lead_fence_write n-1 100 4100 5000 creator-start 5100 client-start /tmp/fly1659.sock
  FENCE_WRITE_RC=$?
  FENCE_FILE="$(_lead_fence_path n-1)"
  _lead_fence_read "$FENCE_FILE"
  FENCE_READ_RC=$?
  if [ "$PENDING_WRITE_RC" -eq 0 ] \
    && [ "$PENDING_READ_RC" -eq 0 ] \
    && [ "$LEAD_PENDING_STATE" = client-recorded ] \
    && [ "$LEAD_PENDING_CLIENT_PID" = 5100 ] \
    && [ "$LEAD_PENDING_SOCKET" = /tmp/fly1659.sock ] \
    && [ "$FENCE_WRITE_RC" -eq 0 ] \
    && [ "$FENCE_READ_RC" -eq 0 ] \
    && [ "$LEAD_FENCE_NONCE" = n-1 ] \
    && [ "$LEAD_FENCE_CLIENT_PID" = 5100 ] \
    && [ "$LEAD_FENCE_SOCKET" = /tmp/fly1659.sock ] \
    && [ ! -L "$FENCE_FILE" ] \
    && ! printf '%s\n' "$FENCE_WRITE_SRC" | rg -Fq 'tmp="${file}.tmp.$$"'; then
    pass "pending and fence preserve self-contained create ownership evidence"
  else
    fail "durable record round-trip drifted: pending=$PENDING_WRITE_RC/$PENDING_READ_RC/${LEAD_PENDING_STATE:-missing} fence=$FENCE_WRITE_RC/$FENCE_READ_RC/${LEAD_FENCE_NONCE:-missing}"
  fi
  printf 'broken\n' > "${TMUX_ARCHIVE_FILE%.tmux}.pending"
  if _lead_pending_read >/dev/null 2>&1; then
    fail "malformed pending evidence was accepted"
  else
    pass "malformed pending evidence fails closed"
  fi
  rm -rf "$RECORD_DIR"
fi

echo "[TEST] gated create accepts direct tuple evidence and retires both ledgers"
CREATE_SRC="$(sed -n '/^_lead_create_tmux_window()/,/^}/p' "$LEAD_SH")"
CLEANUP_FAILED_SRC="$(sed -n '/^_lead_cleanup_failed_create()/,/^}/p' "$LEAD_SH")"
CREATE_FENCE_CONSISTENT_SRC="$(sed -n '/^_lead_pending_fence_consistent()/,/^}/p' "$LEAD_SH")"
CREATE_RETIRE_SRC="$(sed -n '/^_lead_retire_pending_and_fence()/,/^}/p' "$LEAD_SH")"
CREATE_ARCHIVE_MATCH_SRC="$(sed -n '/^_lead_pending_matches_archive()/,/^}/p' "$LEAD_SH")"
if [ -z "$CREATE_SRC" ] || [ -z "$CLEANUP_FAILED_SRC" ]; then
  fail "production launcher is missing the gated create helper"
else
  CREATE_GO_LINE="$(printf '%s\n' "$CREATE_SRC" | awk '/printf .*go/{ print NR; exit }')"
  CREATE_WAIT_LINE="$(printf '%s\n' "$CREATE_SRC" | awk 'seen && /wait "\$client_pid"/{ print NR; exit } /printf .*go/{ seen=1 }')"
  CREATE_CLOSE_LINE="$(printf '%s\n' "$CREATE_SRC" | awk 'seen && /exec 9>&-/{ print NR; exit } /printf .*go/{ seen=1 }')"
  if [ -n "$CREATE_GO_LINE" ] && [ -n "$CREATE_WAIT_LINE" ] \
    && [ -n "$CREATE_CLOSE_LINE" ] \
    && [ "$CREATE_GO_LINE" -lt "$CREATE_WAIT_LINE" ] \
    && [ "$CREATE_WAIT_LINE" -lt "$CREATE_CLOSE_LINE" ] \
    && printf '%s\n' "$CREATE_SRC" | rg -q "printf 'stop"; then
    pass "FIFO parent keeps its writer through wait and releases failures explicitly"
  else
    fail "FIFO lifecycle can lose its token: go=${CREATE_GO_LINE:-missing} wait=${CREATE_WAIT_LINE:-missing} close=${CREATE_CLOSE_LINE:-missing}"
  fi
  eval "$CREATE_FENCE_CONSISTENT_SRC"
  eval "$CREATE_RETIRE_SRC"
  eval "$CREATE_ARCHIVE_MATCH_SRC"
  eval "$CLEANUP_FAILED_SRC"
  eval "$CREATE_SRC"
  CREATE_DIR="$(mktemp -d -t fly1659-create.XXXXXX)"
  mkdir -p "$CREATE_DIR/bin" "$CREATE_DIR/work"
  printf '%s\n' \
    '#!/bin/bash' \
    'printf "%s\\t%s\\t%s\\n" "${FAKE_WINDOW_ID:-@7}" "${FAKE_PANE_PID:-4300}" "${FAKE_SERVER_PID:-4100}"' \
    > "$CREATE_DIR/bin/tmux"
  chmod +x "$CREATE_DIR/bin/tmux"
  ORIGINAL_PATH=$PATH
  PATH="$CREATE_DIR/bin:/usr/bin:/bin"
  export PATH FAKE_WINDOW_ID=@7 FAKE_PANE_PID=4300 FAKE_SERVER_PID=4100
  TMUX_ARCHIVE_FILE="$CREATE_DIR/lead.tmux"
  TMUX_SERVER_PID=4100
  TMUX_ARCHIVE_SERVER_PID=""
  TMUX_ARCHIVE_PANE_PID=""
  TMUX_ARCHIVE_PANE_START=""
  TMUX_ARCHIVE_WINDOW_ID=""
  LEAD_WINDOW_ID=""
  LEAD_BODY_PROVENANCE=""
  LEAD_WORKSPACE="$CREATE_DIR/work"
  LEAD_LEASE_KEY=lead-key
  LEAD_LEASE_GENERATION=1
  LEAD_LEASE_SUPERVISOR_START=creator-start
  # Production always passes pane environment. Keep this non-empty so the
  # harness exercises the real contract on macOS Bash 3.2 under `set -u`.
  env_args=(-e "FLY1659_TEST=1")
  RENAME_CALLS=0
  _tmux_socket_path() { printf '%s/socket\n' "$CREATE_DIR"; }
  tmux_supervisor_process_start_identity() { printf 'start-%s\n' "$1"; }
  tmux_supervisor_archive_write() {
    printf '%s\t%s\t%s\t%s\n' "$2" "$3" "$4" "$5" > "$1"
    TMUX_ARCHIVE_SERVER_PID="$2"
    TMUX_ARCHIVE_PANE_PID="$3"
    TMUX_ARCHIVE_PANE_START="$4"
    TMUX_ARCHIVE_WINDOW_ID="$5"
  }
  lead_identity_bind_lease() { return 0; }
  _tmux_target_matches_archive() { return 0; }
  _tmux() { RENAME_CALLS=$((RENAME_CALLS + 1)); return 0; }
  log() { :; }
  _lead_create_tmux_window flywheel-eng-lead --agent eng-lead
  CREATE_RC=$?
  PENDING_FILE="$(_lead_pending_file)"
  FENCE_COUNT="$(find "$CREATE_DIR" -maxdepth 1 -name 'lead.client.*' -type f | wc -l | tr -d ' ')"
  PATH=$ORIGINAL_PATH
  if [ "$CREATE_RC" -eq 0 ] \
    && [ "$LEAD_WINDOW_ID" = @7 ] \
    && [ "$TMUX_SERVER_PID" = 4100 ] \
    && [ "$LEAD_BODY_PROVENANCE" = launched ] \
    && [ -f "$TMUX_ARCHIVE_FILE" ] \
    && [ ! -e "$PENDING_FILE" ] \
    && [ "$FENCE_COUNT" -eq 0 ] \
    && ! printf '%s\n' "$CREATE_SRC" | rg -q 'tmux_socket_inspect'; then
    pass "direct create tuple commits without verdict noise or stale ledgers"
  else
    fail "gated create drifted: rc=$CREATE_RC window=$LEAD_WINDOW_ID server=$TMUX_SERVER_PID provenance=$LEAD_BODY_PROVENANCE pending=$([ -e "$PENDING_FILE" ] && echo yes || echo no) fences=$FENCE_COUNT"
  fi

  MISMATCH_DIR="$(mktemp -d -t fly1659-create-mismatch.XXXXXX)"
  mkdir -p "$MISMATCH_DIR/work"
  PATH="$CREATE_DIR/bin:/usr/bin:/bin"
  export PATH FAKE_SERVER_PID=4200
  TMUX_ARCHIVE_FILE="$MISMATCH_DIR/lead.tmux"
  TMUX_SERVER_PID=4100
  LEAD_WINDOW_ID=""
  LEAD_BODY_PROVENANCE=""
  LEAD_WORKSPACE="$MISMATCH_DIR/work"
  RENAME_CALLS=0
  _tmux_socket_path() { printf '%s/socket\n' "$MISMATCH_DIR"; }
  _lead_create_tmux_window flywheel-eng-lead --agent eng-lead >/dev/null 2>&1
  MISMATCH_CREATE_RC=$?
  MISMATCH_PENDING="$(_lead_pending_file)"
  MISMATCH_FENCES="$(find "$MISMATCH_DIR" -maxdepth 1 -name 'lead.client.*' -type f | wc -l | tr -d ' ')"
  PATH=$ORIGINAL_PATH
  if [ "$MISMATCH_CREATE_RC" -eq 3 ] \
    && [ "$ENSURE_HOLD_KIND" = split_brain ] \
    && [ -f "$MISMATCH_PENDING" ] \
    && [ "$MISMATCH_FENCES" -eq 1 ] \
    && [ ! -f "$TMUX_ARCHIVE_FILE" ] \
    && [ "$RENAME_CALLS" -eq 0 ]; then
    pass "positive generation drift preserves evidence and never kills the new window"
  else
    fail "generation-drift create mutated or lost evidence: rc=$MISMATCH_CREATE_RC hold=$ENSURE_HOLD_KIND pending=$([ -f "$MISMATCH_PENDING" ] && echo yes || echo no) fences=$MISMATCH_FENCES archive=$([ -f "$TMUX_ARCHIVE_FILE" ] && echo yes || echo no) rename=$RENAME_CALLS"
  fi

  echo "[TEST] archive failure cleans only through the exact frozen tuple"
  CLEAN_FAIL_DIR="$(mktemp -d -t fly1659-create-cleanup.XXXXXX)"
  mkdir -p "$CLEAN_FAIL_DIR/work"
  PATH="$CREATE_DIR/bin:/usr/bin:/bin"
  export PATH FAKE_SERVER_PID=4100
  TMUX_ARCHIVE_FILE="$CLEAN_FAIL_DIR/lead.tmux"
  TMUX_SERVER_PID=4100
  LEAD_WINDOW_ID=""
  LEAD_BODY_PROVENANCE=""
  LEAD_WORKSPACE="$CLEAN_FAIL_DIR/work"
  CLEANUP_CALLS=0
  _tmux_socket_path() { printf '%s/socket\n' "$CLEAN_FAIL_DIR"; }
  tmux_supervisor_archive_write() { return 1; }
  _lead_cleanup_exact_tuple() { CLEANUP_CALLS=$((CLEANUP_CALLS + 1)); return 0; }
  _lead_create_tmux_window flywheel-eng-lead --agent eng-lead >/dev/null 2>&1
  CLEAN_FAIL_RC=$?
  CLEAN_FAIL_PENDING="$(_lead_pending_file)"
  CLEAN_FAIL_FENCES="$(find "$CLEAN_FAIL_DIR" -maxdepth 1 -name 'lead.client.*' -type f | wc -l | tr -d ' ')"
  PATH=$ORIGINAL_PATH
  if [ "$CLEAN_FAIL_RC" -eq 1 ] \
    && [ "$CLEANUP_CALLS" -eq 1 ] \
    && [ ! -e "$TMUX_ARCHIVE_FILE" ] \
    && [ ! -e "$CLEAN_FAIL_PENDING" ] \
    && [ "$CLEAN_FAIL_FENCES" -eq 0 ]; then
    pass "failed archive commit retires evidence only after exact cleanup proof"
  else
    fail "archive failure bypassed exact cleanup: rc=$CLEAN_FAIL_RC cleanup=$CLEANUP_CALLS archive=$([ -e "$TMUX_ARCHIVE_FILE" ] && echo yes || echo no) pending=$([ -e "$CLEAN_FAIL_PENDING" ] && echo yes || echo no) fences=$CLEAN_FAIL_FENCES"
  fi

  echo "[TEST] bind failure preserves every ledger when exact cleanup is uncertain"
  BIND_FAIL_DIR="$(mktemp -d -t fly1659-create-bind.XXXXXX)"
  mkdir -p "$BIND_FAIL_DIR/work"
  PATH="$CREATE_DIR/bin:/usr/bin:/bin"
  export PATH FAKE_SERVER_PID=4100
  TMUX_ARCHIVE_FILE="$BIND_FAIL_DIR/lead.tmux"
  TMUX_SERVER_PID=4100
  LEAD_WINDOW_ID=""
  LEAD_BODY_PROVENANCE=""
  LEAD_WORKSPACE="$BIND_FAIL_DIR/work"
  CLEANUP_CALLS=0
  _tmux_socket_path() { printf '%s/socket\n' "$BIND_FAIL_DIR"; }
  tmux_supervisor_archive_write() {
    printf '%s\t%s\t%s\t%s\n' "$2" "$3" "$4" "$5" > "$1"
    TMUX_ARCHIVE_SERVER_PID="$2"
    TMUX_ARCHIVE_PANE_PID="$3"
    TMUX_ARCHIVE_PANE_START="$4"
    TMUX_ARCHIVE_WINDOW_ID="$5"
  }
  lead_identity_bind_lease() { return 1; }
  _lead_cleanup_exact_tuple() { CLEANUP_CALLS=$((CLEANUP_CALLS + 1)); return 3; }
  _lead_create_tmux_window flywheel-eng-lead --agent eng-lead >/dev/null 2>&1
  BIND_FAIL_RC=$?
  BIND_FAIL_PENDING="$(_lead_pending_file)"
  BIND_FAIL_FENCES="$(find "$BIND_FAIL_DIR" -maxdepth 1 -name 'lead.client.*' -type f | wc -l | tr -d ' ')"
  PATH=$ORIGINAL_PATH
  if [ "$BIND_FAIL_RC" -eq 3 ] \
    && [ "$CLEANUP_CALLS" -eq 1 ] \
    && [ -e "$TMUX_ARCHIVE_FILE" ] \
    && [ -e "$BIND_FAIL_PENDING" ] \
    && [ "$BIND_FAIL_FENCES" -eq 1 ]; then
    pass "uncertain bind cleanup preserves archive, pending, and fence evidence"
  else
    fail "bind failure lost evidence: rc=$BIND_FAIL_RC cleanup=$CLEANUP_CALLS archive=$([ -e "$TMUX_ARCHIVE_FILE" ] && echo yes || echo no) pending=$([ -e "$BIND_FAIL_PENDING" ] && echo yes || echo no) fences=$BIND_FAIL_FENCES"
  fi

  echo "[TEST] malformed create output keeps durable evidence but retires transient files"
  MALFORMED_DIR="$(mktemp -d -t fly1659-create-malformed.XXXXXX)"
  mkdir -p "$MALFORMED_DIR/work"
  PATH="$CREATE_DIR/bin:/usr/bin:/bin"
  export PATH FAKE_SERVER_PID=4100 FAKE_PANE_PID=not-a-pid
  TMUX_ARCHIVE_FILE="$MALFORMED_DIR/lead.tmux"
  TMUX_SERVER_PID=4100
  LEAD_WINDOW_ID=""
  LEAD_BODY_PROVENANCE=""
  LEAD_WORKSPACE="$MALFORMED_DIR/work"
  _tmux_socket_path() { printf '%s/socket\n' "$MALFORMED_DIR"; }
  _lead_create_tmux_window flywheel-eng-lead --agent eng-lead >/dev/null 2>&1
  MALFORMED_RC=$?
  MALFORMED_PENDING="$(_lead_pending_file)"
  MALFORMED_FENCES="$(find "$MALFORMED_DIR" -maxdepth 1 -name 'lead.client.*' -type f | wc -l | tr -d ' ')"
  MALFORMED_TRANSIENT="$(find "$MALFORMED_DIR" -maxdepth 1 \( -name 'lead.pending.out.*' -o -name 'lead.pending.err.*' -o -name 'lead.pending.gate.*' \) -type f | wc -l | tr -d ' ')"
  PATH=$ORIGINAL_PATH
  if [ "$MALFORMED_RC" -eq 3 ] \
    && [ -e "$MALFORMED_PENDING" ] \
    && [ "$MALFORMED_FENCES" -eq 1 ] \
    && [ "$MALFORMED_TRANSIENT" -eq 0 ]; then
    pass "malformed result preserves recovery ledgers without transient-file leaks"
  else
    fail "malformed result artifacts drifted: rc=$MALFORMED_RC pending=$([ -e "$MALFORMED_PENDING" ] && echo yes || echo no) fences=$MALFORMED_FENCES transient=$MALFORMED_TRANSIENT"
  fi
  unset FAKE_WINDOW_ID FAKE_PANE_PID FAKE_SERVER_PID
  rm -rf "$CREATE_DIR" "$MISMATCH_DIR" "$CLEAN_FAIL_DIR" "$BIND_FAIL_DIR" "$MALFORMED_DIR"
fi

echo "[TEST] real private tmux returns the direct create tuple used for acceptance"
if ! command -v tmux >/dev/null 2>&1; then
  fail "real tmux is unavailable"
else
  REAL_DIR="$(mktemp -d -t fly1659-real-tmux.XXXXXX)"
  REAL_SOCKET="$REAL_DIR/tmux.sock"
  REAL_OK=false
  if tmux -S "$REAL_SOCKET" new-session -d -s flywheel -n anchor 'sleep 30'; then
    REAL_EXPECTED="$(tmux -S "$REAL_SOCKET" display-message -p '#{pid}')"
    REAL_RESULT="$(tmux -S "$REAL_SOCKET" -N new-window -d -P \
      -F '#{window_id}	#{pane_pid}	#{pid}' -t =flywheel \
      -n 'flywheel-eng-lead.p-real-fixture' 'sleep 30')"
    IFS=$'\t' read -r REAL_WINDOW REAL_PANE REAL_CREATED <<EOF
$REAL_RESULT
EOF
    REAL_OBSERVED="$(tmux -S "$REAL_SOCKET" list-panes -t "$REAL_WINDOW" \
      -F '#{pane_pid}	#{pane_dead}')"
    if [ "$REAL_CREATED" = "$REAL_EXPECTED" ] \
      && [ "$REAL_OBSERVED" = "$REAL_PANE"$'\t0' ] \
      && tmux -S "$REAL_SOCKET" rename-window -t "$REAL_WINDOW" flywheel-eng-lead \
      && [ "$(tmux -S "$REAL_SOCKET" display-message -p -t "$REAL_WINDOW" '#{window_name}')" = flywheel-eng-lead ]; then
      REAL_OK=true
    fi
  fi
  tmux -S "$REAL_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$REAL_DIR"
  if [ "$REAL_OK" = true ]; then
    pass "tmux 3-field result and guarded temporary-name rename are real"
  else
    fail "real tmux direct-tuple contract failed: expected=${REAL_EXPECTED:-missing} result=${REAL_RESULT:-missing} observed=${REAL_OBSERVED:-missing}"
  fi
fi

echo "[TEST] matching completed intent retires into the typed lease disposition"
RECONCILE_SRC="$(sed -n '/^_lead_reconcile_pending_launch()/,/^}/p' "$LEAD_SH")"
MATCH_ARCHIVE_SRC="$(sed -n '/^_lead_pending_matches_archive()/,/^}/p' "$LEAD_SH")"
FENCE_CONSISTENT_SRC="$(sed -n '/^_lead_pending_fence_consistent()/,/^}/p' "$LEAD_SH")"
RETIRE_RECORDS_SRC="$(sed -n '/^_lead_retire_pending_and_fence()/,/^}/p' "$LEAD_SH")"
if [ -z "$RECONCILE_SRC" ]; then
  fail "production launcher is missing pending-launch reconciliation"
else
  eval "$MATCH_ARCHIVE_SRC"
  eval "$FENCE_CONSISTENT_SRC"
  eval "$RETIRE_RECORDS_SRC"
  eval "$RECONCILE_SRC"
  RECON_DIR="$(mktemp -d -t fly1659-reconcile.XXXXXX)"
  TMUX_ARCHIVE_FILE="$RECON_DIR/lead.tmux"
  LEAD_ID=eng-lead
  PROJECT_NAME=flywheel
  LEAD_LEASE_DEGRADED=""
  LEAD_LEASE_FRESH=0
  LEAD_LEASE_ORPHAN_HOLDER_PID=4300
  LEAD_LEASE_ORPHAN_HOLDER_START=pane-start
  _lead_pending_write complete n-r 100 4100 5000 creator-start \
    5100 client-start /tmp/fly1659.sock 4100 @7 4300 pane-start
  _lead_fence_write n-r 100 4100 5000 creator-start 5100 client-start /tmp/fly1659.sock
  printf 'archive\n' > "$TMUX_ARCHIVE_FILE"
  _tmux_socket_path() { printf '/tmp/fly1659.sock\n'; }
  tmux_supervisor_archive_read() {
    TMUX_ARCHIVE_SERVER_PID=4100
    TMUX_ARCHIVE_PANE_PID=4300
    TMUX_ARCHIVE_PANE_START=pane-start
    TMUX_ARCHIVE_WINDOW_ID=@7
    return 0
  }
  _lead_reconcile_pending_launch 4
  RECON_RC=$?
  RECON_PENDING="$(_lead_pending_file)"
  RECON_FENCE="$(_lead_fence_path n-r)"
  if [ "$RECON_RC" -eq 0 ] \
    && [ ! -e "$RECON_PENDING" ] \
    && [ ! -e "$RECON_FENCE" ] \
    && [ -e "$TMUX_ARCHIVE_FILE" ]; then
    pass "matching archive+rc4 retires transient create ledgers without touching the body"
  else
    fail "matching reconciliation drifted: rc=$RECON_RC pending=$([ -e "$RECON_PENDING" ] && echo yes || echo no) fence=$([ -e "$RECON_FENCE" ] && echo yes || echo no) archive=$([ -e "$TMUX_ARCHIVE_FILE" ] && echo yes || echo no)"
  fi

  echo "[TEST] missing archive rebuild and fresh cleanup follow distinct lease rows"
  rm -f "$TMUX_ARCHIVE_FILE"
  _lead_pending_write complete n-rebuild 101 4100 5001 creator-start \
    5101 client-start /tmp/fly1659.sock 4100 @8 4301 pane-start-2
  _lead_fence_write n-rebuild 101 4100 5001 creator-start 5101 client-start /tmp/fly1659.sock
  LEAD_LEASE_ORPHAN_HOLDER_PID=4301
  LEAD_LEASE_ORPHAN_HOLDER_START=pane-start-2
  _lead_pending_tuple_live_exact() { return 0; }
  tmux_supervisor_archive_write() {
    printf '%s\t%s\t%s\t%s\n' "$2" "$3" "$4" "$5" > "$1"
  }
  _lead_reconcile_pending_launch 4
  REBUILD_RC=$?
  REBUILD_ARCHIVE=$([ -f "$TMUX_ARCHIVE_FILE" ] && echo yes || echo no)

  rm -f "$TMUX_ARCHIVE_FILE"
  _lead_pending_write complete n-clean 102 4100 5002 creator-start \
    5102 client-start /tmp/fly1659.sock 4100 @9 4302 pane-start-3
  _lead_fence_write n-clean 102 4100 5002 creator-start 5102 client-start /tmp/fly1659.sock
  LEAD_LEASE_FRESH=1
  CLEANUP_CALLS=0
  _lead_cleanup_exact_tuple() { CLEANUP_CALLS=$((CLEANUP_CALLS + 1)); return 0; }
  _lead_reconcile_pending_launch 0
  FRESH_CLEAN_RC=$?
  if [ "$REBUILD_RC" -eq 0 ] \
    && [ "$REBUILD_ARCHIVE" = yes ] \
    && [ "$FRESH_CLEAN_RC" -eq 0 ] \
    && [ "$CLEANUP_CALLS" -eq 1 ] \
    && [ ! -e "$(_lead_pending_file)" ] \
    && [ ! -e "$(_lead_fence_path n-clean)" ]; then
    pass "bound body rebuilds archive while fresh residual is evidence-gated cleanup"
  else
    fail "missing-archive rows drifted: rebuild=$REBUILD_RC/$REBUILD_ARCHIVE fresh=$FRESH_CLEAN_RC cleanup=$CLEANUP_CALLS"
  fi

  echo "[TEST] degraded complete intent retires after dead-generation cleanup proof"
  rm -f "$TMUX_ARCHIVE_FILE"
  _lead_pending_write complete n-degraded 1021 4100 50021 creator-start \
    51021 client-start /tmp/fly1659.sock 4100 @91 43021 pane-start-degraded
  _lead_fence_write n-degraded 1021 4100 50021 creator-start \
    51021 client-start /tmp/fly1659.sock
  LEAD_LEASE_DEGRADED=store_error
  LEAD_LEASE_FRESH=0
  CLEANUP_CALLS=0
  _lead_cleanup_exact_tuple() { CLEANUP_CALLS=$((CLEANUP_CALLS + 1)); return 0; }
  _lead_pending_tuple_live_exact() { return 1; }
  _lead_reconcile_pending_launch 0
  DEGRADED_RECON_RC=$?
  if [ "$DEGRADED_RECON_RC" -eq 0 ] \
    && [ "$CLEANUP_CALLS" -eq 0 ] \
    && [ ! -e "$(_lead_pending_file)" ] \
    && [ ! -e "$(_lead_fence_path n-degraded)" ]; then
    pass "store degradation retires a positively absent intent without a kill"
  else
    fail "degraded completed intent stayed wedged: rc=$DEGRADED_RECON_RC cleanup=$CLEANUP_CALLS"
  fi
  LEAD_LEASE_DEGRADED=""
  LEAD_LEASE_FRESH=1

  echo "[TEST] conflicting archive preserves both evidence records"
  _lead_pending_write complete n-conflict 103 4100 5003 creator-start \
    5103 client-start /tmp/fly1659.sock 4100 @10 4303 pane-start-4
  _lead_fence_write n-conflict 103 4100 5003 creator-start 5103 client-start /tmp/fly1659.sock
  printf 'archive\n' > "$TMUX_ARCHIVE_FILE"
  tmux_supervisor_archive_read() {
    TMUX_ARCHIVE_SERVER_PID=4100
    TMUX_ARCHIVE_PANE_PID=9999
    TMUX_ARCHIVE_PANE_START=other-start
    TMUX_ARCHIVE_WINDOW_ID=@99
    return 0
  }
  _lead_reconcile_pending_launch 4 >/dev/null 2>&1
  CONFLICT_RECON_RC=$?
  if [ "$CONFLICT_RECON_RC" -eq 3 ] \
    && [ -e "$(_lead_pending_file)" ] \
    && [ -e "$(_lead_fence_path n-conflict)" ] \
    && [ -e "$TMUX_ARCHIVE_FILE" ]; then
    pass "conflicting archive/pending tuples hold with all evidence"
  else
    fail "conflicting tuple mutated evidence: rc=$CONFLICT_RECON_RC"
  fi


  echo "[TEST] same-process client-recorded failure retires without supervisor restart"
  rm -f "$TMUX_ARCHIVE_FILE"
  _lead_pending_write client-recorded n-owner 104 4100 "$$" creator-start \
    5104 client-start /tmp/fly1659.sock - - - -
  _lead_fence_write n-owner 104 4100 "$$" creator-start 5104 client-start /tmp/fly1659.sock
  LEAD_LEASE_SUPERVISOR_START=creator-start
  _lead_process_tuple_state() {
    [ "$1" = "$$" ] && return 0
    return 1
  }
  _lead_reserved_window_probe() { return 1; }
  _lead_reconcile_pending_launch 0
  OWNER_RECON_RC=$?
  if [ "$OWNER_RECON_RC" -eq 0 ] \
    && [ ! -e "$(_lead_pending_file)" ] \
    && [ ! -e "$(_lead_fence_path n-owner)" ]; then
    pass "owner reaps a failed create and retries in the same process"
  else
    fail "owner intent stayed wedged: rc=$OWNER_RECON_RC"
  fi

  echo "[TEST] dead generation and exact process death retire a fence-write crash"
  _lead_pending_write client-recorded n-no-fence 1041 4100 50041 creator-start \
    51041 client-start /tmp/fly1659.sock - - - -
  LEAD_LEASE_SUPERVISOR_START=other-supervisor-start
  _lead_process_tuple_state() { return 1; }
  eval "$GEN_STATE_SRC"
  eval "$RESERVED_SNAPSHOT_SRC"
  eval "$RESERVED_WINDOW_SRC"
  _tmux_generation_probe() { return 1; }
  _lead_reconcile_pending_launch 0
  NO_FENCE_RECON_RC=$?
  if [ "$NO_FENCE_RECON_RC" -eq 0 ] \
    && [ ! -e "$(_lead_pending_file)" ]; then
    pass "real reserved probes let a dead-generation, missing-fence intent retire"
  else
    fail "missing-fence pending intent stayed wedged: rc=$NO_FENCE_RECON_RC"
  fi
  rm -f "$(_lead_pending_file)"

  echo "[TEST] fence-only census blocks live client then retires on full death proof"
  GATE_SRC="$(sed -n '/^_lead_prelaunch_isolation_gate()/,/^}/p' "$LEAD_SH")"
  if [ -z "$GATE_SRC" ]; then
    fail "production launcher is missing the pre-launch isolation gate"
  else
    eval "$GATE_SRC"
    _lead_fence_write n-fence 105 4100 5005 creator-start 5105 client-start /tmp/fly1659.sock
    FENCE_CLIENT_STATE=0
    _lead_process_tuple_state() {
      [ "$1" = 5105 ] && return "$FENCE_CLIENT_STATE"
      return 1
    }
    _lead_reserved_window_probe() { return 1; }
    _lead_reserved_any_probe() { return 1; }
    _lead_prelaunch_isolation_gate >/dev/null 2>&1
    LIVE_FENCE_RC=$?
    LIVE_FENCE_EXISTS=$([ -e "$(_lead_fence_path n-fence)" ] && echo yes || echo no)
    FENCE_CLIENT_STATE=1
    _lead_prelaunch_isolation_gate >/dev/null 2>&1
    DEAD_FENCE_RC=$?
    if [ "$LIVE_FENCE_RC" -eq 3 ] \
      && [ "$LIVE_FENCE_EXISTS" = yes ] \
      && [ "$DEAD_FENCE_RC" -eq 0 ] \
      && [ ! -e "$(_lead_fence_path n-fence)" ]; then
      pass "independent fence blocks late create until stable death/absence proof"
    else
      fail "fence census drifted: live=$LIVE_FENCE_RC/$LIVE_FENCE_EXISTS dead=$DEAD_FENCE_RC"
    fi
  fi
  rm -rf "$RECON_DIR"
fi

echo "[TEST] launch closes the census and identity TOCTOU immediately before create"
LAUNCH_SRC="$(sed -n '/^_launch_claude()/,/^}/p' "$LEAD_SH")"
LAUNCH_GATE_LINE="$(printf '%s\n' "$LAUNCH_SRC" | awk '/_lead_prelaunch_isolation_gate/{ print NR; exit }')"
LAUNCH_CONFLICT_LINE="$(printf '%s\n' "$LAUNCH_SRC" | awk '/lead_identity_preflight_first_conflict/{ print NR; exit }')"
LAUNCH_AUTHORITY_LINE="$(printf '%s\n' "$LAUNCH_SRC" | awk '/lead_launch_authority_recheck/{ print NR; exit }')"
LAUNCH_CREATE_LINE="$(printf '%s\n' "$LAUNCH_SRC" | awk '/_lead_create_tmux_window/{ print NR; exit }')"
if [ -n "$LAUNCH_GATE_LINE" ] \
  && [ -n "$LAUNCH_CONFLICT_LINE" ] \
  && [ -n "$LAUNCH_AUTHORITY_LINE" ] \
  && [ -n "$LAUNCH_CREATE_LINE" ] \
  && [ "$LAUNCH_GATE_LINE" -lt "$LAUNCH_CONFLICT_LINE" ] \
  && [ "$LAUNCH_CONFLICT_LINE" -lt "$LAUNCH_AUTHORITY_LINE" ] \
  && [ "$LAUNCH_AUTHORITY_LINE" -lt "$LAUNCH_CREATE_LINE" ]; then
  pass "fence census, exact identity preflight, authority, and create are ordered"
else
  fail "launch boundary is not ordered gate=${LAUNCH_GATE_LINE:-missing} conflict=${LAUNCH_CONFLICT_LINE:-missing} authority=${LAUNCH_AUTHORITY_LINE:-missing} create=${LAUNCH_CREATE_LINE:-missing}"
fi

echo "[TEST] degraded startup reconciles ledgers and adoption restores session identity"
MAIN_LOOP_SRC="$(sed -n '/^while true; do$/,/^done$/p' "$LEAD_SH")"
MAIN_MISSING_START_LINE="$(printf '%s\n' "$MAIN_LOOP_SRC" | awk '/if \[ -z "\$LEAD_LEASE_SUPERVISOR_START" \]/{ print NR; exit }')"
MAIN_DEGRADED_RECON_LINE="$(printf '%s\n' "$MAIN_LOOP_SRC" | awk '/_lead_reconcile_pending_launch 6/{ print NR; exit }')"
MAIN_ADOPT_LINE="$(printf '%s\n' "$MAIN_LOOP_SRC" | awk '/_lead_try_adopt_body/{ print NR; exit }')"
MAIN_RESTORE_LINE="$(printf '%s\n' "$MAIN_LOOP_SRC" | awk '/_lead_restore_orphan_session/{ print NR; exit }')"
MAIN_ADOPT_WAIT_LINE="$(printf '%s\n' "$MAIN_LOOP_SRC" | awk 'seen && /_wait_tmux_window/{ print NR; exit } /_lead_restore_orphan_session/{ seen=1 }')"
if [ -n "$MAIN_MISSING_START_LINE" ] && [ -n "$MAIN_DEGRADED_RECON_LINE" ] \
  && [ "$MAIN_MISSING_START_LINE" -lt "$MAIN_DEGRADED_RECON_LINE" ] \
  && [ -n "$MAIN_ADOPT_LINE" ] && [ -n "$MAIN_RESTORE_LINE" ] \
  && [ -n "$MAIN_ADOPT_WAIT_LINE" ] \
  && [ "$MAIN_ADOPT_LINE" -lt "$MAIN_RESTORE_LINE" ] \
  && [ "$MAIN_RESTORE_LINE" -lt "$MAIN_ADOPT_WAIT_LINE" ]; then
  pass "missing supervisor identity still reconciles and adopted bodies recover resume state"
else
  fail "main-loop degraded reconciliation or adoption session recovery is missing"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
