#!/usr/bin/env bash
# FLY-1501 W3: hermetic restart-storm ledger / hold state-machine contracts.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
GATE="$REPO_DIR/scripts/restart-storm-gate.py"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1501-restart-gate.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$TEST_ROOT/bin"
cat > "$TEST_ROOT/bin/meta-alert" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_META_LOG"
EOF
cat > "$TEST_ROOT/bin/lead-alert" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LEAD_LOG"
printf '%s\n' "${FAKE_LEAD_RESULT:-sent}"
EOF
chmod +x "$TEST_ROOT/bin/meta-alert" "$TEST_ROOT/bin/lead-alert"

export FLYWHEEL_META_ALERT_BIN="$TEST_ROOT/bin/meta-alert"
export FLYWHEEL_LEAD_ALERT_BIN="$TEST_ROOT/bin/lead-alert"
export FAKE_META_LOG="$TEST_ROOT/meta.log"
export FAKE_LEAD_LOG="$TEST_ROOT/lead.log"
export FLYWHEEL_RESTART_STORM_LOCK_DEADLINE_SEC=0

run_expect() { # expected_exit stdout_file stderr_file args...
  local expected="$1" stdout_file="$2" stderr_file="$3"
  shift 3
  "$GATE" "$@" >"$stdout_file" 2>"$stderr_file"
  local actual=$?
  [[ "$actual" -eq "$expected" ]]
}

if [[ -x "$GATE" ]] && python3 -m py_compile "$GATE"; then
  pass "gate exists, is executable, and compiles"
else
  fail "gate bootstrap" "$GATE"
fi

BYPASS_ROOT="$TEST_ROOT/bypass-ledger"
if env FLYWHEEL_RESTART_STORM_GATE=0 "$GATE" gate --root "$BYPASS_ROOT" bypass \
    >/dev/null 2>&1 \
  && [[ "$(wc -l < "$BYPASS_ROOT/bypass.jsonl" | tr -d ' ')" == "1" ]]; then
  pass "retired bypass cannot disable the restart brake"
else
  fail "retired bypass" "gate did not record the restart"
fi

LEDGER_ROOT="$TEST_ROOT/ledger"
happy=true
for _ in 1 2 3 4 5; do
  if ! run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
      gate --root "$LEDGER_ROOT" bridge; then
    happy=false
  fi
done
if [[ "$happy" == true ]] \
  && run_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$LEDGER_ROOT" bridge \
  && [[ "$(wc -l < "$LEDGER_ROOT/bridge.jsonl" | tr -d ' ')" == "6" ]] \
  && [[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$LEDGER_ROOT/bridge.state")" == "held_alert_attempted" ]] \
  && [[ ! -e "$LEDGER_ROOT/spool" ]] \
  && grep -q -- '--kind restart_storm_hold' "$FAKE_LEAD_LOG" \
  && grep -q 'restart_storm_bridge' "$FAKE_META_LOG"; then
  pass "sixth launch holds in ledger/state only and emits both alert legs"
else
  fail "sixth launch hold" "state=$(cat "$LEDGER_ROOT/bridge.state" 2>/dev/null || echo missing)"
fi

OLD_EPISODE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["episode_key"])' "$LEDGER_ROOT/bridge.state")"
OLD_LINES="$(wc -l < "$LEDGER_ROOT/bridge.jsonl" | tr -d ' ')"
if run_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$LEDGER_ROOT" bridge \
  && [[ "$(wc -l < "$LEDGER_ROOT/bridge.jsonl" | tr -d ' ')" == "$OLD_LINES" ]] \
  && run_expect 0 "$TEST_ROOT/status" "$TEST_ROOT/err" \
       status --root "$LEDGER_ROOT" bridge \
  && grep -q '"state":"held_alert_attempted"' "$TEST_ROOT/status"; then
  pass "held state is stable and never appends another launch"
else
  fail "held replay" "status=$(cat "$TEST_ROOT/status" 2>/dev/null || echo missing)"
fi

if run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    resume --root "$LEDGER_ROOT" bridge \
  && run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       resume --root "$LEDGER_ROOT" bridge \
  && run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$LEDGER_ROOT" bridge; then
  resume_ok=true
else
  resume_ok=false
fi
for _ in 1 2 3 4; do
  run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$LEDGER_ROOT" bridge || resume_ok=false
done
if [[ "$resume_ok" == true ]] \
  && run_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$LEDGER_ROOT" bridge; then
  NEW_EPISODE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["episode_key"])' "$LEDGER_ROOT/bridge.state")"
  if [[ "$NEW_EPISODE" != "$OLD_EPISODE" ]] && [[ "$NEW_EPISODE" == *"__7" ]]; then
    pass "resume cursor excludes old launches and same-second storms get a new seq episode"
  else
    fail "resume episode identity" "old=$OLD_EPISODE new=$NEW_EPISODE"
  fi
else
  fail "resume cursor" "state=$(cat "$LEDGER_ROOT/bridge.state" 2>/dev/null || echo missing)"
fi

PENDING_ROOT="$TEST_ROOT/pending-ledger"
export FAKE_LEAD_RESULT=duplicate
pending_ok=true
for _ in 1 2 3 4 5; do
  run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$PENDING_ROOT" voice-bridge || pending_ok=false
done
run_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
  gate --root "$PENDING_ROOT" voice-bridge || pending_ok=false
PENDING_LINES="$(wc -l < "$PENDING_ROOT/voice-bridge.jsonl" | tr -d ' ')"
PENDING_STATE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$PENDING_ROOT/voice-bridge.state")"
export FAKE_LEAD_RESULT=sent
if [[ "$pending_ok" == true ]] \
  && [[ "$PENDING_STATE" == "held_alert_pending" ]] \
  && run_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$PENDING_ROOT" voice-bridge \
  && [[ "$(wc -l < "$PENDING_ROOT/voice-bridge.jsonl" | tr -d ' ')" == "$PENDING_LINES" ]] \
  && [[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$PENDING_ROOT/voice-bridge.state")" == "held_alert_attempted" ]]; then
  pass "duplicate is not a durable receipt; pending retries without another launch"
else
  fail "pending alert retry" "state=$(cat "$PENDING_ROOT/voice-bridge.state" 2>/dev/null || echo missing)"
fi
unset FAKE_LEAD_RESULT

CAS_ROOT="$TEST_ROOT/cas-ledger"
if env FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" \
    status --with-seq --root "$CAS_ROOT" cas-child >"$TEST_ROOT/status-seq" 2>"$TEST_ROOT/err" \
  && grep -q '"ledger_seq":0' "$TEST_ROOT/status-seq" \
  && env FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" \
       record-failure --expected-seq 0 --root "$CAS_ROOT" cas-child \
       >"$TEST_ROOT/recorded" 2>"$TEST_ROOT/err" \
  && grep -q '"recorded":true' "$TEST_ROOT/recorded" \
  && grep -q '"ledger_seq":1' "$TEST_ROOT/recorded" \
  && env FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" \
       record-failure --expected-seq 0 --root "$CAS_ROOT" cas-child \
       >"$TEST_ROOT/stale-cas" 2>"$TEST_ROOT/err" \
  && grep -q '"recorded":false' "$TEST_ROOT/stale-cas" \
  && grep -q '"reason":"seq_changed"' "$TEST_ROOT/stale-cas" \
  && [[ "$(wc -l < "$CAS_ROOT/cas-child.jsonl" | tr -d ' ')" == "1" ]]; then
  pass "status snapshot and record-failure CAS count one repair exactly once"
else
  fail "record-failure CAS" "status=$(cat "$TEST_ROOT/status-seq" 2>/dev/null || echo missing) result=$(cat "$TEST_ROOT/recorded" 2>/dev/null || echo missing)"
fi

env FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" \
  record-failure --expected-seq 1 --root "$CAS_ROOT" cas-child \
  >"$TEST_ROOT/record-held" 2>"$TEST_ROOT/err"
RECORD_HELD_EXIT=$?
if [[ "$RECORD_HELD_EXIT" -eq 3 ]] \
  && grep -q '"recorded":true' "$TEST_ROOT/record-held" \
  && grep -q '"ledger_seq":2' "$TEST_ROOT/record-held" \
  && grep -q '"state":"held_alert_attempted"' "$TEST_ROOT/record-held" \
  && [[ ! -e "$CAS_ROOT/spool" ]]; then
  pass "record-failure advances the same brake and held alert state machine"
else
  fail "record-failure hold" "exit=$RECORD_HELD_EXIT result=$(cat "$TEST_ROOT/record-held" 2>/dev/null || echo missing)"
fi

# FLY-1602: a controlled Lead replacement gets a dedicated, marker-fenced
# counter window. The shared resume command remains held-only and byte-stable.
CONTROL_ROOT="$TEST_ROOT/controlled-ledger"
MARKER_ROOT="$TEST_ROOT/lead-replacements"
mkdir -p "$MARKER_ROOT"
export FLYWHEEL_LEAD_REPLACEMENT_DIR="$MARKER_ROOT"
write_control_marker() { # path daemon_key phase attempt_id
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json, os, sys
path, daemon_key, phase, attempt_id = sys.argv[1:]
value = {
    "schema_version": 1,
    "attempt_id": attempt_id,
    "daemon_key": daemon_key,
    "expected_label": f"com.flywheel.lead.{daemon_key}",
    "phase": phase,
    "old_supervisor_tuple": {"pid": 700, "start": "old-start"},
    "authority": {
        "manifest": {
            "path": "/tmp/manifest.json",
            "semantic_identity": {
                "leadId": "eng-lead",
                "projectDir": "/tmp/project",
                "projectName": "flywheel",
                "botTokenEnv": "DISCORD_BOT_TOKEN",
                "leadBackend": {"backendId": "claude-code"},
            },
        },
        "plist": {"path": "/tmp/lead.plist", "digest": "a" * 64},
        "projects": {"path": "/tmp/projects.json", "digest": "b" * 64},
    },
    "ts": "2026-08-02T12:00:00.000Z",
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(value, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
os.chmod(path, 0o600)
PY
}

CONTROL_ATTEMPT="11111111-1111-4111-8111-111111111111"
CONTROL_MARKER="$MARKER_ROOT/flywheel-eng-lead.json"
write_control_marker "$CONTROL_MARKER" flywheel-eng-lead bootout "$CONTROL_ATTEMPT"
env FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" gate \
  --root "$CONTROL_ROOT" lead.flywheel-eng-lead >/dev/null 2>&1
if run_expect 0 "$TEST_ROOT/controlled-arm" "$TEST_ROOT/err" \
    arm-controlled-wave --expected-seq 1 --intent-marker "$CONTROL_MARKER" \
    --attempt-id "$CONTROL_ATTEMPT" --root "$CONTROL_ROOT" lead.flywheel-eng-lead \
  && grep -q '"status":"armed"' "$TEST_ROOT/controlled-arm" \
  && env FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" gate \
       --root "$CONTROL_ROOT" lead.flywheel-eng-lead >/dev/null 2>&1 \
  && [[ "$(wc -l < "$CONTROL_ROOT/lead.flywheel-eng-lead.jsonl" | tr -d ' ')" == "2" ]] \
  && [[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["last_resumed_seq"])' "$CONTROL_ROOT/lead.flywheel-eng-lead.state")" == "1" ]] \
  && [[ "$(python3 -c 'import json,sys; print([json.loads(x)["event"] for x in open(sys.argv[1])])' "$CONTROL_ROOT/lead.flywheel-eng-lead.controlled-waves.ndjson")" == "['prepared', 'armed']" ]]; then
  pass "controlled Lead wave arms an active/maxed counter and audits prepared then armed"
else
  fail "controlled active arm" "out=$(cat "$TEST_ROOT/controlled-arm" 2>/dev/null || echo missing)"
fi

PREPARED_FAULT_ROOT="$TEST_ROOT/controlled-prepared-fault"
mkdir -p "$PREPARED_FAULT_ROOT"
printf '{"state":"active","last_resumed_seq":0}\n' \
  > "$PREPARED_FAULT_ROOT/lead.flywheel-eng-lead.state"
set +e
env FLYWHEEL_RESTART_STORM_FAULT=after_controlled_prepared \
  "$GATE" arm-controlled-wave --expected-seq 0 \
  --intent-marker "$CONTROL_MARKER" --attempt-id "$CONTROL_ATTEMPT" \
  --root "$PREPARED_FAULT_ROOT" lead.flywheel-eng-lead >/dev/null 2>&1
PREPARED_FAULT_EXIT=$?
PREPARED_AUDIT="$PREPARED_FAULT_ROOT/lead.flywheel-eng-lead.controlled-waves.ndjson"
if [[ "$PREPARED_FAULT_EXIT" -eq 97 ]] \
  && [[ "$(python3 -c 'import json,sys; print([json.loads(x)["event"] for x in open(sys.argv[1])])' "$PREPARED_AUDIT")" == "['prepared']" ]] \
  && [[ "$(jq -r .state "$PREPARED_FAULT_ROOT/lead.flywheel-eng-lead.state")" == active ]] \
  && run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       arm-controlled-wave --expected-seq 0 --intent-marker "$CONTROL_MARKER" \
       --attempt-id "$CONTROL_ATTEMPT" --root "$PREPARED_FAULT_ROOT" lead.flywheel-eng-lead \
  && [[ "$(python3 -c 'import json,sys; print([json.loads(x)["event"] for x in open(sys.argv[1])])' "$PREPARED_AUDIT")" == "['prepared', 'prepared', 'armed']" ]]; then
  pass "crash after controlled prepared audit never records a false armed event"
else
  fail "controlled prepared crash audit" "exit=$PREPARED_FAULT_EXIT audit=$(cat "$PREPARED_AUDIT" 2>/dev/null || echo missing)"
fi

STATE_FAULT_ROOT="$TEST_ROOT/controlled-state-fault"
mkdir -p "$STATE_FAULT_ROOT"
printf '{"state":"active","last_resumed_seq":0}\n' \
  > "$STATE_FAULT_ROOT/lead.flywheel-eng-lead.state"
set +e
env FLYWHEEL_RESTART_STORM_FAULT=after_controlled_state \
  "$GATE" arm-controlled-wave --expected-seq 0 \
  --intent-marker "$CONTROL_MARKER" --attempt-id "$CONTROL_ATTEMPT" \
  --root "$STATE_FAULT_ROOT" lead.flywheel-eng-lead >/dev/null 2>&1
STATE_FAULT_EXIT=$?
STATE_AUDIT="$STATE_FAULT_ROOT/lead.flywheel-eng-lead.controlled-waves.ndjson"
if [[ "$STATE_FAULT_EXIT" -eq 97 ]] \
  && [[ "$(python3 -c 'import json,sys; print([json.loads(x)["event"] for x in open(sys.argv[1])])' "$STATE_AUDIT")" == "['prepared']" ]] \
  && [[ "$(jq -r .state "$STATE_FAULT_ROOT/lead.flywheel-eng-lead.state")" == resumed ]] \
  && run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       arm-controlled-wave --expected-seq 0 --intent-marker "$CONTROL_MARKER" \
       --attempt-id "$CONTROL_ATTEMPT" --root "$STATE_FAULT_ROOT" lead.flywheel-eng-lead \
  && [[ "$(python3 -c 'import json,sys; print([json.loads(x)["event"] for x in open(sys.argv[1])])' "$STATE_AUDIT")" == "['prepared', 'prepared', 'armed']" ]]; then
  pass "crash after controlled state commit remains replayable without false armed audit"
else
  fail "controlled state crash audit" "exit=$STATE_FAULT_EXIT audit=$(cat "$STATE_AUDIT" 2>/dev/null || echo missing)"
fi

HELD_CONTROL_ROOT="$TEST_ROOT/controlled-held-ledger"
for _ in 1 2; do
  env FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" gate \
    --root "$HELD_CONTROL_ROOT" lead.flywheel-eng-lead >/dev/null 2>&1 || true
done
write_control_marker "$CONTROL_MARKER" flywheel-eng-lead bootstrap "$CONTROL_ATTEMPT"
if run_expect 0 "$TEST_ROOT/controlled-held-arm" "$TEST_ROOT/err" \
    arm-controlled-wave --expected-seq 2 --intent-marker "$CONTROL_MARKER" \
    --attempt-id "$CONTROL_ATTEMPT" --root "$HELD_CONTROL_ROOT" lead.flywheel-eng-lead \
  && env FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" gate \
       --root "$HELD_CONTROL_ROOT" lead.flywheel-eng-lead >/dev/null 2>&1 \
  && grep -q '"state":"active"' "$HELD_CONTROL_ROOT/lead.flywheel-eng-lead.state"; then
  pass "controlled Lead wave arms held state for both marker phases"
else
  fail "controlled held arm" "out=$(cat "$TEST_ROOT/controlled-held-arm" 2>/dev/null || echo missing)"
fi

STALE_CONTROL_ROOT="$TEST_ROOT/controlled-stale-ledger"
env FLYWHEEL_RESTART_STORM_MAX=5 "$GATE" gate \
  --root "$STALE_CONTROL_ROOT" lead.flywheel-eng-lead >/dev/null 2>&1
STATE_BEFORE="$(shasum -a 256 "$STALE_CONTROL_ROOT/lead.flywheel-eng-lead.state" 2>/dev/null | awk '{print $1}')"
LEDGER_BEFORE="$(shasum -a 256 "$STALE_CONTROL_ROOT/lead.flywheel-eng-lead.jsonl" | awk '{print $1}')"
if run_expect 3 "$TEST_ROOT/controlled-stale" "$TEST_ROOT/err" \
    arm-controlled-wave --expected-seq 0 --intent-marker "$CONTROL_MARKER" \
    --attempt-id "$CONTROL_ATTEMPT" --root "$STALE_CONTROL_ROOT" lead.flywheel-eng-lead \
  && grep -q '"reason":"seq_changed"' "$TEST_ROOT/controlled-stale" \
  && [[ "$(shasum -a 256 "$STALE_CONTROL_ROOT/lead.flywheel-eng-lead.state" 2>/dev/null | awk '{print $1}')" == "$STATE_BEFORE" ]] \
  && [[ "$(shasum -a 256 "$STALE_CONTROL_ROOT/lead.flywheel-eng-lead.jsonl" | awk '{print $1}')" == "$LEDGER_BEFORE" ]] \
  && [[ ! -e "$STALE_CONTROL_ROOT/lead.flywheel-eng-lead.controlled-waves.ndjson" ]]; then
  pass "controlled arm sequence race returns typed rc 3 with zero mutation"
else
  fail "controlled stale sequence" "out=$(cat "$TEST_ROOT/controlled-stale" 2>/dev/null || echo missing)"
fi

INVALID_MARKER="$MARKER_ROOT/flywheel-other-lead.json"
write_control_marker "$INVALID_MARKER" flywheel-other-lead bootout "$CONTROL_ATTEMPT"
MODE_MARKER="$MARKER_ROOT/flywheel-mode-lead.json"
write_control_marker "$MODE_MARKER" flywheel-mode-lead bootout "$CONTROL_ATTEMPT"
chmod 0644 "$MODE_MARKER"
LINK_MARKER="$MARKER_ROOT/flywheel-link-lead.json"
ln -s "$CONTROL_MARKER" "$LINK_MARKER"
if run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    arm-controlled-wave --expected-seq 0 --intent-marker "$CONTROL_MARKER" \
    --attempt-id "$CONTROL_ATTEMPT" --root "$CONTROL_ROOT" bridge \
  && run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       arm-controlled-wave --expected-seq 0 --intent-marker "$INVALID_MARKER" \
       --attempt-id "$CONTROL_ATTEMPT" --root "$CONTROL_ROOT" lead.flywheel-eng-lead \
  && run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       arm-controlled-wave --expected-seq 0 --intent-marker "$MODE_MARKER" \
       --attempt-id "$CONTROL_ATTEMPT" --root "$CONTROL_ROOT" lead.flywheel-mode-lead \
  && run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       arm-controlled-wave --expected-seq 0 --intent-marker "$LINK_MARKER" \
       --attempt-id "$CONTROL_ATTEMPT" --root "$CONTROL_ROOT" lead.flywheel-link-lead; then
  pass "controlled arm rejects non-Lead, identity drift, unsafe mode, and symlink markers"
else
  fail "controlled marker validation" "stderr=$(cat "$TEST_ROOT/err" 2>/dev/null || echo missing)"
fi

RESUME_COMPAT_ROOT="$TEST_ROOT/resume-byte-compat"
mkdir -p "$RESUME_COMPAT_ROOT"
printf '{"state":"active","last_resumed_seq":0}\n' > "$RESUME_COMPAT_ROOT/lead.compat.state"
RESUME_BEFORE="$(shasum -a 256 "$RESUME_COMPAT_ROOT/lead.compat.state" | awk '{print $1}')"
if run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    resume --root "$RESUME_COMPAT_ROOT" lead.compat \
  && [[ "$(shasum -a 256 "$RESUME_COMPAT_ROOT/lead.compat.state" | awk '{print $1}')" == "$RESUME_BEFORE" ]]; then
  pass "shared resume remains a byte-compatible no-op on active state"
else
  fail "resume byte compatibility" "state=$(cat "$RESUME_COMPAT_ROOT/lead.compat.state" 2>/dev/null || echo missing)"
fi

TAIL_ROOT="$TEST_ROOT/tail-ledger"
run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
  gate --root "$TAIL_ROOT" quota-monitor || true
printf '{"seq":2,"ts":"partial' >> "$TAIL_ROOT/quota-monitor.jsonl"
if run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$TAIL_ROOT" quota-monitor \
  && python3 - "$TAIL_ROOT/quota-monitor.jsonl" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1])]
assert [row["seq"] for row in rows] == [1, 2]
PY
then
  pass "partial ledger tail is truncated before the next fsynced append"
else
  fail "partial tail recovery" "ledger=$(cat "$TAIL_ROOT/quota-monitor.jsonl" 2>/dev/null || echo missing)"
fi

MIDDLE_ROOT="$TEST_ROOT/middle-corrupt-ledger"
mkdir -p "$MIDDLE_ROOT"
printf '%s\n%s\n%s\n' \
  '{"seq":1,"ts":"2026-07-27T12:00:00.000Z"}' \
  '{corrupt-complete-line}' \
  '{"seq":3,"ts":"2026-07-27T12:00:02.000Z"}' \
  > "$MIDDLE_ROOT/bridge.jsonl"
if run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$MIDDLE_ROOT" bridge \
  && [[ ! -e "$MIDDLE_ROOT/bridge.jsonl" ]] \
  && [[ "$(find "$MIDDLE_ROOT/ledger-quarantine" -maxdepth 1 -type f -name 'bridge.jsonl.*' | wc -l | tr -d ' ')" == "1" ]] \
  && grep -q 'restart_gate_ledger_corrupt' "$FAKE_META_LOG"; then
  pass "complete-line ledger corruption is quarantined and fails closed"
else
  fail "middle ledger corruption" "tree=$(find "$MIDDLE_ROOT" -maxdepth 2 -print 2>/dev/null)"
fi

CORRUPT_ROOT="$TEST_ROOT/corrupt-ledger"
mkdir -p "$CORRUPT_ROOT"
printf '{"state":"surprise"}\n' > "$CORRUPT_ROOT/broken.state"
if run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$CORRUPT_ROOT" broken \
  && grep -q 'restart_gate_state_corrupt' "$FAKE_META_LOG"; then
  pass "corrupt state fails closed and raises a kernel-independent meta-alert"
else
  fail "corrupt state" "stderr=$(cat "$TEST_ROOT/err" 2>/dev/null || echo missing)"
fi

if run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root relative bridge \
  && run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$TEST_ROOT/x" '../bridge' \
  && run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$TEST_ROOT/x" "$(printf 'a%.0s' {1..129})" \
  && run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       record-failure --expected-seq -1 --root "$TEST_ROOT/x" bridge \
  && run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       validate --root "$TEST_ROOT/x" --file retired.json \
  && run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       mark-applied --root "$TEST_ROOT/x" bridge retired \
  && run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       quarantine --root "$TEST_ROOT/x" --file retired.json --digest nonregular \
  && run_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       unknown --root "$TEST_ROOT/x" bridge; then
  pass "unsafe inputs and retired projection commands are usage errors"
else
  fail "usage fail-closed" "stderr=$(cat "$TEST_ROOT/err" 2>/dev/null || echo missing)"
fi

LOCK_ROOT="$TEST_ROOT/lock-ledger"
mkdir -p "$LOCK_ROOT"
# FLY-1501 QA: this case is a required CI gate now, so it must not race. The
# holder blocks until this suite releases it rather than sleeping a guessed
# lease, and the readiness wait is asserted instead of falling through — a probe
# that ran before the lock was taken would silently test nothing.
python3 - "$LOCK_ROOT/locked.lock" "$TEST_ROOT/lock-ready" "$TEST_ROOT/lock-release" <<'PY' &
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
open(sys.argv[2], "w").close()
deadline = time.time() + 120
while not os.path.exists(sys.argv[3]) and time.time() < deadline:
    time.sleep(0.05)
PY
LOCK_PID=$!
for _ in {1..600}; do [[ -e "$TEST_ROOT/lock-ready" ]] && break; sleep 0.1; done
if [[ ! -e "$TEST_ROOT/lock-ready" ]]; then
  fail "lock contention" "holder never acquired the lock within 60s"
elif run_expect 2 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$LOCK_ROOT" locked \
  && run_expect 2 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       record-failure --expected-seq 0 --root "$LOCK_ROOT" locked; then
  pass "fcntl contention fails closed for launch and repair accounting"
else
  fail "lock contention" "stderr=$(cat "$TEST_ROOT/err" 2>/dev/null || echo missing)"
fi
: >"$TEST_ROOT/lock-release"
kill "$LOCK_PID" 2>/dev/null || true
wait "$LOCK_PID" 2>/dev/null || true

FAULT_ROOT="$TEST_ROOT/fault-hold-claim"
env FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" gate --root "$FAULT_ROOT" fault-hold \
  >/dev/null 2>&1
env FLYWHEEL_RESTART_STORM_MAX=1 FLYWHEEL_RESTART_STORM_FAULT=after_hold_claim \
  "$GATE" gate --root "$FAULT_ROOT" fault-hold >/dev/null 2>&1
FAULT_EXIT=$?
env FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" gate --root "$FAULT_ROOT" fault-hold \
  >/dev/null 2>&1
FAULT_REPLAY_EXIT=$?
if [[ "$FAULT_EXIT" -eq 97 ]] \
  && [[ "$FAULT_REPLAY_EXIT" -eq 3 ]] \
  && [[ ! -e "$FAULT_ROOT/spool" ]] \
  && [[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$FAULT_ROOT/fault-hold.state")" == "held_alert_attempted" ]]; then
  pass "crash after hold claim replays the direct alert without a projection spool"
else
  fail "hold claim crash replay" "crash_exit=$FAULT_EXIT replay_exit=$FAULT_REPLAY_EXIT"
fi

APPEND_ROOT="$TEST_ROOT/fault-append"
env FLYWHEEL_RESTART_STORM_MAX=1 FLYWHEEL_RESTART_STORM_FAULT=after_ledger_append \
  "$GATE" gate --root "$APPEND_ROOT" append-crash >/dev/null 2>&1
APPEND_EXIT=$?
env FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" gate --root "$APPEND_ROOT" append-crash \
  >/dev/null 2>&1
APPEND_REPLAY_EXIT=$?
if [[ "$APPEND_EXIT" -eq 97 ]] \
  && [[ "$APPEND_REPLAY_EXIT" -eq 3 ]] \
  && [[ "$(wc -l < "$APPEND_ROOT/append-crash.jsonl" | tr -d ' ')" == "2" ]]; then
  pass "crash after durable append replays without losing the first restart"
else
  fail "append crash replay" "crash_exit=$APPEND_EXIT replay_exit=$APPEND_REPLAY_EXIT"
fi

RESTART_SCRIPT="$REPO_DIR/scripts/restart-services.sh"
QA_README="$REPO_DIR/packages/qa-framework/README.md"
AUDIT_SRC="$(sed -n '/^audit_tmux_qa_residue_read_only()/,/^}/p' "$RESTART_SCRIPT")"
if [[ -z "$AUDIT_SRC" ]]; then
  fail "tmux QA residue audit" "restart-services is missing the read-only preflight"
else
  eval "$AUDIT_SRC"
  AUDIT_LOG="$TEST_ROOT/tmux-audit.log"
  AUDIT_ALERT="$TEST_ROOT/tmux-audit-alert.log"
  AUDIT_MUTATIONS=0
  tmux_rescue_probe() { local _timeout="$1"; shift; "$@"; }
  id() { printf '501\n'; }
  ps() {
    printf '%s\n' \
      '501 6000 1 tmux: server' \
      '501 6001 1 /opt/homebrew/bin/tmux -L atlas new-session -Ad -s atlas' \
      '501 6100 1 tmux: server' \
      '501 6200 1 tmux: server' \
      '501 6300 2 tmux: server' \
      '502 6400 1 tmux: server'
  }
  lsof() {
    local pid="" previous=""
    for previous in "$@"; do
      [[ "$pid" == want ]] && { pid="$previous"; break; }
      [[ "$previous" == -p ]] && pid=want
    done
    case "$pid" in
      # macOS resolves /tmp through /private/tmp before lsof reports the
      # descriptor path. Keep the configured production paths in /tmp form
      # below so this fixture catches literal-string allowlist regressions.
      6000) printf 'p6000\nn/private/tmp/tmux-501/default\n' ;;
      6001) printf 'p6001\nn/private/tmp/tmux-501/atlas\n' ;;
      6100) printf 'p6100\nn/tmp/q96/tmux.sock\n' ;;
      6200) printf 'p6200\nn/tmp/q97/tmux.sock\n' ;;
      6300) printf 'p6300\nn/tmp/q98/tmux.sock\n' ;;
    esac
  }
  _tmux_rescue_normalize_socket() {
    case "$1" in
      /tmp/tmux-501/*) printf '/private%s' "$1" ;;
      /tmp/q96/tmux.sock)
        printf '/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-1659/0fa8692e-159c-4a48-b5ab-32292a6f63ff/scratchpad/rig/tmux.sock'
        ;;
      /*) printf '%s' "$1" ;;
      *) return 1 ;;
    esac
  }
  tmux() {
    local socket=""
    [[ "${1:-}" == -S ]] && socket="${2:-}"
    case "$socket" in
      /private/tmp/tmux-501/default) printf 'flywheel\nflywheel-keepalive\n' ;;
      /private/tmp/tmux-501/atlas) printf 'atlas-growth\n' ;;
      /tmp/q96/tmux.sock) printf 'flywheel\nqa-fly1659-noise\n' ;;
      /tmp/q97/tmux.sock) printf 'qa-fly1659-storm\n' ;;
      *) AUDIT_MUTATIONS=$((AUDIT_MUTATIONS + 1)); return 2 ;;
    esac
  }
  kill() { AUDIT_MUTATIONS=$((AUDIT_MUTATIONS + 1)); }
  log() { printf '%s\n' "$*" >> "$AUDIT_LOG"; }
  alert_severe() { printf '%s\n' "$*" >> "$AUDIT_ALERT"; }
  TMUX_TMPDIR=/tmp
  FLYWHEEL_TMUX_AUDIT_ALLOWLIST=/tmp/tmux-501/atlas
  audit_tmux_qa_residue_read_only
  if grep -q 'pid=6100.*socket=/tmp/q96/tmux.sock.*sessions=flywheel,qa-fly1659-noise' "$AUDIT_LOG" \
    && grep -q 'pid=6200.*socket=/tmp/q97/tmux.sock.*sessions=qa-fly1659-storm' "$AUDIT_LOG" \
    && ! grep -q 'pid=6000\|pid=6001\|pid=6300\|pid=6400' "$AUDIT_LOG" \
    && grep -q 'tmux-qa-residue-flywheel-session' "$AUDIT_ALERT" \
    && [[ "$(grep -c 'tmux-qa-residue-flywheel-session' "$AUDIT_ALERT")" -eq 1 ]] \
    && [[ "$AUDIT_MUTATIONS" -eq 0 ]]; then
    pass "restart preflight audits foreign QA sockets and alerts on reserved session names without mutation"
  else
    fail "tmux QA residue audit" "log=$(cat "$AUDIT_LOG" 2>/dev/null || echo missing) alert=$(cat "$AUDIT_ALERT" 2>/dev/null || echo missing) mutations=$AUDIT_MUTATIONS"
  fi
fi

if grep -q 'QA tmux session names MUST use the `qa-` prefix' "$QA_README"; then
  pass "QA framework reserves the qa- tmux session namespace"
else
  fail "QA tmux naming rule" "$QA_README does not reserve the qa- prefix"
fi

echo
echo "[restart-storm-gate.test] passed=$PASSED failed=$FAILED"
[[ "$FAILED" -eq 0 ]]
