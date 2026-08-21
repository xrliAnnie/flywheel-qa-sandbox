#!/usr/bin/env bash
# FLY-1929: contract suite for scripts/flywheel-voucher-watch.sh.
#
# The watcher keeps NO cross-tick state — the alert signature IS the state, and
# lead-alert.sh's claims.db dedupes it. So the fake lead-alert.sh here MUST
# mirror that permanent receipt: an event id already sent returns sent/0 and
# posts nothing. A forgetful fake would claim exactly-once behaviour the real
# system does not have.
#
# Injection uses VOUCHER_WATCH_* — not FLYWHEEL_* (governed by the flag
# registry) and not VOUCHER_GUARD_* (the unrelated production root daemon).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WATCH="$REPO_ROOT/scripts/flywheel-voucher-watch.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1" >&2; [ -n "${2:-}" ] && printf '       %s\n' "$2" >&2; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }

[ -x "$WATCH" ] || { printf 'FAIL: watcher missing/not executable: %s\n' "$WATCH" >&2; exit 1; }

SANDBOX="$(mktemp -d)"; trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin"

cat > "$SANDBOX/bin/zprint" <<'EOF'
#!/usr/bin/env bash
conf="${ZPRINT_CONF:?}"
# shellcheck disable=SC1090
. "$conf"
if [ "${ZP_MALFORMED:-0}" = "1" ]; then
  echo "bank_task                    160          0K          0K          0           0     NOPE     0K      0"; exit 0
fi
if [ "${ZP_MISSING_ROW:-0}" = "1" ]; then
  echo "ipc.ports                    144          0K          0K          0           0      107779     0K      0"; exit 0
fi
cat <<ROWS
ipc.vouchers                  64          0K          0K          0           0       ${ZP_VOUCH}     0K      0
bank_task                    160          0K          0K          0           0       ${ZP_BANK_TASK}     0K      0
bank_account                 112          0K          0K          0           0       ${ZP_BANK_ACCT}     0K      0
ROWS
EOF
chmod +x "$SANDBOX/bin/zprint"

cat > "$SANDBOX/bin/lead-alert.sh" <<'EOF'
#!/usr/bin/env bash
sig=""; kind=""; sev=""
while [ $# -gt 0 ]; do
  case "$1" in
    --signature) sig="$2"; shift 2;; --kind) kind="$2"; shift 2;;
    --severity) sev="$2"; shift 2;; --strict-delivery) shift;; *) shift;;
  esac
done
[ "${ALERT_HANG:-0}" = "1" ] && sleep 120
receipts="${ALERT_RECEIPTS:?}"; posts="${ALERT_POSTS:?}"
case "${ALERT_FORCE_RESULT:-}" in
  queued_transient) echo queued_transient; exit 2;;
  dead_lettered)    echo dead_lettered;    exit 2;;
  config_error1)    echo config_error;     exit 1;;
  duplicate)        echo duplicate;        exit 0;;
  empty)            exit 0;;
esac
eid="${kind}|${sig}"
# Mirror the REAL permanent receipt: an already-sent id -> sent/0, no new post.
if grep -qxF "$eid" "$receipts" 2>/dev/null; then echo sent; exit 0; fi
printf '%s\n' "$eid" >> "$receipts"
printf '%s\t%s\t%s\n' "$sev" "$kind" "$sig" >> "$posts"
echo sent; exit 0
EOF
chmod +x "$SANDBOX/bin/lead-alert.sh"

printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$1" >> "${META_LOG:?}"\nexit 0\n' > "$SANDBOX/bin/meta-alert.sh"
chmod +x "$SANDBOX/bin/meta-alert.sh"

new_case() {
  CASE_DIR="$SANDBOX/case_$1"
  rm -rf "$CASE_DIR"; mkdir -p "$CASE_DIR/panics" "$CASE_DIR/logs"
  : > "$CASE_DIR/receipts"; : > "$CASE_DIR/posts"; : > "$CASE_DIR/meta"
  ZPRINT_CONF="$CASE_DIR/zprint.conf"
  GUARD_PLIST="$CASE_DIR/guard.plist"; : > "$GUARD_PLIST"
  # A label that cannot exist, so the launchd probe never sees the REAL
  # com.annie.voucher-guard daemon on this host and mask the fixture.
  GUARD_LABEL="com.flywheel.test.absent-$$"
  DAY=20260820
  set_quiet
  unset ALERT_FORCE_RESULT MATCHER_OVERRIDE
}
set_counts(){ printf 'ZP_BANK_TASK=%s\nZP_BANK_ACCT=%s\nZP_VOUCH=%s\n' "$1" "$2" "$3" > "$ZPRINT_CONF"; }
set_zp_flag(){ printf '%s\n' "$1=1" >> "$ZPRINT_CONF"; }
# warn >= 260000, severe >= 350000. A healthy production cycle peaks near 204k.
set_quiet()   { set_counts 1125 264 300; }
set_healthy() { set_counts 204349 203400 203000; }
set_warn()    { set_counts 265000 264000 264000; }
set_severe()  { set_counts 360000 359000 359000; }

run_watch() {
  ZPRINT_CONF="$ZPRINT_CONF" ALERT_RECEIPTS="$CASE_DIR/receipts" ALERT_POSTS="$CASE_DIR/posts" \
  META_LOG="$CASE_DIR/meta" ALERT_FORCE_RESULT="${ALERT_FORCE_RESULT:-}" ALERT_HANG="${ALERT_HANG:-0}" \
  VOUCHER_WATCH_LOG="$CASE_DIR/logs/w.ndjson" VOUCHER_WATCH_ZPRINT="$SANDBOX/bin/zprint" \
  VOUCHER_WATCH_ALERT_BIN="$SANDBOX/bin/lead-alert.sh" \
  VOUCHER_WATCH_META_ALERT_BIN="$SANDBOX/bin/meta-alert.sh" \
  VOUCHER_WATCH_PANIC_DIR="$CASE_DIR/panics" VOUCHER_WATCH_NOW="${VOUCHER_WATCH_NOW:-1787000060}" \
  VOUCHER_WATCH_DAY="$DAY" VOUCHER_WATCH_SEED_BASENAME="${SEED_BASENAME:-none.panic}" \
  VOUCHER_WATCH_GUARD_PLIST="$GUARD_PLIST" VOUCHER_WATCH_GUARD_LABEL="$GUARD_LABEL" \
  VOUCHER_WATCH_MATCHER="${MATCHER_OVERRIDE:-$REPO_ROOT/scripts/lib/voucher-panic-match.py}" \
  VOUCHER_WATCH_COOLDOWN_DIR="$CASE_DIR/cooldown" \
  VOUCHER_WATCH_ROTATION_OFFSET="${ROT_OFFSET:-0}" \
  "$WATCH" "${1:-tick}" ${2:+"$2"}
}
posts_count(){ awk 'END{print NR+0}' "$CASE_DIR/posts" 2>/dev/null || echo 0; }
posts_sev(){ awk -F'\t' -v s="$1" '$1==s{n++} END{print n+0}' "$CASE_DIR/posts" 2>/dev/null || echo 0; }
posts_sig(){ awk -F'\t' -v s="$1" '$3==s{n++} END{print n+0}' "$CASE_DIR/posts" 2>/dev/null || echo 0; }

VP='{"bug_type":"210"}
{ "panicString" : "panic(cpu 3 caller 0x1): Cannot grow ipc space beyond IVAC_ENTRIES_MAX. Some process is leaking vouchers @ipc_voucher.c:573\nDebugger message: panic\n" }'
OP='{"bug_type":"210"}
{ "panicString" : "panic(cpu 1 caller 0x2): something entirely unrelated\n" }'
DECOY='{"bug_type":"210"}
{ "otherField" : "Cannot grow ipc space beyond IVAC_ENTRIES_MAX",
  "panicString" : "panic: unrelated reason\n" }'

echo "== A. occupancy thresholds vs the healthy production cycle =="

new_case a0
set_healthy; run_watch >/dev/null 2>&1; run_watch >/dev/null 2>&1; run_watch >/dev/null 2>&1
check "A0 a healthy 204k cycle never pages (anti-spam: the whole point)" "$(posts_count)" "0"

new_case a1
set_warn; run_watch >/dev/null 2>&1
check "A1 above the warn threshold pages warning" "$(posts_sev warning)" "1"
run_watch >/dev/null 2>&1; run_watch >/dev/null 2>&1
check "A1b repeat ticks the same day page ONCE (claims.db dedup, not our state)" "$(posts_sev warning)" "1"

new_case a2
set_severe; run_watch >/dev/null 2>&1
check "A2 above the severe threshold pages severe" "$(posts_sev severe)" "1"
check "A2b and does not also page warning" "$(posts_sev warning)" "0"

new_case a3
set_warn; run_watch >/dev/null 2>&1
set_severe; run_watch >/dev/null 2>&1
check "A3 escalation warn->severe pages both (distinct signatures)" \
  "$(posts_sev warning)/$(posts_sev severe)" "1/1"

new_case a4
set_warn; run_watch >/dev/null 2>&1
DAY=20260821; run_watch >/dev/null 2>&1
check "A4 a new day re-pages a still-broken remediation (never quiet forever)" \
  "$(posts_sev warning)" "2"

echo "== B. remediation health =="

new_case b0
rm -f "$GUARD_PLIST"
set_quiet; run_watch >/dev/null 2>&1
check "B0 a missing remediation daemon pages severe even at quiet occupancy" \
  "$(posts_sig "guard-absent:20260820")" "1"
run_watch >/dev/null 2>&1; run_watch >/dev/null 2>&1
check "B0b and not once per tick" "$(posts_sig "guard-absent:20260820")" "1"

new_case b1
set_quiet; run_watch >/dev/null 2>&1
check "B1 a present remediation daemon pages nothing" "$(posts_count)" "0"

echo "== C. panic recurrence =="

new_case c1
printf '%s' "$VP" > "$CASE_DIR/panics/panic-full-2026-08-21-010101.0001.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C1 a new voucher panic pages severe" "$(posts_sev severe)" "1"
run_watch >/dev/null 2>&1; run_watch >/dev/null 2>&1
check "C1b and exactly once, forever (basename signature + permanent receipt)" "$(posts_sev severe)" "1"

new_case c2
printf '%s' "$OP" > "$CASE_DIR/panics/panic-full-2026-08-21-020202.0001.panic"
set_quiet; run_watch >/dev/null 2>&1; run_watch >/dev/null 2>&1
check "C2 a non-voucher panic never pages" "$(posts_count)" "0"

new_case c3
printf '%s' "$DECOY" > "$CASE_DIR/panics/panic-full-2026-08-21-025555.0001.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C3 the marker in a NON-panicString field must not page" "$(posts_count)" "0"

new_case c4
printf '%s' "$VP" > "$CASE_DIR/panics/panic-full-2026-08-20-070924.0002.panic"
SEED_BASENAME="panic-full-2026-08-20-070924.0002.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C4 the already-handled 2026-08-20 report stays quiet" "$(posts_count)" "0"
unset SEED_BASENAME

new_case c5
printf '%s' "$VP" > "$CASE_DIR/panics/p1.panic"
printf '%s' "$VP" > "$CASE_DIR/panics/p2.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C5 two voucher panics page once each" "$(posts_sev severe)" "2"

new_case c6
# Still being written: the JSON string is not closed, so it must NOT read as a
# match. Statelessness means the next tick simply re-reads it — there is no
# permanent misclassification to get wrong.
printf '%s' '{"bug_type":"210"}
{ "panicString" : "panic(cpu 3 caller 0x1): Cannot grow ipc space bey' > "$CASE_DIR/panics/partial.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C6 a truncated in-progress report does not page" "$(posts_count)" "0"
printf '%s' "$VP" > "$CASE_DIR/panics/partial.panic"
run_watch >/dev/null 2>&1
check "C6b once fully written the SAME file pages (no permanent misclassification)" \
  "$(posts_sev severe)" "1"

new_case c7
set_quiet; set_zp_flag ZP_MALFORMED
printf '%s' "$VP" > "$CASE_DIR/panics/panic-full-2026-08-21-060606.0001.panic"
run_watch >/dev/null 2>&1; rc=$?
check "C7 a BROKEN sampler still pages the panic (the paths are independent)" "$(posts_sev severe)" "1"
check "C7b and the sampler failure itself is loud" "$([ "$rc" -ne 0 ] && echo loud || echo silent)" "loud"

new_case c8
# 25 older, unrelated reports must not consume the per-tick budget and hide a
# newer voucher report. A lexical walk that counted every file would starve it
# FOREVER, because there is no cross-tick cursor to make progress with.
i=1
while [ "$i" -le 25 ]; do printf '%s' "$OP" > "$CASE_DIR/panics/a$(printf '%02d' $i).panic"; i=$((i + 1)); done
ln -s /dev/null "$CASE_DIR/panics/a99-link.panic"
sleep 1
printf '%s' "$VP" > "$CASE_DIR/panics/z-new-voucher.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C8 a NEW voucher report is seen despite 25 older reports + a symlink" \
  "$(posts_sev severe)" "1"

new_case c9
# "I could not tell" must never be silently equated with "not a recurrence".
printf '%s' "$VP" > "$CASE_DIR/panics/panic-full-2026-08-21-070707.0001.panic"
MATCHER_OVERRIDE="$CASE_DIR/definitely-not-here.py"
set_quiet; run_watch >/dev/null 2>&1
check "C9 a missing matcher does NOT page (cannot confirm)" "$(posts_count)" "0"
check "C9b but it is surfaced, not swallowed" \
  "$([ -s "$CASE_DIR/meta" ] && echo surfaced || echo silent)" "surfaced"
unset MATCHER_OVERRIDE

new_case c10
printf '%s' '{"note":"panicString","other":"x","panicString":"panic: Cannot grow ipc space beyond IVAC_ENTRIES_MAX"}' \
  > "$CASE_DIR/panics/reversed-decoy.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C10 a decoy BEFORE the real key must not mask it" "$(posts_sev severe)" "1"

new_case c11
# REVERSE starvation: the voucher report is OLDER than a pile of clean ones.
# C8 covers the newest-first direction; this covers the one that broke.
printf '%s' "$VP" > "$CASE_DIR/panics/old-voucher.panic"
sleep 1
i=1
while [ "$i" -le 25 ]; do printf '%s' "$OP" > "$CASE_DIR/panics/new$(printf '%02d' $i).panic"; i=$((i + 1)); done
set_quiet
# Rotation is derived from the clock, so advance it between ticks the way real
# 60s ticks would; every eligible report must be reached within a few rounds.
# 26 eligible => rest=25, step=19: two disjoint windows cover everything.
ROT_OFFSET=0  run_watch >/dev/null 2>&1
ROT_OFFSET=19 run_watch >/dev/null 2>&1
check "C11 an OLDER voucher report behind 25 newer clean ones is still found" \
  "$(posts_sev severe)" "1"

new_case c12
chmod 000 "$CASE_DIR/panics"
set_quiet; run_watch >/dev/null 2>&1; rc=$?
chmod 755 "$CASE_DIR/panics"
check "C12 an unreadable panic directory is surfaced, not read as empty" \
  "$([ -s "$CASE_DIR/meta" ] && echo surfaced || echo silent)" "surfaced"

new_case c13
printf '%s' '{"panicString":"unrelated","panicString":"panic: Cannot grow ipc space beyond IVAC_ENTRIES_MAX"}' \
  > "$CASE_DIR/panics/dupkey.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C13 duplicate top-level keys: the marker in the LAST one still pages" "$(posts_sev severe)" "1"

new_case c14
printf '%s' '{"nested":{"panicString":"panic: Cannot grow ipc space beyond IVAC_ENTRIES_MAX"},"panicString":"unrelated"}' \
  > "$CASE_DIR/panics/nested.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C14 a NESTED panicString carrying the marker must not false-page" "$(posts_count)" "0"

new_case c15
# THE REGRESSION THAT MATTERS MOST. A real panic report is ~5MB: panicString sits
# near byte 442, but its enclosing object does not close for megabytes. An
# earlier fix decoded whole objects and therefore returned "undetermined" on the
# genuine 2026-08-20 report — a real recurrence would NOT have paged. This
# fixture reproduces that shape (real header bytes + a deliberately huge
# unterminated body).
cp "$REPO_ROOT/scripts/__tests__/fixtures/fly1929-real-shape-panic.txt" \
   "$CASE_DIR/panics/real-shape.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C15 a REAL-shaped multi-MB report with a truncated body still pages" \
  "$(posts_sev severe)" "1"

new_case c16
# Rotation FAIRNESS, not merely "rotation happens". 40 eligible reports, so the
# claimed bound is ceil((40-1)/(20-1)) = 3 ticks; with disjoint stepping tick 2
# covers rest-indices 19..37. The voucher report is placed at rest-index 37 (the
# 39th newest), which the CORRECT stepping reaches on tick 2 but a +1-per-tick
# rotation does not — so this case actually discriminates between them.
# mtimes are set explicitly: relying on creation order made the ordering fuzzy.
i=1
while [ "$i" -le 40 ]; do
  f="$CASE_DIR/panics/r$(printf '%02d' $i).panic"
  if [ "$i" -eq 39 ]; then printf '%s' "$VP" > "$f"; else printf '%s' "$OP" > "$f"; fi
  # newest first => r01 newest. Give r01 the latest mtime, r40 the earliest.
  touch -t "202608$(printf '%02d' $(( 20 - (i / 24) )))$(printf '%02d%02d' $(( 23 - (i % 24) )) $(( 59 - (i % 60) )))" "$f"
  i=$((i + 1))
done
set_quiet
ROT_OFFSET=0  run_watch >/dev/null 2>&1
check "C16 tick 1 (window 0..18) has not yet reached rest-index 37" "$(posts_sev severe)" "0"
ROT_OFFSET=19 run_watch >/dev/null 2>&1
check "C16b the next disjoint window (19..37) reaches it" \
  "$(posts_sev severe)" "1"

new_case c17
printf '{"panicString":"\xff\xfe undecodable"}' > "$CASE_DIR/panics/badutf8.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C17 undecodable bytes are UNKNOWN, not a clean non-match" \
  "$([ -s "$CASE_DIR/meta" ] && echo surfaced || echo silent)" "surfaced"

new_case c18
# When claims.db is unusable lead-alert.sh FAILS OPEN to a direct POST, so a
# per-minute producer would post the same alert every 60s for the whole outage.
# The local cooldown bounds that. (The fake never dedupes here, standing in for
# a broken claims.db.)
set_warn
ALERT_FORCE_RESULT=""
rm -f "$CASE_DIR/receipts"; : > "$CASE_DIR/receipts"
run_watch >/dev/null 2>&1
: > "$CASE_DIR/receipts"   # simulate the DB losing the receipt each time
run_watch >/dev/null 2>&1
: > "$CASE_DIR/receipts"
run_watch >/dev/null 2>&1
check "C18 a broken dedup store cannot make it post every tick" "$(posts_sev warning)" "1"

new_case c19
# Distinct signatures must never share a cooldown slot: squashing punctuation to
# "_" made different alerts collide onto one filename, so one alert's cooldown
# would silence a DIFFERENT alert.
set_warn; run_watch >/dev/null 2>&1              # bank-task-high:warn:<day>
rm -f "$GUARD_PLIST"                              # guard-absent:<day>
run_watch >/dev/null 2>&1
check "C19 a warn cooldown does not suppress the guard-absent alert" \
  "$(posts_sig "guard-absent:20260820")" "1"
check "C19b two distinct signatures keep two distinct stamps" \
  "$(ls "$CASE_DIR/cooldown" 2>/dev/null | wc -l | tr -d ' ')" "2"

new_case c20
mkdir -p "$CASE_DIR/cooldown"
# A symlinked stamp must not be written through, and must not suppress either.
sig_stamp="$CASE_DIR/cooldown/$(printf '%s' 'bank-task-high:warn:20260820' | shasum -a 256 | awk '{print $1}')"
# A CANARY, not /dev/null: writing through a symlink to /dev/null is
# indistinguishable from refusing, so that version of this case proved nothing.
printf 'CANARY' > "$CASE_DIR/canary.txt"
ln -s "$CASE_DIR/canary.txt" "$sig_stamp"
set_warn; run_watch >/dev/null 2>&1; rc=$?
check "C20 a symlinked stamp is not written through (canary intact)" \
  "$(cat "$CASE_DIR/canary.txt")" "CANARY"
check "C20b and it neither suppresses the alert nor breaks the tick" \
  "$(posts_sev warning)/$rc" "1/0"

new_case c21
# The Lead's convergence condition: a document that VIOLATES the single-top-level
# -key assumption must not receive a negative verdict. It gets UNKNOWN, which
# surfaces rather than silently clearing the report.
printf '%s' '{"panicString":"one unrelated","panicString":"another unrelated"}' \
  > "$CASE_DIR/panics/twokeys.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C21 two top-level panicStrings do not page" "$(posts_count)" "0"
check "C21b but the violated assumption is surfaced, not silently cleared" \
  "$([ -s "$CASE_DIR/meta" ] && echo surfaced || echo silent)" "surfaced"

new_case c22
# Truncated with no complete key: UNKNOWN, surfaced, and NOT a clean negative.
printf '%s' '{"bug_type":"210"}
{ "panicString" : "panic(cpu 3): Cannot grow ipc space bey' > "$CASE_DIR/panics/cut.panic"
set_quiet; run_watch >/dev/null 2>&1
check "C22 a truncated report with no complete key does not page" "$(posts_count)" "0"
check "C22b and is surfaced as undetermined" \
  "$([ -s "$CASE_DIR/meta" ] && echo surfaced || echo silent)" "surfaced"

echo "== D. fail-loud sampling =="

new_case d1
set_quiet; set_zp_flag ZP_MALFORMED
run_watch >/dev/null 2>&1; rc=$?
check "D1 non-numeric zprint fails loud" "$([ "$rc" -ne 0 ] && echo loud || echo silent)" "loud"
check "D1b and writes no sample row" "$(awk 'END{print NR+0}' "$CASE_DIR/logs/w.ndjson" 2>/dev/null || echo 0)" "0"

new_case d2
set_quiet; set_zp_flag ZP_MISSING_ROW
run_watch >/dev/null 2>&1; rc=$?
check "D2 a missing zone row fails loud (never silently 0)" "$([ "$rc" -ne 0 ] && echo loud || echo silent)" "loud"

echo "== E. delivery degradation =="

new_case e1
set_warn; ALERT_FORCE_RESULT=queued_transient
run_watch >/dev/null 2>&1
check "E1 queued_transient/2 is success, not a degradation" \
  "$([ -s "$CASE_DIR/meta" ] && echo poked || echo quiet)" "quiet"
unset ALERT_FORCE_RESULT

new_case e2
set_warn; ALERT_FORCE_RESULT=config_error1
run_watch >/dev/null 2>&1
check "E2 config_error pokes meta-alert from the watcher itself" \
  "$([ -s "$CASE_DIR/meta" ] && echo poked || echo quiet)" "poked"
unset ALERT_FORCE_RESULT

new_case e3
set_warn; ALERT_FORCE_RESULT=empty
run_watch >/dev/null 2>&1
check "E3 empty stdout is degraded, not success" \
  "$([ -s "$CASE_DIR/meta" ] && echo poked || echo quiet)" "poked"
unset ALERT_FORCE_RESULT

new_case e3b
set_warn; ALERT_FORCE_RESULT=duplicate
run_watch >/dev/null 2>&1
check "E3b duplicate/0 is NOT proof of delivery (active lease / claims-DB fail-open)" \
  "$([ -s "$CASE_DIR/meta" ] && echo surfaced || echo "treated as delivered")" "surfaced"
unset ALERT_FORCE_RESULT

new_case e4
set_warn; ALERT_HANG=1
start=$(date +%s); run_watch >/dev/null 2>&1; elapsed=$(( $(date +%s) - start ))
check "E4 a hung alert channel cannot hang the tick (bounded < 45s)" \
  "$([ "$elapsed" -lt 45 ] && echo bounded || echo "unbounded:${elapsed}s")" "bounded"
ALERT_HANG=0

echo "== F. telemetry =="

new_case f1
set_quiet; run_watch >/dev/null 2>&1
row="$(tail -1 "$CASE_DIR/logs/w.ndjson" 2>/dev/null || echo '')"
for k in bank_task bank_account ipc_vouchers envelope guard_present ead_count; do
  case "$row" in *"\"$k\""*) ok "F1 sample row carries $k";; *) bad "F1 sample row carries $k" "row=$row";; esac
done

new_case f2
set_quiet; run_watch mark "cass-attach-start" >/dev/null 2>&1
check "F2 mark appends an annotation row" \
  "$(grep -c '"kind":"mark"' "$CASE_DIR/logs/w.ndjson" 2>/dev/null | head -1)" "1"

new_case f3
set_quiet; run_watch status >/dev/null 2>&1
check "F3 status exits 0" "$?" "0"

new_case f4
ln -s /dev/null "$CASE_DIR/logs/w.ndjson"
set_quiet; run_watch >/dev/null 2>&1; rc=$?
check "F4 refuses to write telemetry through a symlink" \
  "$([ "$rc" -ne 0 ] && echo refused || echo followed)" "refused"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
