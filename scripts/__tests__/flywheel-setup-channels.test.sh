#!/bin/bash
# FLY-648 WI-D: Discord [AUTO] step — channel find-or-create (403 → guided
# fallback), per-bot read+post+delete probes, guild/channel ID capture, and
# founder-ID acquisition (paste primary / bot-reads-message fallback).
#
# Hermetic: curl stubbed on PATH; guided inputs via FLYWHEEL_SETUP_ANSWER_*.
#
# Covers:
#   D1  fresh guild → creates #cos-chat/#eng-chat/#general, probes both bots
#       (read+post+delete per channel), founder paste-path validated,
#       evidence carries channel ids, DISCORD_OWNER_USER_ID lands in .env
#   D2  channels already exist → reused, no create calls (idempotent)
#   D3  create → 403 → guided fallback (user creates manually, re-list verifies)
#   D4  probe failure → step fails (fail-closed)
#   D5  founder-ID fallback: empty paste → bot reads latest #general author
#   D6  resume hydration: with bots+channels done, a later step sees FS_* values
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="${REPO_ROOT}/scripts/flywheel-setup.sh"

SANDBOX="$(mktemp -d -t fly648-chan-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
H="$SANDBOX/home"; mkdir -p "$H"

# ── curl stub ──
# Modes (FLY648_STUB_MODE): ok | nochannels-then-create | forbidden-create |
# probe-post-403. State lives in FLY648_STUB_DIR (per-case reset).
STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
ARGV_LOG="$SANDBOX/curl-argv.log"
cat > "$STUB_BIN/curl" <<'EOF'
#!/bin/bash
echo "$*" >> "${FLY648_ARGV_LOG:?}"
cat >/dev/null   # consume stdin config; never logged
url=""; method="GET"; body=""
prev=""
for a in "$@"; do
  case "$prev" in -X) method="$a" ;; -d) body="$a" ;; esac
  case "$a" in https://*) url="$a" ;; esac
  prev="$a"
done
sd="${FLY648_STUB_DIR:?}"
mode="${FLY648_STUB_MODE:-ok}"
chan_list_full='[{"id":"C-cos","name":"cos-chat","type":0},{"id":"C-eng","name":"eng-chat","type":0},{"id":"C-gen","name":"general","type":0}]'
case "$method $url" in
  "GET "*/guilds/*/channels)
    if [ -f "$sd/channels-exist" ]; then printf '%s\n200' "$chan_list_full"
    else printf '[]\n200'; fi
    ;;
  "POST "*/guilds/*/channels)
    if [ "$mode" = "forbidden-create" ]; then printf '{"message":"Missing Permissions"}\n403'
    else
      name="$(printf '%s' "$body" | sed -nE 's/.*"name":"([^"]*)".*/\1/p')"
      touch "$sd/created-$name"
      # once all three created, the guild "has" them
      [ -f "$sd/created-cos-chat" ] && [ -f "$sd/created-eng-chat" ] && [ -f "$sd/created-general" ] && touch "$sd/channels-exist"
      printf '{"id":"C-%s","name":"%s","type":0}\n201' "${name%-chat}" "$name"
    fi
    ;;
  "GET "*/channels/*/messages*)
    printf '[{"id":"M1","author":{"id":"987654321098765432","bot":false},"content":"hi"}]\n200'
    ;;
  "POST "*/channels/*/messages)
    if [ "$mode" = "probe-post-403" ]; then printf '{"message":"Missing Access"}\n403'
    else printf '{"id":"PROBE1"}\n200'; fi
    ;;
  "DELETE "*/channels/*/messages/*)
    printf '\n204'
    ;;
  "GET "*/users/@me/guilds) printf '[{"id":"G1","name":"Test"}]\n200' ;;
  "GET "*/users/@me)        printf '{"id":"stub-bot-id","username":"stub"}\n200' ;;
  "GET "*/users/*)          printf '{"id":"stub-user","username":"founder"}\n200' ;;
  *) printf '{}\n200' ;;
esac
EOF
chmod +x "$STUB_BIN/curl"

BOT_ANSWERS=(
  FLYWHEEL_SETUP_ANSWER_BOT_APP_ID_COS=111111111111111111
  FLYWHEEL_SETUP_ANSWER_BOT_TOKEN_COS=fake-cos-token-value
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_COS=y
  FLYWHEEL_SETUP_ANSWER_BOT_APP_ID_ENG=222222222222222222
  FLYWHEEL_SETUP_ANSWER_BOT_TOKEN_ENG=fake-eng-token-value
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_ENG=y
)

# run_chain <state-dir> <stub-dir> <extra-step-or--> [env K=V...]
run_chain() {
  local sdir="$1" stubd="$2" extra="$3"; shift 3
  mkdir -p "$stubd"
  (
    export FLYWHEEL_SETUP_SOURCED=1 HOME="$H" PATH="$STUB_BIN:$PATH"
    export FLY648_ARGV_LOG="$ARGV_LOG" FLY648_STUB_DIR="$stubd"
    local kv
    for kv in "$@"; do export "${kv?}"; done
    # shellcheck source=../flywheel-setup.sh
    source "$SETUP" || exit 97
    FLYWHEEL_SETUP_STATE_DIR="$sdir"
    FS_PROJECT="husband-ecom"; FS_DEPT="engineering"
    FS_COS_PERSONA="Cass"; FS_ENG_PERSONA="Tad"
    fs_derive_identity || exit 96
    if [ "$extra" = "-" ]; then
      STEP_IDS=(bots channels)
    else
      STEP_IDS=(bots channels "$extra")
      # capture step: proves hydration gave later steps the FS_* values.
      step_run_capture() {
        {
          echo "GUILD=$FS_GUILD_ID"
          echo "COS=$FS_CHANNEL_COS"; echo "ENG=$FS_CHANNEL_ENG"; echo "GEN=$FS_CHANNEL_GENERAL"
          echo "FOUNDER=$FS_FOUNDER_ID"
        } > "$SANDBOX/captured.env"
        setup_mark_done capture '{}'
      }
    fi
    setup_main_loop
  )
}

# ── D1: fresh guild — create 3 channels + probes + paste founder id ──
S1="$SANDBOX/state1"; SD1="$SANDBOX/stub1"; mkdir -p "$S1"; : > "$ARGV_LOG"
OUT1="$(run_chain "$S1" "$SD1" - "${BOT_ANSWERS[@]}" \
  FLYWHEEL_SETUP_ANSWER_FOUNDER_USER_ID=100000000000000009 2>&1)"
D1_RC=$?
EV="$(jq -c '.steps.channels.evidence' "$S1/setup-state.json" 2>/dev/null)"
D1_OK=1
[ "$D1_RC" -eq 0 ] || D1_OK=0
[ "$(jq -r '.channels.cos' <<<"$EV" 2>/dev/null)" = "C-cos" ] || D1_OK=0
[ "$(jq -r '.channels.eng' <<<"$EV" 2>/dev/null)" = "C-eng" ] || D1_OK=0
[ "$(jq -r '.channels.general' <<<"$EV" 2>/dev/null)" = "C-gen" ] || D1_OK=0
[ "$(jq -r '.founderId' <<<"$EV" 2>/dev/null)" = "100000000000000009" ] || D1_OK=0
grep -q '^DISCORD_OWNER_USER_ID=100000000000000009$' "$S1/.env" || D1_OK=0
# probes: both bots posted + deleted their probe message
[ "$(grep -c "POST .*channels/C-cos/messages" <<<"$(grep POST "$ARGV_LOG")")" -ge 1 ] || D1_OK=0
grep -q "DELETE" "$ARGV_LOG" || D1_OK=0
if [ "$D1_OK" -eq 1 ]; then
  pass "D1 fresh guild: channels created + probes ran + founder paste-path + env"
else
  fail "D1 rc=$D1_RC ev=$EV; out: $(tail -4 <<<"$OUT1")"
fi

# ── D2: channels already exist → reuse, zero create calls ──
S2="$SANDBOX/state2"; SD2="$SANDBOX/stub2"; mkdir -p "$SD2"; touch "$SD2/channels-exist"
: > "$ARGV_LOG"
run_chain "$S2" "$SD2" - "${BOT_ANSWERS[@]}" \
  FLYWHEEL_SETUP_ANSWER_FOUNDER_USER_ID=100000000000000009 >/dev/null 2>&1
D2_RC=$?
if [ "$D2_RC" -eq 0 ] && ! grep -q "POST .*guilds/G1/channels" "$ARGV_LOG"; then
  pass "D2 existing channels reused (no create calls)"
else
  fail "D2 rc=$D2_RC creates: $(grep -c 'POST .*guilds' "$ARGV_LOG")"
fi

# ── D3: create 403 → guided fallback → user creates → re-list verifies ──
S3="$SANDBOX/state3"; SD3="$SANDBOX/stub3"; mkdir -p "$SD3"
# the "user" creates the channels during the fallback confirm: the answer hook
# can't run commands, so pre-arrange: confirm answer given AND the stub flips
# to channels-exist when the fallback confirm is re-listed. We emulate the
# user's manual creation by touching channels-exist BEFORE the run but making
# the FIRST list call return empty via a one-shot marker.
cat > "$STUB_BIN/curl-flip-note" <<'EOF'
(D3 uses mode=forbidden-create with a first-list-empty one-shot below)
EOF
# one-shot: first GET list empty, later lists full — emulate via counter
cat > "$STUB_BIN/curl" <<'EOF'
#!/bin/bash
echo "$*" >> "${FLY648_ARGV_LOG:?}"
cat >/dev/null
url=""; method="GET"; body=""
prev=""
for a in "$@"; do
  case "$prev" in -X) method="$a" ;; -d) body="$a" ;; esac
  case "$a" in https://*) url="$a" ;; esac
  prev="$a"
done
sd="${FLY648_STUB_DIR:?}"
mode="${FLY648_STUB_MODE:-ok}"
chan_list_full='[{"id":"C-cos","name":"cos-chat","type":0},{"id":"C-eng","name":"eng-chat","type":0},{"id":"C-gen","name":"general","type":0}]'
case "$method $url" in
  "GET "*/guilds/*/channels)
    if [ "$mode" = "forbidden-create" ]; then
      n=0; [ -f "$sd/list-count" ] && n="$(cat "$sd/list-count")"; echo $((n+1)) > "$sd/list-count"
      if [ "$n" -ge 1 ]; then printf '%s\n200' "$chan_list_full"; else printf '[]\n200'; fi
    elif [ -f "$sd/channels-exist" ]; then printf '%s\n200' "$chan_list_full"
    else printf '[]\n200'; fi
    ;;
  "POST "*/guilds/*/channels)
    if [ "$mode" = "forbidden-create" ]; then printf '{"message":"Missing Permissions"}\n403'
    else
      name="$(printf '%s' "$body" | sed -nE 's/.*"name":"([^"]*)".*/\1/p')"
      touch "$sd/created-$name"
      [ -f "$sd/created-cos-chat" ] && [ -f "$sd/created-eng-chat" ] && [ -f "$sd/created-general" ] && touch "$sd/channels-exist"
      printf '{"id":"C-%s","name":"%s","type":0}\n201' "${name%-chat}" "$name"
    fi
    ;;
  "GET "*/channels/*/messages*)
    printf '[{"id":"M1","author":{"id":"987654321098765432","bot":false},"content":"hi"}]\n200'
    ;;
  "POST "*/channels/*/messages)
    if [ "$mode" = "probe-post-403" ]; then printf '{"message":"Missing Access"}\n403'
    else printf '{"id":"PROBE1"}\n200'; fi
    ;;
  "DELETE "*/channels/*/messages/*) printf '\n204' ;;
  "GET "*/users/@me/guilds) printf '[{"id":"G1","name":"Test"}]\n200' ;;
  "GET "*/users/@me)        printf '{"id":"stub-bot-id","username":"stub"}\n200' ;;
  "GET "*/users/*)          printf '{"id":"stub-user","username":"founder"}\n200' ;;
  *) printf '{}\n200' ;;
esac
EOF
chmod +x "$STUB_BIN/curl"
OUT3="$(run_chain "$S3" "$SD3" - "${BOT_ANSWERS[@]}" \
  FLY648_STUB_MODE=forbidden-create \
  FLYWHEEL_SETUP_ANSWER_CHANNELS_CREATED_MANUALLY=y \
  FLYWHEEL_SETUP_ANSWER_FOUNDER_USER_ID=100000000000000009 2>&1)"
D3_RC=$?
EV3="$(jq -c '.steps.channels.evidence' "$S3/setup-state.json" 2>/dev/null)"
if [ "$D3_RC" -eq 0 ] && grep -qi "create .*channels\|manually\|yourself" <<<"$OUT3" \
   && [ "$(jq -r '.channels.cos' <<<"$EV3")" = "C-cos" ]; then
  pass "D3 403 create → guided manual-create fallback → verified by re-list"
else
  fail "D3 rc=$D3_RC ev=$EV3 out: $(grep -iE 'manual|create|403|permission' <<<"$OUT3" | head -3)"
fi

# ── D4: probe post 403 → fail-closed ──
S4="$SANDBOX/state4"; SD4="$SANDBOX/stub4"; mkdir -p "$SD4"; touch "$SD4/channels-exist"
run_chain "$S4" "$SD4" - "${BOT_ANSWERS[@]}" FLY648_STUB_MODE=probe-post-403 \
  FLYWHEEL_SETUP_ANSWER_FOUNDER_USER_ID=100000000000000009 >/dev/null 2>&1
D4_RC=$?
if [ "$D4_RC" -ne 0 ] \
   && [ "$(jq -r '.steps.channels.status // "pending"' "$S4/setup-state.json")" != "done" ]; then
  pass "D4 probe failure → step fails, stays pending"
else
  fail "D4 rc=$D4_RC"
fi

# ── D5: founder fallback — empty paste → read latest #general author ──
S5="$SANDBOX/state5"; SD5="$SANDBOX/stub5"; mkdir -p "$SD5"; touch "$SD5/channels-exist"
OUT5="$(run_chain "$S5" "$SD5" - "${BOT_ANSWERS[@]}" \
  FLYWHEEL_SETUP_ANSWER_FOUNDER_USER_ID=read \
  FLYWHEEL_SETUP_ANSWER_FOUNDER_MESSAGE_POSTED=y 2>&1)"
D5_RC=$?
FID="$(jq -r '.steps.channels.evidence.founderId' "$S5/setup-state.json" 2>/dev/null)"
if [ "$D5_RC" -eq 0 ] && [ "$FID" = "987654321098765432" ] \
   && grep -q '^DISCORD_OWNER_USER_ID=987654321098765432$' "$S5/.env"; then
  pass "D5 founder fallback: bot reads the latest #general message author"
else
  fail "D5 rc=$D5_RC founderId=$FID out: $(tail -3 <<<"$OUT5")"
fi

# ── D6: resume hydration — done bots+channels feed FS_* to a later step ──
rm -f "$SANDBOX/captured.env"
run_chain "$S1" "$SD1" capture "${BOT_ANSWERS[@]}" \
  FLYWHEEL_SETUP_ANSWER_FOUNDER_USER_ID=100000000000000009 >/dev/null 2>&1
D6_RC=$?
if [ "$D6_RC" -eq 0 ] && grep -q '^GUILD=G1$' "$SANDBOX/captured.env" 2>/dev/null \
   && grep -q '^COS=C-cos$' "$SANDBOX/captured.env" \
   && grep -q '^GEN=C-gen$' "$SANDBOX/captured.env" \
   && grep -q '^FOUNDER=100000000000000009$' "$SANDBOX/captured.env"; then
  pass "D6 resume hydration: skipped-done steps rehydrate FS_* from evidence"
else
  fail "D6 rc=$D6_RC captured: $(cat "$SANDBOX/captured.env" 2>/dev/null)"
fi

echo ""
echo "flywheel-setup-channels.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
