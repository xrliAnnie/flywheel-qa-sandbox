#!/bin/bash
# FLY-882: discord-bot-pool.sh / discord-bot-pool-lib.sh — hermetic tests.
#
# Covers:
#   T0) init is idempotent, creates 0700 dir + 0600 pool.json, never
#       clobbers an existing pool.json
#   T1) add-slot registers a slot only when a non-empty token file already
#       exists with 0600 perms; rejects missing/empty token; rejects dup slot
#   T2) list never prints raw token content (masked tail only) — asserted
#       both by direct substring check AND via fleet-sanitize's
#       scan_for_secrets (defence in depth, reused not reimplemented)
#   T3) verify: 200 → OK/exit 0, 401 → FAIL/exit 1, missing token → FAIL,
#       never logs the raw token value even to the stub's call log
#   T4) rename: PATCH success/failure paths
#   T5) invite-url: correct client_id/permissions/guild_id, no Administrator
#       bit, unknown slot errors
#   T6) claim: unclaimed → claimed-by-X, refuses double-claim, refuses
#       unknown slot, does not touch invited_at
#   T7) CLI wrapper end-to-end (not just the sourced lib functions)
#
# Hermetic: fixture DISCORD_BOT_POOL_HOME (no real ~/.flywheel touched) +
# stub curl on PATH that responds based on the Authorization header's token
# value, recording every call to a log (so tests can assert the token itself
# never appears verbatim in any call-log entry).
set -uo pipefail

PASSED=0
FAILED=0
log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
POOL_CLI="${REPO_ROOT}/scripts/discord-bot-pool.sh"

SANDBOX="$(mktemp -d -t fly882-pool-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# ── stub curl: responds based on the Authorization token value ────────────
# VALIDTOKEN*  -> 200 {"id":"999","username":"..."}
# anything else -> 401 {"message":"401: Unauthorized"}
# every call is logged (method + token + body) so tests can assert the raw
# token text is never written into any log/output by discord-bot-pool itself.
# discord-bot-pool-lib.sh passes the Authorization header via `-K -` (a
# stdin config line), never as an -H argv flag — this stub reads stdin for
# that `header = "..."` line when it sees -K -, matching real curl's -K
# semantics, so the test double actually exercises the real code path.
STUB_BIN="$SANDBOX/stubbin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/curl" <<'CURLEOF'
#!/bin/bash
out=""; method="GET"; token=""; payload=""; stdin_cfg=0
args=("$@")
i=0
while [ $i -lt ${#args[@]} ]; do
  case "${args[$i]}" in
    -o) i=$((i+1)); out="${args[$i]}" ;;
    -X) i=$((i+1)); method="${args[$i]}" ;;
    -K)
      i=$((i+1))
      [ "${args[$i]}" = "-" ] && stdin_cfg=1
      ;;
    -H)
      i=$((i+1))
      h="${args[$i]}"
      case "$h" in
        Authorization:*) token="${h#Authorization: Bot }" ;;
      esac
      ;;
    -d) i=$((i+1)); payload="${args[$i]}" ;;
  esac
  i=$((i+1))
done
if [ "$stdin_cfg" = "1" ]; then
  while IFS= read -r line; do
    case "$line" in
      'header = "Authorization: Bot '*)
        token="${line#header = \"Authorization: Bot }"
        token="${token%\"}"
        ;;
    esac
  done
fi
echo "[stub:curl] method=$method token=$token payload=$payload" >> "$STUB_CALL_LOG"
echo "[stub:curl:argv] $*" >> "$STUB_ARGV_LOG"
case "$token" in
  VALIDTOKEN*)
    [ -n "$out" ] && printf '{"id":"999","username":"claimed-name"}' > "$out"
    printf '200'
    ;;
  *)
    [ -n "$out" ] && printf '{"message":"401: Unauthorized"}' > "$out"
    printf '401'
    ;;
esac
CURLEOF
chmod +x "$STUB_BIN/curl"
export PATH="$STUB_BIN:$PATH"
export STUB_CALL_LOG="$SANDBOX/curl-calls.log"
export STUB_ARGV_LOG="$SANDBOX/curl-argv.log"
touch "$STUB_CALL_LOG" "$STUB_ARGV_LOG"

# ── fixture pool home ──────────────────────────────────────────────────────
POOL_HOME="$SANDBOX/pool"
export DISCORD_BOT_POOL_HOME="$POOL_HOME"

run_cli() { # args... ; sets CLI_RC + CLI_OUT
  CLI_OUT="$(bash "$POOL_CLI" "$@" 2>&1)"
  CLI_RC=$?
}

# ── T0: init idempotent, correct perms, never clobbers ─────────────────────
run_cli init
if [ "$CLI_RC" -eq 0 ] && [ -d "$POOL_HOME" ] && [ -f "$POOL_HOME/pool.json" ]; then
  pass "T0a: init creates pool dir + pool.json"
else
  fail "T0a: init (rc=$CLI_RC)"; echo "$CLI_OUT"
fi
# GNU (-c) must be tried FIRST — on Linux, `stat -f` means "file system
# status" (not "format"), so it doesn't fail cleanly, it leaks a
# multi-line filesystem-info block onto stdout instead (caught live: CI
# on ubuntu-latest). BSD/macOS stat has no -c flag and fails cleanly.
DIRMODE=$(stat -c '%a' "$POOL_HOME" 2>/dev/null || stat -f '%Lp' "$POOL_HOME" 2>/dev/null)
JSONMODE=$(stat -c '%a' "$POOL_HOME/pool.json" 2>/dev/null || stat -f '%Lp' "$POOL_HOME/pool.json" 2>/dev/null)
if [ "$DIRMODE" = "700" ] && [ "$JSONMODE" = "600" ]; then
  pass "T0b: pool dir=700, pool.json=600"
else
  fail "T0b: perms wrong (dir=$DIRMODE json=$JSONMODE)"
fi
echo '{"slots":[{"slot":"sentinel","app_id":"1","status":"unclaimed"}]}' > "$POOL_HOME/pool.json"
chmod 600 "$POOL_HOME/pool.json"
run_cli init
if grep -q sentinel "$POOL_HOME/pool.json"; then
  pass "T0c: re-init never clobbers existing pool.json"
else
  fail "T0c: init clobbered existing pool.json"
fi
# restore clean state for the rest of the suite
printf '{"slots":[]}\n' > "$POOL_HOME/pool.json"
chmod 600 "$POOL_HOME/pool.json"

# ── T1: add-slot ────────────────────────────────────────────────────────────
mkdir -p "$POOL_HOME/flywheel-pool-01"
run_cli add-slot flywheel-pool-01 app-1 ""
if [ "$CLI_RC" -ne 0 ]; then
  pass "T1a: add-slot rejects missing token file"
else
  fail "T1a: add-slot should have rejected missing token"
fi
echo "VALIDTOKEN0001.fakeButRealisticLengthDiscordBotTokenPaddingXYZ" > "$POOL_HOME/flywheel-pool-01/token"
chmod 644 "$POOL_HOME/flywheel-pool-01/token"   # wrong perms on purpose
run_cli add-slot flywheel-pool-01 app-1 ""
TOKMODE=$(stat -c '%a' "$POOL_HOME/flywheel-pool-01/token" 2>/dev/null || stat -f '%Lp' "$POOL_HOME/flywheel-pool-01/token" 2>/dev/null)
if [ "$CLI_RC" -eq 0 ] && [ "$TOKMODE" = "600" ]; then
  pass "T1b: add-slot registers + self-heals token perms to 600"
else
  fail "T1b: add-slot (rc=$CLI_RC, tokmode=$TOKMODE)"; echo "$CLI_OUT"
fi
run_cli add-slot flywheel-pool-01 app-1 ""
if [ "$CLI_RC" -ne 0 ]; then
  pass "T1c: add-slot rejects duplicate slot"
else
  fail "T1c: add-slot should reject duplicate registration"
fi
# a second real slot for the rest of the suite
mkdir -p "$POOL_HOME/flywheel-pool-02"
echo "BADTOKEN0002.fakeButRealisticLengthDiscordBotTokenPaddingXYZ" > "$POOL_HOME/flywheel-pool-02/token"
chmod 600 "$POOL_HOME/flywheel-pool-02/token"
run_cli add-slot flywheel-pool-02 app-2 ""
if [ "$CLI_RC" -eq 0 ]; then
  pass "T1d: second slot registered"
else
  fail "T1d: second slot registration"; echo "$CLI_OUT"
fi

# T1e/T1f: slot names are interpolated into filesystem paths that get
# chmod'd/mkdir'd — reject anything but a safe charset (Codex review finding).
mkdir -p "$POOL_HOME/../evil-escape" 2>/dev/null || true
run_cli add-slot "../evil-escape" app-evil bot-evil
if [ "$CLI_RC" -ne 0 ]; then
  pass "T1e: add-slot rejects a path-traversal slot name (../evil-escape)"
else
  fail "T1e: add-slot should reject path-traversal slot names"
fi
run_cli verify "../../etc"
if [ "$CLI_RC" -ne 0 ]; then
  pass "T1f: verify rejects a path-traversal slot name"
else
  fail "T1f: verify should reject path-traversal slot names"
fi
run_cli rename "some/slash" "x"
if [ "$CLI_RC" -ne 0 ]; then
  pass "T1g: rename rejects a slot name containing a slash"
else
  fail "T1g: rename should reject slot names with slashes"
fi

# T1h: a real-world failure mode — the Portal's Copy button silently didn't
# put the token on the clipboard, so pbpaste captured unrelated short
# clipboard leftovers instead. add-slot must refuse an implausibly short
# token file rather than register it as if it were live.
mkdir -p "$POOL_HOME/flywheel-pool-shortfail"
echo "canSpawnRunners" > "$POOL_HOME/flywheel-pool-shortfail/token"
chmod 600 "$POOL_HOME/flywheel-pool-shortfail/token"
run_cli add-slot flywheel-pool-shortfail app-short bot-short
if [ "$CLI_RC" -ne 0 ] && ! jq -e '.slots[] | select(.slot=="flywheel-pool-shortfail")' "$POOL_HOME/pool.json" >/dev/null 2>&1; then
  pass "T1h: add-slot rejects an implausibly short token file (stale clipboard)"
else
  fail "T1h: add-slot should reject an implausibly short token file"; echo "$CLI_OUT"
fi

# T1i: add-slot must also refuse a long-enough token file whose content
# contains characters outside the token alphabet (quote/newline injection
# risk into the `-K -` curl config used later by verify/rename).
mkdir -p "$POOL_HOME/flywheel-pool-badcharset"
printf 'VALIDTOKEN"%s\ninjected = "evil"\n' "$(head -c 50 </dev/zero | tr '\0' 'a')" \
  > "$POOL_HOME/flywheel-pool-badcharset/token"
chmod 600 "$POOL_HOME/flywheel-pool-badcharset/token"
run_cli add-slot flywheel-pool-badcharset app-badcharset bot-badcharset
if [ "$CLI_RC" -ne 0 ] && ! jq -e '.slots[] | select(.slot=="flywheel-pool-badcharset")' "$POOL_HOME/pool.json" >/dev/null 2>&1; then
  pass "T1i: add-slot rejects a token file with unexpected (non-token-alphabet) characters"
else
  fail "T1i: add-slot should reject a token with unexpected characters"; echo "$CLI_OUT"
fi

# ── T2: list never prints raw token ────────────────────────────────────────
run_cli list
if [ "$CLI_RC" -eq 0 ] && echo "$CLI_OUT" | grep -q "flywheel-pool-01" && ! echo "$CLI_OUT" | grep -q "VALIDTOKEN0001"; then
  pass "T2a: list shows slots, never the raw token"
else
  fail "T2a: list output wrong"; echo "$CLI_OUT"
fi
# defence in depth: reuse fleet-sanitize's scanner on the list output itself
# shellcheck disable=SC1090,SC1091
source "${REPO_ROOT}/scripts/lib/fleet-sanitize.sh"
LISTOUT_FILE="$SANDBOX/list-out.txt"
echo "$CLI_OUT" > "$LISTOUT_FILE"
if scan_for_secrets "$LISTOUT_FILE" >/dev/null 2>&1; then
  pass "T2b: scan_for_secrets finds nothing secret-like in list output"
else
  fail "T2b: scan_for_secrets flagged list output"; scan_for_secrets "$LISTOUT_FILE"
fi

# ── T3: verify ──────────────────────────────────────────────────────────────
run_cli verify flywheel-pool-01
if [ "$CLI_RC" -eq 0 ] && echo "$CLI_OUT" | grep -q "OK"; then
  pass "T3a: verify OK on valid token (200)"
else
  fail "T3a: verify valid token"; echo "$CLI_OUT"
fi
# T3a2: verify backfills bot_user_id from the liveness response (Annie's
# audit finding — the only place that attests a real bot_user_id).
BACKFILLED_ID=$(jq -r '.slots[] | select(.slot=="flywheel-pool-01") | .bot_user_id' "$POOL_HOME/pool.json")
if [ "$BACKFILLED_ID" = "999" ]; then
  pass "T3a2: verify backfills bot_user_id into pool.json"
else
  fail "T3a2: bot_user_id not backfilled (got '$BACKFILLED_ID')"; cat "$POOL_HOME/pool.json"
fi
run_cli verify flywheel-pool-02
if [ "$CLI_RC" -ne 0 ] && echo "$CLI_OUT" | grep -q "FAIL"; then
  pass "T3b: verify FAILs on invalid token (401)"
else
  fail "T3b: verify invalid token"; echo "$CLI_OUT"
fi
run_cli verify flywheel-pool-99
if [ "$CLI_RC" -ne 0 ]; then
  pass "T3c: verify FAILs cleanly on slot with no token file"
else
  fail "T3c: verify should fail for missing token"
fi
run_cli verify --all
if [ "$CLI_RC" -ne 0 ]; then
  pass "T3d: verify --all exits non-zero when any slot fails"
else
  fail "T3d: verify --all should reflect the failing slot"
fi
# T3e: the SCRIPT's own stdout/stderr (CLI_OUT, what a human/agent actually
# sees) must never contain the raw token — this is the property that
# matters. (The stub curl's own diagnostic call-log intentionally records
# the token it received so T3a/T3b can assert the right token was sent;
# that log is a test fixture, not discord-bot-pool.sh output.)
if ! echo "$CLI_OUT" | grep -q "VALIDTOKEN0001\|BADTOKEN0002"; then
  pass "T3e: raw token text never appears in discord-bot-pool.sh's own output"
else
  fail "T3e: raw token leaked into script output"; echo "$CLI_OUT"
fi
# T3f: the token must go to curl via -K stdin config, never as -H argv text
# — assert against curl's own recorded argv (what a local `ps` would show),
# not just discord-bot-pool.sh's stdout.
if ! grep -q "Authorization" "$STUB_ARGV_LOG"; then
  pass "T3f: curl argv never contains the Authorization header (token went via -K stdin)"
else
  fail "T3f: Authorization header leaked into curl argv"; cat "$STUB_ARGV_LOG"
fi
if grep -q -- '-K -' "$STUB_ARGV_LOG"; then
  pass "T3g: curl is actually invoked with -K - (stdin auth path exercised)"
else
  fail "T3g: curl was never invoked with -K - — the stdin auth path isn't exercised"; cat "$STUB_ARGV_LOG"
fi

# ── T4: rename ──────────────────────────────────────────────────────────────
run_cli rename flywheel-pool-01 "Honey Lemon"
if [ "$CLI_RC" -eq 0 ] && echo "$CLI_OUT" | grep -q "renamed"; then
  pass "T4a: rename succeeds with valid token"
else
  fail "T4a: rename"; echo "$CLI_OUT"
fi
run_cli rename flywheel-pool-02 "Anna"
if [ "$CLI_RC" -ne 0 ]; then
  pass "T4b: rename fails cleanly with invalid token"
else
  fail "T4b: rename should have failed"
fi

# T4c/T4d: _pool_load_token's defensive check must apply on every read, not
# just at add-slot registration time — a token file tampered with *after*
# registration (wrong perms, or overwritten with short garbage by a stray
# pbpaste) must make subsequent verify/rename refuse, not silently send
# garbage to Discord.
mkdir -p "$POOL_HOME/flywheel-pool-tamper"
echo "VALIDTOKEN9999.fakeButRealisticLengthDiscordBotTokenPaddingXYZ" > "$POOL_HOME/flywheel-pool-tamper/token"
chmod 600 "$POOL_HOME/flywheel-pool-tamper/token"
run_cli add-slot flywheel-pool-tamper app-tamper ""
run_cli verify flywheel-pool-tamper
if [ "$CLI_RC" -eq 0 ]; then
  pass "T4c-setup: freshly registered tamper-test slot verifies OK"
else
  fail "T4c-setup: tamper-test slot should verify OK before tampering"; echo "$CLI_OUT"
fi
chmod 644 "$POOL_HOME/flywheel-pool-tamper/token"
run_cli verify flywheel-pool-tamper
if [ "$CLI_RC" -ne 0 ] && echo "$CLI_OUT" | grep -q "expected 600"; then
  pass "T4c: verify refuses a token file whose perms drifted from 600 after registration"
else
  fail "T4c: verify should refuse a non-600 token file"; echo "$CLI_OUT"
fi
chmod 600 "$POOL_HOME/flywheel-pool-tamper/token"
echo "short" > "$POOL_HOME/flywheel-pool-tamper/token"
chmod 600 "$POOL_HOME/flywheel-pool-tamper/token"
run_cli rename flywheel-pool-tamper "x"
if [ "$CLI_RC" -ne 0 ] && echo "$CLI_OUT" | grep -q "implausibly short"; then
  pass "T4d: rename refuses a token file truncated to garbage after registration"
else
  fail "T4d: rename should refuse an implausibly short token"; echo "$CLI_OUT"
fi

# T4e: a token file whose content contains characters outside the token
# alphabet (e.g. a stray embedded quote/newline from a corrupted paste) must
# be refused on read, not passed through to _pool_curl_authed's `-K -` stdin
# config where it could break out of the `header = "..."` line and inject
# an extra curl config directive.
printf 'VALIDTOKEN"%s\ninjected = "evil"\n' "$(head -c 50 </dev/zero | tr '\0' 'a')" \
  > "$POOL_HOME/flywheel-pool-tamper/token"
chmod 600 "$POOL_HOME/flywheel-pool-tamper/token"
run_cli verify flywheel-pool-tamper
if [ "$CLI_RC" -ne 0 ] && echo "$CLI_OUT" | grep -q "unexpected characters"; then
  pass "T4e: verify refuses a token file containing unexpected (non-token-alphabet) characters"
else
  fail "T4e: verify should refuse a token with unexpected characters"; echo "$CLI_OUT"
fi

# ── T5: invite-url ──────────────────────────────────────────────────────────
run_cli invite-url flywheel-pool-01
if [ "$CLI_RC" -eq 0 ] && echo "$CLI_OUT" | grep -q "client_id=app-1" && echo "$CLI_OUT" | grep -q "permissions=277025459264"; then
  pass "T5a: invite-url has correct client_id + non-Administrator permission bits"
else
  fail "T5a: invite-url content wrong"; echo "$CLI_OUT"
fi
if ! echo "$CLI_OUT" | grep -qE 'permissions=8($|&)'; then
  pass "T5b: invite-url does not grant Administrator"
else
  fail "T5b: invite-url granted Administrator"
fi
run_cli invite-url flywheel-pool-does-not-exist
if [ "$CLI_RC" -ne 0 ]; then
  pass "T5c: invite-url errors on unknown slot"
else
  fail "T5c: invite-url should error on unknown slot"
fi

# ── T6: claim ────────────────────────────────────────────────────────────────
run_cli claim flywheel-pool-01 honey-lemon
if [ "$CLI_RC" -eq 0 ] && jq -e '.slots[] | select(.slot=="flywheel-pool-01") | .status == "claimed-by-honey-lemon"' "$POOL_HOME/pool.json" >/dev/null; then
  pass "T6a: claim marks status claimed-by-<id>"
else
  fail "T6a: claim status"; cat "$POOL_HOME/pool.json"
fi
INVITED_AT=$(jq -r '.slots[] | select(.slot=="flywheel-pool-01") | .invited_at' "$POOL_HOME/pool.json")
if [ "$INVITED_AT" = "null" ]; then
  pass "T6b: claim leaves invited_at untouched (still null)"
else
  fail "T6b: claim should not set invited_at"
fi
run_cli claim flywheel-pool-01 someone-else
if [ "$CLI_RC" -ne 0 ]; then
  pass "T6c: claim refuses double-claim of an already-claimed slot"
else
  fail "T6c: double-claim should be refused"
fi
run_cli claim flywheel-pool-nope anna
if [ "$CLI_RC" -ne 0 ]; then
  pass "T6d: claim refuses unknown slot"
else
  fail "T6d: claim should refuse unknown slot"
fi

# T6e: concurrent claim race — Codex's review reproduced two simultaneous
# `claim` calls on the same slot both succeeding (last-writer-wins lost
# update) before the mkdir-based pool.json lock existed. Reproduce the same
# scenario here and assert exactly one wins and pool.json ends up
# consistent (not corrupted, not double-claimed).
mkdir -p "$POOL_HOME/flywheel-pool-race"
echo "VALIDTOKEN7777.fakeButRealisticLengthDiscordBotTokenPaddingXYZ" > "$POOL_HOME/flywheel-pool-race/token"
chmod 600 "$POOL_HOME/flywheel-pool-race/token"
run_cli add-slot flywheel-pool-race app-race ""
RACE_OUT_A="$SANDBOX/race-a.out"; RACE_OUT_B="$SANDBOX/race-b.out"
( bash "$POOL_CLI" claim flywheel-pool-race racer-a > "$RACE_OUT_A" 2>&1; echo $? > "$RACE_OUT_A.rc" ) &
PID_A=$!
( bash "$POOL_CLI" claim flywheel-pool-race racer-b > "$RACE_OUT_B" 2>&1; echo $? > "$RACE_OUT_B.rc" ) &
PID_B=$!
wait "$PID_A" "$PID_B"
RC_A=$(cat "$RACE_OUT_A.rc"); RC_B=$(cat "$RACE_OUT_B.rc")
WINNERS=0
[ "$RC_A" -eq 0 ] && WINNERS=$((WINNERS + 1))
[ "$RC_B" -eq 0 ] && WINNERS=$((WINNERS + 1))
FINAL_CLAIMED_BY=$(jq -r '.slots[] | select(.slot=="flywheel-pool-race") | .claimed_by' "$POOL_HOME/pool.json")
if [ "$WINNERS" -eq 1 ] && { [ "$FINAL_CLAIMED_BY" = "racer-a" ] || [ "$FINAL_CLAIMED_BY" = "racer-b" ]; }; then
  pass "T6e: concurrent claim on the same slot — exactly one wins, pool.json consistent"
else
  fail "T6e: concurrent claim race not serialized correctly (winners=$WINNERS, claimed_by=$FINAL_CLAIMED_BY)"
  echo "racer-a: rc=$RC_A $(cat "$RACE_OUT_A")"
  echo "racer-b: rc=$RC_B $(cat "$RACE_OUT_B")"
fi

# T6f: concurrent add-slot race — Codex review round 2 reproduced two
# simultaneous `add-slot` calls for the same never-before-registered slot
# both returning 0 and leaving two duplicate entries in pool.json (the
# outer pool_slot_exists pre-check ran before either side acquired the
# lock). The authoritative re-check now lives inside the locked writer;
# assert exactly one call wins and pool.json has exactly one entry for the
# slot.
mkdir -p "$POOL_HOME/flywheel-pool-addrace"
echo "VALIDTOKEN8888.fakeButRealisticLengthDiscordBotTokenPaddingXYZ" > "$POOL_HOME/flywheel-pool-addrace/token"
chmod 600 "$POOL_HOME/flywheel-pool-addrace/token"
ADDRACE_OUT_A="$SANDBOX/addrace-a.out"; ADDRACE_OUT_B="$SANDBOX/addrace-b.out"
( bash "$POOL_CLI" add-slot flywheel-pool-addrace app-addrace-a "" > "$ADDRACE_OUT_A" 2>&1; echo $? > "$ADDRACE_OUT_A.rc" ) &
PID_A=$!
( bash "$POOL_CLI" add-slot flywheel-pool-addrace app-addrace-b "" > "$ADDRACE_OUT_B" 2>&1; echo $? > "$ADDRACE_OUT_B.rc" ) &
PID_B=$!
wait "$PID_A" "$PID_B"
RC_A=$(cat "$ADDRACE_OUT_A.rc"); RC_B=$(cat "$ADDRACE_OUT_B.rc")
WINNERS=0
[ "$RC_A" -eq 0 ] && WINNERS=$((WINNERS + 1))
[ "$RC_B" -eq 0 ] && WINNERS=$((WINNERS + 1))
ENTRY_COUNT=$(jq '[.slots[] | select(.slot=="flywheel-pool-addrace")] | length' "$POOL_HOME/pool.json")
if [ "$WINNERS" -eq 1 ] && [ "$ENTRY_COUNT" -eq 1 ]; then
  pass "T6f: concurrent add-slot for the same new slot — exactly one wins, pool.json has one entry"
else
  fail "T6f: concurrent add-slot race not serialized correctly (winners=$WINNERS, entries=$ENTRY_COUNT)"
  echo "addrace-a: rc=$RC_A $(cat "$ADDRACE_OUT_A")"
  echo "addrace-b: rc=$RC_B $(cat "$ADDRACE_OUT_B")"
fi

# ── T7: CLI wrapper sanity (usage / unknown command) ───────────────────────
run_cli
if [ "$CLI_RC" -eq 0 ] && echo "$CLI_OUT" | grep -q "Usage:"; then
  pass "T7a: no-arg invocation prints usage, exits 0"
else
  fail "T7a: usage output"; echo "$CLI_OUT"
fi
run_cli bogus-command
if [ "$CLI_RC" -ne 0 ]; then
  pass "T7b: unknown command exits non-zero"
else
  fail "T7b: unknown command should error"
fi

# ── T8: pool_mask_token unit tests (source the lib directly) ──────────────
export DISCORD_BOT_POOL_LIB_SOURCED=""
# shellcheck disable=SC1091
source "${REPO_ROOT}/scripts/lib/discord-bot-pool-lib.sh"
if [ "$(pool_mask_token "")" = "(none)" ]; then
  pass "T8a: pool_mask_token('') -> (none)"
else
  fail "T8a: pool_mask_token('') = $(pool_mask_token "")"
fi
# a pathologically short token must never come back out verbatim, even
# behind an ellipsis (Codex review finding).
SHORT_MASK="$(pool_mask_token "abcd")"
if [ "$SHORT_MASK" = "(present)" ]; then
  pass "T8b: pool_mask_token('abcd') never reveals the full short token"
else
  fail "T8b: pool_mask_token('abcd') = $SHORT_MASK (leaked short token)"
fi
LONG_MASK="$(pool_mask_token "VALIDTOKEN0001")"
if [ "$LONG_MASK" = "…0001" ]; then
  pass "T8c: pool_mask_token shows only the last 4 chars of a real-length token"
else
  fail "T8c: pool_mask_token(real token) = $LONG_MASK"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
