#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1574-audit.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
DB_PATH="$TMP_ROOT/comm.db"
CLI="$ROOT/packages/flywheel-comm/dist/index.js"
AUDIT="$ROOT/scripts/audit-discord-mailbox-ingest.sh"

run_chat_ingest() {
  local db_path="$1"
  local message_id="$2"
  shift 2
  node "$CLI" chat-ingest \
    --db "$db_path" \
    --lead flywheel-eng-lead \
    --chat-id 100000000000000010 \
    --origin-channel-id 100000000000000010 \
    --message-id "$message_id" \
    --author-id 100000000000000012 \
    --author-name Annie \
    --ts 2026-08-10T12:00:00.000Z \
    --msg-kind guild \
    --attachments-json '[]' \
    --content-stdin --json "$@" <<< 'hello'
}

if [[ "$(node "$CLI" chat-ingest --version-probe --json)" == *'"protocolVersion":2'* ]]; then
  printf '[TEST] ok - chat-ingest advertises held-message protocol v2\n'
else
  printf '[TEST] FAIL - chat-ingest did not advertise protocol v2\n' >&2
  exit 1
fi

run_chat_ingest "$DB_PATH" 100000000000000011 >/dev/null

if "$AUDIT" --db "$DB_PATH" --since 2026-08-10T00:00:00.000Z >/dev/null; then
  printf '[TEST] ok - valid inbox row passes the audit\n'
else
  printf '[TEST] FAIL - valid inbox row failed the audit\n' >&2
  exit 1
fi

sqlite3 "$DB_PATH" "UPDATE mailbox SET delivery_content='missing delivery id' WHERE type='discord_chat';"
if "$AUDIT" --db "$DB_PATH" --since 2026-08-10T00:00:00.000Z >/dev/null 2>&1; then
  printf '[TEST] FAIL - missing visible mailbox id passed the audit\n' >&2
  exit 1
else
  printf '[TEST] ok - missing visible mailbox id fails the audit\n'
fi

sqlite3 "$DB_PATH" "UPDATE mailbox SET delivery_content='<channel delivery_id=\"' || delivery_id || '\">ok</channel>', state='DEAD' WHERE type='discord_chat';"
if "$AUDIT" --db "$DB_PATH" --since 2026-08-10T00:00:00.000Z >/dev/null 2>&1; then
  printf '[TEST] FAIL - Discord DEAD row passed the audit\n' >&2
  exit 1
else
  printf '[TEST] ok - Discord DEAD row fails the audit\n'
fi

DEAD_DB_PATH="$TMP_ROOT/dead.db"
dead_verdict="$(run_chat_ingest "$DEAD_DB_PATH" 100000000000000021 \
  --held-since 2026-08-10T11:55:00.000Z \
  --held-reason discord_wiring_broken \
  --dead-letter-reason discord_wiring_broken_stale)"
dead_row="$(sqlite3 "$DEAD_DB_PATH" "SELECT state || '|' || dead_reason || '|' || delivery_content FROM mailbox WHERE delivery_id='chat:flywheel-eng-lead:100000000000000021';")"
if [[ "$dead_verdict" == *'"deadLettered":true'* ]] \
  && [[ "$dead_row" == DEAD\|discord_wiring_broken_stale\|* ]] \
  && [[ "$dead_row" == *'held_since="2026-08-10T11:55:00.000Z"'* ]]; then
  printf '[TEST] ok - stale held CLI input becomes a visible DEAD mailbox row\n'
else
  printf '[TEST] FAIL - stale held CLI input was not dead-lettered correctly\n' >&2
  exit 1
fi

if run_chat_ingest "$TMP_ROOT/missing-held.db" 100000000000000022 \
  --dead-letter-reason discord_wiring_broken_stale >/dev/null 2>&1; then
  printf '[TEST] FAIL - dead-letter reason without held-since was accepted\n' >&2
  exit 1
else
  printf '[TEST] ok - dead-letter reason requires held-since\n'
fi

if run_chat_ingest "$TMP_ROOT/missing-held-reason.db" 100000000000000024 \
  --held-reason discord_wiring_broken >/dev/null 2>&1; then
  printf '[TEST] FAIL - held reason without held-since was accepted\n' >&2
  exit 1
else
  printf '[TEST] ok - held reason requires held-since\n'
fi

if run_chat_ingest "$TMP_ROOT/bad-reason.db" 100000000000000023 \
  --held-since 2026-08-10T11:55:00.000Z \
  --held-reason discord_wiring_broken \
  --dead-letter-reason other >/dev/null 2>&1; then
  printf '[TEST] FAIL - unknown dead-letter reason was accepted\n' >&2
  exit 1
else
  printf '[TEST] ok - unknown dead-letter reason remains rejected\n'
fi

if run_chat_ingest "$TMP_ROOT/unknown-flag.db" 100000000000000025 \
  --unknown-flag value >/dev/null 2>&1; then
  printf '[TEST] FAIL - unknown chat-ingest flag was accepted\n' >&2
  exit 1
else
  printf '[TEST] ok - unknown chat-ingest flags remain rejected\n'
fi

if grep -Fq 'result.lane === "inserted_inbox" && !result.deadLettered' \
  "$ROOT/packages/flywheel-comm/src/index.ts"; then
  printf '[TEST] ok - DEAD inserts do not nudge the Lead inbox\n'
else
  printf '[TEST] FAIL - DEAD inserts can still nudge the Lead inbox\n' >&2
  exit 1
fi
