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
FAKE_ACQUIRE_RC=0
FAKE_ADOPT_STATUS=adopted
FAKE_ADOPT_RC=0
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
      [ "$FAKE_BIND_STATUS" = bound ]
      ;;
    adopt)
      printf '{"status":"%s","generation":%s,"leadKey":"flywheel-eng-lead"}\n' \
        "$FAKE_ADOPT_STATUS" "$FAKE_GENERATION"
      return "$FAKE_ADOPT_RC"
      ;;
  esac
}

FAKE_SUPERVISOR_TABLE=""
FAKE_SUPERVISOR_TABLE_RC=0
lead_identity_process_table() {
  printf '%s\n' "$FAKE_SUPERVISOR_TABLE"
  return "$FAKE_SUPERVISOR_TABLE_RC"
}

if lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" \
  && [ "$LEAD_LEASE_KEY" = flywheel-eng-lead ] \
  && [ "$LEAD_LEASE_GENERATION" = 1 ] \
  && [ -z "$LEAD_LEASE_DEGRADED" ]; then
  ok "canonical acquire exports an unbound generation"
else
  bad "canonical acquire did not produce the generation claim"
fi

FAKE_ACQUIRE_STATUS=idempotent
lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null
[ "$LEAD_LEASE_GENERATION" = 1 ] \
  && ok "HOLD/retry acquire is generation-idempotent" \
  || bad "idempotent acquire changed generation"

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
  ok "live holder HOLDs without takeover"
else
  bad "live holder reason was '$LEAD_LEASE_HOLD_REASON'"
fi

FAKE_ACQUIRE_STATUS=holder_orphaned
FAKE_ACQUIRE_RC=0
FAKE_GENERATION=1
if lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null 2>&1; then
  bad "orphan classification returned normal-launch success"
elif [ "$?" -eq 4 ] \
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
  bad "adopted-monitor classification returned normal-launch success"
elif [ "$?" -eq 5 ] \
  && [ "$LEAD_LEASE_ORPHAN_HOLDER_PID" = 800 ] \
  && [ "$LEAD_LEASE_ORPHAN_HOLDER_START" = holder-start ] \
  && [ -z "$LEAD_LEASE_ORPHAN_OLD_SUP_PID" ]; then
  ok "idempotent adoption exports holder evidence with rc 5"
else
  bad "idempotent adoption did not preserve its holder evidence"
fi

FAKE_ACQUIRE_STATUS=denied_sensor_degraded
FAKE_ACQUIRE_RC=3
if lead_identity_prepare_lease eng-lead flywheel 700 "supervisor-start" >/dev/null 2>&1; then
  bad "sensor-degraded tuple did not HOLD"
elif [ "$LEAD_LEASE_HOLD_REASON" = denied_sensor_degraded ]; then
  ok "sensor-degraded tuple keeps a distinct HOLD reason"
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
FAKE_GENERATION=9
lead_identity_bind_lease flywheel-eng-lead 9 700 "supervisor-start" 800 "pane-start" \
  && ok "bind commit accepts the exact pane generation" \
  || bad "valid bind failed"
FAKE_BIND_STATUS=stale_generation
if lead_identity_bind_lease flywheel-eng-lead 9 700 "supervisor-start" 800 "pane-start"; then
  bad "stale bind was accepted"
else
  ok "stale bind fails for generation-bound cleanup"
fi

FAKE_GENERATION=1
FAKE_ADOPT_STATUS=adopted
FAKE_ADOPT_RC=0
if lead_identity_adopt_lease \
  eng-lead flywheel 700 supervisor-start 800 holder-start 600 old-supervisor-start; then
  ok "adopt wrapper accepts an atomic adoption"
else
  bad "adopt wrapper rejected an atomic adoption"
fi
FAKE_ADOPT_STATUS=lost_race
FAKE_ADOPT_RC=3
if lead_identity_adopt_lease \
  eng-lead flywheel 700 supervisor-start 800 holder-start 600 old-supervisor-start; then
  bad "adopt wrapper accepted a lost CAS race"
elif [ "$?" -eq 3 ]; then
  ok "adopt wrapper preserves lost-race status"
else
  bad "adopt wrapper folded lost-race into another error"
fi

FAKE_SUPERVISOR_TABLE=$'#sensor 705 704\n700 1 /bin/bash /repo/packages/teamlead/scripts/claude-lead.sh eng-lead /repo flywheel\n701 1 /bin/bash /repo/packages/teamlead/scripts/claude-lead.sh other-lead /repo flywheel\n703 700 /bin/bash /repo/packages/teamlead/scripts/claude-lead.sh eng-lead /repo flywheel\n704 703 /bin/bash /repo/packages/teamlead/scripts/claude-lead.sh eng-lead /repo flywheel\n705 704 /bin/ps -axo pid=,ppid=,command='
census_rc=0
census="$(lead_identity_supervisor_census eng-lead flywheel 700)" || census_rc=$?
if [ "$census_rc" -eq 0 ] && [ -z "$census" ]; then
  ok "supervisor census excludes the complete nested sensor chain and unrelated Leads"
else
  bad "supervisor census was not clean (rc=$census_rc census=$census)"
fi
FAKE_SUPERVISOR_TABLE="${FAKE_SUPERVISOR_TABLE}"$'\n'"702 1 /bin/bash /repo/packages/teamlead/scripts/claude-lead.sh eng-lead /repo flywheel"
census_rc=0
census="$(lead_identity_supervisor_census eng-lead flywheel 700)" || census_rc=$?
if [ "$census_rc" -eq 0 ] && printf '%s\n' "$census" | grep -q $'^702\t'; then
  ok "supervisor census reports an exact foreign supervisor"
else
  bad "supervisor census missed exact foreign supervisor (rc=$census_rc census=$census)"
fi
FAKE_SUPERVISOR_TABLE_RC=1
census_rc=0
lead_identity_supervisor_census eng-lead flywheel 700 >/dev/null 2>&1 || census_rc=$?
if [ "$census_rc" -eq 0 ]; then
  bad "supervisor census sensor failure was treated as empty"
elif [ "$census_rc" -eq 2 ]; then
  ok "supervisor census sensor failure is fail-closed"
else
  bad "supervisor census returned the wrong sensor status (rc=$census_rc)"
fi

# Exercise the production shell topology, not only a fabricated PID table.
# macOS Bash 3.2 keeps $$ pinned to the main supervisor while each nested
# command substitution inherits claude-lead.sh argv under a different real
# PID. The process sensor must identify and exclude that full invocation chain.
REAL_CENSUS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1602-real-census.XXXXXX")"
REAL_CENSUS_SCRIPT="$REAL_CENSUS_ROOT/claude-lead.sh"
REAL_CENSUS_BIN="$REAL_CENSUS_ROOT/bin"
mkdir -p "$REAL_CENSUS_BIN"
cat > "$REAL_CENSUS_BIN/ps" <<'EOF'
#!/bin/bash
# Preserve the real process topology while making the external ps sensor
# deterministic in sandboxes that deny process-table access. The production
# lead_identity_process_table function still emits and consumes its own marker.
printf '%s %s /bin/bash /fixture/claude-lead.sh %s /repo %s\n' \
  "$FLY1602_SELF_PID" 1 "$FLY1602_LEAD" "$FLY1602_PROJECT"
printf '%s %s /bin/bash /fixture/claude-lead.sh %s /repo %s\n' \
  "$PPID" "$FLY1602_SELF_PID" "$FLY1602_LEAD" "$FLY1602_PROJECT"
printf '%s %s /fixture/ps -axo pid=,ppid=,command=\n' "$$" "$PPID"
if [ -n "${FLY1602_FOREIGN_PID:-}" ]; then
  printf '%s %s /bin/bash /fixture/claude-lead.sh %s /repo %s\n' \
    "$FLY1602_FOREIGN_PID" 1 "$FLY1602_LEAD" "$FLY1602_PROJECT"
fi
EOF
chmod +x "$REAL_CENSUS_BIN/ps"
cat > "$REAL_CENSUS_SCRIPT" <<'EOF'
#!/bin/bash
set -uo pipefail
source "$4"
expected_foreign_pid="${5:-}"
export FLY1602_SELF_PID="$$"
export FLY1602_LEAD="$1"
export FLY1602_PROJECT="$3"
export FLY1602_FOREIGN_PID="$expected_foreign_pid"
round=0
while [ "$round" -lt 8 ]; do
  round=$((round + 1))
  rc=0
  census="$(lead_identity_supervisor_census "$1" "$3" "$$")" || rc=$?
  if [ "$rc" -eq 2 ]; then
    exit 2
  fi
  if [ -n "$expected_foreign_pid" ]; then
    if [ "$rc" -eq 0 ] \
      && printf '%s\n' "$census" | grep -q "^${expected_foreign_pid}$(printf '\t')"; then
      exit 0
    fi
    printf 'round=%s rc=%s expected=%s census=%s\n' \
      "$round" "$rc" "$expected_foreign_pid" "$census" >&2
    exit 1
  elif [ "$rc" -ne 0 ] || [ -n "$census" ]; then
    printf 'round=%s rc=%s census=%s\n' "$round" "$rc" "$census" >&2
    exit 1
  fi
done
EOF
chmod +x "$REAL_CENSUS_SCRIPT"
REAL_CENSUS_LEAD="fly1602-census-$$"
REAL_CENSUS_PROJECT="fly1602-project-$$"
real_census_rc=0
if PATH="$REAL_CENSUS_BIN:$PATH" /bin/bash "$REAL_CENSUS_SCRIPT" \
  "$REAL_CENSUS_LEAD" /repo "$REAL_CENSUS_PROJECT" "$LIB"; then
  ok "real nested command substitutions never census their own supervisor argv"
else
  real_census_rc=$?
  if [ "$real_census_rc" -eq 2 ]; then
    bad "real nested census lost its sensor marker and failed closed"
  else
    bad "real nested command substitution produced a false foreign supervisor"
  fi
fi

mkdir -p "$REAL_CENSUS_ROOT/foreign"
REAL_FOREIGN_SCRIPT="$REAL_CENSUS_ROOT/foreign/claude-lead.sh"
cat > "$REAL_FOREIGN_SCRIPT" <<'EOF'
#!/bin/bash
trap 'exit 0' TERM INT
while :; do sleep 1; done
EOF
chmod +x "$REAL_FOREIGN_SCRIPT"
/bin/bash "$REAL_FOREIGN_SCRIPT" \
  "$REAL_CENSUS_LEAD" /repo "$REAL_CENSUS_PROJECT" &
REAL_FOREIGN_PID=$!
real_foreign_rc=0
if PATH="$REAL_CENSUS_BIN:$PATH" /bin/bash "$REAL_CENSUS_SCRIPT" \
  "$REAL_CENSUS_LEAD" /repo "$REAL_CENSUS_PROJECT" "$LIB" "$REAL_FOREIGN_PID"; then
  ok "real process-table census reports an unrelated exact foreign supervisor"
else
  real_foreign_rc=$?
  bad "real process-table census missed a foreign supervisor (rc=$real_foreign_rc pid=$REAL_FOREIGN_PID)"
fi
kill "$REAL_FOREIGN_PID" >/dev/null 2>&1 || true
wait "$REAL_FOREIGN_PID" 2>/dev/null || true
rm -rf "$REAL_CENSUS_ROOT"

if rg -q 'source .*lead-identity-preflight\.sh' "$LEAD_SH" \
  && rg -q 'lead_identity_prepare_lease' "$LEAD_SH" \
  && rg -q 'lead_identity_preflight_first_conflict' "$LEAD_SH" \
  && rg -q 'FLYWHEEL_LEAD_LEASE_KEY' "$LEAD_SH" \
  && rg -q 'FLYWHEEL_LEAD_GENERATION' "$LEAD_SH" \
  && rg -q 'lead_identity_bind_lease' "$LEAD_SH"; then
  ok "production supervisor wires resolve/acquire/preflight/env/bind"
else
  bad "production supervisor is missing a lease integration seam"
fi

authority_line="$(rg -n 'lead_launch_authority_prepare' "$LEAD_SH" | head -1 | cut -d: -f1)"
pid_write_line="$(rg -n '^echo \$\$ > "\$PID_FILE"' "$LEAD_SH" | head -1 | cut -d: -f1)"
if [ -n "$authority_line" ] && [ -n "$pid_write_line" ] \
  && [ "$authority_line" -lt "$pid_write_line" ] \
  && rg -q '_lead_adopt_existing_body' "$LEAD_SH" \
  && rg -q 'lead_body_adoption_evidence' "$LEAD_SH" \
  && rg -q 'lead_body_attach_adopted' "$LEAD_SH"; then
  ok "production supervisor gates before PID state and wires read-only adoption"
else
  bad "production supervisor is missing authority/adoption ordering"
fi

adoption_block="$(sed -n '/^_lead_adopt_existing_body()/,/^}/p' "$LEAD_SH")"
if ! printf '%s\n' "$adoption_block" | rg -q '_prepare_lead_launch|lead_identity_preflight_first_conflict|_rules_bundle_commit_once'; then
  ok "adoption path bypasses all three launch-only guards explicitly"
else
  bad "adoption path accidentally invokes a launch-only guard"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
