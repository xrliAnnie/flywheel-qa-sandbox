#!/bin/bash
# FLY-1309: exact Lead argv preflight + supervisor lease orchestration.
set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LEAD_SH="$(cd "$SCRIPT_DIR/.." && pwd)/claude-lead.sh"
LIB="$(cd "$SCRIPT_DIR/../lib" && pwd)/lead-identity-preflight.sh"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$*" >&2; }

if [ ! -f "$LIB" ]; then
  bad "lead-identity-preflight.sh is missing"
  printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi

# The fixture must not depend on the parent runner/CI environment having set a
# valid Comm CLI path. Calls are still intercepted by lead_identity_cli below.
export FLYWHEEL_COMM_CLI="$LIB"

# shellcheck source=../lib/lead-identity-preflight.sh
source "$LIB"

# Positive controls intentionally come first. Removing either accepted spelling
# must make this suite red before any negative/mutation guard is evaluated.
lead_identity_command_matches "/opt/bin/claude --agent eng-lead --resume abc" eng-lead \
  && ok "split --agent form matches" || bad "split --agent form"
lead_identity_command_matches "/opt/bin/claude --agent=eng-lead --resume abc" eng-lead \
  && ok "equals --agent form matches" || bad "equals --agent form"

for command in \
  "/opt/bin/not-claude --agent eng-lead" \
  "/opt/bin/claude --agent-id eng-lead" \
  "/opt/bin/claude --agent eng-lead-shadow" \
  "/opt/bin/claude --prompt=--agent=eng-lead" \
  "/opt/bin/claude --agent-id=eng-lead"; do
  if lead_identity_command_matches "$command" eng-lead; then
    bad "near-match was accepted: $command"
  else
    ok "near-match rejected: $command"
  fi
done

SNAPSHOT=$(cat <<'EOF'
101 /opt/bin/claude --agent other-lead
202 /opt/bin/not-claude --agent eng-lead
303 /opt/bin/claude --agent=eng-lead --resume live
404 /opt/bin/claude --agent eng-lead-shadow
EOF
)
MATCH="$(printf '%s\n' "$SNAPSHOT" | lead_identity_first_conflict eng-lead)"
[ "$MATCH" = $'303\t/opt/bin/claude --agent=eng-lead --resume live' ] \
  && ok "scanner returns the exact conflicting process" \
  || bad "scanner returned '$MATCH'"

# Override the source-only library seam: production calls the real Comm CLI;
# this fixture drives every resolver/acquire/bind state without filesystem or ps
# side effects.
FAKE_RESOLVE_STATUS=ok
FAKE_ACQUIRE_STATUS=acquired
FAKE_GENERATION=1
FAKE_BIND_STATUS=bound
FAKE_BIND_RC=0
FAKE_VERIFY_STATUS=verified
FAKE_VERIFY_RC=0
FAKE_ACQUIRE_RC=0
FAKE_HOLDER_PID=800
FAKE_HOLDER_START="holder-start"
FAKE_OLD_SUPERVISOR_PID=600
FAKE_OLD_SUPERVISOR_START="old-supervisor-start"
lead_identity_cli() {
  case "$1" in
    resolve)
      case "$FAKE_RESOLVE_STATUS" in
        ok) printf '{"status":"ok","canonicalProject":"flywheel","leadKey":"flywheel-eng-lead"}\n' ;;
        valid_but_lead_absent) printf '{"status":"valid_but_lead_absent","leadId":"eng-lead"}\n' ;;
        ambiguous) printf '{"status":"ambiguous","leadId":"eng-lead","projects":["a","b"]}\n' ;;
        source_error) printf '{"status":"source_error","error":"broken"}\n'; return 1 ;;
      esac
      ;;
    acquire)
      printf '{"status":"%s","generation":%s,"leadKey":"flywheel-eng-lead","holderPid":%s,"holderStart":"%s","supervisorPid":%s,"supervisorStart":"%s"}\n' \
        "$FAKE_ACQUIRE_STATUS" "$FAKE_GENERATION" \
        "$FAKE_HOLDER_PID" "$FAKE_HOLDER_START" \
        "$FAKE_OLD_SUPERVISOR_PID" "$FAKE_OLD_SUPERVISOR_START"
      return "$FAKE_ACQUIRE_RC"
      ;;
    bind)
      printf '{"status":"%s","generation":%s}\n' "$FAKE_BIND_STATUS" "$FAKE_GENERATION"
      return "$FAKE_BIND_RC"
      ;;
    verify-bound)
      printf '{"status":"%s","generation":%s}\n' \
        "$FAKE_VERIFY_STATUS" "${FAKE_VERIFY_GENERATION:-$FAKE_GENERATION}"
      return "$FAKE_VERIFY_RC"
      ;;
  esac
}

if lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" \
  && [ "$LEAD_LEASE_KEY" = flywheel-eng-lead ] \
  && [ "$LEAD_LEASE_GENERATION" = 1 ] \
  && [ "${LEAD_LEASE_FRESH:-missing}" = 1 ] \
  && [ -z "$LEAD_LEASE_DEGRADED" ]; then
  ok "canonical acquire exports a fresh unbound generation"
else
  bad "canonical acquire did not produce the fresh generation claim"
fi

FAKE_ACQUIRE_STATUS=idempotent
lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null
[ "$LEAD_LEASE_GENERATION" = 1 ] \
  && [ "${LEAD_LEASE_FRESH:-missing}" = 1 ] \
  && ok "HOLD/retry acquire is a fresh generation-idempotent claim" \
  || bad "idempotent acquire changed generation freshness"

FAKE_RESOLVE_STATUS=valid_but_lead_absent
FAKE_ACQUIRE_STATUS=acquired
FAKE_GENERATION=4
lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null
[ "$LEAD_LEASE_KEY" = flywheel-eng-lead ] && [ "$LEAD_LEASE_GENERATION" = 4 ] \
  && ok "valid-but-absent bootstrap derives the scoped key" \
  || bad "valid-but-absent bootstrap failed"

for status in ambiguous source_error; do
  FAKE_RESOLVE_STATUS="$status"
  if lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null 2>&1; then
    bad "$status resolver result did not HOLD"
  elif [ "$LEAD_LEASE_HOLD_REASON" = "identity_${status}" ]; then
    ok "$status resolver result HOLDs fail-stop"
  else
    bad "$status resolver HOLD reason was '$LEAD_LEASE_HOLD_REASON'"
  fi
done

FAKE_RESOLVE_STATUS=ok
FAKE_ACQUIRE_STATUS=error
FAKE_ACQUIRE_RC=2
if lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null 2>&1 \
  && [ "$LEAD_LEASE_DEGRADED" = store_error ] \
  && [ "${LEAD_LEASE_FRESH:-missing}" = 0 ] \
  && [ -z "$LEAD_LEASE_KEY" ] \
  && [ -z "$LEAD_LEASE_GENERATION" ]; then
  ok "lease store failure is explicit fail-open degradation"
else
  bad "lease store failure did not produce store_error degradation"
fi

FAKE_ACQUIRE_STATUS=denied_holder_alive
FAKE_ACQUIRE_RC=3
if lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null 2>&1; then
  bad "live holder did not HOLD"
elif [ "$LEAD_LEASE_HOLD_REASON" = denied_holder_alive ]; then
  if [ "${LEAD_LEASE_FRESH:-missing}" = 0 ]; then
    ok "live holder HOLDs without retaining stale freshness"
  else
    bad "live holder retained stale freshness '${LEAD_LEASE_FRESH:-missing}'"
  fi
else
  bad "live holder reason was '$LEAD_LEASE_HOLD_REASON'"
fi

FAKE_ACQUIRE_STATUS=holder_orphaned
FAKE_ACQUIRE_RC=0
FAKE_GENERATION=1
if lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null 2>&1; then
  bad "orphan classification returned normal-launch success"
elif [ "$?" -eq 4 ] \
  && [ "${LEAD_LEASE_FRESH:-missing}" = 0 ] \
  && [ "$LEAD_LEASE_KEY" = flywheel-eng-lead ] \
  && [ "$LEAD_LEASE_GENERATION" = 1 ] \
  && [ "$LEAD_LEASE_ORPHAN_HOLDER_PID" = 800 ] \
  && [ "$LEAD_LEASE_ORPHAN_HOLDER_START" = holder-start ] \
  && [ "$LEAD_LEASE_ORPHAN_OLD_SUP_PID" = 600 ] \
  && [ "$LEAD_LEASE_ORPHAN_OLD_SUP_START" = old-supervisor-start ]; then
  ok "orphan classification exports frozen evidence with rc 4"
else
  bad "orphan classification did not preserve its tuple evidence"
fi

FAKE_ACQUIRE_STATUS=idempotent_adopted
if lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null 2>&1; then
  bad "bound-body classification returned normal-launch success"
elif [ "$?" -eq 5 ] \
  && [ "$LEAD_LEASE_ORPHAN_HOLDER_PID" = 800 ] \
  && [ "$LEAD_LEASE_ORPHAN_HOLDER_START" = holder-start ] \
  && [ -z "$LEAD_LEASE_ORPHAN_OLD_SUP_PID" ]; then
  ok "idempotent bound body exports holder evidence with rc 5"
else
  bad "idempotent bound body did not preserve its holder evidence"
fi

FAKE_ACQUIRE_STATUS=denied_sensor_degraded
FAKE_ACQUIRE_RC=3
if lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null 2>&1; then
  bad "sensor-degraded tuple did not HOLD"
elif [ "$LEAD_LEASE_HOLD_REASON" = denied_sensor_degraded ]; then
  if [ "${LEAD_LEASE_FRESH:-missing}" = 0 ]; then
    ok "sensor-degraded tuple keeps a distinct HOLD reason and clears freshness"
  else
    bad "sensor-degraded tuple retained stale freshness '${LEAD_LEASE_FRESH:-missing}'"
  fi
else
  bad "sensor-degraded HOLD reason was '$LEAD_LEASE_HOLD_REASON'"
fi

FAKE_ACQUIRE_STATUS=holder_orphaned
FAKE_ACQUIRE_RC=3
if lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null 2>&1; then
  bad "incompatible orphan status and CLI rc was accepted"
elif [ "$LEAD_LEASE_HOLD_REASON" = identity_acquire_invalid_response ]; then
  ok "status-first routing rejects incompatible status and CLI rc"
else
  bad "incompatible status and rc reason was '$LEAD_LEASE_HOLD_REASON'"
fi

FAKE_BIND_STATUS=bound
FAKE_BIND_RC=0
FAKE_GENERATION=9
lead_identity_bind_lease flywheel-eng-lead 9 700 "supervisor-start" 800 "pane-start" \
  && ok "bind commit accepts the exact pane generation" \
  || bad "valid bind failed"
FAKE_BIND_STATUS=stale_generation
FAKE_BIND_RC=1
if lead_identity_bind_lease flywheel-eng-lead 9 700 "supervisor-start" 800 "pane-start"; then
  bad "stale bind was accepted"
else
  ok "stale bind fails for generation-bound cleanup"
fi

# FLY-1697: the launchd-native body is both supervisor and holder. Exercise
# the source-only v2 identity seam as a state machine; no filesystem or process
# mutation is needed at this layer.
FAKE_ACQUIRE_STATUS=acquired
FAKE_ACQUIRE_RC=0
FAKE_GENERATION=12
FAKE_BIND_STATUS=bound
FAKE_BIND_RC=0
FAKE_VERIFY_STATUS=verified
FAKE_VERIFY_RC=0
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" \
  && [ "$LEAD_LEASE_KEY" = flywheel-eng-lead ] \
  && [ "$LEAD_LEASE_GENERATION" = 12 ]; then
  ok "v2 body acquires and binds its own generation"
else
  bad "v2 body did not acquire and bind its own generation"
fi

FAKE_ACQUIRE_STATUS=idempotent
FAKE_BIND_STATUS=stale_generation
FAKE_BIND_RC=1
FAKE_VERIFY_STATUS=mismatch
FAKE_VERIFY_RC=3
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" >/dev/null 2>&1; then
  bad "definite bind mismatch was accepted"
elif [ "$?" -eq 2 ] \
  && [ "$LEAD_LEASE_HOLD_REASON" = v2_bind_unverified ] \
  && [ "$LEAD_LEASE_GENERATION" = 12 ]; then
  ok "v2 body holds a definite bind mismatch on the same generation"
else
  bad "v2 definite bind mismatch lost its typed evidence"
fi
FAKE_BIND_STATUS=bound
FAKE_BIND_RC=0
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" \
  && [ "$LEAD_LEASE_GENERATION" = 12 ]; then
  ok "v2 self-unbound retry converges without generation churn"
else
  bad "v2 self-unbound retry did not converge"
fi

FAKE_ACQUIRE_STATUS=acquired
FAKE_BIND_STATUS=stale_generation
FAKE_BIND_RC=1
FAKE_VERIFY_STATUS=mismatch
FAKE_VERIFY_RC=3
lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" >/dev/null 2>&1 || true
[ "$LEAD_LEASE_HOLD_REASON" = v2_bind_unverified ] \
  && [ -z "$(lead_identity_v2_hold_alert_kind "$LEAD_LEASE_HOLD_REASON" 1)" ] \
  && [ "$(lead_identity_v2_hold_alert_kind "$LEAD_LEASE_HOLD_REASON" 2)" = lead_identity_source_broken ] \
  && ok "repeated v2 bind mismatch escalates after one silent retry" \
  || bad "v2 bind mismatch escalation classification drifted"

FAKE_VERIFY_STATUS=verified
FAKE_VERIFY_RC=0
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" \
  && [ "$LEAD_LEASE_GENERATION" = 12 ]; then
  ok "read-after-write verification accepts an ambiguously reported bind"
else
  bad "read-after-write verification did not recover an ambiguous bind"
fi

FAKE_VERIFY_GENERATION=13
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" >/dev/null 2>&1; then
  bad "read-after-write verification accepted a different generation"
elif [ "$?" -eq 2 ] && [ "$LEAD_LEASE_HOLD_REASON" = v2_bind_unverified ]; then
  ok "read-after-write verification rejects a different generation on the same tuple"
else
  bad "read-after-write generation mismatch lost its typed hold reason"
fi
unset FAKE_VERIFY_GENERATION

FAKE_ACQUIRE_STATUS=idempotent_adopted
FAKE_HOLDER_PID=700
FAKE_HOLDER_START=body-start
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" \
  && [ "$LEAD_LEASE_GENERATION" = 12 ]; then
  ok "v2 body accepts its own already-bound tuple after a lost bind response"
else
  bad "v2 body rejected its own already-bound tuple"
fi

FAKE_HOLDER_PID=800
FAKE_HOLDER_START=foreign-holder-start
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" >/dev/null 2>&1; then
  bad "v2 body adopted a foreign live holder"
elif [ "$?" -eq 2 ] && [ "$LEAD_LEASE_HOLD_REASON" = denied_holder_alive ]; then
  ok "v2 body refuses a foreign already-bound holder"
else
  bad "v2 foreign holder refusal lost its typed reason"
fi

FAKE_ACQUIRE_STATUS=holder_orphaned
FAKE_HOLDER_PID=800
FAKE_HOLDER_START=foreign-holder-start
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" >/dev/null 2>&1; then
  bad "v2 body adopted a legacy orphan holder"
elif [ "$?" -eq 2 ] && [ "$LEAD_LEASE_HOLD_REASON" = denied_holder_alive ]; then
  ok "v2 body holds instead of adopting a legacy orphan holder"
else
  bad "v2 legacy orphan refusal lost its typed reason"
fi

FAKE_ACQUIRE_STATUS=error
FAKE_ACQUIRE_RC=2
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" >/dev/null 2>&1; then
  bad "v2 store degradation returned a bound identity"
elif [ "$?" -eq 1 ] \
  && [ "$LEAD_LEASE_DEGRADED" = store_error ] \
  && [ -z "$LEAD_LEASE_KEY" ] \
  && [ -z "$LEAD_LEASE_GENERATION" ]; then
  ok "v2 store degradation launches without a generation claim"
else
  bad "v2 store degradation did not preserve fail-open-at-launch evidence"
fi

FAKE_ACQUIRE_STATUS=acquired
FAKE_ACQUIRE_RC=0
FAKE_BIND_STATUS=bound
FAKE_BIND_RC=0
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "" >/dev/null 2>&1; then
  bad "v2 body accepted an empty immutable start identity"
elif [ "$?" -eq 1 ] \
  && [ "$LEAD_LEASE_DEGRADED" = store_error ] \
  && [ -z "$LEAD_LEASE_KEY" ] \
  && [ -z "$LEAD_LEASE_GENERATION" ]; then
  ok "v2 body degrades safely when lstart is unavailable"
else
  bad "v2 empty lstart did not clear stale identity output"
fi

FAKE_ACQUIRE_STATUS=acquired
FAKE_BIND_STATUS=error
FAKE_BIND_RC=2
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" >/dev/null 2>&1; then
  bad "v2 bind store error returned success"
elif [ "$?" -eq 2 ] && [ "$LEAD_LEASE_HOLD_REASON" = v2_bind_store_error ]; then
  ok "v2 bind store error is a typed hold"
else
  bad "v2 bind store error classification drifted"
fi

FAKE_BIND_STATUS=stale_generation
FAKE_BIND_RC=1
FAKE_VERIFY_STATUS=error
FAKE_VERIFY_RC=2
if lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" >/dev/null 2>&1; then
  bad "v2 verify store error returned success"
elif [ "$?" -eq 2 ] && [ "$LEAD_LEASE_HOLD_REASON" = v2_bind_verify_store_error ]; then
  ok "v2 verify store error is a typed hold"
else
  bad "v2 verify store error classification drifted"
fi

[ "$(lead_identity_v2_hold_alert_kind denied_holder_alive 1)" = lead_dual_active ] \
  && [ "$(lead_identity_v2_hold_alert_kind denied_sensor_degraded 1)" = lead_dual_active_sensor_degraded ] \
  && [ "$(lead_identity_v2_hold_alert_kind v2_bind_store_error 1)" = lead_lease_store_broken ] \
  && [ "$(lead_identity_v2_hold_alert_kind v2_bind_verify_store_error 1)" = lead_lease_store_broken ] \
  && [ "$(lead_identity_v2_hold_alert_kind identity_source_error 1)" = lead_identity_source_broken ] \
  && [ "$(lead_identity_v2_hold_alert_kind unexpected_reason 1)" = lead_identity_source_broken ] \
  && ok "v2 identity hold reasons map to non-overlapping alert kinds" \
  || bad "v2 identity alert classification table drifted"

FAKE_ACQUIRE_STATUS=acquired
FAKE_ACQUIRE_RC=0
FAKE_BIND_STATUS=bound
FAKE_BIND_RC=0
prepare_rc=caller-prepare
bind_rc=caller-bind
verify_rc=caller-verify
output=caller-output
rc=caller-rc
status=caller-status
lead_identity_v2_acquire_bind eng-lead flywheel 700 "body-start" >/dev/null 2>&1 || true
if [ "$prepare_rc" = caller-prepare ] \
  && [ "$bind_rc" = caller-bind ] \
  && [ "$verify_rc" = caller-verify ] \
  && [ "$output" = caller-output ] \
  && [ "$rc" = caller-rc ] \
  && [ "$status" = caller-status ]; then
  ok "v2 identity helpers do not leak temporary variables into the sourcing shell"
else
  bad "v2 identity helper leaked a temporary variable into the sourcing shell"
fi

if rg -q 'source .*lead-identity-preflight\.sh' "$LEAD_SH" \
  && rg -q 'lead_identity_v2_acquire_bind' "$LEAD_SH" \
  && rg -q 'LEAD_LEASE_SUPERVISOR_START' "$LEAD_SH" \
  && rg -q 'FLYWHEEL_LEAD_LEASE_KEY' "$LEAD_SH" \
  && rg -q 'FLYWHEEL_LEAD_GENERATION' "$LEAD_SH"; then
  ok "production v2 body wires acquire/bind identity into the child env"
else
  bad "production v2 body is missing a lease integration seam"
fi

identity_line="$(rg -n '^[[:space:]]+lead_identity_v2_acquire_bind' "$LEAD_SH" | head -1 | cut -d: -f1)"
session_line="$(rg -n '^[[:space:]]+_v2_is_resume=false' "$LEAD_SH" | head -1 | cut -d: -f1)"
if [ -n "$identity_line" ] && [ -n "$session_line" ] \
  && [ "$identity_line" -lt "$session_line" ]; then
  ok "production v2 body binds identity before choosing a session"
else
  bad "production v2 identity ordering drifted"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
