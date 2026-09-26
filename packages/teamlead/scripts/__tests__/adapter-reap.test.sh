#!/bin/bash
# FLY-183 — tests for lib/reap-orphan-adapters.sh
#
# Safety: every test is hermetic. The reaper's process-table DISCOVERY source is
# injected via FLY183_PS_OVERRIDE so it NEVER scans the real process table; in a
# destructive (non-dry-run) reap the override is honored only because each test
# sets the explicit opt-in FLY183_TEST_ALLOW_OVERRIDE=1 (production ignores the
# override entirely, Codex R2 HIGH). Any real processes spawned here are
# test-owned (tracked in a pid file + killed on exit). Nothing in this file can
# touch a production adapter.
#
# Note: the destructive tests (T2/T3/T6/T10) and lsof tests (T3/T4) require a real
# process table; the Codex sandbox blocks `ps`/`pgrep`/`lsof` so those assertions
# only run green on a real host. The dry-run matcher tests (T1/T7/T8/T9) are
# table-only and run anywhere.
#
# Coverage:
#   T1  matcher + ppid gate (synthetic table, dry-run): cache abs-path,
#       marketplace abs-path, legacy wrapper all match; ppid!=1, non-discord,
#       and relative-bun-server.ts-without-discord-cwd do NOT match.
#   T2  real reap kills a matched orphan (TERM/grace/KILL path).
#   T3  legacy relative `bun server.ts` matched via lsof cwd-probe.
#   T4  identity label: Flywheel-Lead state dir -> normal; foreign -> WARNING.
#   T5  dry-run never kills.
#   T6  recursive descendant kill (real discord-shaped orphan with a child subtree).
#   T7  path-in-argv but non-launcher (editor/pager) is NOT matched.
#   T8  position-aware matcher: bun-in-path, `--bun` flag, and the discord-backup
#       sibling dir are all NOT matched (Codex R2 MEDIUM).
#   T9  start-adapter.sh launcher IS matched (via bash + direct exec).
#   T10 forged FLY183_PS_OVERRIDE cannot force a kill: live revalidation reads the
#       REAL table and refuses to signal a live non-adapter (Codex R2 HIGH).
#   T11 bun launching a NON-entry .ts in the discord dir is NOT matched (R3 MEDIUM).
#   T12 WHITELIST positives — every real launch shape matches (inner/wrapper/launcher
#       × cache/marketplace, `--cwd` and `--cwd=`, abs `*/bun`) (Codex R4 rewrite).
#   T13 WHITELIST negatives — every known false-positive shape skipped, incl. the
#       discord-backup sibling (inner + wrapper), non-'start' `bun run`, and
#       NON-absolute / `--entry=` option-value tokens (Codex R4 + R5).
#   T14 shape-3 cwd-probe rejects an ABS non-plugin server.ts even when cwd is a
#       discord dir (Codex R4 MEDIUM#2).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../lib/reap-orphan-adapters.sh"

# Codex R3 LOW: fail FAST if fixture scaffolding can't be created (e.g. a sandbox
# that denies mktemp). Otherwise an empty TMP_DIR yields bogus paths and empty
# PIDs, and assertions like `kill -0 ""` falsely "pass" the reap tests.
TMP_DIR="$(mktemp -d -t adapter-reap-test.XXXXXX)" || { echo "FATAL: mktemp -d failed; cannot scaffold fixtures" >&2; exit 1; }
[ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] || { echo "FATAL: TMP_DIR '$TMP_DIR' is not a usable directory" >&2; exit 1; }
PIDS_FILE="$TMP_DIR/spawned.pids"
: > "$PIDS_FILE" || { echo "FATAL: cannot write PIDS_FILE under $TMP_DIR" >&2; exit 1; }

cleanup() {
  if [ -f "$PIDS_FILE" ]; then
    local p
    while read -r p; do [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true; done < "$PIDS_FILE"
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

PASSED=0
FAILED=0
ERRORS=""
log_test() { echo "[TEST] $*"; }
log_pass() { echo "  ✓ $*"; PASSED=$((PASSED + 1)); }
log_fail() { echo "  ✗ $*" >&2; FAILED=$((FAILED + 1)); ERRORS="${ERRORS}\n  - $*"; }

# shellcheck source=../lib/reap-orphan-adapters.sh
source "$LIB"

# Spawn a test-owned, orphaned (ppid==1) long-lived process.
#   $1 = argv string (argv[0]); $2 = cwd; $3 = optional file to hold open.
# Echoes the pid. CRITICAL: the backgrounded process redirects all std fds to
# /dev/null so it does NOT hold this function's command-substitution stdout pipe
# open (otherwise `pid=$(spawn_orphan ...)` would block until sleep 600 exits).
spawn_orphan() {
  local argv="$1" cwd="$2" openfile="${3:-}" pidfile
  pidfile="$(mktemp "$TMP_DIR/pid.XXXXXX")"
  mkdir -p "$cwd"
  (
    cd "$cwd" || exit 0
    if [ -n "$openfile" ]; then
      mkdir -p "$(dirname "$openfile")"; : > "$openfile"
      bash -c 'exec 9< "$1"; exec -a "$2" sleep 600' _ "$openfile" "$argv" </dev/null >/dev/null 2>&1 &
    else
      bash -c 'exec -a "$1" sleep 600' _ "$argv" </dev/null >/dev/null 2>&1 &
    fi
    echo $! > "$pidfile"
  )
  local pid; pid="$(cat "$pidfile")"
  # Codex R3 LOW: a non-numeric/empty pid means fixture setup failed -- fail FAST
  # instead of returning "" and letting `kill -0 ""` falsely satisfy a later assert.
  case "$pid" in
    ''|*[!0-9]*) echo "FATAL: spawn_orphan produced non-numeric pid '$pid' (fixture setup failed)" >&2; exit 1 ;;
  esac
  echo "$pid" >> "$PIDS_FILE"
  sleep 0.4   # let the exiting subshell reparent the child to ppid==1
  echo "$pid"
}

CACHE="/u/.claude/plugins/cache/claude-plugins-official/discord/0.0.4"
MKT="/u/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord"

# ── T1: matcher + ppid gate (synthetic table, dry-run) ──────────────────
log_test "T1 matcher + ppid gate (dry-run, synthetic table)"
T1_TABLE='printf "%s\n" \
"1111 1 bun run --cwd '"$CACHE"' --shell=bun --silent start" \
"2222 1 bun '"$CACHE"'/server.ts" \
"3333 1 bun '"$MKT"'/server.ts" \
"4444 9 bun '"$MKT"'/server.ts" \
"5555 1 node /u/other/index.js" \
"6666 1 bun server.ts"'
OUT="$(FLY183_PS_OVERRIDE="$T1_TABLE" FLY183_REAP_DRY_RUN=1 reap_orphan_adapters 2>&1)"
ok=1
for p in 1111 2222 3333; do echo "$OUT" | grep -q "WOULD reap pid=$p" || { ok=0; log_fail "T1 expected match pid=$p missing"; }; done
for p in 4444 5555 6666; do echo "$OUT" | grep -q "pid=$p" && { ok=0; log_fail "T1 should NOT match pid=$p"; }; done
[ "$ok" = 1 ] && log_pass "T1 cache+marketplace+wrapper matched; ppid!=1/non-discord/relative-no-cwd skipped"

# ── T2: real reap kills a matched orphan ────────────────────────────────
log_test "T2 real reap kills a matched orphan"
PID2="$(spawn_orphan "bun $MKT/server.ts" "$TMP_DIR/t2")"
FLY183_TEST_ALLOW_OVERRIDE=1 FLY183_PS_OVERRIDE="printf '%s 1 bun $MKT/server.ts\n' $PID2" reap_orphan_adapters >/dev/null 2>&1
sleep 0.3
if kill -0 "$PID2" 2>/dev/null; then log_fail "T2 orphan pid=$PID2 still alive after reap"; else log_pass "T2 orphan reaped"; fi

# ── T3: legacy relative `bun server.ts` matched via lsof cwd-probe ───────
log_test "T3 relative 'bun server.ts' matched via lsof cwd-probe"
if command -v lsof >/dev/null 2>&1; then
  CWD3="$TMP_DIR/x/claude-plugins-official/external_plugins/discord"
  PID3="$(spawn_orphan "bun server.ts" "$CWD3")"
  FLY183_TEST_ALLOW_OVERRIDE=1 FLY183_PS_OVERRIDE="printf '%s 1 bun server.ts\n' $PID3" reap_orphan_adapters >/dev/null 2>&1
  sleep 0.3
  if kill -0 "$PID3" 2>/dev/null; then log_fail "T3 cwd-probe orphan pid=$PID3 still alive"; else log_pass "T3 relative inner reaped via cwd-probe"; fi
else
  log_pass "T3 skipped (lsof unavailable)"
fi

# ── T4: identity label (dry-run) ────────────────────────────────────────
log_test "T4 identity label flywheel vs foreign"
if command -v lsof >/dev/null 2>&1; then
  PID4A="$(spawn_orphan "bun $MKT/server.ts" "$TMP_DIR/t4a" "$TMP_DIR/t4a/channels/discord-product-lead/.env")"
  PID4B="$(spawn_orphan "bun $MKT/server.ts" "$TMP_DIR/t4b" "$TMP_DIR/t4b/channels/discord-belle/.env")"
  OUTA="$(FLY183_PS_OVERRIDE="printf '%s 1 bun $MKT/server.ts\n' $PID4A" FLY183_REAP_DRY_RUN=1 reap_orphan_adapters 2>&1)"
  OUTB="$(FLY183_PS_OVERRIDE="printf '%s 1 bun $MKT/server.ts\n' $PID4B" FLY183_REAP_DRY_RUN=1 reap_orphan_adapters 2>&1)"
  ok=1
  echo "$OUTA" | grep -q "label=flywheel:discord-product-lead" || { ok=0; log_fail "T4 product-lead not labeled flywheel: $OUTA"; }
  echo "$OUTB" | grep -q "label=NONFLYWHEEL:discord-belle" || { ok=0; log_fail "T4 belle not labeled NONFLYWHEEL: $OUTB"; }
  [ "$ok" = 1 ] && log_pass "T4 identity label classifies flywheel vs foreign"
else
  log_pass "T4 skipped (lsof unavailable)"
fi

# ── T5: dry-run never kills ─────────────────────────────────────────────
log_test "T5 dry-run never kills"
PID5="$(spawn_orphan "bun $MKT/server.ts" "$TMP_DIR/t5")"
FLY183_PS_OVERRIDE="printf '%s 1 bun $MKT/server.ts\n' $PID5" FLY183_REAP_DRY_RUN=1 reap_orphan_adapters >/dev/null 2>&1
sleep 0.2
if kill -0 "$PID5" 2>/dev/null; then log_pass "T5 dry-run left orphan alive"; else log_fail "T5 dry-run killed pid=$PID5 (must not!)"; fi

# ── T6: recursive descendant kill ───────────────────────────────────────
# The orphaned ROOT is a REAL discord-shaped adapter: a bash that first spawns a
# real background child (the descendant), then `exec -a "bun .../server.ts"`s into
# the discord argv. So the root's live argv passes the R2-HIGH revalidation gate,
# and the reaper must collect + kill the descendant before signalling the root.
log_test "T6 recursive descendant kill"
ROOTF="$(mktemp "$TMP_DIR/pid.XXXXXX")"; CHILDF="$(mktemp "$TMP_DIR/pid.XXXXXX")"
(
  bash -c 'sleep 600 </dev/null >/dev/null 2>&1 & echo $! > "'"$CHILDF"'"; exec -a "bun '"$MKT"'/server.ts" sleep 600' </dev/null >/dev/null 2>&1 &
  echo $! > "$ROOTF"
)
PID6P="$(cat "$ROOTF")"; sleep 0.6; PID6C="$(cat "$CHILDF" 2>/dev/null || true)"
echo "$PID6P" >> "$PIDS_FILE"; [ -n "${PID6C:-}" ] && echo "$PID6C" >> "$PIDS_FILE"
FLY183_TEST_ALLOW_OVERRIDE=1 FLY183_PS_OVERRIDE="printf '%s 1 bun $MKT/server.ts\n' $PID6P" reap_orphan_adapters >/dev/null 2>&1
sleep 0.4
if kill -0 "$PID6P" 2>/dev/null; then
  log_fail "T6 parent pid=$PID6P still alive"
elif [ -z "${PID6C:-}" ]; then
  log_fail "T6 child pid was not captured (fixture setup failed)"
elif kill -0 "$PID6C" 2>/dev/null; then
  log_fail "T6 child pid=$PID6C survived (descendant not reaped)"
else
  log_pass "T6 parent + child subtree reaped"
fi

# ── T7: matcher tightening — path-in-argv but NOT a bun/launcher is skipped ──
log_test "T7 non-launcher process referencing plugin path is NOT matched"
T7_TABLE='printf "%s\n" \
"7777 1 vim '"$MKT"'/server.ts" \
"7788 1 less '"$CACHE"'/server.ts"'
OUT7="$(FLY183_PS_OVERRIDE="$T7_TABLE" FLY183_REAP_DRY_RUN=1 reap_orphan_adapters 2>&1)"
if echo "$OUT7" | grep -q "pid=77"; then
  log_fail "T7 matched a non-launcher process referencing the plugin path: $OUT7"
else
  log_pass "T7 editor/pager referencing plugin path not matched (matcher requires bun/launcher shape)"
fi

# ── T8: position-aware matcher — bun-in-path / --bun flag / discord-backup ──
# Codex R2 MEDIUM: the old substring check matched any argv mentioning `bun`
# (a /Users/bun/ path component, a `--bun` flag) and the discord-backup sibling.
# 8801: argv[0] is a non-bun editor whose PATH contains `bun` twice -> not a launch.
# 8802: argv[0] is `node`, `--bun` is just a flag -> not a launch.
# 8803: argv[0] IS bun, but the path is the discord-backup SIBLING -> not discord.
log_test "T8 bun-in-path / --bun flag / discord-backup sibling are NOT matched"
T8_TABLE='printf "%s\n" \
"8801 1 /Users/bun/tools/editor /Users/bun/x/claude-plugins-official/external_plugins/discord/server.ts" \
"8802 1 node --bun /u/x/claude-plugins-official/external_plugins/discord/server.ts" \
"8803 1 bun /u/x/claude-plugins-official/external_plugins/discord-backup/server.ts"'
OUT8="$(FLY183_PS_OVERRIDE="$T8_TABLE" FLY183_REAP_DRY_RUN=1 reap_orphan_adapters 2>&1)"
if echo "$OUT8" | grep -q "pid=88"; then
  log_fail "T8 matched a non-launcher/sibling-path process: $OUT8"
else
  log_pass "T8 bun-in-path, --bun flag, and discord-backup sibling all correctly skipped"
fi

# ── T9: start-adapter.sh launcher IS matched (both invocation forms) ─────
log_test "T9 start-adapter.sh launcher matched (via bash + direct exec)"
T9_TABLE='printf "%s\n" \
"9901 1 /bin/bash '"$MKT"'/start-adapter.sh" \
"9902 1 '"$MKT"'/start-adapter.sh"'
OUT9="$(FLY183_PS_OVERRIDE="$T9_TABLE" FLY183_REAP_DRY_RUN=1 reap_orphan_adapters 2>&1)"
ok=1
for p in 9901 9902; do echo "$OUT9" | grep -q "WOULD reap pid=$p" || { ok=0; log_fail "T9 start-adapter shape pid=$p not matched: $OUT9"; }; done
[ "$ok" = 1 ] && log_pass "T9 start-adapter.sh launcher matched via bash and direct exec"

# ── T11: bun launching a NON-entry file in the discord dir is NOT matched ──
# Codex R3 MEDIUM: a first-token bun that references the plugin dir but does not
# launch the adapter entry (server.ts) or the legacy `... start` wrapper must be
# skipped. server.test.ts / test-helper.ts / not-server.ts are all non-entries.
log_test "T11 bun running a non-entry .ts in the discord dir is NOT matched"
T11_TABLE='printf "%s\n" \
"1101 1 bun test '"$MKT"'/server.test.ts" \
"1102 1 bun '"$MKT"'/test-helper.ts" \
"1103 1 bun '"$CACHE"'/not-server.ts" \
"1104 1 bun run --cwd '"$CACHE"' --shell=bun --silent build"'
OUT11="$(FLY183_PS_OVERRIDE="$T11_TABLE" FLY183_REAP_DRY_RUN=1 reap_orphan_adapters 2>&1)"
if echo "$OUT11" | grep -q "pid=110"; then
  log_fail "T11 matched a bun process that does not launch the adapter entry: $OUT11"
else
  log_pass "T11 bun test / helper .ts / non-'start' run in the discord dir all skipped"
fi

# ── T10: forged override cannot force a kill (Codex R2 HIGH) ─────────────
# A REAL, live, NON-discord orphan; the injected table LIES that it is a ppid==1
# discord adapter (with the test opt-in, so discovery finds it). The live
# revalidation gate must read the REAL table (argv = the non-adapter name, not an
# adapter) and refuse to signal it. Requires a real process table (real host).
log_test "T10 forged override cannot kill a live non-adapter (live revalidation)"
PID10="$(spawn_orphan "totally-not-an-adapter" "$TMP_DIR/t10")"
FLY183_TEST_ALLOW_OVERRIDE=1 FLY183_PS_OVERRIDE="printf '%s 1 bun $MKT/server.ts\n' $PID10" reap_orphan_adapters >/dev/null 2>&1
sleep 0.3
if kill -0 "$PID10" 2>/dev/null; then
  log_pass "T10 forged-override target survived (live revalidation refused the kill)"
else
  log_fail "T10 reaper killed a live non-adapter on a forged override (HIGH regression)"
fi

# ── T12: WHITELIST positives — EVERY real adapter launch shape MUST match ──
# Codex R4 (systematic rewrite): enumerate every legitimate launch shape and
# assert all match. Both install layouts (cache `.../discord/<ver>` + marketplace
# `.../external_plugins/discord`), both `--cwd <v>` and `--cwd=<v>` forms, abs and
# path-qualified `*/bun` argv[0], and the start-adapter.sh launcher (bash + direct).
log_test "T12 whitelist positives — every real adapter launch shape matches"
T12_TABLE='printf "%s\n" \
"1201 1 bun '"$MKT"'/server.ts" \
"1202 1 bun '"$CACHE"'/server.ts" \
"1203 1 /Users/x/.bun/bin/bun '"$MKT"'/server.ts" \
"1204 1 bun run --cwd '"$MKT"' --shell=bun --silent start" \
"1205 1 bun run --cwd '"$CACHE"' --shell=bun --silent start" \
"1206 1 bun run --cwd='"$MKT"' --silent start" \
"1207 1 /bin/bash '"$MKT"'/start-adapter.sh" \
"1208 1 '"$MKT"'/start-adapter.sh"'
OUT12="$(FLY183_PS_OVERRIDE="$T12_TABLE" FLY183_REAP_DRY_RUN=1 reap_orphan_adapters 2>&1)"
ok=1
for p in 1201 1202 1203 1204 1205 1206 1207 1208; do
  echo "$OUT12" | grep -q "WOULD reap pid=$p" || { ok=0; log_fail "T12 real adapter shape pid=$p NOT matched (false negative): $OUT12"; }
done
[ "$ok" = 1 ] && log_pass "T12 all 8 real launch shapes (inner/wrapper/launcher × cache/marketplace) matched"

# ── T13: WHITELIST negatives — every known false-positive shape MUST NOT match ──
# bun-in-path, --bun flag, editor/pager, bun test, helper/non-entry .ts, the
# discord-backup sibling (inner + wrapper), and a non-'start' `bun run`.
log_test "T13 whitelist negatives — known false-positive shapes all skipped"
BK="/u/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord-backup"
# 1310-1313 (Codex R5): NON-absolute / option-value tokens must NOT match — the
# real adapter is always launched with an absolute path, so a relative path, a
# relative --cwd, or an `--entry=<abs>` option-value token are all rejected.
REL="rel/claude-plugins-official/external_plugins/discord"
T13_TABLE='printf "%s\n" \
"1301 1 /Users/bun/tools/editor '"$MKT"'/server.ts" \
"1302 1 node --bun '"$MKT"'/server.ts" \
"1303 1 vim '"$MKT"'/server.ts" \
"1304 1 bun test '"$MKT"'/server.test.ts" \
"1305 1 bun '"$MKT"'/test-helper.ts" \
"1306 1 bun '"$CACHE"'/not-server.ts" \
"1307 1 bun run --cwd '"$CACHE"' --shell=bun --silent build" \
"1308 1 bun '"$BK"'/server.ts" \
"1309 1 bun run --cwd '"$BK"' --silent start" \
"1310 1 bun --entry='"$MKT"'/server.ts" \
"1311 1 bun '"$REL"'/server.ts" \
"1312 1 '"$REL"'/start-adapter.sh" \
"1313 1 bun run --cwd '"$REL"' --silent start"'
OUT13="$(FLY183_PS_OVERRIDE="$T13_TABLE" FLY183_REAP_DRY_RUN=1 reap_orphan_adapters 2>&1)"
if echo "$OUT13" | grep -qE "pid=13[0-9][0-9]"; then
  log_fail "T13 matched a known non-adapter shape (false positive): $OUT13"
else
  log_pass "T13 all 13 false-positive shapes (bun-in-path/--bun/editor/test/helper/non-entry/non-start/discord-backup×2/--entry=/relative×3) skipped"
fi

# ── T14: shape-3 cwd-probe must NOT match an ABS non-plugin server.ts ─────
# Codex R4 MEDIUM#2: a bun process whose argv has an ABSOLUTE /server.ts OUTSIDE
# the plugin, but whose cwd happens to be a discord dir, must NOT match (shape A
# rejects it — dir not discord; shape C only accepts the BARE relative token).
log_test "T14 abs non-plugin server.ts with cwd=discord dir is NOT matched"
if command -v lsof >/dev/null 2>&1; then
  CWD14="$TMP_DIR/x14/claude-plugins-official/external_plugins/discord"
  ELSE14="$TMP_DIR/elsewhere14"; mkdir -p "$ELSE14"
  PID14="$(spawn_orphan "bun $ELSE14/server.ts" "$CWD14")"
  FLY183_TEST_ALLOW_OVERRIDE=1 FLY183_PS_OVERRIDE="printf '%s 1 bun $ELSE14/server.ts\n' $PID14" reap_orphan_adapters >/dev/null 2>&1
  sleep 0.3
  if kill -0 "$PID14" 2>/dev/null; then
    log_pass "T14 abs non-plugin server.ts (cwd=discord) survived — shape-3 no longer over-matches"
  else
    log_fail "T14 killed an abs non-plugin server.ts whose cwd is the discord dir (MEDIUM#2 regression)"
  fi
else
  log_pass "T14 skipped (lsof unavailable)"
fi

# ── Summary ─────────────────────────────────────────────────────────────
echo ""
echo "═════════════════════════════════════════"
echo "PASSED: $PASSED"
echo "FAILED: $FAILED"
echo "═════════════════════════════════════════"
if [ "$FAILED" -gt 0 ]; then echo -e "Failures:$ERRORS" >&2; exit 1; fi
exit 0
