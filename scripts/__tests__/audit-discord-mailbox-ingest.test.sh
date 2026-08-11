#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1574-audit.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
DB_PATH="$TMP_ROOT/comm.db"
CLI="$ROOT/packages/flywheel-comm/dist/index.js"
AUDIT="$ROOT/scripts/audit-discord-mailbox-ingest.sh"

node "$CLI" chat-ingest \
  --db "$DB_PATH" \
  --lead flywheel-eng-lead \
  --chat-id 100000000000000010 \
  --origin-channel-id 100000000000000010 \
  --message-id 100000000000000011 \
  --author-id 100000000000000012 \
  --author-name Annie \
  --ts 2026-08-10T12:00:00.000Z \
  --msg-kind guild \
  --attachments-json '[]' \
  --content-stdin --json <<< 'hello' >/dev/null

if "$AUDIT" --db "$DB_PATH" --since 2026-08-10T00:00:00.000Z >/dev/null; then
  printf '[TEST] ok - valid inbox row passes the audit\n'
else
  printf '[TEST] FAIL - valid inbox row failed the audit\n' >&2
  exit 1
fi

sqlite3 "$DB_PATH" "UPDATE mailbox SET delivery_content='missing receipt' WHERE type='discord_chat';"
if "$AUDIT" --db "$DB_PATH" --since 2026-08-10T00:00:00.000Z >/dev/null 2>&1; then
  printf '[TEST] FAIL - missing visible mailbox id passed the audit\n' >&2
  exit 1
else
  printf '[TEST] ok - missing visible mailbox id fails the audit\n'
fi

sqlite3 "$DB_PATH" "UPDATE mailbox SET delivery_content='<channel receipt_id=\"' || delivery_id || '\">ok</channel>', state='DEAD' WHERE type='discord_chat';"
if "$AUDIT" --db "$DB_PATH" --since 2026-08-10T00:00:00.000Z >/dev/null 2>&1; then
  printf '[TEST] FAIL - Discord DEAD row passed the audit\n' >&2
  exit 1
else
  printf '[TEST] ok - Discord DEAD row fails the audit\n'
fi
