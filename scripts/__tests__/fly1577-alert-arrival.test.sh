#!/bin/bash
# FLY-1577 acceptance 6 + 7: does the alert actually ARRIVE, and does an
# unreachable receiver fail observably?
#
# Why this file exists, in one incident: FLY-742 shipped a "never-silent guard"
# whose stated property was "a skipped job must surface immediately, not be
# discovered days later". Its guard fired 16 times between 07-14 and 07-29 —
# every single time. All 16 died between `messages` and `lead_inbox`: read_at
# non-null on 0 of them, 0 reached lead_inbox. Seventeen days, nobody knew.
# FLY-742's acceptance passed, because it verified that the guard FIRES. It
# never verified that anyone RECEIVES.
#
# The rest of this branch's suites have the same shape of hole: they point
# FLYWHEEL_CONVERGE_ALERT_BIN at a stub and assert converge invoked it with the
# right arguments. That proves the shout, not the hearing.
#
# So here the alert source is real (a real converge run over real drift), the
# alerter is the real scripts/lead-alert.sh, and the assertions are on its
# RECEIPTS — the durable delivery row and the bytes that actually left over the
# wire — not on "it was called" or "it exited 0". FLY-742's 16 losses all
# exited 0 too.
#
# Lead's rule, applied literally below: an acceptance that can pass while the
# receiver does not exist is not an acceptance. D0 proves the receiver is live
# before anything is asserted about arrival, and D4 proves the arrival
# assertion itself fails when nothing was delivered.
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; shift; [ $# -gt 0 ] && echo "        $*"; return 0; }

REAL_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RSB="$(mktemp -d "${TESTS_DIR}/.tmp-fly1577arr-XXXXXX")"
SB="$(mktemp -d -t fly1577-arrival-XXXXXX)"
cleanup() { chmod -R u+w "$RSB" "$SB" 2>/dev/null; rm -rf "$RSB" "$SB"; }
trap cleanup EXIT

for tool in jq sqlite3 shasum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[SKIP] $tool unavailable — arrival suite needs it"; exit 0; }
done

pad() { local i=1; while [ "$i" -le 60 ]; do echo "$1 line $i padding text >/dev/null"; i=$((i+1)); done; }

# ── trusted fake repo carrying the REAL alerter ─────────────────────────────
FR="$RSB/repo"; mkdir -p "$FR/scripts/lib" "$FR/.git"
for f in lib/script-sanity.sh lib/path-hygiene.sh lib/bounded-run.sh \
         meta-alert.sh lead-alert.sh lead-patrol-snapshot.sh \
         converge-flywheel-bin.sh; do
  cp "$REAL_REPO_ROOT/scripts/$f" "$FR/scripts/$f"
done
chmod 0755 "$FR/scripts/meta-alert.sh" "$FR/scripts/lead-alert.sh" \
  "$FR/scripts/lead-patrol-snapshot.sh"
for f in flywheel-lead-wrapper-v2.sh flywheel-lead-attach.sh \
         flywheel-view-attach.sh flywheel-node-status.sh \
         flywheel-bridge-wrapper.sh restart-services.sh; do
  { echo '#!/bin/bash'; pad "echo r-$f"; } > "$FR/scripts/$f"
done
{ echo '#!/bin/bash'; pad 'echo r-lead-address'; } > "$FR/scripts/lib/lead-address.sh"
{ echo '#!/usr/bin/env python3'; echo 'import sys'; pad "print('g')  #"; echo 'sys.exit(0)'; } \
  > "$FR/scripts/restart-storm-gate.py"

# ── the receiver stand-in ────────────────────────────────────────────────────
# lead-alert.sh POSTs to a hard-coded discord.com URL, so the wire is shimmed
# rather than redirected. The shim is a RECORDER: it captures the exact bytes
# that left (URL + payload) and returns the HTTP status the case is testing.
# Capturing the payload is the point — "curl was executed" would be another
# FLY-742-shaped assertion.
SHIM="$SB/shim"; mkdir -p "$SHIM"
cat > "$SHIM/curl" <<'EOF'
#!/bin/bash
# A VALIDATING stand-in, not an argv recorder. An endpoint that returns 204 to
# any request whatsoever cannot distinguish "delivered" from "posted to the
# wrong channel with no credentials" — and mis-routing is precisely the FLY-742
# loss shape. So the request has to be well-formed before any success is
# reported; a malformed one is rejected as 400, which is a receiver saying no,
# not a transport failure.
out=""; url=""; body=""; method=""; ctype=""; reads_stdin_cfg=0
# A real option parser, not a "look at the previous token" heuristic. Without
# consuming an option's ARGUMENT, a value that happens to read `-K` becomes an
# option again on the next pass: `-w -K -` makes curl treat -K as the -w format
# (and then fail on the bare `-`), while the heuristic saw a config flag and
# blessed credentials curl never loaded.
expect=""; opts_ended=0
for a in "$@"; do
  if [ -n "$expect" ]; then
    case "$expect" in
      -o) out="$a" ;;
      -d) body="$a" ;;
      -X) method="$a" ;;
      -H) case "$a" in Content-Type:*) ctype="$a" ;; esac ;;
      -K) [ "$a" = "-" ] && reads_stdin_cfg=1 ;;
    esac
    expect=""; continue          # consumed exactly once, never re-read as an option
  fi
  if [ "$opts_ended" = "0" ] && [ "$a" = "--" ]; then opts_ended=1; continue; fi
  if [ "$opts_ended" = "0" ]; then
    case "$a" in
      -o|-d|-X|-H|-K|-w|--max-time) expect="$a"; continue ;;
    esac
  fi
  case "$a" in https://*) url="$a" ;; esac
done

# Read the config ONLY if curl was actually told to. Slurping stdin regardless
# would validate a heredoc that real curl never loads: drop `-K -` from
# production and the request goes out unauthenticated while this shim still
# sees the credentials sitting unread on the pipe.
stdin_cfg=""
[ "$reads_stdin_cfg" = "1" ] && stdin_cfg="$(cat 2>/dev/null || true)" || cat >/dev/null 2>&1 || true
{ echo "URL=$url"
  echo "RENDERED=$(printf '%s' "$body" | jq -r '.content // ""' 2>/dev/null | tr '\n\r' '  ')"
  echo "METHOD=$method"
  echo "CTYPE=$ctype"
  printf 'AUTH=%s\n' "$(printf '%s' "$stdin_cfg" | tr '\n\r' '  ')"
  printf 'BODY=%s\n' "$(printf '%s' "$body" | tr '\n\r' '  ')"
} >> "${RECEIVER_LOG:?}"

reject() { [ -n "$out" ] && printf '{"message":"%s"}' "$1" > "$out"; printf '400'; exit 0; }
# EXACT comparisons, not substring. `X-Authorization: Bot <tok>` CONTAINS
# `Authorization: Bot <tok>`, so a substring test happily blesses a header real
# Discord would not authenticate on — the acceptance would go green in exactly
# the state where the receiver rejects. Same for a `xapplication/json` content
# type or a token with trailing junk.
[ "$url" = "https://discord.com/api/v10/channels/${EXPECT_CHANNEL:?}/messages" ] || reject "wrong-endpoint"
[ "$method" = "POST" ] || reject "wrong-method"
[ "$ctype" = "Content-Type: application/json" ] || reject "wrong-content-type"
[ "$reads_stdin_cfg" = "1" ] || reject "no-config-source"
printf '%s\n' "$stdin_cfg" | grep -qxF "header = \"Authorization: Bot ${EXPECT_TOKEN:?}\"" || reject "unauthenticated"
printf '%s' "$body" | jq -e . >/dev/null 2>&1 || reject "body-not-json"
# Discord renders `.content` and nothing else. Payload bytes that leave the wire
# with the alert tucked into some other key are delivered to the API and
# invisible to the human — the precise distinction this whole issue is about.
printf '%s' "$body" | jq -e '(.content|type=="string") and (.content|length>0)' >/dev/null 2>&1 \
  || reject "no-renderable-content"
printf '%s' "$body" | jq -r '.content' > "${RECEIVER_CONTENT:-/dev/null}"

# Only a fully well-formed request earns this line. Cases assert on VALID
# rather than re-deriving validity with their own loose greps — re-checking the
# same thing the same wrong way is how the first version stayed green.
echo "VALID=1" >> "${RECEIVER_LOG:?}"
[ -n "$out" ] && printf '%s' "${RECEIVER_RESP:-{\}}" > "$out"
printf '%s' "${RECEIVER_HTTP:-204}"
# Real curl signals a failed connection BOTH ways: it prints 000 via
# -w '%{http_code}' AND exits non-zero (7 on connection-refused). A shim that
# printed 000 while exiting 0 is what hid the production `000000` concatenation
# bug from this very acceptance case.
[ "${RECEIVER_HTTP:-204}" = "000" ] && exit 7
exit 0
EOF
chmod +x "$SHIM/curl"

FIXHOME="$SB/home"; mkdir -p "$FIXHOME/.flywheel"
CLAIMS="$SB/claims.db"; QUEUE="$SB/queue"; DEADL="$SB/deadletter"
CHANNEL_ID="424242424242424242"; SENDER_TOKEN="fake-token-for-test"
# meta-alert's desktop channel must never touch the real machine during a test.
cat > "$SHIM/osascript" <<'EOF'
#!/bin/bash
echo "OSA $*" >> "${OSA_LOG:?}"
exit 0
EOF
chmod +x "$SHIM/osascript"

reset_receiver() {
  rm -rf "$CLAIMS" "$QUEUE" "$DEADL" "$SB/receiver.log" "$SB/osa.log"
  mkdir -p "$QUEUE" "$DEADL"
  : > "$SB/receiver.log"; : > "$SB/osa.log"
}

run_converge() {  # <state-dir> [extra env...] → rc; converge uses the REAL lead-alert.sh
  local st="$1"; shift
  env HOME="$FIXHOME" PATH="$SHIM:$PATH" \
    FLYWHEEL_STATE_DIR="$st" \
    FLYWHEEL_CLAIMS_DB="$CLAIMS" \
    FLYWHEEL_ALERT_QUEUE_DIR="$QUEUE" \
    FLYWHEEL_ALERT_DEADLETTER_DIR="$DEADL" \
    FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="$CHANNEL_ID" \
    FLYWHEEL_ALERT_SENDER_TOKEN_ENV="FLY1577_SENDER_TOKEN" \
    FLY1577_SENDER_TOKEN="$SENDER_TOKEN" \
    FLYWHEEL_CONVERGE_PROD_STATE=1 \
    RECEIVER_LOG="$SB/receiver.log" OSA_LOG="$SB/osa.log" \
    EXPECT_CHANNEL="$CHANNEL_ID" EXPECT_TOKEN="$SENDER_TOKEN" \
    "$@" \
    bash "$FR/scripts/converge-flywheel-bin.sh" >"$SB/out.log" 2>&1
}

seed_state() {  # <state-dir> — converged copy lane + healthy meta link
  local st="$1" f
  rm -rf "$st"; mkdir -p "$st/bin/lib"
  for f in flywheel-lead-wrapper-v2.sh flywheel-lead-attach.sh \
           flywheel-view-attach.sh flywheel-node-status.sh \
           flywheel-bridge-wrapper.sh restart-services.sh restart-storm-gate.py \
           lib/bounded-run.sh lib/lead-address.sh; do
    cp "$FR/scripts/$f" "$st/bin/$f"; chmod 555 "$st/bin/$f"
  done
  ln -sfn "$FR/scripts/meta-alert.sh" "$st/bin/meta-alert.sh"
  ln -sfn "$FR/scripts/lead-patrol-snapshot.sh" "$st/bin/flywheel-patrol-snapshot"
}

deliveries_in_state() {  # <state> → count
  [ -f "$CLAIMS" ] || { echo 0; return; }
  sqlite3 "$CLAIMS" "SELECT COUNT(*) FROM alert_deliveries WHERE state='$1';" 2>/dev/null || echo 0
}

# record_ok <dir> — exactly one record, and it carries THIS alert's identity.
# "some .json exists" would accept an empty {}: a queue entry that cannot be
# replayed is not durable retry, and an empty dead-letter is not an audit.
record_ok() {  # <dir> <receipt-state> <expected queueReason>
  local dir="$1" state="$2" reason="$3" f n rid eid
  n=$(ls "$dir"/*.json 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" = "1" ] || { echo "        (expected exactly 1 record in $dir, found $n)"; return 1; }
  f=$(ls "$dir"/*.json 2>/dev/null | head -1)
  # The drain re-posts this object, so every field LeadAlertNotifier requires
  # has to be present and non-empty — a parseable file that cannot be replayed
  # is not durable retry, and one that does not describe THIS alert is not an
  # audit of it.
  jq -e --arg r "$reason" '
      (.leadId|type=="string" and length>0)
      and (.projectName|type=="string" and length>0)
      and (.eventId|type=="string" and length>0)
      and (.eventType=="bin_integrity_drift")
      and (.severity|type=="string" and length>0)
      and (.queuedAt|type=="string" and length>0)
      and (.queueReason==$r)
      and (.title|test("bin integrity drift"))
      and (.body|test("restart-storm-gate.py"))
  ' "$f" >/dev/null 2>&1 || { echo "        (record is not a replayable record of this alert: $(head -c 240 "$f"))"; return 1; }
  # And it must be the SAME event the receipt is about. Two artifacts that each
  # look fine but refer to different events is not one durable outcome.
  eid=$(jq -r '.eventId' "$f")
  rid=$(sqlite3 "$CLAIMS" "SELECT event_id FROM alert_deliveries WHERE state='$state';" 2>/dev/null)
  [ -n "$rid" ] && [ "$eid" = "$rid" ] \
    || { echo "        (record eventId '$eid' does not match the '$state' receipt '$rid')"; return 1; }
  return 0
}

# assert_arrived <needle> — the ONLY definition of arrival used below:
#   1. a durable delivery receipt says 'sent', and
#   2. the bytes that actually left carry this alert's own content.
# Deliberately NOT: "the alerter ran", "it exited 0". FLY-742's 16 losses
# satisfied both of those.
assert_arrived() {
  local needle="$1"
  [ "$(deliveries_in_state sent)" -ge 1 ] || return 1
  # RENDERED is `.content` — the only field Discord shows a human. Matching raw
  # payload bytes would accept an alert hidden in a key nobody renders.
  grep -q "RENDERED=.*${needle}" "$SB/receiver.log" 2>/dev/null || return 1
  return 0
}

# ── D0: is the receiver even there? (Lead's invalidity rule, as a precondition)
reset_receiver
ST="$SB/state-d0"; seed_state "$ST"
D0_OK=1
[ -x "$SHIM/curl" ] || { D0_OK=0; fail "D0: the receiver recorder is not executable"; }
[ -s "$SB/receiver.log" ] && { D0_OK=0; fail "D0: receiver log dirty before any alert"; }
[ "$(deliveries_in_state sent)" -eq 0 ] || { D0_OK=0; fail "D0: delivery receipts present before any alert"; }
# Prove the receiver actually ACCEPTS a well-formed request. The earlier version
# sent a probe to channel `1` with no auth and a non-JSON body — the shim bailed
# out before validating anything, and D0 passed by grepping the BODY line the
# shim had already written. That is a positive control that never demonstrated
# the positive: it proved the recorder writes, not that the receiver accepts.
D0_CODE=$(env RECEIVER_LOG="$SB/receiver.log" RECEIVER_HTTP=204 \
  EXPECT_CHANNEL="$CHANNEL_ID" EXPECT_TOKEN="$SENDER_TOKEN" PATH="$SHIM:$PATH" \
  curl -s -o /dev/null -w '%{http_code}' \
    -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/messages" \
    -H "Content-Type: application/json" \
    -d '{"content":"PROBE-D0"}' \
    -K - <<CURLCFG
header = "Authorization: Bot $SENDER_TOKEN"
CURLCFG
); D0_RC=$?
[ "$D0_RC" -eq 0 ] || { D0_OK=0; fail "D0: the probe request failed (rc=$D0_RC)"; }
[ "$D0_CODE" = "204" ] || { D0_OK=0; fail "D0: receiver did not accept a well-formed request (got $D0_CODE)"; }
grep -q "BODY=.*PROBE-D0" "$SB/receiver.log" || { D0_OK=0; fail "D0: recorder did not record a known probe — the ruler is broken"; }
[ "$(grep -c '^VALID=1' "$SB/receiver.log")" -eq 1 ] \
  || { D0_OK=0; fail "D0: the probe never passed the receiver's validation — positive control is hollow"; }
: > "$SB/receiver.log"
[ "$D0_OK" = "1" ] && pass "D0 (positive control): receiver exists, starts empty, and provably records"

# ── D1 / acceptance 6: real drift → real lead-alert.sh → arrival at the receiver
reset_receiver
ST="$SB/state-d1"; seed_state "$ST"
chmod u+w "$ST/bin/restart-storm-gate.py"; rm -f "$ST/bin/restart-storm-gate.py"
RECEIVER_HTTP=204 run_converge "$ST"; RC=$?
D1_OK=1
[ "$RC" -eq 0 ] || { D1_OK=0; fail "D1: converge rc=$RC"; }
assert_arrived "restart-storm-gate.py" \
  || { D1_OK=0; fail "D1: the drift alert never arrived (sent-receipts=$(deliveries_in_state sent), wire=$(wc -l < "$SB/receiver.log" | tr -d ' ') lines)"; }
grep -q "RENDERED=.*bin integrity drift repaired" "$SB/receiver.log" \
  || { D1_OK=0; fail "D1: the human-visible message is not this alert"; }
[ "$(grep -c '^URL=' "$SB/receiver.log")" -eq 1 ] \
  || { D1_OK=0; fail "D1: expected exactly one request on the wire, got $(grep -c '^URL=' "$SB/receiver.log")"; }
[ "$(deliveries_in_state sent)" -eq 1 ] \
  || { D1_OK=0; fail "D1: expected exactly one 'sent' receipt"; }
[ "$(grep -c '^VALID=1' "$SB/receiver.log")" -eq 1 ] \
  || { D1_OK=0; fail "D1: the receiver never validated this request (wrong endpoint / credentials / content-type) — it would have been rejected in production"; }
[ "$D1_OK" = "1" ] && pass "D1 (acceptance 6): real converge drift → real lead-alert.sh → delivered, with a durable 'sent' receipt"

# ── D2 / acceptance 7a: receiver unreachable (network) → must NOT be silent
reset_receiver
ST="$SB/state-d2"; seed_state "$ST"
chmod u+w "$ST/bin/restart-storm-gate.py"; rm -f "$ST/bin/restart-storm-gate.py"
RECEIVER_HTTP=000 run_converge "$ST"
D2_OK=1
[ "$(deliveries_in_state sent)" -eq 0 ] || { D2_OK=0; fail "D2: recorded a 'sent' receipt for a delivery that never landed"; }
[ "$(deliveries_in_state queued)" -ge 1 ] \
  || { D2_OK=0; fail "D2: unreachable receiver left no durable trace (queued receipts=$(deliveries_in_state queued))"; }
record_ok "$QUEUE" queued "discord-000" || { D2_OK=0; fail "D2: the queued record is not a replayable alert"; }
grep -q "Discord POST failed" "$SB/out.log" \
  || { D2_OK=0; fail "D2: the failure was not even logged"; }
[ "$(grep -c '^VALID=1' "$SB/receiver.log")" -eq 1 ] \
  || { D2_OK=0; fail "D2: the request was malformed, so this measures a bad request rather than an unreachable receiver"; }
grep -q "HTTP=000" "$SB/out.log" \
  || { D2_OK=0; fail "D2: the transport failure was not classified as 000 (this is the 000000 bug's signature)"; }
[ "$(deliveries_in_state queued)" -eq 1 ] || { D2_OK=0; fail "D2: expected exactly one queued receipt"; }
[ "$D2_OK" = "1" ] && pass "D2 (acceptance 7): unreachable receiver → queued + receipt says 'queued', never silently 'sent'"

# ── D3 / acceptance 7b: permanently rejected → dead-letter + an INDEPENDENT
# channel. A 401 is not retryable, so the only thing standing between this and
# another 17 silent days is the Discord-independent meta-alert escape. Assert
# the escape actually produced its marker — the second channel exists precisely
# because the first one is the thing that failed.
reset_receiver
ST="$SB/state-d3"; seed_state "$ST"
chmod u+w "$ST/bin/restart-storm-gate.py"; rm -f "$ST/bin/restart-storm-gate.py"
RECEIVER_HTTP=401 run_converge "$ST"
D3_OK=1
[ "$(deliveries_in_state sent)" -eq 0 ] || { D3_OK=0; fail "D3: recorded 'sent' for a rejected delivery"; }
[ "$(deliveries_in_state dead_lettered)" -eq 1 ] \
  || { D3_OK=0; fail "D3: expected exactly one dead-letter receipt"; }
[ "$(grep -c '^VALID=1' "$SB/receiver.log")" -eq 1 ] \
  || { D3_OK=0; fail "D3: the request was malformed, so this measures a bad request rather than a 401 rejection"; }
grep -q "HTTP=401" "$SB/out.log" \
  || { D3_OK=0; fail "D3: the outcome was not actually a 401 rejection"; }
record_ok "$DEADL" dead_lettered "discord-401" || { D3_OK=0; fail "D3: the dead-letter record is not an audit of this alert"; }
# The whole point of dead-lettering a PERMANENT rejection is that Discord — the
# channel that just refused — cannot be the one to tell anyone. Assert the
# Discord-INDEPENDENT escape actually produced its marker; without this, D3
# would pass while the only notice of a permanently undeliverable alert is a
# row in a database nobody reads.
D3_MARK="$(ls "$ST"/meta-alert/*.txt 2>/dev/null | head -1)"
if [ -n "$D3_MARK" ]; then
  grep -q "dead" "$D3_MARK" 2>/dev/null \
    || { D3_OK=0; fail "D3: meta-alert marker exists but does not describe the dead-letter"; }
else
  D3_OK=0; fail "D3: the Discord-independent escape left no marker — a permanent loss nobody is told about"
fi
[ "$D3_OK" = "1" ] && pass "D3 (acceptance 7): permanent rejection → dead-lettered + audited, never silently 'sent'"

# ── D4: the invalidity rule, turned on this file's own assertion ─────────────
# "An acceptance that can pass while the receiver does not exist is not an
# acceptance." So run the exact arrival assertion against a fixture where
# nothing was ever delivered. It MUST fail. If it passes here, every green
# above is worthless.
# Both halves of the definition must be load-bearing. An empty fixture fails on
# whichever clause is evaluated first, so it cannot show that BOTH are required
# — satisfy each one alone and require the assertion to still refuse.
reset_receiver
if assert_arrived "restart-storm-gate.py"; then
  fail "D4a: assert_arrived() passes with an empty receiver — every arrival assertion here is void"
else
  pass "D4a (self-check): arrival fails when nothing was delivered at all"
fi

# receipt WITHOUT wire bytes — a database row is not delivery
reset_receiver
sqlite3 "$CLAIMS" "CREATE TABLE IF NOT EXISTS alert_deliveries (event_id TEXT PRIMARY KEY, state TEXT, lease_token TEXT, lease_until INTEGER, attempt_count INTEGER, updated_at INTEGER, last_error TEXT);
INSERT INTO alert_deliveries VALUES ('fake','sent',NULL,NULL,1,0,NULL);" 2>/dev/null
if assert_arrived "restart-storm-gate.py"; then
  fail "D4b: a 'sent' receipt with nothing on the wire counted as arrival — the receipt clause is doing all the work"
else
  pass "D4b (self-check): a receipt alone is not arrival"
fi

# wire bytes WITHOUT a receipt — bytes leaving is not a durable delivery
reset_receiver
printf 'RENDERED=bin integrity drift repaired: restart-storm-gate.py\n' > "$SB/receiver.log"
if assert_arrived "restart-storm-gate.py"; then
  fail "D4c: wire bytes with no durable receipt counted as arrival — the wire clause is doing all the work"
else
  pass "D4c (self-check): wire bytes alone are not arrival"
fi

echo ""; echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
