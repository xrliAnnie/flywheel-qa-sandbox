#!/usr/bin/env bash
# FLY-2137: report-only founder-calendar sweep + durable delivery state machine.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SWEEP="$ROOT/scripts/calendar-write-sweep.mjs"
NODE_BIN="$(command -v node)"
EPOCH="1970-01-01T00:00:00.000Z"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2137-sweep-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1" >&2; }

if [[ ! -f "$SWEEP" ]]; then
	fail "calendar-write-sweep.mjs exists"
	printf '%s passed, %s failed\n' "$PASS" "$FAIL"
	exit 1
fi

BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"
printf '%s\n' \
	'#!/usr/bin/env bash' \
	'printf "%s\n" "$*" >> "$GOG_CALLS"' \
	'if [[ "${GOG_EXIT:-0}" != 0 ]]; then exit "$GOG_EXIT"; fi' \
	'printf "%s" "$(<"$GOG_FIXTURE")"' > "$BIN/gog"
chmod +x "$BIN/gog"

printf '%s\n' \
	'#!/usr/bin/env bash' \
	'body=""; signature=""; kind=""; severity=""; lead=""' \
	'while [[ $# -gt 0 ]]; do case "$1" in --body) body="$2"; shift 2;; --signature) signature="$2"; shift 2;; --kind) kind="$2"; shift 2;; --severity) severity="$2"; shift 2;; --lead) lead="$2"; shift 2;; *) shift;; esac; done' \
	'mkdir -p "$ALERT_CAPTURE"' \
	'n=$(( $(find "$ALERT_CAPTURE" -name "body.*" -type f 2>/dev/null | wc -l | tr -d " ") + 1 ))' \
	'printf "%s" "$body" > "$ALERT_CAPTURE/body.$n"' \
	'printf "%s|%s|%s|%s\n" "$signature" "$kind" "$severity" "$lead" > "$ALERT_CAPTURE/meta.$n"' \
	'case "${ALERT_RESULT:-sent}" in sent) printf "sent\n"; exit 0;; queued_transient) printf "queued_transient\n"; exit 2;; config_error) printf "config_error\n"; exit 1;; dead_lettered) printf "dead_lettered\n"; exit 1;; crash) exit 9;; *) printf "%s\n" "$ALERT_RESULT"; exit 1;; esac' > "$BIN/lead-alert"
chmod +x "$BIN/lead-alert"

new_case() {
	CASE_DIR="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
	CASE_HOME="$CASE_DIR/home"
	FIXTURE="$CASE_DIR/events.json"
	AUDIT_LOG="$CASE_HOME/.flywheel/logs/restart-guard.log"
	STATE="$CASE_HOME/.flywheel/state/calendar-sweep.json"
	CAPTURE="$CASE_DIR/alerts"
	GOG_CALLS_FILE="$CASE_DIR/gog.calls"
	mkdir -p "$(dirname "$AUDIT_LOG")" "$(dirname "$STATE")" "$CAPTURE"
	: > "$AUDIT_LOG"
	printf '{"events":[]}\n' > "$FIXTURE"
	printf 'CALENDAR_SWEEP_CLIENT=sweep-readonly\n' > "$CASE_HOME/.flywheel/.env"
}

run_sweep() {
	local now="$1" result="${2:-sent}" crash="${3:-0}"
	HOME="$CASE_HOME" PATH="$BIN:/usr/bin:/bin" \
		CALENDAR_SWEEP_GOG="$BIN/gog" \
		CALENDAR_SWEEP_ALERT="$BIN/lead-alert" \
		CALENDAR_SWEEP_NOW="$now" \
		FLYWHEEL_CALENDAR_SWEEP_TEST_CRASH_AFTER_ALERT="$crash" \
		FLYWHEEL_CALENDAR_SWEEP_TEST_APPEND_AUDIT_AFTER_READ="${FLYWHEEL_CALENDAR_SWEEP_TEST_APPEND_AUDIT_AFTER_READ:-}" \
		GOG_FIXTURE="$FIXTURE" GOG_CALLS="$GOG_CALLS_FILE" \
		ALERT_CAPTURE="$CAPTURE" ALERT_RESULT="$result" \
		"$NODE_BIN" "$SWEEP"
}

alert_count() { find "$CAPTURE" -name 'body.*' -type f 2>/dev/null | wc -l | tr -d ' '; }
state_eval() {
	"$NODE_BIN" -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=Function("s","return ("+process.argv[2]+")")(s);process.stdout.write(String(v))' "$STATE" "$1"
}

# S1 — complete zero-finding scan checkpoints both cursors and emits nothing.
new_case
if run_sweep "2026-08-31T16:00:00.000Z" >/dev/null 2>&1 \
	&& [[ "$(alert_count)" == 0 ]] \
	&& [[ "$(state_eval 's.eventCursorISO')" == "2026-08-31T16:00:00.000Z" ]] \
	&& [[ "$(state_eval 's.logCursor.offset')" == 0 ]] \
	&& grep -q -- '--account personal --client sweep-readonly --json calendar events primary' "$GOG_CALLS_FILE" \
	&& grep -q -- '--fields items(id,summary,created,updated,creator,extendedProperties,reminders),nextPageToken' "$GOG_CALLS_FILE"; then
	pass "S1 zero findings: no output + local cursor checkpoint + read-only gog grammar"
else fail "S1 zero-finding checkpoint"; fi

# S2 — one suspicious unmarked event, at most one alert in the PT day.
new_case
printf '%s\n' '{"events":[{"id":"evt-1","summary":"FLY-2130 QA 验收 — Tadashi","created":"2026-08-31T15:00:00.000Z","updated":"2026-08-31T15:00:00.000Z","extendedProperties":{"private":{}},"reminders":{"overrides":[{"method":"email","minutes":10}]}}]}' > "$FIXTURE"
run_sweep "2026-08-31T16:00:00.000Z" >/dev/null 2>&1
run_sweep "2026-08-31T17:00:00.000Z" >/dev/null 2>&1
if [[ "$(alert_count)" == 1 ]] \
	&& grep -q 'calendar-sweep-2026-08-31|calendar_wild_write|warning|system' "$CAPTURE/meta.1" \
	&& grep -q 'evt-1' "$CAPTURE/body.1" \
	&& [[ "$(state_eval 's.reportedEventIds.includes("evt-1")')" == true ]]; then
	pass "S2 suspicious event reported once per PT day"
else fail "S2 suspicious event daily dedup"; fi

# S3 — pending outbox is immutable; success receipt then defers new findings.
new_case
printf '%s\n' '{"events":[{"id":"evt-pending","summary":"QA fake meeting","created":"2026-08-31T15:00:00.000Z","updated":"2026-08-31T15:00:00.000Z","extendedProperties":{"private":{}}}]}' > "$FIXTURE"
run_sweep "2026-08-31T16:00:00.000Z" config_error >/dev/null 2>&1 || true
first_body="$(<"$CAPTURE/body.1")"
printf '%s\n' '{"ts":1788195600,"pattern":"P6","decision":"would_deny","mode":"audit","cli":"gog","service":"calendar","method":"create","targets":["primary"]}' >> "$AUDIT_LOG"
run_sweep "2026-08-31T16:30:00.000Z" sent >/dev/null 2>&1
second_body="$(<"$CAPTURE/body.2")"
run_sweep "2026-08-31T17:00:00.000Z" sent >/dev/null 2>&1
same_day_count="$(alert_count)"
pending_same_day="$(state_eval 'Boolean(s.pendingOutbox)')"
run_sweep "2026-09-01T16:00:00.000Z" sent >/dev/null 2>&1
if [[ "$first_body" == "$second_body" ]] \
	&& [[ "$same_day_count" == 2 ]] \
	&& [[ "$pending_same_day" == true ]] \
	&& [[ "$(alert_count)" == 3 ]] \
	&& grep -q 'would_deny' "$CAPTURE/body.3"; then
	pass "S3 immutable retry + same-day defer + next-day re-bucket"
else fail "S3 durable pending outbox state machine"; fi

# S4 — queued_transient is a delivery receipt and advances cursors.
new_case
printf '%s\n' '{"events":[{"id":"evt-q","summary":"GEO-1 test","created":"2026-08-31T15:00:00.000Z","updated":"2026-08-31T15:00:00.000Z","extendedProperties":{"private":{}}}]}' > "$FIXTURE"
if run_sweep "2026-08-31T16:00:00.000Z" queued_transient >/dev/null 2>&1 \
	&& [[ "$(state_eval 's.dayReceipt.result')" == queued_transient ]] \
	&& [[ "$(state_eval 's.pendingOutbox === null')" == true ]]; then
	pass "S4 queued_transient counts as receipt"
else fail "S4 queued receipt"; fi

# S5 — enforce→audit reports once; persistent invalid mode reports daily.
new_case
mkdir -p "$CASE_HOME/.flywheel/calendar-guard"
printf '%s\n' '{"schemaVersion":1,"approvedBy":"founder","discordMsgId":"msg-enforce","decision":"enforce"}' > "$CASE_HOME/.flywheel/calendar-guard/enforce-receipt.json"
printf 'enforce # msg-enforce\n' > "$CASE_HOME/.flywheel/calendar-guard/mode"
run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1
printf 'audit # msg-rollback\n' > "$CASE_HOME/.flywheel/calendar-guard/mode"
run_sweep "2026-09-01T16:00:00.000Z" sent >/dev/null 2>&1
run_sweep "2026-09-02T16:00:00.000Z" sent >/dev/null 2>&1
rollback_count="$(alert_count)"
printf 'damaged\n' > "$CASE_HOME/.flywheel/calendar-guard/mode"
run_sweep "2026-09-03T16:00:00.000Z" sent >/dev/null 2>&1
run_sweep "2026-09-04T16:00:00.000Z" sent >/dev/null 2>&1
if [[ "$rollback_count" == 1 ]] \
	&& grep -q 'enforce.*audit\|audit.*enforce' "$CAPTURE/body.1" \
	&& [[ "$(alert_count)" == 3 ]] \
	&& grep -q 'invalid' "$CAPTURE/body.2" \
	&& grep -q 'invalid' "$CAPTURE/body.3"; then
	pass "S5 mode transition once; invalid state every day"
else fail "S5 mode governance findings"; fi

# S6 — malformed JSONL is quarantined, reported with later valid P6, then converges.
new_case
printf '%s\n' 'not-json' '{"ts":1788195600,"pattern":"P6","decision":"deny","mode":"enforce","cli":"gog","service":"calendar","method":"create","targets":["primary"]}' > "$AUDIT_LOG"
run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1
run_sweep "2026-09-01T16:00:00.000Z" sent >/dev/null 2>&1
if [[ "$(alert_count)" == 1 ]] \
	&& grep -q 'audit_log_parse_error' "$CAPTURE/body.1" \
	&& grep -q 'deny' "$CAPTURE/body.1" \
	&& [[ "$(state_eval 's.quarantine.length')" == 1 ]]; then
	pass "S6 bad JSONL quarantines, reports once, and advances past later valid rows"
else fail "S6 JSONL quarantine convergence"; fi

# S7 — inode rotation drains retained generations before the new file.
new_case
run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1
printf '%s\n' '{"ts":1788195600,"pattern":"P6","decision":"would_deny","mode":"audit","cli":"gog","service":"calendar","method":"create","targets":["primary"]}' >> "$AUDIT_LOG"
mv "$AUDIT_LOG" "$AUDIT_LOG.1"
printf '%s\n' '{"ts":1788195700,"pattern":"P6","decision":"deny","mode":"enforce","cli":"gws","service":"calendar","method":"events.insert","targets":["primary"]}' > "$AUDIT_LOG"
run_sweep "2026-09-01T16:00:00.000Z" sent >/dev/null 2>&1
if grep -q 'would_deny=1' "$CAPTURE/body.1" && grep -q 'deny=1' "$CAPTURE/body.1"; then
	pass "S7 log rotation preserves retained + new P6 rows"
else fail "S7 log rotation"; fi

# S8 — corrupt state fail-louds, is preserved, and never sends a half-report.
new_case
printf '{broken' > "$STATE"
if ! run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1 \
	&& [[ "$(alert_count)" == 0 ]] \
	&& find "$(dirname "$STATE")" -name 'calendar-sweep.json.corrupt-*' -type f | grep -q . \
	&& [[ "$(state_eval 's.schemaVersion')" == 2 ]]; then
	pass "S8 corrupt state quarantined + nonzero + no alert"
else fail "S8 corrupt state"; fi

# S9 — gog failure and held lock are explicit negative guards.
new_case
GOG_EXIT=7 run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1; gog_rc=$?
mkdir -p "$CASE_HOME/.flywheel/state/calendar-sweep.lock"
GOG_EXIT=0 run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1; lock_rc=$?
if [[ "$gog_rc" != 0 && "$lock_rc" == 0 && "$(alert_count)" == 0 ]]; then
	pass "S9 gog fail-loud; mkdir lock exits quietly"
else fail "S9 negative guards"; fi

new_case
mkdir -p "$CASE_HOME/.flywheel/state/calendar-sweep.lock"
touch -t 202001010000 "$CASE_HOME/.flywheel/state/calendar-sweep.lock"
run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1; stale_lock_rc=$?
if [[ "$stale_lock_rc" == 0 && -f "$STATE" ]] \
	&& [[ ! -e "$CASE_HOME/.flywheel/state/calendar-sweep.lock" ]]; then
	pass "S9c stale lock is recovered before the sweep runs"
else fail "S9c stale lock recovery"; fi

new_case
printf 'corrupt-lock\n' > "$CASE_HOME/.flywheel/state/calendar-sweep.lock"
run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1; corrupt_lock_rc=$?
if [[ "$corrupt_lock_rc" != 0 && ! -f "$STATE" ]] \
	&& [[ "$(alert_count)" == 0 ]]; then
	pass "S9d non-directory lock path fails loud"
else fail "S9d corrupt lock path"; fi

new_case
printf 'not-json' > "$FIXTURE"
run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1; json_rc=$?
printf '%s\n' '{"events":[{"id":"evt-alert-crash","summary":"FLY-10 QA","created":"2026-08-31T15:00:00.000Z","updated":"2026-08-31T15:00:00.000Z","extendedProperties":{"private":{}}}]}' > "$FIXTURE"
run_sweep "2026-08-31T16:00:00.000Z" crash >/dev/null 2>&1; alert_rc=$?
if [[ "$json_rc" != 0 && "$alert_rc" != 0 ]] \
	&& [[ "$(state_eval 'Boolean(s.pendingOutbox)')" == true ]] \
	&& [[ "$(state_eval 's.eventCursorISO')" == "$EPOCH" ]]; then
	pass "S9b malformed gog JSON and alert crash retain cursors fail-loud"
else fail "S9b JSON/alert crash guards"; fi

# S10 — sent-before-checkpoint crash may duplicate across days (bounded at-least-once).
new_case
printf '%s\n' '{"events":[{"id":"evt-crash","summary":"FLY-9 QA","created":"2026-08-31T15:00:00.000Z","updated":"2026-08-31T15:00:00.000Z","extendedProperties":{"private":{}}}]}' > "$FIXTURE"
run_sweep "2026-08-31T16:00:00.000Z" sent 1 >/dev/null 2>&1; crash_rc=$?
run_sweep "2026-09-01T16:00:00.000Z" sent 0 >/dev/null 2>&1
if [[ "$crash_rc" != 0 && "$(alert_count)" == 2 ]] \
	&& grep -q 'calendar-sweep-2026-08-31' "$CAPTURE/meta.1" \
	&& grep -q 'calendar-sweep-2026-09-01' "$CAPTURE/meta.2"; then
	pass "S10 delivery/checkpoint crash is bounded at-least-once across PT days"
else fail "S10 crash-window semantics"; fi

# S11 — PT day bucketing straddles the UTC date boundary exactly.
new_case
printf '%s\n' '{"events":[{"id":"evt-before-midnight","summary":"FLY-11 QA","created":"2026-09-01T06:30:00.000Z","updated":"2026-09-01T06:30:00.000Z","extendedProperties":{"private":{}}}]}' > "$FIXTURE"
run_sweep "2026-09-01T06:59:00.000Z" sent >/dev/null 2>&1
before_meta="$(<"$CAPTURE/meta.1")"
new_case
printf '%s\n' '{"events":[{"id":"evt-after-midnight","summary":"FLY-12 QA","created":"2026-09-01T07:00:00.000Z","updated":"2026-09-01T07:00:00.000Z","extendedProperties":{"private":{}}}]}' > "$FIXTURE"
run_sweep "2026-09-01T07:01:00.000Z" sent >/dev/null 2>&1
after_meta="$(<"$CAPTURE/meta.1")"
if [[ "$before_meta" == calendar-sweep-2026-08-31* ]] \
	&& [[ "$after_meta" == calendar-sweep-2026-09-01* ]]; then
	pass "S11 America/Los_Angeles bucket is correct across 07:00Z boundary"
else fail "S11 PT/UTC bucket boundary"; fi

# S12 — reported event ids are a bounded 500-entry FIFO.
new_case
run_sweep "2026-08-31T15:00:00.000Z" sent >/dev/null 2>&1
"$NODE_BIN" -e 'const fs=require("fs"),p=process.argv[1],s=JSON.parse(fs.readFileSync(p));s.reportedEventIds=Array.from({length:500},(_,i)=>`old-${i}`);fs.writeFileSync(p,JSON.stringify(s))' "$STATE"
printf '%s\n' '{"events":[{"id":"evt-fifo-new","summary":"FLY-13 QA","created":"2026-08-31T15:30:00.000Z","updated":"2026-08-31T15:30:00.000Z","extendedProperties":{"private":{}}}]}' > "$FIXTURE"
run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1
if [[ "$(state_eval 's.reportedEventIds.length')" == 500 ]] \
	&& [[ "$(state_eval 's.reportedEventIds.includes("evt-fifo-new")')" == true ]] \
	&& [[ "$(state_eval 's.reportedEventIds.includes("old-0")')" == false ]]; then
	pass "S12 reportedEventIds is a 500-entry FIFO"
else fail "S12 reportedEventIds FIFO"; fi

# S13 — authorized Raya marker and unrelated human-looking events are negatives.
new_case
printf '%s\n' '{"events":[{"id":"evt-raya","summary":"FLY-14 QA","created":"2026-08-31T15:00:00.000Z","updated":"2026-08-31T15:00:00.000Z","extendedProperties":{"private":{"raya_meeting_id":"raya-1"}}},{"id":"evt-human","summary":"Dentist appointment","created":"2026-08-31T15:00:00.000Z","updated":"2026-08-31T15:00:00.000Z","extendedProperties":{"private":{}}}]}' > "$FIXTURE"
run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1
if [[ "$(alert_count)" == 0 ]]; then
	pass "S13 Raya-marked and non-keyword events are not findings"
else fail "S13 event suspicion negatives"; fi

# S14 — an append after the read snapshot must remain beyond the committed cursor.
new_case
late_row='{"ts":1788195800,"pattern":"P6","decision":"deny","mode":"enforce","cli":"gog","service":"calendar","method":"create","targets":["primary"]}'
FLYWHEEL_CALENDAR_SWEEP_TEST_APPEND_AUDIT_AFTER_READ="$late_row" \
	run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1
first_count="$(alert_count)"
run_sweep "2026-09-01T16:00:00.000Z" sent >/dev/null 2>&1
if [[ "$first_count" == 0 && "$(alert_count)" == 1 ]] \
	&& grep -q 'deny=1' "$CAPTURE/body.1"; then
	pass "S14 append after read snapshot is consumed on the next run"
else fail "S14 audit append/read cursor race"; fi

# S15 — ~/.flywheel/.env provides defaults, but explicit caller overrides win.
new_case
cat > "$CASE_HOME/.flywheel/.env" <<'EOF'
CALENDAR_SWEEP_ACCOUNT=env-account
CALENDAR_SWEEP_CALENDAR=env-calendar
CALENDAR_SWEEP_CLIENT=sweep-readonly
EOF
run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1
env_call="$(<"$GOG_CALLS_FILE")"
new_case
cat > "$CASE_HOME/.flywheel/.env" <<'EOF'
CALENDAR_SWEEP_ACCOUNT=env-account
CALENDAR_SWEEP_CALENDAR=env-calendar
CALENDAR_SWEEP_CLIENT=sweep-readonly
EOF
CALENDAR_SWEEP_ACCOUNT=caller-account CALENDAR_SWEEP_CALENDAR=caller-calendar \
	run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1
caller_call="$(<"$GOG_CALLS_FILE")"
if [[ "$env_call" == *'--account env-account --client sweep-readonly --json calendar events env-calendar'* ]] \
	&& [[ "$caller_call" == *'--account caller-account --client sweep-readonly --json calendar events caller-calendar'* ]]; then
	pass "S15 env-file loads the isolated OAuth client and caller overrides win"
else fail "S15 env snapshot/restore contract"; fi

# S16 — a same-day deferred enforce→audit transition is emitted exactly once.
new_case
mkdir -p "$CASE_HOME/.flywheel/calendar-guard"
printf '%s\n' '{"schemaVersion":1,"approvedBy":"founder","discordMsgId":"msg-enforce","decision":"enforce"}' > "$CASE_HOME/.flywheel/calendar-guard/enforce-receipt.json"
printf 'enforce # msg-enforce\n' > "$CASE_HOME/.flywheel/calendar-guard/mode"
printf '%s\n' '{"events":[{"id":"evt-prime-receipt","summary":"FLY-16 QA","created":"2026-08-31T15:00:00.000Z","updated":"2026-08-31T15:00:00.000Z","extendedProperties":{"private":{}}}]}' > "$FIXTURE"
run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1
printf 'audit # msg-rollback\n' > "$CASE_HOME/.flywheel/calendar-guard/mode"
run_sweep "2026-08-31T17:00:00.000Z" sent >/dev/null 2>&1
run_sweep "2026-09-01T16:00:00.000Z" sent >/dev/null 2>&1
transition_count="$(grep -o 'mode_transition' "$CAPTURE/body.2" | wc -l | tr -d ' ')"
if [[ "$(alert_count)" == 2 && "$transition_count" == 1 ]]; then
	pass "S16 deferred mode transition is de-duplicated across PT days"
else fail "S16 deferred mode transition duplicate"; fi

# S17 — carried P6 findings are replaced by the complete rescan aggregate.
new_case
printf '%s\n' '{"events":[{"id":"evt-p6-prime","summary":"FLY-17 QA","created":"2026-08-31T15:00:00.000Z","updated":"2026-08-31T15:00:00.000Z","extendedProperties":{"private":{}}}]}' > "$FIXTURE"
run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1
printf '%s\n' '{"ts":1788195600,"pattern":"P6","decision":"would_deny","mode":"audit","cli":"gog","service":"calendar","method":"create","targets":["primary"]}' >> "$AUDIT_LOG"
run_sweep "2026-08-31T17:00:00.000Z" sent >/dev/null 2>&1
printf '%s\n' '{"ts":1788195700,"pattern":"P6","decision":"deny","mode":"enforce","cli":"gws","service":"calendar","method":"events.insert","targets":["primary"]}' >> "$AUDIT_LOG"
run_sweep "2026-09-01T16:00:00.000Z" sent >/dev/null 2>&1
p6_lines="$(grep -o 'P6 audit:' "$CAPTURE/body.2" | wc -l | tr -d ' ')"
if [[ "$p6_lines" == 1 ]] \
	&& grep -q 'would_deny=1 deny=1' "$CAPTURE/body.2"; then
	pass "S17 P6 carry/rescan produces one complete aggregate"
else fail "S17 P6 carry/rescan aggregate de-duplication"; fi

# S18 — carried invalid-mode findings collapse to one line in each daily body.
new_case
mkdir -p "$CASE_HOME/.flywheel/calendar-guard"
printf '%s\n' '{"schemaVersion":1,"approvedBy":"founder","discordMsgId":"msg-enforce","decision":"enforce"}' > "$CASE_HOME/.flywheel/calendar-guard/enforce-receipt.json"
printf 'damaged\n' > "$CASE_HOME/.flywheel/calendar-guard/mode"
run_sweep "2026-08-31T16:00:00.000Z" config_error >/dev/null 2>&1 || true
run_sweep "2026-09-01T16:00:00.000Z" config_error >/dev/null 2>&1 || true
run_sweep "2026-09-02T16:00:00.000Z" sent >/dev/null 2>&1
invalid_lines="$(grep -o 'mode_invalid_with_receipt' "$CAPTURE/body.3" | wc -l | tr -d ' ')"
if [[ "$invalid_lines" == 1 ]]; then
	pass "S18 carried invalid-mode finding stays singular"
else fail "S18 carried invalid-mode duplicate"; fi

# S19 — a sweep without an isolated OAuth client must fail before invoking gog.
new_case
rm "$CASE_HOME/.flywheel/.env"
if ! run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1 \
	&& [[ ! -s "$GOG_CALLS_FILE" ]]; then
	pass "S19 missing isolated OAuth client fails before Calendar access"
else fail "S19 missing isolated OAuth client"; fi

# S20 — option-like client selectors are rejected before invoking gog.
new_case
printf 'CALENDAR_SWEEP_CLIENT=--help\n' > "$CASE_HOME/.flywheel/.env"
if ! run_sweep "2026-08-31T16:00:00.000Z" sent >/dev/null 2>&1 \
	&& [[ ! -s "$GOG_CALLS_FILE" ]]; then
	pass "S20 invalid isolated OAuth client fails before Calendar access"
else fail "S20 invalid isolated OAuth client"; fi

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
exit "$FAIL"
