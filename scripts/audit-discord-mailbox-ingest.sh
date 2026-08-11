#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --db <comm.db> --since <UTC ISO> [--ingress-log <path>]" >&2
  exit 2
}

DB_PATH=""
SINCE=""
INGRESS_LOG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --db) DB_PATH="${2:-}"; shift 2 ;;
    --since) SINCE="${2:-}"; shift 2 ;;
    --ingress-log) INGRESS_LOG="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$DB_PATH" ] && [ -f "$DB_PATH" ] && [ -n "$SINCE" ] || usage
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$ ]] || usage
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 2; }

bad_rows="$(sqlite3 -bail "$DB_PATH" "
  SELECT count(*) FROM mailbox
   WHERE type = 'discord_chat' AND created_at >= '$SINCE'
     AND (carrier <> 'inbox'
       OR instr(COALESCE(delivery_content, ''), 'delivery_id=\"' || delivery_id || '\"') = 0);")"
external_rows="$(sqlite3 -bail "$DB_PATH" "
  SELECT count(*) FROM mailbox
   WHERE source_kind = 'discord_chat' AND carrier = 'external'
     AND created_at >= '$SINCE';")"
duplicate_rows="$(sqlite3 -bail "$DB_PATH" "
  SELECT count(*) FROM (
    SELECT source_ref FROM mailbox
     WHERE type = 'discord_chat' AND created_at >= '$SINCE'
     GROUP BY source_ref HAVING count(*) <> 1
  );")"
dead_rows="$(sqlite3 -bail "$DB_PATH" "
  SELECT count(*) FROM mailbox
   WHERE type = 'discord_chat' AND created_at >= '$SINCE' AND state = 'DEAD';")"

printf 'discord_mailbox_audit since=%s bad_rows=%s external_rows=%s duplicate_rows=%s dead_rows=%s\n' \
  "$SINCE" "$bad_rows" "$external_rows" "$duplicate_rows" "$dead_rows"

missing_ingress=0
if [ -n "$INGRESS_LOG" ]; then
  [ -f "$INGRESS_LOG" ] || usage
  while IFS= read -r message_id; do
    [ -n "$message_id" ] || continue
    identity_count="$(sqlite3 -bail "$DB_PATH" "
      SELECT count(*) FROM mailbox_identity
       WHERE id = 'chat:' || (SELECT to_agent FROM mailbox WHERE source_ref LIKE '%:$message_id' LIMIT 1) || ':$message_id'
          OR id LIKE 'chat:%:$message_id';")"
    if [ "$identity_count" -eq 0 ]; then
      echo "missing mailbox identity for Discord ingress message_id=$message_id" >&2
      missing_ingress=$((missing_ingress + 1))
    fi
  done < <(rg -o '"message_id":"[0-9]+"' "$INGRESS_LOG" | sed -E 's/.*:"([0-9]+)"/\1/' | sort -u)
fi

if [ "$bad_rows" -ne 0 ] || [ "$external_rows" -ne 0 ] \
  || [ "$duplicate_rows" -ne 0 ] || [ "$dead_rows" -ne 0 ] \
  || [ "$missing_ingress" -ne 0 ]; then
  exit 1
fi
