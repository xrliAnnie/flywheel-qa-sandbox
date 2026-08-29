#!/bin/bash
# FLY-648 WI-C: bot-provisioning seam — C1 own-portal / C2 pool-invite, the
# BotProvisionResult convergence contract, and the single-point permissions
# constant (incl MANAGE_CHANNELS).
#
# Hermetic: curl is stubbed on PATH (canned Discord API responses; records
# argv so we can assert tokens NEVER appear there — they travel via the
# curl config on stdin). Guided inputs are injected via
# FLYWHEEL_SETUP_ANSWER_* (the engine's automation seam).
#
# Covers:
#   C1  c1 (default): two bots complete → BotProvisionResult shape per lead,
#       tokens land in .env (0600), guild captured, journal evidence secret-free,
#       token absent from curl argv
#   C2  c2: two pool invite-urls printed + honest semi-managed annotation +
#       same result shape
#   C3  path selection: FLYWHEEL_SETUP_BOT_PATH / default c1
#   C4  invalid token (401) → step fails (fail-closed, resumable)
#   C5  the two bots resolving different guilds → fail
#   C6  permissions constant contains MANAGE_CHANNELS and lands in invite urls
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="${REPO_ROOT}/scripts/flywheel-setup.sh"

SANDBOX="$(mktemp -d -t fly648-bot-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
H="$SANDBOX/home"; mkdir -p "$H"

# ── curl stub: canned Discord responses; records argv + never the stdin config ──
STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
ARGV_LOG="$SANDBOX/curl-argv.log"
GUILD_SEQ="$SANDBOX/guild-seq"
cat > "$STUB_BIN/curl" <<'EOF'
#!/bin/bash
echo "$*" >> "${FLY648_ARGV_LOG:?}"
cfg="$(cat)"   # consume the stdin curl config (Authorization header) — never logged
tok="$(printf '%s' "$cfg" | sed -nE 's/.*Authorization: Bot ([^"]*).*/\1/p')"
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
mode="${FLY648_STUB_MODE:-ok}"
case "$url" in
  */users/@me/guilds)
    if [ "$mode" = "guildmismatch" ]; then
      n=0; [ -f "${FLY648_GUILD_SEQ:?}" ] && n="$(cat "$FLY648_GUILD_SEQ")"
      echo $((n+1)) > "$FLY648_GUILD_SEQ"
      if [ "$n" -ge 1 ]; then printf '[{"id":"G2","name":"Other"}]\n200'; else printf '[{"id":"G1","name":"Test"}]\n200'; fi
    else
      printf '[{"id":"G1","name":"Test"}]\n200'
    fi
    ;;
  */users/@me)
    # never reflect the token back — the test asserts it stays out of the journal
    if [ "$mode" = "badauth" ]; then printf '{"message":"401: Unauthorized"}\n401'
    elif [ -z "$tok" ]; then printf '{"message":"401: no token"}\n401'
    else printf '{"id":"stub-bot-id","username":"stub"}\n200'; fi
    ;;
  *) printf '{}\n200' ;;
esac
EOF
chmod +x "$STUB_BIN/curl"

# run_bots <state-dir> [env K=V...] — subshell: source, set identity, run the
# bots step via the engine (single-step STEP_IDS).
run_bots() {
  local sdir="$1"; shift
  (
    export FLYWHEEL_SETUP_SOURCED=1 HOME="$H" PATH="$STUB_BIN:$PATH"
    export FLY648_ARGV_LOG="$ARGV_LOG" FLY648_GUILD_SEQ="$GUILD_SEQ"
    local kv
    for kv in "$@"; do export "${kv?}"; done
    # shellcheck source=../flywheel-setup.sh
    source "$SETUP" || exit 97
    FLYWHEEL_SETUP_STATE_DIR="$sdir"
    FS_PROJECT="husband-ecom"; FS_DEPT="engineering"
    FS_COS_PERSONA="Cass"; FS_ENG_PERSONA="Tad"
    fs_derive_identity || exit 96
    STEP_IDS=(bots)
    setup_main_loop
  )
}

C1_ANSWERS=(
  FLYWHEEL_SETUP_ANSWER_BOT_APP_ID_COS=111111111111111111
  FLYWHEEL_SETUP_ANSWER_BOT_TOKEN_COS=fake-cos-token-value
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_COS=y
  FLYWHEEL_SETUP_ANSWER_BOT_APP_ID_ENG=222222222222222222
  FLYWHEEL_SETUP_ANSWER_BOT_TOKEN_ENG=fake-eng-token-value
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_ENG=y
)

# ── C1: default c1 path completes for both bots ──
S1="$SANDBOX/state1"; mkdir -p "$S1"; : > "$ARGV_LOG"
OUT1="$(run_bots "$S1" "${C1_ANSWERS[@]}" 2>&1)"
C1_RC=$?
ST="$S1/setup-state.json"
EV="$(jq -c '.steps.bots.evidence' "$ST" 2>/dev/null)"
C1_OK=1
[ "$C1_RC" -eq 0 ] || C1_OK=0
[ "$(jq -r '.results | length' <<<"$EV" 2>/dev/null)" = "2" ] || C1_OK=0
[ "$(jq -r '.results[0].leadId' <<<"$EV" 2>/dev/null)" = "cos-lead" ] || C1_OK=0
[ "$(jq -r '.results[0].tokenEnvName' <<<"$EV" 2>/dev/null)" = "CASS_BOT_TOKEN" ] || C1_OK=0
[ "$(jq -r '.results[1].leadId' <<<"$EV" 2>/dev/null)" = "tad-eng-lead" ] || C1_OK=0
[ "$(jq -r '.guildId' <<<"$EV" 2>/dev/null)" = "G1" ] || C1_OK=0
grep -q '^CASS_BOT_TOKEN=fake-cos-token-value$' "$S1/.env" 2>/dev/null || C1_OK=0
grep -q '^TAD_BOT_TOKEN=fake-eng-token-value$' "$S1/.env" 2>/dev/null || C1_OK=0
grep -q '^DISCORD_GUILD_ID=G1$' "$S1/.env" 2>/dev/null || C1_OK=0
if [ "$C1_OK" -eq 1 ]; then
  pass "C1 c1 path: 2 BotProvisionResults + tokens/guild in .env"
else
  fail "C1 rc=$C1_RC ev=$EV env=$(cat "$S1/.env" 2>/dev/null); out: $(tail -5 <<<"$OUT1")"
fi

# ── C1b: secrets hygiene — token in NEITHER journal NOR curl argv; .env 0600 ──
PERMS="$(stat -c '%a' "$S1/.env" 2>/dev/null || stat -f '%Lp' "$S1/.env" 2>/dev/null)"
if ! grep -q "fake-cos-token-value" "$ST" \
   && ! grep -q "fake-cos-token-value" "$ARGV_LOG" \
   && [ "$PERMS" = "600" ]; then
  pass "C1b token absent from journal + curl argv; .env 0600"
else
  fail "C1b perms=$PERMS journal-hit=$(grep -c fake-cos-token-value "$ST"); argv-hit=$(grep -c fake-cos-token-value "$ARGV_LOG")"
fi

# ── C2: c2 pool path — invite urls + honest annotation + same shape ──
S2="$SANDBOX/state2"; mkdir -p "$S2"; : > "$ARGV_LOG"
OUT2="$(run_bots "$S2" FLYWHEEL_SETUP_BOT_PATH=c2 \
  FLYWHEEL_SETUP_ANSWER_POOL_APP_ID_COS=333333333333333333 \
  FLYWHEEL_SETUP_ANSWER_POOL_APP_ID_ENG=444444444444444444 \
  FLYWHEEL_SETUP_ANSWER_POOL_TOKEN_COS=fake-pool-cos-token \
  FLYWHEEL_SETUP_ANSWER_POOL_TOKEN_ENG=fake-pool-eng-token \
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_COS=y \
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_ENG=y 2>&1)"
C2_RC=$?
EV2="$(jq -c '.steps.bots.evidence' "$S2/setup-state.json" 2>/dev/null)"
C2_OK=1
[ "$C2_RC" -eq 0 ] || C2_OK=0
grep -q "client_id=333333333333333333" <<<"$OUT2" || C2_OK=0
grep -q "client_id=444444444444444444" <<<"$OUT2" || C2_OK=0
grep -qi "semi-managed\|半托管" <<<"$OUT2" || C2_OK=0
[ "$(jq -r '.results | length' <<<"$EV2" 2>/dev/null)" = "2" ] || C2_OK=0
[ "$(jq -r '.path' <<<"$EV2" 2>/dev/null)" = "c2" ] || C2_OK=0
if [ "$C2_OK" -eq 1 ]; then
  pass "C2 c2 path: pool invite urls + honest annotation + same result shape"
else
  fail "C2 rc=$C2_RC ev=$EV2 out: $(grep -E 'client_id|托管|managed' <<<"$OUT2" | head -4)"
fi

# ── C3: default path is c1 (evidence records it) ──
if [ "$(jq -r '.steps.bots.evidence.path' "$ST")" = "c1" ]; then
  pass "C3 default bot path is c1 (Annie anchor); c2 via FLYWHEEL_SETUP_BOT_PATH"
else
  fail "C3 default path: $(jq -r '.steps.bots.evidence.path' "$ST")"
fi

# ── C4: invalid token (401) → step fails, resumable (fail-closed) ──
S4="$SANDBOX/state4"; mkdir -p "$S4"
run_bots "$S4" FLY648_STUB_MODE=badauth "${C1_ANSWERS[@]}" >/dev/null 2>&1
C4_RC=$?
if [ "$C4_RC" -ne 0 ] && [ "$(jq -r '.steps.bots.status // "pending"' "$S4/setup-state.json")" != "done" ]; then
  pass "C4 401 token validation → step fails, journal keeps it pending"
else
  fail "C4 rc=$C4_RC status=$(jq -r '.steps.bots.status' "$S4/setup-state.json" 2>/dev/null)"
fi

# ── C5: the two bots resolving different guilds → fail ──
S5="$SANDBOX/state5"; mkdir -p "$S5"; rm -f "$GUILD_SEQ"
OUT5="$(run_bots "$S5" FLY648_STUB_MODE=guildmismatch "${C1_ANSWERS[@]}" 2>&1)"
C5_RC=$?
if [ "$C5_RC" -ne 0 ] && grep -qi "guild" <<<"$OUT5"; then
  pass "C5 guild mismatch between the two bots → fail-closed"
else
  fail "C5 rc=$C5_RC out: $(tail -3 <<<"$OUT5")"
fi

# ── C6: permissions constant single point, includes MANAGE_CHANNELS, in urls ──
PERM_OUT="$(
  export FLYWHEEL_SETUP_SOURCED=1 HOME="$H"
  source "$SETUP" >/dev/null 2>&1 || exit 97
  echo "$FS_BOT_PERMISSIONS"
  fs_bot_invite_url 555
)"
PERM_VAL="$(head -1 <<<"$PERM_OUT")"
URL_VAL="$(tail -1 <<<"$PERM_OUT")"
MANAGE_CHANNELS=16
if [ -n "$PERM_VAL" ] && [ $(( PERM_VAL & MANAGE_CHANNELS )) -eq "$MANAGE_CHANNELS" ] \
   && grep -q "permissions=$PERM_VAL" <<<"$URL_VAL" && grep -q "client_id=555" <<<"$URL_VAL"; then
  pass "C6 permissions constant includes MANAGE_CHANNELS + lands in invite urls"
else
  fail "C6 perm=$PERM_VAL url=$URL_VAL"
fi

echo ""
echo "flywheel-setup-bot.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
