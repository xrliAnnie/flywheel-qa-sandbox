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
exit "${FAKE_LEAD_EXIT:-0}"
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

write_held_fixture() { # root child age_seconds state
  python3 - "$1" "$2" "$3" "${4:-held_alert_attempted}" <<'PY'
from datetime import datetime, timedelta, timezone
import json, os, sys

root, child, age_raw, state_name = sys.argv[1:]
os.makedirs(root, exist_ok=True)
hold_at = datetime.now(timezone.utc) - timedelta(seconds=int(age_raw))
window_start = hold_at - timedelta(seconds=5)
events = []
for offset in range(6):
    ts = window_start + timedelta(seconds=offset)
    events.append({"seq": offset + 1, "ts": ts.isoformat(timespec="milliseconds").replace("+00:00", "Z")})
with open(os.path.join(root, f"{child}.jsonl"), "w", encoding="utf-8") as handle:
    for event in events:
        handle.write(json.dumps(event, separators=(",", ":"), sort_keys=True) + "\n")
stamp = window_start.strftime("%Y%m%dT%H%M%SZ")
state = {
    "state": state_name,
    "episode_key": f"{child}__{stamp}__1",
    "window_start": events[0]["ts"],
    "last_resumed_seq": 0,
}
with open(os.path.join(root, f"{child}.state"), "w", encoding="utf-8") as handle:
    handle.write(json.dumps(state, separators=(",", ":"), sort_keys=True) + "\n")
PY
}

write_autoresume_sidecar() { # root child step gap_before_hold_seconds
  python3 - "$1" "$2" "$3" "$4" <<'PY'
from datetime import datetime, timedelta
import json, os, sys

root, child, step_raw, gap_raw = sys.argv[1:]
with open(os.path.join(root, f"{child}.jsonl"), encoding="utf-8") as handle:
    hold_at = datetime.fromisoformat(json.loads(list(handle)[-1])["ts"].replace("Z", "+00:00"))
last = hold_at - timedelta(seconds=int(gap_raw))
value = {
    "schema_version": 1,
    "step": int(step_raw),
    "last_auto_resume_ts": last.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "episode_key": f"{child}__{last.strftime('%Y%m%dT%H%M%SZ')}__99",
}
path = os.path.join(root, f"{child}.auto-resume.json")
with open(path, "w", encoding="utf-8") as handle:
    handle.write(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n")
os.chmod(path, 0o600)
PY
}

write_autoresume_sidecar_v2() { # root child step gap probes cap_probes total_delay [terminal=current]
  python3 - "$@" <<'PY'
from datetime import datetime, timedelta
import json, os, sys

root, child, step_raw, gap_raw, probes_raw, cap_probes_raw, total_raw, *terminal = sys.argv[1:]
with open(os.path.join(root, f"{child}.jsonl"), encoding="utf-8") as handle:
    hold_at = datetime.fromisoformat(json.loads(list(handle)[-1])["ts"].replace("Z", "+00:00"))
with open(os.path.join(root, f"{child}.state"), encoding="utf-8") as handle:
    state = json.load(handle)
last = hold_at - timedelta(seconds=int(gap_raw))
value = {
    "schema_version": 2,
    "step": int(step_raw),
    "last_auto_resume_ts": last.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "episode_key": f"{child}__{last.strftime('%Y%m%dT%H%M%SZ')}__99",
    "probe_count": int(probes_raw),
    "cap_probe_count": int(cap_probes_raw),
    "total_delay_sec": int(total_raw),
    "terminal_episode_key": state["episode_key"] if terminal == ["current"] else None,
}
path = os.path.join(root, f"{child}.auto-resume.json")
with open(path, "w", encoding="utf-8") as handle:
    handle.write(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n")
os.chmod(path, 0o600)
PY
}

write_invalid_autoresume_sidecar() { # root child variant
  python3 - "$1" "$2" "$3" <<'PY'
from datetime import datetime, timedelta, timezone
import json, os, sys

root, child, variant = sys.argv[1:]
path = os.path.join(root, f"{child}.auto-resume.json")
now = datetime.now(timezone.utc)
value = {
    "schema_version": 1,
    "step": 1,
    "last_auto_resume_ts": (now - timedelta(seconds=10)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "episode_key": f"{child}__{(now - timedelta(seconds=10)).strftime('%Y%m%dT%H%M%SZ')}__99",
}
if variant == "bad_json":
    raw = "{bad json\n"
elif variant == "missing_key":
    value.pop("step")
    raw = json.dumps(value)
elif variant == "extra_key":
    value["extra"] = True
    raw = json.dumps(value)
elif variant == "negative_step":
    value["step"] = -1
    raw = json.dumps(value)
elif variant == "large_step":
    value["step"] = 64
    raw = json.dumps(value)
elif variant == "bool_step":
    value["step"] = True
    raw = json.dumps(value)
elif variant == "bad_ts":
    value["last_auto_resume_ts"] = "yesterday"
    raw = json.dumps(value)
elif variant == "future_ts":
    value["last_auto_resume_ts"] = (now + timedelta(hours=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    raw = json.dumps(value)
elif variant == "wrong_child":
    value["episode_key"] = "someone-else__20260815T000000Z__1"
    raw = json.dumps(value)
elif variant == "symlink":
    os.symlink(os.path.join(root, f"{child}.state"), path)
    raise SystemExit
else:
    raw = json.dumps(value)
with open(path, "w", encoding="utf-8") as handle:
    handle.write(raw + ("" if raw.endswith("\n") else "\n"))
os.chmod(path, 0o644 if variant == "unsafe_mode" else 0o600)
PY
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
                "projectsFile": "/tmp/projects.json",
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

# FLY-1784: an open restart-storm breaker must eventually probe again without
# losing its exponential-backoff memory or requiring an operator runbook.
AUTO_ENV=(
  FLYWHEEL_RESTART_STORM_AUTORESUME_BASE_SEC=5
  FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC=60
  FLYWHEEL_RESTART_STORM_AUTORESUME_STICK_SEC=30
  FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_PROBES=6
)
run_auto_expect() { # expected_exit stdout_file stderr_file args...
  local expected="$1" stdout_file="$2" stderr_file="$3"
  shift 3
  env "${AUTO_ENV[@]}" "$GATE" "$@" >"$stdout_file" 2>"$stderr_file"
  local actual=$?
  [[ "$actual" -eq "$expected" ]]
}
run_default_auto_expect() { # expected_exit stdout_file stderr_file args...
  local expected="$1" stdout_file="$2" stderr_file="$3"
  shift 3
  env FLYWHEEL_RESTART_STORM_AUTORESUME_BASE_SEC=300 \
    FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC=3600 \
    FLYWHEEL_RESTART_STORM_AUTORESUME_STICK_SEC=1800 \
    FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_PROBES=6 \
    "$GATE" "$@" >"$stdout_file" 2>"$stderr_file"
  local actual=$?
  [[ "$actual" -eq "$expected" ]]
}

AUTO_DUE_ROOT="$TEST_ROOT/autoresume-due"
write_held_fixture "$AUTO_DUE_ROOT" auto-due 6
: >"$FAKE_LEAD_LOG"
if env "${AUTO_ENV[@]}" "$GATE" gate --root "$AUTO_DUE_ROOT" auto-due \
    >"$TEST_ROOT/out" 2>"$TEST_ROOT/err" \
  && [[ "$(jq -r .state "$AUTO_DUE_ROOT/auto-due.state")" == active ]] \
  && [[ "$(wc -l < "$AUTO_DUE_ROOT/auto-due.jsonl" | tr -d ' ')" == 7 ]] \
  && [[ "$(jq -r .step "$AUTO_DUE_ROOT/auto-due.auto-resume.json")" == 1 ]] \
  && [[ "$(jq -r .event "$AUTO_DUE_ROOT/auto-due.auto-resume.ndjson")" == probe_intent ]] \
  && grep -q -- '--signature .*__auto__1' "$FAKE_LEAD_LOG"; then
  pass "expired hold enters half-open once and durably records probe #1"
else
  fail "auto-resume due" "state=$(cat "$AUTO_DUE_ROOT/auto-due.state" 2>/dev/null || echo missing) err=$(cat "$TEST_ROOT/err")"
fi

AUTO_EARLY_ROOT="$TEST_ROOT/autoresume-early"
write_held_fixture "$AUTO_EARLY_ROOT" auto-early 4
if run_auto_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_EARLY_ROOT" auto-early \
  && [[ "$(wc -l < "$AUTO_EARLY_ROOT/auto-early.jsonl" | tr -d ' ')" == 6 ]] \
  && [[ ! -e "$AUTO_EARLY_ROOT/auto-early.auto-resume.json" ]] \
  && [[ ! -e "$AUTO_EARLY_ROOT/auto-early.auto-resume.ndjson" ]]; then
  pass "hold remains closed until the half-open cooldown expires"
else
  fail "auto-resume early" "state=$(cat "$AUTO_EARLY_ROOT/auto-early.state" 2>/dev/null || echo missing)"
fi

AUTO_BACKOFF_EARLY_ROOT="$TEST_ROOT/autoresume-backoff-early"
write_held_fixture "$AUTO_BACKOFF_EARLY_ROOT" auto-backoff-early 6
write_autoresume_sidecar "$AUTO_BACKOFF_EARLY_ROOT" auto-backoff-early 1 10
if run_auto_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_BACKOFF_EARLY_ROOT" auto-backoff-early; then
  pass "recent failed probe inherits the next ten-second backoff"
else
  fail "auto-resume inherited hold" "state=$(cat "$AUTO_BACKOFF_EARLY_ROOT/auto-backoff-early.state" 2>/dev/null || echo missing)"
fi

AUTO_BACKOFF_DUE_ROOT="$TEST_ROOT/autoresume-backoff-due"
write_held_fixture "$AUTO_BACKOFF_DUE_ROOT" auto-backoff-due 11
write_autoresume_sidecar "$AUTO_BACKOFF_DUE_ROOT" auto-backoff-due 1 10
if run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_BACKOFF_DUE_ROOT" auto-backoff-due \
  && [[ "$(jq -r .step "$AUTO_BACKOFF_DUE_ROOT/auto-backoff-due.auto-resume.json")" == 2 ]]; then
  pass "recent failed probe releases only after the doubled cooldown"
else
  fail "auto-resume inherited release" "state=$(cat "$AUTO_BACKOFF_DUE_ROOT/auto-backoff-due.state" 2>/dev/null || echo missing)"
fi

AUTO_RESET_ROOT="$TEST_ROOT/autoresume-reset"
write_held_fixture "$AUTO_RESET_ROOT" auto-reset 6
write_autoresume_sidecar "$AUTO_RESET_ROOT" auto-reset 3 7200
if run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_RESET_ROOT" auto-reset \
  && [[ "$(jq -r .step "$AUTO_RESET_ROOT/auto-reset.auto-resume.json")" == 1 ]]; then
  pass "a stable interval resets the exponential backoff ladder"
else
  fail "auto-resume ladder reset" "sidecar=$(cat "$AUTO_RESET_ROOT/auto-reset.auto-resume.json" 2>/dev/null || echo missing)"
fi

AUTO_ZERO_REPLAY_ROOT="$TEST_ROOT/autoresume-zero-replay"
write_held_fixture "$AUTO_ZERO_REPLAY_ROOT" auto-zero-replay 6
write_autoresume_sidecar "$AUTO_ZERO_REPLAY_ROOT" auto-zero-replay 0 10
ZERO_REPLAY_SIDECAR="$AUTO_ZERO_REPLAY_ROOT/auto-zero-replay.auto-resume.json"
jq --arg episode_key "$(jq -r .episode_key "$AUTO_ZERO_REPLAY_ROOT/auto-zero-replay.state")" \
  '.episode_key = $episode_key' "$ZERO_REPLAY_SIDECAR" >"$ZERO_REPLAY_SIDECAR.tmp"
mv "$ZERO_REPLAY_SIDECAR.tmp" "$ZERO_REPLAY_SIDECAR"
chmod 0600 "$ZERO_REPLAY_SIDECAR"
if run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_ZERO_REPLAY_ROOT" auto-zero-replay \
  && [[ "$(jq -r .step "$AUTO_ZERO_REPLAY_ROOT/auto-zero-replay.auto-resume.json")" == 1 ]] \
  && [[ "$(find "$AUTO_ZERO_REPLAY_ROOT" -maxdepth 1 -name 'auto-zero-replay.auto-resume.json.corrupt.*' | wc -l | tr -d ' ')" == 1 ]]; then
  pass "unreachable step-zero prepared replay is quarantined before probing"
else
  fail "step-zero prepared replay" "sidecar=$(cat "$AUTO_ZERO_REPLAY_ROOT/auto-zero-replay.auto-resume.json" 2>/dev/null || echo missing)"
fi

AUTO_MANUAL_ROOT="$TEST_ROOT/autoresume-manual-reset"
write_held_fixture "$AUTO_MANUAL_ROOT" auto-manual 1
write_autoresume_sidecar "$AUTO_MANUAL_ROOT" auto-manual 3 10
if run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    resume --root "$AUTO_MANUAL_ROOT" auto-manual \
  && [[ ! -e "$AUTO_MANUAL_ROOT/auto-manual.auto-resume.json" ]]; then
  printf '{"state":"active","last_resumed_seq":6}\n' > "$AUTO_MANUAL_ROOT/auto-manual.state"
  write_autoresume_sidecar "$AUTO_MANUAL_ROOT" auto-manual 2 10
  if run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
      resume --root "$AUTO_MANUAL_ROOT" auto-manual \
    && [[ ! -e "$AUTO_MANUAL_ROOT/auto-manual.auto-resume.json" ]]; then
    pass "manual resume clears backoff memory even when state is already active"
  else
    fail "active manual reset" "sidecar still exists"
  fi
else
  fail "held manual reset" "sidecar still exists"
fi

AUTO_ALERT_ROOT="$TEST_ROOT/autoresume-alert-copy"
: >"$FAKE_LEAD_LOG"
env "${AUTO_ENV[@]}" FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" gate \
  --root "$AUTO_ALERT_ROOT" auto-alert >/dev/null 2>&1
env "${AUTO_ENV[@]}" FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" gate \
  --root "$AUTO_ALERT_ROOT" auto-alert >/dev/null 2>&1 || true
if grep -q 'Auto-resume probe #1' "$FAKE_LEAD_LOG" \
  && grep -q "python3 $GATE resume auto-alert" "$FAKE_LEAD_LOG"; then
  pass "hold alert includes probe ETA and an absolute manual-resume command"
else
  fail "hold alert copy" "lead=$(cat "$FAKE_LEAD_LOG" 2>/dev/null || echo missing)"
fi

AUTO_PENDING_ROOT="$TEST_ROOT/autoresume-pending"
write_held_fixture "$AUTO_PENDING_ROOT" auto-pending 6 held_alert_pending
: >"$FAKE_LEAD_LOG"
if run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_PENDING_ROOT" auto-pending \
  && [[ "$(jq -r .state "$AUTO_PENDING_ROOT/auto-pending.state")" == active ]] \
  && [[ "$(wc -l < "$AUTO_PENDING_ROOT/auto-pending.jsonl" | tr -d ' ')" == 7 ]] \
  && [[ "$(jq -r .step "$AUTO_PENDING_ROOT/auto-pending.auto-resume.json")" == 1 ]] \
  && grep -q -- '--signature auto-pending__.*__auto__1' "$FAKE_LEAD_LOG"; then
  pass "expired pending hold finishes alert recovery before one half-open release"
else
  fail "pending auto-resume" "state=$(cat "$AUTO_PENDING_ROOT/auto-pending.state" 2>/dev/null || echo missing)"
fi

AUTO_BAD_COUNT=0
for variant in bad_json missing_key extra_key negative_step large_step bool_step \
    bad_ts future_ts wrong_child symlink unsafe_mode; do
  child="bad-$variant"
  root="$TEST_ROOT/autoresume-$variant"
  write_held_fixture "$root" "$child" 6
  write_invalid_autoresume_sidecar "$root" "$child" "$variant"
  if run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
      gate --root "$root" "$child" \
    && [[ "$(jq -r .state "$root/$child.state")" == active ]] \
    && [[ "$(find "$root" -maxdepth 1 -name "$child.auto-resume.json.corrupt.*" | wc -l | tr -d ' ')" == 1 ]] \
    && [[ "$(jq -r .step "$root/$child.auto-resume.json")" == 1 ]]; then
    AUTO_BAD_COUNT=$((AUTO_BAD_COUNT + 1))
  fi
done
if [[ "$AUTO_BAD_COUNT" -eq 11 ]] \
  && grep -q 'restart_gate_autoresume_corrupt' "$FAKE_META_LOG"; then
  pass "invalid, unsafe, and future auto-resume sidecars quarantine fail-open"
else
  fail "auto-resume sidecar matrix" "passed=$AUTO_BAD_COUNT/11"
fi

AUTO_ALERT_FAIL_ROOT="$TEST_ROOT/autoresume-alert-failure"
write_held_fixture "$AUTO_ALERT_FAIL_ROOT" auto-alert-failure 6
if env "${AUTO_ENV[@]}" FAKE_LEAD_RESULT=config_error FAKE_LEAD_EXIT=1 \
    "$GATE" gate --root "$AUTO_ALERT_FAIL_ROOT" auto-alert-failure \
    >"$TEST_ROOT/out" 2>"$TEST_ROOT/err" \
  && [[ "$(jq -r .state "$AUTO_ALERT_FAIL_ROOT/auto-alert-failure.state")" == active ]] \
  && [[ "$(jq -r .event "$AUTO_ALERT_FAIL_ROOT/auto-alert-failure.auto-resume.ndjson")" == probe_intent ]]; then
  pass "best-effort alert failure cannot roll back a durable half-open release"
else
  fail "auto-resume alert failure" "state=$(cat "$AUTO_ALERT_FAIL_ROOT/auto-alert-failure.state" 2>/dev/null || echo missing)"
fi

AUTO_FIRST_CAP_ROOT="$TEST_ROOT/autoresume-first-cap"
write_held_fixture "$AUTO_FIRST_CAP_ROOT" first-cap 61
write_autoresume_sidecar_v2 "$AUTO_FIRST_CAP_ROOT" first-cap 4 10 4 0 75
if run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_FIRST_CAP_ROOT" first-cap \
  && [[ "$(jq -r .probe_count "$AUTO_FIRST_CAP_ROOT/first-cap.auto-resume.json")" == 5 ]] \
  && [[ "$(jq -r .cap_probe_count "$AUTO_FIRST_CAP_ROOT/first-cap.auto-resume.json")" == 1 ]] \
  && [[ "$(jq -r .total_delay_sec "$AUTO_FIRST_CAP_ROOT/first-cap.auto-resume.json")" == 135 ]]; then
  pass "the first 60-minute tier release counts as cap probe one"
else
  fail "first cap probe" "sidecar=$(cat "$AUTO_FIRST_CAP_ROOT/first-cap.auto-resume.json" 2>/dev/null || echo missing)"
fi

AUTO_TERMINAL_ROOT="$TEST_ROOT/autoresume-terminal"
write_held_fixture "$AUTO_TERMINAL_ROOT" auto-terminal 3601
write_autoresume_sidecar_v2 "$AUTO_TERMINAL_ROOT" auto-terminal 8 10 8 4 18900
if run_default_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_TERMINAL_ROOT" auto-terminal \
  && [[ "$(jq -r .cap_probe_count "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.json")" == 5 ]]; then
  write_held_fixture "$AUTO_TERMINAL_ROOT" auto-terminal 3701
  if run_default_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
      gate --root "$AUTO_TERMINAL_ROOT" auto-terminal \
    && [[ "$(jq -r .probe_count "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.json")" == 10 ]] \
    && [[ "$(jq -r .cap_probe_count "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.json")" == 6 ]] \
    && [[ "$(jq -r .total_delay_sec "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.json")" == 26100 ]]; then
    write_held_fixture "$AUTO_TERMINAL_ROOT" auto-terminal 1
    : >"$FAKE_LEAD_LOG"
    : >"$FAKE_META_LOG"
    TERMINAL_LEDGER_BEFORE="$(wc -l < "$AUTO_TERMINAL_ROOT/auto-terminal.jsonl" | tr -d ' ')"
    if run_default_auto_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
        gate --root "$AUTO_TERMINAL_ROOT" auto-terminal \
      && [[ "$(jq -r .state "$AUTO_TERMINAL_ROOT/auto-terminal.state")" == terminal_hold ]] \
      && [[ "$(jq -r .terminal_episode_key "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.json")" == "$(jq -r .episode_key "$AUTO_TERMINAL_ROOT/auto-terminal.state")" ]] \
      && [[ "$(wc -l < "$AUTO_TERMINAL_ROOT/auto-terminal.jsonl" | tr -d ' ')" == "$TERMINAL_LEDGER_BEFORE" ]] \
      && grep -q -- '--kind restart_storm_hold --severity severe' "$FAKE_LEAD_LOG" \
      && grep -q 'Automatic recovery abandoned after 10 probes over 7.25h' "$FAKE_LEAD_LOG" \
      && grep -q "terminal_hold requires manual recovery: python3 $GATE resume auto-terminal" "$FAKE_LEAD_LOG" \
      && grep -q -- '--signature .*__terminal' "$FAKE_LEAD_LOG" \
      && ! grep -q 'Restart storm held:' "$FAKE_LEAD_LOG"; then
      TERMINAL_SIDECAR_SUM="$(cksum "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.json")"
      TERMINAL_AUDIT_SUM="$(cksum "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.ndjson")"
      TERMINAL_ALERT_LINES="$(wc -l < "$FAKE_LEAD_LOG" | tr -d ' ')"
      if run_default_auto_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
          gate --root "$AUTO_TERMINAL_ROOT" auto-terminal \
        && [[ "$(cksum "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.json")" == "$TERMINAL_SIDECAR_SUM" ]] \
        && [[ "$(cksum "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.ndjson")" == "$TERMINAL_AUDIT_SUM" ]] \
        && [[ "$(wc -l < "$FAKE_LEAD_LOG" | tr -d ' ')" == "$TERMINAL_ALERT_LINES" ]] \
        && run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
             resume --root "$AUTO_TERMINAL_ROOT" auto-terminal \
        && [[ ! -e "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.json" ]]; then
        pass "six capped failures enter an explicit quiet terminal hold with one actionable final alert"
      else
        fail "terminal hold idempotency and manual exit" "state=$(cat "$AUTO_TERMINAL_ROOT/auto-terminal.state") lead=$(cat "$FAKE_LEAD_LOG")"
      fi
    else
      fail "terminal hold transition" "state=$(cat "$AUTO_TERMINAL_ROOT/auto-terminal.state") lead=$(cat "$FAKE_LEAD_LOG")"
    fi
  else
    fail "sixth cap probe" "sidecar=$(cat "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.json" 2>/dev/null || echo missing)"
  fi
else
  fail "fifth cap probe remains recoverable" "sidecar=$(cat "$AUTO_TERMINAL_ROOT/auto-terminal.auto-resume.json" 2>/dev/null || echo missing)"
fi

AUTO_CUSTOM_LIMIT_ROOT="$TEST_ROOT/autoresume-custom-limit"
write_held_fixture "$AUTO_CUSTOM_LIMIT_ROOT" custom-limit 61
write_autoresume_sidecar_v2 "$AUTO_CUSTOM_LIMIT_ROOT" custom-limit 4 10 4 0 75
if env "${AUTO_ENV[@]}" FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_PROBES=1 \
    "$GATE" gate --root "$AUTO_CUSTOM_LIMIT_ROOT" custom-limit >/dev/null 2>&1; then
  write_held_fixture "$AUTO_CUSTOM_LIMIT_ROOT" custom-limit 1
  env "${AUTO_ENV[@]}" FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_PROBES=1 \
    "$GATE" gate --root "$AUTO_CUSTOM_LIMIT_ROOT" custom-limit \
    >"$TEST_ROOT/out" 2>"$TEST_ROOT/err"
  AUTO_CUSTOM_LIMIT_RC=$?
else
  AUTO_CUSTOM_LIMIT_RC=99
fi
if [[ "$AUTO_CUSTOM_LIMIT_RC" -eq 3 ]] \
  && [[ "$(jq -r .state "$AUTO_CUSTOM_LIMIT_ROOT/custom-limit.state")" == terminal_hold ]] \
  && [[ "$(jq -r .cap_probe_count "$AUTO_CUSTOM_LIMIT_ROOT/custom-limit.auto-resume.json")" == 1 ]]; then
  pass "the configurable cap-probe budget terminates after its first capped failure"
else
  fail "custom cap-probe budget" "rc=$AUTO_CUSTOM_LIMIT_RC state=$(cat "$AUTO_CUSTOM_LIMIT_ROOT/custom-limit.state" 2>/dev/null || echo missing)"
fi

AUTO_CAP_CRASH_ROOT="$TEST_ROOT/autoresume-cap-crash"
write_held_fixture "$AUTO_CAP_CRASH_ROOT" cap-crash 61
write_autoresume_sidecar_v2 "$AUTO_CAP_CRASH_ROOT" cap-crash 9 10 9 5 22500
env "${AUTO_ENV[@]}" FLYWHEEL_RESTART_STORM_FAULT=after_autoresume_sidecar \
  "$GATE" gate --root "$AUTO_CAP_CRASH_ROOT" cap-crash >/dev/null 2>&1
AUTO_CAP_CRASH_RC=$?
if [[ "$AUTO_CAP_CRASH_RC" -eq 97 ]] \
  && [[ "$(jq -r .probe_count "$AUTO_CAP_CRASH_ROOT/cap-crash.auto-resume.json")" == 10 ]] \
  && [[ "$(jq -r .cap_probe_count "$AUTO_CAP_CRASH_ROOT/cap-crash.auto-resume.json")" == 6 ]] \
  && run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$AUTO_CAP_CRASH_ROOT" cap-crash \
  && [[ "$(jq -r .probe_count "$AUTO_CAP_CRASH_ROOT/cap-crash.auto-resume.json")" == 10 ]]; then
  write_held_fixture "$AUTO_CAP_CRASH_ROOT" cap-crash 1
  if run_auto_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
      gate --root "$AUTO_CAP_CRASH_ROOT" cap-crash \
    && [[ "$(jq -r .state "$AUTO_CAP_CRASH_ROOT/cap-crash.state")" == terminal_hold ]]; then
    pass "a crash after the sixth cap sidecar replays without consuming a seventh probe"
  else
    fail "sixth cap crash retrip" "state=$(cat "$AUTO_CAP_CRASH_ROOT/cap-crash.state")"
  fi
else
  fail "sixth cap sidecar crash" "rc=$AUTO_CAP_CRASH_RC sidecar=$(cat "$AUTO_CAP_CRASH_ROOT/cap-crash.auto-resume.json" 2>/dev/null || echo missing)"
fi

AUTO_TERMINAL_CRASH_ROOT="$TEST_ROOT/autoresume-terminal-crash"
write_held_fixture "$AUTO_TERMINAL_CRASH_ROOT" terminal-crash 1
write_autoresume_sidecar_v2 "$AUTO_TERMINAL_CRASH_ROOT" terminal-crash 10 10 10 6 26100
env "${AUTO_ENV[@]}" FLYWHEEL_RESTART_STORM_FAULT=after_terminal_sidecar \
  "$GATE" gate --root "$AUTO_TERMINAL_CRASH_ROOT" terminal-crash >/dev/null 2>&1
AUTO_TERMINAL_CRASH_RC=$?
if [[ "$AUTO_TERMINAL_CRASH_RC" -eq 97 ]] \
  && [[ "$(jq -r .state "$AUTO_TERMINAL_CRASH_ROOT/terminal-crash.state")" == held_alert_attempted ]] \
  && [[ "$(jq -r .terminal_episode_key "$AUTO_TERMINAL_CRASH_ROOT/terminal-crash.auto-resume.json")" == "$(jq -r .episode_key "$AUTO_TERMINAL_CRASH_ROOT/terminal-crash.state")" ]] \
  && run_auto_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$AUTO_TERMINAL_CRASH_ROOT" terminal-crash \
  && [[ "$(jq -r .state "$AUTO_TERMINAL_CRASH_ROOT/terminal-crash.state")" == terminal_hold ]]; then
  pass "a durable terminal sidecar intent converges after a state-commit crash"
else
  fail "terminal sidecar crash recovery" "rc=$AUTO_TERMINAL_CRASH_RC state=$(cat "$AUTO_TERMINAL_CRASH_ROOT/terminal-crash.state")"
fi

AUTO_V1_ROOT="$TEST_ROOT/autoresume-v1-upgrade"
write_held_fixture "$AUTO_V1_ROOT" v1-upgrade 11
write_autoresume_sidecar "$AUTO_V1_ROOT" v1-upgrade 1 10
if run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_V1_ROOT" v1-upgrade \
  && [[ "$(jq -r .schema_version "$AUTO_V1_ROOT/v1-upgrade.auto-resume.json")" == 2 ]] \
  && [[ "$(jq -r .probe_count "$AUTO_V1_ROOT/v1-upgrade.auto-resume.json")" == 2 ]] \
  && [[ "$(jq -r .terminal_episode_key "$AUTO_V1_ROOT/v1-upgrade.auto-resume.json")" == null ]] \
  && [[ "$(find "$AUTO_V1_ROOT" -name '*.corrupt.*' | wc -l | tr -d ' ')" == 0 ]]; then
  pass "legacy sidecar v1 is accepted and upgraded on the next probe"
else
  fail "sidecar v1 upgrade" "sidecar=$(cat "$AUTO_V1_ROOT/v1-upgrade.auto-resume.json" 2>/dev/null || echo missing)"
fi

AUTO_V2_BAD_COUNT=0
for variant in missing_counter extra_counter bool_counter negative_counter \
    cap_gt_total step_gt_total negative_delay bad_terminal; do
  child="v2-$variant"
  root="$TEST_ROOT/autoresume-$child"
  write_held_fixture "$root" "$child" 6
  write_autoresume_sidecar_v2 "$root" "$child" 1 10 1 0 5
  sidecar="$root/$child.auto-resume.json"
  case "$variant" in
    missing_counter) expression='del(.probe_count)' ;;
    extra_counter) expression='.extra = 1' ;;
    bool_counter) expression='.probe_count = true' ;;
    negative_counter) expression='.cap_probe_count = -1' ;;
    cap_gt_total) expression='.cap_probe_count = 2' ;;
    step_gt_total) expression='.step = 2' ;;
    negative_delay) expression='.total_delay_sec = -1' ;;
    bad_terminal) expression='.terminal_episode_key = "someone-else__20260815T000000Z__1"' ;;
  esac
  jq "$expression" "$sidecar" >"$sidecar.tmp"
  mv "$sidecar.tmp" "$sidecar"
  chmod 0600 "$sidecar"
  if run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
      gate --root "$root" "$child" \
    && [[ "$(find "$root" -maxdepth 1 -name "$child.auto-resume.json.corrupt.*" | wc -l | tr -d ' ')" == 1 ]]; then
    AUTO_V2_BAD_COUNT=$((AUTO_V2_BAD_COUNT + 1))
  fi
done
if [[ "$AUTO_V2_BAD_COUNT" -eq 8 ]]; then
  pass "invalid v2 counters and terminal markers quarantine fail-open"
else
  fail "auto-resume v2 validation" "passed=$AUTO_V2_BAD_COUNT/8"
fi

AUTO_RECORD_TERMINAL_ROOT="$TEST_ROOT/autoresume-record-terminal"
write_held_fixture "$AUTO_RECORD_TERMINAL_ROOT" record-terminal 1
printf '{"last_resumed_seq":0,"state":"active"}\n' > "$AUTO_RECORD_TERMINAL_ROOT/record-terminal.state"
write_autoresume_sidecar_v2 "$AUTO_RECORD_TERMINAL_ROOT" record-terminal 10 10 10 6 26100
: >"$FAKE_LEAD_LOG"
env "${AUTO_ENV[@]}" FLYWHEEL_RESTART_STORM_MAX=5 "$GATE" record-failure \
  --expected-seq 6 --root "$AUTO_RECORD_TERMINAL_ROOT" record-terminal \
  >"$TEST_ROOT/out" 2>"$TEST_ROOT/err"
AUTO_RECORD_TERMINAL_RC=$?
if [[ "$AUTO_RECORD_TERMINAL_RC" -eq 3 ]] \
  && [[ "$(jq -r .state "$AUTO_RECORD_TERMINAL_ROOT/record-terminal.state")" == terminal_hold ]] \
  && [[ "$(jq -r .reason "$TEST_ROOT/out")" == null ]] \
  && grep -q 'Automatic recovery abandoned after 10 probes over 7.25h' "$FAKE_LEAD_LOG"; then
  pass "record-failure re-trips into the same finite terminal state"
else
  fail "record-failure terminal transition" "rc=$AUTO_RECORD_TERMINAL_RC out=$(cat "$TEST_ROOT/out") state=$(cat "$AUTO_RECORD_TERMINAL_ROOT/record-terminal.state")"
fi

AUTO_SATURATED_ROOT="$TEST_ROOT/autoresume-saturated"
write_held_fixture "$AUTO_SATURATED_ROOT" auto-saturated 61
write_autoresume_sidecar "$AUTO_SATURATED_ROOT" auto-saturated 32 10
if run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_SATURATED_ROOT" auto-saturated \
  && [[ "$(jq -r .step "$AUTO_SATURATED_ROOT/auto-saturated.auto-resume.json")" == 32 ]]; then
  write_held_fixture "$AUTO_SATURATED_ROOT" auto-saturated 62
  if run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
      gate --root "$AUTO_SATURATED_ROOT" auto-saturated \
    && [[ "$(jq -r .step "$AUTO_SATURATED_ROOT/auto-saturated.auto-resume.json")" == 32 ]] \
    && [[ "$(find "$AUTO_SATURATED_ROOT" -name '*.corrupt.*' | wc -l | tr -d ' ')" == 0 ]]; then
    pass "saturated step 32 stays at the cap across repeated re-trips"
  else
    fail "auto-resume saturated retrip" "sidecar=$(cat "$AUTO_SATURATED_ROOT/auto-saturated.auto-resume.json" 2>/dev/null || echo missing)"
  fi
else
  fail "auto-resume saturation" "sidecar=$(cat "$AUTO_SATURATED_ROOT/auto-saturated.auto-resume.json" 2>/dev/null || echo missing)"
fi

AUTO_EQUAL_CAP_ROOT="$TEST_ROOT/autoresume-equal-cap"
write_held_fixture "$AUTO_EQUAL_CAP_ROOT" auto-equal-cap 6
write_autoresume_sidecar "$AUTO_EQUAL_CAP_ROOT" auto-equal-cap 3 10
AUTO_ODD_CAP_ROOT="$TEST_ROOT/autoresume-odd-cap"
write_held_fixture "$AUTO_ODD_CAP_ROOT" auto-odd-cap 14
write_autoresume_sidecar "$AUTO_ODD_CAP_ROOT" auto-odd-cap 2 10
if env FLYWHEEL_RESTART_STORM_AUTORESUME_BASE_SEC=5 \
       FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC=5 \
       FLYWHEEL_RESTART_STORM_AUTORESUME_STICK_SEC=30 \
       "$GATE" gate --root "$AUTO_EQUAL_CAP_ROOT" auto-equal-cap >/dev/null 2>&1 \
  && [[ "$(jq -r .step "$AUTO_EQUAL_CAP_ROOT/auto-equal-cap.auto-resume.json")" == 4 ]] \
  && env FLYWHEEL_RESTART_STORM_AUTORESUME_BASE_SEC=5 \
       FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC=13 \
       FLYWHEEL_RESTART_STORM_AUTORESUME_STICK_SEC=30 \
       "$GATE" gate --root "$AUTO_ODD_CAP_ROOT" auto-odd-cap >/dev/null 2>&1 \
  && [[ "$(jq -r .step "$AUTO_ODD_CAP_ROOT/auto-odd-cap.auto-resume.json")" == 3 ]]; then
  pass "equal and non-power-of-two caps use the bounded integer schedule"
else
  fail "auto-resume cap formulas" "equal=$(cat "$AUTO_EQUAL_CAP_ROOT/auto-equal-cap.state") odd=$(cat "$AUTO_ODD_CAP_ROOT/auto-odd-cap.state")"
fi

AUTO_INVALID_OK=true
for command in gate record-failure; do
  for variant in base_gt_cap nonnumeric cap_too_large zero_cap_probes \
      nonnumeric_cap_probes; do
    root="$TEST_ROOT/autoresume-invalid-$command-$variant"
    case "$variant" in
      base_gt_cap) invalid_env=(FLYWHEEL_RESTART_STORM_AUTORESUME_BASE_SEC=10 FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC=5) ;;
      nonnumeric) invalid_env=(FLYWHEEL_RESTART_STORM_AUTORESUME_BASE_SEC=nope) ;;
      cap_too_large) invalid_env=(FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC=31536001) ;;
      zero_cap_probes) invalid_env=(FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_PROBES=0) ;;
      nonnumeric_cap_probes) invalid_env=(FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_PROBES=nope) ;;
    esac
    if [[ "$command" == gate ]]; then
      env "${invalid_env[@]}" "$GATE" gate --root "$root" invalid-config \
        >"$TEST_ROOT/out" 2>"$TEST_ROOT/err"
    else
      env "${invalid_env[@]}" "$GATE" record-failure --expected-seq 0 \
        --root "$root" invalid-config >"$TEST_ROOT/out" 2>"$TEST_ROOT/err"
    fi
    rc=$?
    if [[ "$rc" -ne 4 ]] || [[ -e "$root" ]] || ! grep -q 'restart-storm-gate:' "$TEST_ROOT/err"; then
      AUTO_INVALID_OK=false
    fi
  done
done
if [[ "$AUTO_INVALID_OK" == true ]]; then
  pass "invalid auto-resume config fails closed before gate or record mutation"
else
  fail "auto-resume config validation" "one or more invalid inputs mutated state or returned an untyped exit"
fi

AUTO_MAX_TS_ROOT="$TEST_ROOT/autoresume-max-ts"
mkdir -p "$AUTO_MAX_TS_ROOT"
printf '{"seq":1,"ts":"9999-12-31T23:59:59.000Z"}\n' > "$AUTO_MAX_TS_ROOT/max-ts.jsonl"
printf '{"episode_key":"max-ts__99991231T235959Z__1","last_resumed_seq":0,"state":"held_alert_attempted","window_start":"9999-12-31T23:59:59.000Z"}\n' \
  > "$AUTO_MAX_TS_ROOT/max-ts.state"
if run_auto_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_MAX_TS_ROOT" max-ts \
  && grep -q 'auto-resume ETA overflows' "$TEST_ROOT/err" \
  && ! grep -q 'Traceback' "$TEST_ROOT/err" \
  && [[ "$(jq -r .state "$AUTO_MAX_TS_ROOT/max-ts.state")" == held_alert_attempted ]]; then
  pass "near-datetime-max hold returns typed invalid without releasing"
else
  fail "auto-resume datetime overflow" "rc or stderr mismatch: $(cat "$TEST_ROOT/err")"
fi

AUTO_FUTURE_HOLD_ROOT="$TEST_ROOT/autoresume-future-hold"
write_held_fixture "$AUTO_FUTURE_HOLD_ROOT" future-hold -60
if run_auto_expect 3 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_FUTURE_HOLD_ROOT" future-hold; then
  pass "clock rollback never releases a hold before its computed ETA"
else
  fail "future hold" "state=$(cat "$AUTO_FUTURE_HOLD_ROOT/future-hold.state")"
fi

AUTO_RECORD_HELD_ROOT="$TEST_ROOT/autoresume-record-held"
write_held_fixture "$AUTO_RECORD_HELD_ROOT" record-held 60
if env "${AUTO_ENV[@]}" "$GATE" record-failure --expected-seq 6 \
    --root "$AUTO_RECORD_HELD_ROOT" record-held >"$TEST_ROOT/out" 2>"$TEST_ROOT/err"; then
  AUTO_RECORD_HELD_RC=0
else
  AUTO_RECORD_HELD_RC=$?
fi
if [[ "$AUTO_RECORD_HELD_RC" -eq 3 ]] \
  && [[ "$(jq -r .state "$AUTO_RECORD_HELD_ROOT/record-held.state")" == held_alert_attempted ]] \
  && [[ ! -e "$AUTO_RECORD_HELD_ROOT/record-held.auto-resume.json" ]]; then
  pass "record-failure remains accounting-only and never performs half-open release"
else
  fail "record-failure auto-resume isolation" "rc=$AUTO_RECORD_HELD_RC"
fi

AUTO_RECORD_ALERT_ROOT="$TEST_ROOT/autoresume-record-alert"
: >"$FAKE_LEAD_LOG"
env "${AUTO_ENV[@]}" FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" record-failure \
  --expected-seq 0 --root "$AUTO_RECORD_ALERT_ROOT" record-alert >/dev/null 2>&1
env "${AUTO_ENV[@]}" FLYWHEEL_RESTART_STORM_MAX=1 "$GATE" record-failure \
  --expected-seq 1 --root "$AUTO_RECORD_ALERT_ROOT" record-alert >/dev/null 2>&1 || true
if grep -q 'Auto-resume probe #1' "$FAKE_LEAD_LOG" \
  && grep -q "python3 $GATE resume record-alert" "$FAKE_LEAD_LOG"; then
  pass "record-failure hold alerts share the ETA and absolute recovery copy"
else
  fail "record-failure alert copy" "lead=$(cat "$FAKE_LEAD_LOG" 2>/dev/null || echo missing)"
fi

AUTO_CONTROL_ROOT="$TEST_ROOT/autoresume-controlled-reset"
write_held_fixture "$AUTO_CONTROL_ROOT" lead.flywheel-eng-lead 1
write_autoresume_sidecar "$AUTO_CONTROL_ROOT" lead.flywheel-eng-lead 3 10
if run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" arm-controlled-wave \
    --expected-seq 6 --intent-marker "$CONTROL_MARKER" \
    --attempt-id "$CONTROL_ATTEMPT" --root "$AUTO_CONTROL_ROOT" \
    lead.flywheel-eng-lead \
  && [[ ! -e "$AUTO_CONTROL_ROOT/lead.flywheel-eng-lead.auto-resume.json" ]]; then
  pass "controlled wave explicitly resets the auto-resume ladder"
else
  fail "controlled auto-resume reset" "sidecar still exists"
fi

AUTO_CONTROL_TERMINAL_ROOT="$TEST_ROOT/autoresume-controlled-terminal"
write_held_fixture "$AUTO_CONTROL_TERMINAL_ROOT" lead.flywheel-eng-lead 1 terminal_hold
write_autoresume_sidecar_v2 "$AUTO_CONTROL_TERMINAL_ROOT" lead.flywheel-eng-lead 10 10 10 6 26100 current
if run_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" arm-controlled-wave \
    --expected-seq 6 --intent-marker "$CONTROL_MARKER" \
    --attempt-id "$CONTROL_ATTEMPT" --root "$AUTO_CONTROL_TERMINAL_ROOT" \
    lead.flywheel-eng-lead \
  && [[ "$(jq -r .state "$AUTO_CONTROL_TERMINAL_ROOT/lead.flywheel-eng-lead.state")" == resumed ]] \
  && [[ ! -e "$AUTO_CONTROL_TERMINAL_ROOT/lead.flywheel-eng-lead.auto-resume.json" ]]; then
  pass "controlled wave is an explicit exit from terminal hold"
else
  fail "controlled terminal exit" "state=$(cat "$AUTO_CONTROL_TERMINAL_ROOT/lead.flywheel-eng-lead.state")"
fi

AUTO_CONTROL_FAULT_ROOT="$TEST_ROOT/autoresume-controlled-fault-reset"
write_held_fixture "$AUTO_CONTROL_FAULT_ROOT" lead.flywheel-eng-lead 1
write_autoresume_sidecar "$AUTO_CONTROL_FAULT_ROOT" lead.flywheel-eng-lead 3 10
env FLYWHEEL_RESTART_STORM_FAULT=after_controlled_state "$GATE" \
  arm-controlled-wave --expected-seq 6 --intent-marker "$CONTROL_MARKER" \
  --attempt-id "$CONTROL_ATTEMPT" --root "$AUTO_CONTROL_FAULT_ROOT" \
  lead.flywheel-eng-lead >/dev/null 2>&1
AUTO_CONTROL_FAULT_RC=$?
write_held_fixture "$AUTO_CONTROL_FAULT_ROOT" lead.flywheel-eng-lead 6
if [[ "$AUTO_CONTROL_FAULT_RC" -eq 97 ]] \
  && [[ ! -e "$AUTO_CONTROL_FAULT_ROOT/lead.flywheel-eng-lead.auto-resume.json" ]] \
  && run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$AUTO_CONTROL_FAULT_ROOT" lead.flywheel-eng-lead \
  && [[ "$(jq -r .step "$AUTO_CONTROL_FAULT_ROOT/lead.flywheel-eng-lead.auto-resume.json")" == 1 ]]; then
  pass "controlled-wave state fault still commits the operator ladder reset"
else
  fail "controlled fault reset" "rc=$AUTO_CONTROL_FAULT_RC sidecar=$(cat "$AUTO_CONTROL_FAULT_ROOT/lead.flywheel-eng-lead.auto-resume.json" 2>/dev/null || echo missing)"
fi

AUTO_AUDIT_FAULT_ROOT="$TEST_ROOT/autoresume-fault-audit"
write_held_fixture "$AUTO_AUDIT_FAULT_ROOT" fault-audit 6
env "${AUTO_ENV[@]}" FLYWHEEL_RESTART_STORM_FAULT=after_autoresume_audit \
  "$GATE" gate --root "$AUTO_AUDIT_FAULT_ROOT" fault-audit >/dev/null 2>&1
AUTO_AUDIT_FAULT_RC=$?
if [[ "$AUTO_AUDIT_FAULT_RC" -eq 97 ]] \
  && [[ "$(jq -r .state "$AUTO_AUDIT_FAULT_ROOT/fault-audit.state")" == held_alert_attempted ]] \
  && [[ ! -e "$AUTO_AUDIT_FAULT_ROOT/fault-audit.auto-resume.json" ]] \
  && run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$AUTO_AUDIT_FAULT_ROOT" fault-audit \
  && [[ "$(python3 -c 'import json,sys; print([json.loads(x)["event"] for x in open(sys.argv[1])])' "$AUTO_AUDIT_FAULT_ROOT/fault-audit.auto-resume.ndjson")" == "['probe_intent', 'probe_intent']" ]] \
  && [[ "$(jq -r .step "$AUTO_AUDIT_FAULT_ROOT/fault-audit.auto-resume.json")" == 1 ]]; then
  pass "crash after audit replays without consuming another backoff step"
else
  fail "auto-resume audit crash" "rc=$AUTO_AUDIT_FAULT_RC"
fi

AUTO_SIDECAR_FAULT_ROOT="$TEST_ROOT/autoresume-fault-sidecar"
write_held_fixture "$AUTO_SIDECAR_FAULT_ROOT" fault-sidecar 6 held_alert_pending
: >"$FAKE_LEAD_LOG"
env "${AUTO_ENV[@]}" FAKE_LEAD_RESULT=duplicate \
  FLYWHEEL_RESTART_STORM_FAULT=after_autoresume_sidecar \
  "$GATE" gate --root "$AUTO_SIDECAR_FAULT_ROOT" fault-sidecar >/dev/null 2>&1
AUTO_SIDECAR_FAULT_RC=$?
if [[ "$AUTO_SIDECAR_FAULT_RC" -eq 97 ]] \
  && [[ "$(jq -r .state "$AUTO_SIDECAR_FAULT_ROOT/fault-sidecar.state")" == held_alert_pending ]] \
  && [[ "$(jq -r .step "$AUTO_SIDECAR_FAULT_ROOT/fault-sidecar.auto-resume.json")" == 1 ]] \
  && run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$AUTO_SIDECAR_FAULT_ROOT" fault-sidecar \
  && [[ "$(python3 -c 'import json,sys; print([json.loads(x)["event"] for x in open(sys.argv[1])])' "$AUTO_SIDECAR_FAULT_ROOT/fault-sidecar.auto-resume.ndjson")" == "['probe_intent', 'probe_replayed']" ]] \
  && [[ "$(jq -r .step "$AUTO_SIDECAR_FAULT_ROOT/fault-sidecar.auto-resume.json")" == 1 ]] \
  && grep -q 'prepared probe #1 replaying now' "$FAKE_LEAD_LOG"; then
  pass "prepared sidecar replays immediately with the original probe identity"
else
  fail "auto-resume sidecar crash" "rc=$AUTO_SIDECAR_FAULT_RC state=$(cat "$AUTO_SIDECAR_FAULT_ROOT/fault-sidecar.state")"
fi

AUTO_STATE_FAULT_ROOT="$TEST_ROOT/autoresume-fault-state"
write_held_fixture "$AUTO_STATE_FAULT_ROOT" fault-state 6
env "${AUTO_ENV[@]}" FLYWHEEL_RESTART_STORM_FAULT=after_autoresume_state \
  "$GATE" gate --root "$AUTO_STATE_FAULT_ROOT" fault-state >/dev/null 2>&1
AUTO_STATE_FAULT_RC=$?
if [[ "$AUTO_STATE_FAULT_RC" -eq 97 ]] \
  && [[ "$(jq -r .state "$AUTO_STATE_FAULT_ROOT/fault-state.state")" == resumed ]] \
  && run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
       gate --root "$AUTO_STATE_FAULT_ROOT" fault-state \
  && [[ "$(jq -r .state "$AUTO_STATE_FAULT_ROOT/fault-state.state")" == active ]] \
  && [[ "$(wc -l < "$AUTO_STATE_FAULT_ROOT/fault-state.jsonl" | tr -d ' ')" == 7 ]] \
  && [[ "$(wc -l < "$AUTO_STATE_FAULT_ROOT/fault-state.auto-resume.ndjson" | tr -d ' ')" == 1 ]]; then
  pass "crash after state commit resumes through the existing normalization path"
else
  fail "auto-resume state crash" "rc=$AUTO_STATE_FAULT_RC"
fi

AUTO_CORRUPT_LEDGER_ROOT="$TEST_ROOT/autoresume-corrupt-held-ledger"
write_held_fixture "$AUTO_CORRUPT_LEDGER_ROOT" corrupt-held 1
sed -i.bak '2s/.*/{corrupt}/' "$AUTO_CORRUPT_LEDGER_ROOT/corrupt-held.jsonl"
if run_auto_expect 4 "$TEST_ROOT/out" "$TEST_ROOT/err" \
    gate --root "$AUTO_CORRUPT_LEDGER_ROOT" corrupt-held \
  && [[ ! -e "$AUTO_CORRUPT_LEDGER_ROOT/corrupt-held.jsonl" ]] \
  && [[ "$(find "$AUTO_CORRUPT_LEDGER_ROOT/ledger-quarantine" -type f | wc -l | tr -d ' ')" == 1 ]]; then
  pass "held-attempted path now quarantines corrupt ledgers before probing"
else
  fail "held corrupt ledger" "stderr=$(cat "$TEST_ROOT/err")"
fi

AUTO_AUDIT_NEGATIVE_OK=true
for variant in symlink unsafe_mode injected_error; do
  child="audit-$variant"
  root="$TEST_ROOT/autoresume-audit-$variant"
  write_held_fixture "$root" "$child" 6
  audit="$root/$child.auto-resume.ndjson"
  case "$variant" in
    symlink) ln -s "$root/$child.state" "$audit" ;;
    unsafe_mode) : >"$audit"; chmod 0644 "$audit" ;;
    injected_error) ;;
  esac
  fault_env=()
  [[ "$variant" == injected_error ]] \
    && fault_env=(FLYWHEEL_RESTART_STORM_FAULT=autoresume_audit_error)
  env "${AUTO_ENV[@]}" "${fault_env[@]}" "$GATE" gate \
    --root "$root" "$child" >"$TEST_ROOT/out" 2>"$TEST_ROOT/err"
  rc=$?
  if [[ "$rc" -ne 4 ]] \
    || [[ "$(jq -r .state "$root/$child.state")" != held_alert_attempted ]] \
    || [[ -e "$root/$child.auto-resume.json" ]] \
    || [[ "$(wc -l < "$root/$child.jsonl" | tr -d ' ')" != 6 ]]; then
    AUTO_AUDIT_NEGATIVE_OK=false
    continue
  fi
  case "$variant" in
    symlink) unlink "$audit" ;;
    unsafe_mode) chmod 0600 "$audit" ;;
  esac
  if ! run_auto_expect 0 "$TEST_ROOT/out" "$TEST_ROOT/err" \
      gate --root "$root" "$child"; then
    AUTO_AUDIT_NEGATIVE_OK=false
  fi
done
if [[ "$AUTO_AUDIT_NEGATIVE_OK" == true ]]; then
  pass "mandatory audit failures keep held state and recover on the next clean probe"
else
  fail "auto-resume audit mandatory" "one or more audit failure paths released or failed to recover"
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
