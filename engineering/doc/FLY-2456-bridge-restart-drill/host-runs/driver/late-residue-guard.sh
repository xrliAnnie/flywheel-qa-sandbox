#!/usr/bin/env bash
# FLY-2456 DEVIATION #9 — late slot residue guard (runs before deploy_room main).
# A torn-down slot directory reappeared 9s after teardown (attempt 12, 16:42:29Z) holding only an
# empty-schema CommDB, which makes room_capture deploy probe a dead port (curl exit 7).
# Contract: archive + remove ONLY when every check below holds; anything else -> stop (exit 70).
set -uo pipefail
SLOT="${SLOT:?}"; SLOT_DIR="${SLOT_DIR:?}"; EVIDENCE="${EVIDENCE:?}"; SLOT_CONFIG="${SLOT_CONFIG:?}"
OUT="$EVIDENCE/late-residue-$(date -u +%Y%m%dT%H%M%SZ)"
if [ ! -e "$SLOT_DIR" ]; then echo '{"status":"absent"}'; exit 0; fi
port=$(python3 - "$SLOT" "$SLOT_CONFIG" <<'PY'
import json,sys
print(json.load(open(sys.argv[2]))['slots'][int(sys.argv[1])-1]['bridgePort'])
PY
)
mkdir -m 700 "$OUT" || exit 70
fail=""
[ -e "$SLOT_DIR.lock" ] && fail="lock_present"
[ "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | wc -l | tr -d ' ')" != "0" ] && fail="${fail:+$fail,}port_listening"
# self chain: guard, its ancestors (driver/launcher/tool shells export SLOT_DIR) and its descendants must not count
self_chain="$$"; pid=$$; while [ "$pid" -gt 1 ]; do pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' '); [ -z "$pid" ] && break; self_chain="$self_chain $pid"; done
# env-aware match only to select pids; evidence never stores environment text (secrets)
cand=$(ps -axE -o pid=,ppid=,command= 2>/dev/null | grep -F "$SLOT_DIR" | awk '{print $1":"$2}')
: > "$OUT/processes.txt"
for cp in $cand; do cpid=${cp%%:*}; cppid=${cp##*:}; skip=0
  for sp in $self_chain; do [ "$cpid" = "$sp" ] && skip=1; [ "$cppid" = "$sp" ] && skip=1; done
  [ "$skip" = 1 ] && continue
  ps -o pid=,ppid=,command= -p "$cpid" 2>/dev/null | grep -v 'grep -F\|ps -axE' >> "$OUT/processes.txt"
done
[ -s "$OUT/processes.txt" ] && fail="${fail:+$fail,}process_references_slot"
find "$SLOT_DIR" -mindepth 1 -print > "$OUT/listing.txt"
# allowed content: only state/comm/test-slot-N/comm.db (+ -wal/-shm) and the directories above it
if grep -vE "^$SLOT_DIR/state(/comm(/test-slot-$SLOT(/comm\.db(-wal|-shm)?)?)?)?$" "$OUT/listing.txt" | grep -q .; then fail="${fail:+$fail,}unexpected_content"; fi
db="$SLOT_DIR/state/comm/test-slot-$SLOT/comm.db"
if [ -f "$db" ]; then
  shasum -a 256 "$db" > "$OUT/comm.db.sha256"
  stat -f 'size=%z created=%SB modified=%Sm' "$db" > "$OUT/comm.db.stat"
  sqlite3 "$db" "select name from sqlite_master where type='table' order by name;" > "$OUT/tables.txt" 2>&1
  rows=0; while read -r t; do n=$(sqlite3 "$db" "select count(*) from \"$t\";" 2>/dev/null || echo 0); printf '%s=%s\n' "$t" "$n" >> "$OUT/rowcounts.txt"; [ "$t" = mailbox_migration_meta ] || rows=$((rows+n)); done < "$OUT/tables.txt"
  [ "$rows" -ne 0 ] && fail="${fail:+$fail,}db_has_rows"
  cp "$db" "$OUT/comm.db.archived"
fi
if [ -n "$fail" ]; then printf '{"status":"stop","reasons":"%s","evidence":"%s"}\n' "$fail" "$OUT"; exit 70; fi
rm -rf "$SLOT_DIR" || exit 70
printf '{"status":"removed","evidence":"%s","port":%s}\n' "$OUT" "$port"
