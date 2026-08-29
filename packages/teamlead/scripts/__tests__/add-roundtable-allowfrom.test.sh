#!/bin/bash
# FLY-574 — tests for add-roundtable-allowfrom.sh
#
# Closing the #leads-roundtable allowlist gap: a companion lead's access.json
# roundtable group (requireMention:true) has a NON-EMPTY allowFrom whitelist, so
# the plugin's gate() (server.ts line 675) DROPS any sender not in it — before the
# mention check — even a bot that is in allowBots. Tadashi/Cass were missing from
# Belle's roundtable allowFrom, so their @ never reached Belle. This script adds
# sender ids to ONE existing group's allowFrom: atomic (temp+rename), backed up,
# idempotent, fail-closed, and touching no other field.
#
# Safety: every test is hermetic — it only ever reads/writes temp fixtures under a
# mktemp dir. It never touches a real access.json, launchctl, or Discord.
#
# Coverage:
#   T1  adds new ids to the target group's allowFrom (appended, order preserved)
#   T2  idempotent: re-run adds nothing, exits 0, no duplicate ids
#   T3  touches NO other field (allowBots, mentionPatterns, dmPolicy, other
#       groups, target group's requireMention all byte-identical)
#   T4  a backup of the original file is written before the edit
#   T5  --dry-run reports intended adds but does NOT modify the file
#   T6  fail-closed: missing --access-file path -> non-zero, file not created
#   T7  fail-closed: target --channel-id group absent -> non-zero, file unchanged
#   T8  fail-closed: invalid JSON access file -> non-zero, file unchanged
#   T9  partial add: some ids present, some new -> only genuinely-new appended
#   T10 accepts comma-separated --add list as well as repeated --add flags

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/../add-roundtable-allowfrom.sh"

TMP_DIR="$(mktemp -d -t add-rt-allowfrom-test.XXXXXX)" || { echo "FATAL: mktemp -d failed" >&2; exit 1; }
[ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] || { echo "FATAL: TMP_DIR unusable" >&2; exit 1; }
# shellcheck disable=SC2329  # invoked indirectly via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

RT="1512578695468941333"        # #leads-roundtable
OTHER="1509720034463846481"     # an unrelated group (must stay untouched)
TADASHI="1516207680836866219"
CASS="1516205086890786917"

PASSED=0
FAILED=0
ERRORS=""
log_test() { echo "[TEST] $*"; }
log_pass() { echo "  ✓ $*"; PASSED=$((PASSED + 1)); }
log_fail() { echo "  ✗ $*" >&2; FAILED=$((FAILED + 1)); ERRORS="${ERRORS}\n  - $*"; }

# Write a representative companion access.json fixture into $1.
make_access() {
  cat > "$1" <<JSON
{
  "dmPolicy": "pairing",
  "allowFrom": ["1138241636057481306"],
  "groups": {
    "$OTHER": { "requireMention": false, "allowFrom": ["1138241636057481306"] },
    "$RT": {
      "requireMention": true,
      "allowFrom": ["1138241636057481306", "1485896147951419434"]
    }
  },
  "pending": {},
  "mentionPatterns": ["\\\\bBelle\\\\b"],
  "allowBots": ["$TADASHI", "$CASS", "1485896147951419434"]
}
JSON
}

# canonical view of everything EXCEPT the target group's allowFrom — used to prove
# no other field changed.
rest_fingerprint() { jq -S "del(.groups[\"$RT\"].allowFrom)" "$1"; }

# ── T1: adds new ids ────────────────────────────────────────────────────────
log_test "T1 adds new ids to the target group's allowFrom"
A="$TMP_DIR/t1.json"; make_access "$A"
if bash "$SCRIPT" --access-file "$A" --channel-id "$RT" --add "$TADASHI" --add "$CASS" >/dev/null 2>&1; then
  have_t=$(jq -r --arg id "$TADASHI" '.groups["'"$RT"'"].allowFrom | index($id) // "MISS"' "$A")
  have_c=$(jq -r --arg id "$CASS" '.groups["'"$RT"'"].allowFrom | index($id) // "MISS"' "$A")
  if [ "$have_t" != "MISS" ] && [ "$have_c" != "MISS" ]; then
    log_pass "T1 both ids present in target allowFrom"
  else
    log_fail "T1 ids missing after add (tadashi=$have_t cass=$have_c)"
  fi
else
  log_fail "T1 script exited non-zero on a valid add"
fi

# ── T2: idempotent ──────────────────────────────────────────────────────────
log_test "T2 idempotent re-run adds nothing, exits 0, no duplicates"
bash "$SCRIPT" --access-file "$A" --channel-id "$RT" --add "$TADASHI" --add "$CASS" >/dev/null 2>&1
rc=$?
count_t=$(jq -r '[.groups["'"$RT"'"].allowFrom[] | select(. == "'"$TADASHI"'")] | length' "$A")
if [ "$rc" -eq 0 ] && [ "$count_t" -eq 1 ]; then
  log_pass "T2 idempotent (exit 0, tadashi appears exactly once)"
else
  log_fail "T2 not idempotent (rc=$rc tadashi_count=$count_t)"
fi

# ── T3: no other field touched ──────────────────────────────────────────────
log_test "T3 touches no other field"
B="$TMP_DIR/t3.json"; make_access "$B"
before="$(rest_fingerprint "$B")"
req_before=$(jq -r '.groups["'"$RT"'"].requireMention' "$B")
bash "$SCRIPT" --access-file "$B" --channel-id "$RT" --add "$TADASHI" >/dev/null 2>&1
after="$(rest_fingerprint "$B")"
req_after=$(jq -r '.groups["'"$RT"'"].requireMention' "$B")
if [ "$before" = "$after" ] && [ "$req_before" = "$req_after" ]; then
  log_pass "T3 allowBots/mentionPatterns/dmPolicy/other-group/requireMention all unchanged"
else
  log_fail "T3 a sibling field changed (requireMention $req_before->$req_after)"
fi

# ── T4: backup written ──────────────────────────────────────────────────────
log_test "T4 a backup of the original is written"
C="$TMP_DIR/t4.json"; make_access "$C"
orig="$(cat "$C")"
bash "$SCRIPT" --access-file "$C" --channel-id "$RT" --add "$TADASHI" >/dev/null 2>&1
bak="$(ls "$C".bak.* 2>/dev/null | head -1)"
if [ -n "$bak" ] && [ "$(cat "$bak")" = "$orig" ]; then
  log_pass "T4 backup exists and matches the pre-edit content"
else
  log_fail "T4 no backup or backup mismatch (bak=$bak)"
fi

# ── T5: dry-run does not modify ─────────────────────────────────────────────
log_test "T5 --dry-run does not modify the file"
D="$TMP_DIR/t5.json"; make_access "$D"
snap="$(cat "$D")"
bash "$SCRIPT" --access-file "$D" --channel-id "$RT" --add "$TADASHI" --dry-run >/dev/null 2>&1
if [ "$(cat "$D")" = "$snap" ]; then
  log_pass "T5 file byte-identical after --dry-run"
else
  log_fail "T5 --dry-run mutated the file"
fi

# ── T6: missing file fail-closed ────────────────────────────────────────────
log_test "T6 missing access file fails closed"
MISS="$TMP_DIR/does-not-exist.json"
if bash "$SCRIPT" --access-file "$MISS" --channel-id "$RT" --add "$TADASHI" >/dev/null 2>&1; then
  log_fail "T6 exited 0 on a missing file"
else
  [ ! -f "$MISS" ] && log_pass "T6 non-zero and did not create the file" || log_fail "T6 created the missing file"
fi

# ── T7: absent group fail-closed ────────────────────────────────────────────
log_test "T7 absent target group fails closed, file unchanged"
E="$TMP_DIR/t7.json"; make_access "$E"
snap="$(cat "$E")"
if bash "$SCRIPT" --access-file "$E" --channel-id "9999999999" --add "$TADASHI" >/dev/null 2>&1; then
  log_fail "T7 exited 0 for an absent group (would silently subscribe a new channel)"
else
  [ "$(cat "$E")" = "$snap" ] && log_pass "T7 non-zero and file unchanged" || log_fail "T7 mutated file on absent group"
fi

# ── T8: invalid JSON fail-closed ────────────────────────────────────────────
log_test "T8 invalid JSON fails closed, file unchanged"
F="$TMP_DIR/t8.json"; printf '{ not json ' > "$F"; snap="$(cat "$F")"
if bash "$SCRIPT" --access-file "$F" --channel-id "$RT" --add "$TADASHI" >/dev/null 2>&1; then
  log_fail "T8 exited 0 on invalid JSON"
else
  [ "$(cat "$F")" = "$snap" ] && log_pass "T8 non-zero and file unchanged" || log_fail "T8 mutated invalid-JSON file"
fi

# ── T9: partial add ─────────────────────────────────────────────────────────
log_test "T9 only genuinely-new ids appended when some already present"
G="$TMP_DIR/t9.json"; make_access "$G"
# 1485896147951419434 already in the RT allowFrom; TADASHI is new.
bash "$SCRIPT" --access-file "$G" --channel-id "$RT" --add "1485896147951419434" --add "$TADASHI" >/dev/null 2>&1
count_existing=$(jq -r '[.groups["'"$RT"'"].allowFrom[] | select(. == "1485896147951419434")] | length' "$G")
have_new=$(jq -r --arg id "$TADASHI" '.groups["'"$RT"'"].allowFrom | index($id) // "MISS"' "$G")
if [ "$count_existing" -eq 1 ] && [ "$have_new" != "MISS" ]; then
  log_pass "T9 existing id not duplicated, new id appended"
else
  log_fail "T9 partial add wrong (existing_count=$count_existing new=$have_new)"
fi

# ── T10: comma-separated --add ──────────────────────────────────────────────
log_test "T10 accepts comma-separated --add list"
H="$TMP_DIR/t10.json"; make_access "$H"
bash "$SCRIPT" --access-file "$H" --channel-id "$RT" --add "$TADASHI,$CASS" >/dev/null 2>&1
have_t=$(jq -r --arg id "$TADASHI" '.groups["'"$RT"'"].allowFrom | index($id) // "MISS"' "$H")
have_c=$(jq -r --arg id "$CASS" '.groups["'"$RT"'"].allowFrom | index($id) // "MISS"' "$H")
if [ "$have_t" != "MISS" ] && [ "$have_c" != "MISS" ]; then
  log_pass "T10 both csv ids added"
else
  log_fail "T10 csv add failed (tadashi=$have_t cass=$have_c)"
fi

# ── T11: a concurrent-writer field is preserved (no data loss) ──────────────
# The Discord plugin writes sibling fields to this file (e.g. a DM-pairing
# `pending` entry). Adding to allowFrom must preserve every such field — this is
# the data-loss half of the optimistic-concurrency guard (FLY-574 Codex HIGH).
log_test "T11 a plugin-written 'pending' entry survives the allowFrom edit"
P="$TMP_DIR/t11.json"; make_access "$P"
# simulate a concurrent plugin write already present on disk when we read.
jq '.pending = {"abc123": {"senderId": "999", "chatId": "888", "createdAt": 1, "expiresAt": 9999999999999, "replies": 1}}' "$P" > "$P.x" && mv "$P.x" "$P"
bash "$SCRIPT" --access-file "$P" --channel-id "$RT" --add "$TADASHI" >/dev/null 2>&1
pending_survived=$(jq -r '.pending["abc123"].senderId // "GONE"' "$P")
have_new=$(jq -r --arg id "$TADASHI" '.groups["'"$RT"'"].allowFrom | index($id) // "MISS"' "$P")
if [ "$pending_survived" = "999" ] && [ "$have_new" != "MISS" ]; then
  log_pass "T11 pending entry preserved and allowFrom add applied"
else
  log_fail "T11 data loss (pending=$pending_survived new=$have_new)"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "═════════════════════════════════════════"
echo "PASSED: $PASSED"
echo "FAILED: $FAILED"
echo "═════════════════════════════════════════"
if [ "$FAILED" -gt 0 ]; then echo -e "Failures:$ERRORS" >&2; exit 1; fi
exit 0
