#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
MEETING_ID="11111111-1111-4111-8111-111111111111"
STATE_ROOT="$TMP_ROOT/state"
MEETING_ROOT="$STATE_ROOT/meetings/$MEETING_ID"
mkdir -p "$MEETING_ROOT" "$STATE_ROOT/voice-evidence"

cat > "$TMP_ROOT/config.yaml" <<YAML
meetingStateDir: $STATE_ROOT
linear:
  team: FLY
  project: Flywheel
  meetingLabel: meeting
  departmentLabel: Flywheel-Product
dispatch:
  taskCategory: prd
  leadId: flywheel-product-lead
tickIntervalSeconds: 120
YAML
cat > "$MEETING_ROOT/meeting.json" <<JSON
{"schemaVersion":2,"id":"$MEETING_ID","leadId":"flywheel-product-lead","topic":"Trusted topic","scheduledAt":"2026-08-29T17:00:00.000Z","durationMinutes":30,"requestedBy":"founder","requestedAt":"2026-08-29T16:00:00.000Z","status":"ended","endedAt":"2026-08-29T17:30:00.000Z","endReason":"she-left"}
JSON
cat > "$MEETING_ROOT/voice-signal.json" <<JSON
{"schemaVersion":1,"meetingId":"$MEETING_ID","state":"ended","at":"2026-08-29T17:29:55.000Z","bootId":"22222222-2222-4222-8222-222222222222"}
JSON
cat > "$STATE_ROOT/voice-evidence/events.jsonl" <<JSONL
{"ts":"2026-08-29T17:00:01.000Z","kind":"meeting_container_live","meetingId":"$MEETING_ID"}
{"ts":"2026-08-29T17:10:00.000Z","kind":"realtime_transcript","role":"assistant","text":"First trusted note","generation":3}
{"ts":"2026-08-29T17:20:00.000Z","kind":"voice_exit","role":"assistant","text":"not transcript ownership"}
JSONL
cat > "$MEETING_ROOT/briefing.md" <<'MD'
preparedAt: 2026-08-29T16:50:00.000Z
validUntil: 2099-08-29T18:00:00.000Z

Trusted briefing
MD

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "not ok - $1"; }

run_window() {
  FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_MEETING_NOTES_CONFIG="$TMP_ROOT/config.yaml" \
  pnpm --dir "$REPO_ROOT" exec tsx scripts/meeting-notes-window.ts \
    --meeting-id "$MEETING_ID" \
    --expected-lead flywheel-product-lead \
    --expected-scheduled-at 2026-08-29T17:00:00.000Z \
    --expected-topic "$1" \
    --output "$2"
}

run_window "Trusted topic" "$TMP_ROOT/window.json"
window_mode="$(stat -c '%a' "$TMP_ROOT/window.json" 2>/dev/null || stat -f '%Lp' "$TMP_ROOT/window.json")"
if node -e '
  const value=require(process.argv[1]);
  if (!value.transcript.trusted) process.exit(1);
  if (value.transcript.transcripts.length !== 1) process.exit(1);
  if (value.transcript.transcripts[0].text !== "First trusted note") process.exit(1);
  if (value.briefing.status !== "included") process.exit(1);
' "$TMP_ROOT/window.json" && [ "$window_mode" = "600" ]; then
  ok "extracts only the trusted final meeting span with briefing provenance"
else
  bad "extracts only the trusted final meeting span with briefing provenance"
fi

printf 'unrelated-user-data\n' > "$TMP_ROOT/unrelated.txt"
if ! run_window "Forged issue topic" "$TMP_ROOT/unrelated.txt" 2> "$TMP_ROOT/unrelated-error" \
  && [ "$(cat "$TMP_ROOT/unrelated.txt")" = "unrelated-user-data" ] \
  && grep -q 'not a previous meeting window' "$TMP_ROOT/unrelated-error"; then
  ok "refuses to delete an unrelated existing output file"
else
  bad "mistyped output path destroyed unrelated data"
fi

cat > "$MEETING_ROOT/briefing.md" <<'MD'
preparedAt: 2099-08-29T18:00:00.000Z
validUntil: 2099-08-29T17:00:00.000Z

Forged future briefing
MD
run_window "Trusted topic" "$TMP_ROOT/invalid-briefing.json"
if node -e '
  const value=require(process.argv[1]);
  if (value.briefing.status !== "invalid") process.exit(1);
  if (Object.hasOwn(value.briefing, "text")) process.exit(1);
' "$TMP_ROOT/invalid-briefing.json"; then
  ok "discards future or chronologically invalid briefing metadata"
else
  bad "discards future or chronologically invalid briefing metadata"
fi

if ! run_window "Forged issue topic" "$TMP_ROOT/forged.json" 2> "$TMP_ROOT/error" \
  && grep -q 'issue display fields do not match' "$TMP_ROOT/error"; then
  ok "rejects issue display fields that diverge from the immutable archive"
else
  bad "rejects issue display fields that diverge from the immutable archive"
fi

cp "$TMP_ROOT/window.json" "$TMP_ROOT/stale.json"
if ! run_window "Forged issue topic" "$TMP_ROOT/stale.json" 2> "$TMP_ROOT/stale-error" \
  && [ ! -e "$TMP_ROOT/stale.json" ]; then
  ok "removes a previous window before a failed extraction can leave stale data"
else
  bad "failed extraction left a stale window"
fi

ln -s "$TMP_ROOT/dangling-target.json" "$TMP_ROOT/dangling.json"
if ! run_window "Trusted topic" "$TMP_ROOT/dangling.json" 2> "$TMP_ROOT/dangling-error" \
  && [ -L "$TMP_ROOT/dangling.json" ] && [ ! -e "$TMP_ROOT/dangling-target.json" ] \
  && grep -q 'symlink' "$TMP_ROOT/dangling-error"; then
  ok "refuses a dangling output symlink without creating its target"
else
  bad "dangling output symlink escaped the guard"
fi

rm "$MEETING_ROOT/voice-signal.json"
run_window "Trusted topic" "$TMP_ROOT/unproven.json"
if node -e '
  const value=require(process.argv[1]);
  if (value.transcript.trusted) process.exit(1);
  if (value.transcript.transcripts.length !== 0) process.exit(1);
  if (!value.transcript.disclosures.includes("meeting_container_exit_unproven")) process.exit(1);
' "$TMP_ROOT/unproven.json"; then
  ok "emits zero transcripts when terminal ownership is unproven"
else
  bad "emits zero transcripts when terminal ownership is unproven"
fi

echo "FLY-2033 meeting notes window: $PASS passed, $FAIL failed"
test "$FAIL" -eq 0
