#!/bin/bash
# FLY-2829 C9: the production observation watchdog judges on a ≥3-sample
# slope, trips by writing the maintenance marker back, and treats its own
# blindness or under-coverage as INVALID rather than PASS. Driven with a fake
# clock and a scripted sampler so 40 "minutes" take a second.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$(mktemp -d -t fly2829-watchdog-XXXXXX)"
trap 'rm -rf "$SB"' EXIT
WD="$ROOT/scripts/qa/fly2829-prod-watchdog.sh"
pass=0 fail=0
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }

cat > "$SB/alert-bin" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "${FLY2829_ALERT_LOG}"
SH
cat > "$SB/sampler" <<'SH'
#!/bin/bash
# Pops one total|managed-husks sample per call and advances the fake clock.
f="$FLY2829_VALUES"
v=$(head -1 "$f" 2>/dev/null); [[ -n "$v" ]] || v='10|0'
tail -n +2 "$f" > "$f.n" 2>/dev/null; mv "$f.n" "$f"
echo $(( $(cat "$FLY2829_PRODGATE_NOW_FILE") + FLY2829_STEP )) > "$FLY2829_PRODGATE_NOW_FILE"
echo "$v"
SH
chmod +x "$SB/alert-bin" "$SB/sampler"

mkdir -p "$SB/real-alert/bin" "$SB/real-alert/home"
cat > "$SB/real-alert/bin/curl" <<'SH'
#!/bin/bash
printf 'call\n' >> "${FLY2829_REAL_CURL_CALLS:?}"
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o && $# -ge 2 ]]; then out="$2"; shift 2; else shift; fi
done
[[ -n "$out" ]] && printf '{"id":"777777777777777777"}\n' > "$out"
printf '200'
SH
chmod +x "$SB/real-alert/bin/curl"
cat > "$SB/real-alert/projects.json" <<'JSON'
[
  {
    "projectName": "flywheel",
    "generalChannel": "999999999999999999",
    "leads": [
      {
        "agentId": "flywheel-eng-lead",
        "alertChannel": "444444444444444444",
        "alertBotTokenEnv": "FLY2829_REAL_ALERT_TOKEN",
        "botTokenEnv": "FLY2829_REAL_ALERT_TOKEN"
      }
    ]
  }
]
JSON

run_wd() {
  # run_wd <case> <step-seconds> <values...>  → prints the last line; sets RC
  local case_name="$1" step="$2"; shift 2
  local dir="$SB/$case_name"; mkdir -p "$dir"
  printf '%s\n' "$@" > "$dir/values"
  echo 1000000 > "$dir/now"
  : > "$dir/alerts"
  RC=0
  FLY2829_PRODGATE_NOW_FILE="$dir/now" FLY2829_PRODGATE_SLEEP=0 FLY2829_PRODGATE_MIN_MINUTES=1 \
  FLY2829_PRODGATE_SAMPLER="$SB/sampler" FLY2829_VALUES="$dir/values" FLY2829_STEP="$step" \
  FLY2829_ALERT_LOG="$dir/alerts" FLYWHEEL_ALERT_BIN="${FLY2829_TEST_ALERT_BIN:-$SB/alert-bin}" \
    bash "$WD" --minutes 40 --interval 60 --slope-max 3 --ceiling "${CEILING_OVERRIDE:-150}" --marker "${MARKER_OVERRIDE:-$dir/marker}" --out "$dir/out" > "$dir/log" 2>&1 || RC=$?
  LAST=$(tail -1 "$dir/log")
  CASE_DIR="$dir"
}

printf '\n== PASS: 40 minutes of flat samples ==\n'
run_wd flat 60
if [[ "$RC" == 0 && "$LAST" == "FLY2829-PRODGATE PASS minutes=40 samples=40/41 max_slope=0"* && -f "$CASE_DIR/out/watchdog.heartbeat" \
      && "$(grep -c . "$CASE_DIR/out/prod-samples.tsv")" == 41 ]]; then
  ok "flat window passes with 40/41 samples, heartbeat and full sample file"
else
  bad "flat window: rc=$RC last=[$LAST] rows=$(grep -c . "$CASE_DIR/out/prod-samples.tsv" 2>/dev/null)"
fi

printf '\n== INVALID reason=coverage: sampler too slow, only half the samples ==\n'
run_wd slow 120
if [[ "$RC" == 3 && "$LAST" == "FLY2829-PRODGATE INVALID reason=coverage samples=20/41 marker=unwritten" ]]; then
  ok "half coverage is INVALID, not PASS"
else
  bad "coverage: rc=$RC last=[$LAST]"
fi

printf '\n== INVALID reason=blind: three consecutive failed samples trip the marker ==\n'
run_wd blind 60 '10|0' '10|0' NA NA NA '10|0' '10|0'
if [[ "$RC" == 3 && "$LAST" == "FLY2829-PRODGATE INVALID reason=blind "*"marker=written" && -f "$CASE_DIR/marker" ]] \
   && grep -q 'watchdog-hold: FLY-2829 prod gate tripped blind' "$CASE_DIR/marker" \
   && grep -q -- '--severity severe' "$CASE_DIR/alerts"; then
  ok "blindness writes the marker, alerts severe, and ends INVALID"
else
  bad "blind: rc=$RC last=[$LAST] marker=$([[ -f $CASE_DIR/marker ]] && cat "$CASE_DIR/marker" || echo absent) alerts=[$(cat "$CASE_DIR/alerts")]"
fi

printf '\n== TRIPPED: slope over 3/min across three samples ==\n'
run_wd slope 60 '100|0' '105|10' '110|20' '110|20' '110|20'
if [[ "$RC" == 1 && "$LAST" == "FLY2829-PRODGATE TRIPPED slope=10.000 samples=0,10,20 marker=written" ]] \
   && grep -q 'tripped husks slope=10.000/min samples=0,10,20' "$CASE_DIR/marker" \
   && [[ "$(grep -c . "$CASE_DIR/out/prod-samples.tsv")" == 41 ]]; then
  ok "10/min slope trips on the third sample, writes the marker, and keeps sampling to the end"
else
  bad "slope: rc=$RC last=[$LAST] marker=$([[ -f $CASE_DIR/marker ]] && cat "$CASE_DIR/marker" || echo absent)"
fi
# Two samples never judge; a jump between the first two that is already back
# by the third sample yields a flat regression and must not trip.
run_wd jump 60 '100|0' '110|50' '120|0' '125|0'
if [[ "$RC" == 0 && "$LAST" == "FLY2829-PRODGATE PASS "* ]]; then
  ok "a single-point jump between two samples does not trip; only a ≥3-sample slope judges"
else
  bad "jump: rc=$RC last=[$LAST]"
fi
run_wd ceiling 60 '149|0' '149|0' '150|0' '149|0'
if [[ "$RC" == 1 && "$LAST" == "FLY2829-PRODGATE TRIPPED slope=ceiling "*"marker=written" ]]; then
  ok "a sample at or above the ceiling trips regardless of slope"
else
  bad "ceiling: rc=$RC last=[$LAST]"
fi

printf '\n== TRIPPED: real lead-alert.sh accepts the watchdog severity ==\n'
: > "$SB/real-alert/curl.calls"
PATH="$SB/real-alert/bin:$PATH" \
HOME="$SB/real-alert/home" \
FLYWHEEL_STATE_DIR="$SB/real-alert/state" \
FLYWHEEL_PROJECTS_FILE="$SB/real-alert/projects.json" \
FLYWHEEL_CLAIMS_DB="$SB/real-alert/claims.db" \
FLYWHEEL_ALERT_QUEUE_DIR="$SB/real-alert/queue" \
FLYWHEEL_ALERT_DEADLETTER_DIR="$SB/real-alert/deadletter" \
FLY2829_REAL_ALERT_TOKEN="canary-token" \
FLY2829_REAL_CURL_CALLS="$SB/real-alert/curl.calls" \
FLY2829_TEST_ALERT_BIN="$ROOT/scripts/lead-alert.sh" \
run_wd real-alert 60 '150|0' '10|0'
if [[ "$RC" == 1 && "$LAST" == "FLY2829-PRODGATE TRIPPED slope=ceiling "*"marker=written" \
      && "$(grep -c '^call$' "$SB/real-alert/curl.calls")" == 1 ]] \
   && ! grep -q 'unknown --severity' "$CASE_DIR/log"; then
  ok "ceiling trip passes severe through the real lead-alert severity gate and sends once"
else
  bad "real alert: rc=$RC last=[$LAST] curl_calls=$(grep -c '^call$' "$SB/real-alert/curl.calls") log=[$(tail -5 "$CASE_DIR/log")]"
fi

printf '\n== marker=unwritten escalates to the manual-action alert ==\n'
MARKER_OVERRIDE="/nonexistent-fly2829-root/marker" run_wd unwritable 60 '100|0' '105|10' '110|20'
if [[ "$RC" == 1 && "$LAST" == *"marker=unwritten" ]] && grep -q 'automatic protection NOT established' "$CASE_DIR/alerts"; then
  ok "an unwritable marker path is reported and the alert demands manual action"
else
  bad "unwritable: rc=$RC last=[$LAST] alerts=[$(cat "$CASE_DIR/alerts")]"
fi

printf '\n== founder samples: legitimate backlog growth has zero managed husks ==\n'
run_wd backlog 60 '128|0' '132|0' '135|0' '137|0' '144|0'
if [[ "$RC" == 0 && "$LAST" == "FLY2829-PRODGATE PASS "* ]]; then
  ok "128→144 legitimate managed mirrors do not trip when husks stay at zero"
else
  bad "legitimate backlog growth tripped: rc=$RC last=[$LAST]"
fi

printf '\n== incident samples: 154 managed husks reproduce the runaway ==\n'
CEILING_OVERRIDE=500 run_wd incident 60 '58|0' '100|40' '220|154' '220|154'
if [[ "$RC" == 1 && "$LAST" == "FLY2829-PRODGATE TRIPPED slope=77.000 samples=0,40,154 marker=written" ]]; then
  ok "58→220 with 154 managed husks trips independently of the total ceiling"
else
  bad "incident husk growth did not trip: rc=$RC last=[$LAST]"
fi

printf '\n== argument fences ==\n'
rc=0; bash "$WD" --minutes 10 --out "$SB/short" >/dev/null 2>&1 || rc=$?
if [[ "$rc" == 2 ]]; then ok "--minutes below 35 is refused"; else bad "short window accepted rc=$rc"; fi
rc=0; bash "$WD" --minutes 40 --marker relative/path --out "$SB/rel" >/dev/null 2>&1 || rc=$?
if [[ "$rc" == 2 ]]; then ok "a relative marker path is refused"; else bad "relative marker accepted rc=$rc"; fi

printf '\nFLY-2829 prod watchdog: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
