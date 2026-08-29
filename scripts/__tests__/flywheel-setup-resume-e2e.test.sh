#!/bin/bash
# FLY-648 QA: full-chain resume + idempotency, driven through the REAL 10
# steps (not the generic fake alpha/beta/gamma steps flywheel-setup-engine.test
# uses to exercise the step-engine in isolation). The engine test proves the
# framework's resume mechanics; this proves the wizard's own step_verify_*/
# step_hydrate_* implementations behave correctly when a run is genuinely
# interrupted mid-chain and resumed, and that a fully-done wizard is a total
# no-op on re-run (no re-prompting, no re-creation).
#
# Hermetic: curl/systemctl/loginctl/apt-get/dnf/sudo/brew stubbed on PATH; no
# network, no real ~/.flywheel. Needs the built teamlead dist (real-loader
# gate) — CI runs pnpm build first.
#
# Covers:
#   R1  a genuine mid-chain failure (bad Linear key) stops EXACTLY at the
#       linear step; steps 1-5 (preflight/skeleton/model_key/bots/channels)
#       are done, nothing beyond
#   R2  fixing the failure and re-running the SAME state dir: steps 1-5 are
#       skipped (not re-prompted — bot/channel evidence byte-identical across
#       the resume), linear actually re-runs, and all 10 steps land done
#   R3  the hydrated Discord values from run 1 flow correctly into the
#       config step's projects.json (not re-collected), and it passes the
#       REAL validator
#   R4  idempotency: re-running a fully-done wizard with ZERO answer env vars
#       set is a clean no-op (would fail loud if it tried to re-ask anything)
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="${REPO_ROOT}/scripts/flywheel-setup.sh"
VALIDATOR="${REPO_ROOT}/packages/teamlead/dist/bin/validate-projects.js"
[ -f "$VALIDATOR" ] || { echo "ERROR: built validator missing — pnpm -C packages/teamlead build"; exit 1; }

SANDBOX="$(mktemp -d -t fly648-resume-e2e-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
PH="$SANDBOX/home"; mkdir -p "$PH"
SD="$SANDBOX/stubstate"; mkdir -p "$SD"
STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
for b in systemctl loginctl apt-get dnf sudo brew; do
  cat > "$STUB_BIN/$b" <<EOF
#!/bin/bash
exit 0
EOF
  chmod +x "$STUB_BIN/$b"
done

# curl stub: the Linear viewer check only succeeds once $SD/linear-ok exists —
# this is how run 1 is made to fail exactly at the linear step.
cat > "$STUB_BIN/curl" <<'EOF'
#!/bin/bash
[ -t 0 ] || cat >/dev/null
url=""; method="GET"; body=""; prev=""
for a in "$@"; do
  case "$prev" in -X) method="$a" ;; -d) body="$a" ;; esac
  case "$a" in http://*|https://*) url="$a" ;; esac
  prev="$a"
done
chan_full='[{"id":"C-cos","name":"cos-chat","type":0},{"id":"C-eng","name":"eng-chat","type":0},{"id":"C-gen","name":"general","type":0}]'
case "$method $url" in
  "GET "*discord.com*/guilds/*/channels) printf '%s\n200' "$chan_full" ;;
  "GET "*discord.com*/channels/*/messages*) printf '[{"id":"M1","author":{"id":"900000000000000001","bot":false}}]\n200' ;;
  "POST "*discord.com*/channels/*/messages) printf '{"id":"PROBE1"}\n200' ;;
  "DELETE "*discord.com*/channels/*/messages/*) printf '\n204' ;;
  "GET "*discord.com*/users/@me/guilds) printf '[{"id":"G1","name":"Test"}]\n200' ;;
  "GET "*discord.com*/users/@me) printf '{"id":"stub-bot-id","username":"stub"}\n200' ;;
  "GET "*discord.com*/users/*) printf '{"id":"stub-user"}\n200' ;;
  "POST "*api.linear.app*)
    case "$body" in
      *viewer*organization*)
        if [ -f "${FLY648_SD:?}/linear-ok" ]; then
          printf '{"data":{"viewer":{"id":"u1"},"organization":{"urlKey":"fake-workspace"}}}\n200'
        else
          printf '{"errors":[{"message":"Authentication failed - invalid token"}]}\n401'
        fi ;;
      *teamCreate*) touch "$FLY648_SD/team-exists"; printf '{"data":{"teamCreate":{"success":true,"team":{"id":"T1","key":"QAT","name":"qa-resume"}}}}\n200' ;;
      *issueLabelCreate*) printf '{"data":{"issueLabelCreate":{"success":true,"issueLabel":{"id":"LBL1","name":"Qa-resume"}}}}\n200' ;;
      *projectCreate*) printf '{"data":{"projectCreate":{"success":true,"project":{"id":"P1","name":"qa-resume"}}}}\n200' ;;
      *teams*nodes*)
        if [ -f "${FLY648_SD:?}/team-exists" ]; then printf '{"data":{"teams":{"nodes":[{"id":"T1","key":"QAT","name":"qa-resume"}]}}}\n200'
        else printf '{"data":{"teams":{"nodes":[]}}}\n200'; fi ;;
      *issueLabels*) printf '{"data":{"issueLabels":{"nodes":[]}}}\n200' ;;
      *projects*) printf '{"data":{"projects":{"nodes":[]}}}\n200' ;;
      *) printf '{"data":{}}\n200' ;;
    esac ;;
  *) printf '{}\n200' ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN/curl"

COMMON_ENV=(
  FLYWHEEL_PLATFORM=linux
  FLY648_SD="$SD"
  FLYWHEEL_SETUP_HEALTH_TRIES=1 FLYWHEEL_SETUP_HEALTH_SLEEP=0
  FLYWHEEL_SETUP_ANSWER_MODEL_AUTH_MODE=login
  FLYWHEEL_SETUP_ANSWER_CLAUDE_LOGIN_CONFIRMED=y
  FLYWHEEL_SETUP_ANSWER_BOT_APP_ID_COS=111111111111111111
  FLYWHEEL_SETUP_ANSWER_BOT_TOKEN_COS=fake-cos-token-value
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_COS=y
  FLYWHEEL_SETUP_ANSWER_BOT_APP_ID_ENG=222222222222222222
  FLYWHEEL_SETUP_ANSWER_BOT_TOKEN_ENG=fake-eng-token-value
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_ENG=y
  FLYWHEEL_SETUP_ANSWER_FOUNDER_USER_ID=100000000000000009
  FLYWHEEL_SETUP_ANSWER_LINEAR_API_KEY_INPUT=lin_api_fakekey_bad
)

# ── R1: run 1 — bad Linear key stops exactly at the linear step ──
OUT1="$(env -i HOME="$PH" USER="tester" PATH="$STUB_BIN:$PATH" "${COMMON_ENV[@]}" \
  bash "$SETUP" --project qa-resume --cos-persona Cass --eng-persona Tad --linear-team QAT </dev/null 2>&1)"
RC1=$?
FW="$PH/.flywheel"
DONE1="$(jq -r '.steps | to_entries[] | select(.value.status=="done") | .key' "$FW/setup-state.json" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
if [ "$RC1" -ne 0 ] && [ "$DONE1" = "preflight skeleton model_key bots channels" ]; then
  pass "R1 mid-chain failure (bad Linear key) stops exactly at linear; steps 1-5 done, nothing beyond"
else
  fail "R1 rc=$RC1 done='$DONE1' out: $(tail -5 <<<"$OUT1")"
fi

BOTS_EV_BEFORE="$(jq -c '.steps.bots.evidence' "$FW/setup-state.json" 2>/dev/null)"
CHAN_EV_BEFORE="$(jq -c '.steps.channels.evidence' "$FW/setup-state.json" 2>/dev/null)"

# ── R2/R3: fix the key, resume the SAME state dir ──
touch "$SD/linear-ok"
OUT2="$(env -i HOME="$PH" USER="tester" PATH="$STUB_BIN:$PATH" "${COMMON_ENV[@]}" \
  bash "$SETUP" --project qa-resume --cos-persona Cass --eng-persona Tad --linear-team QAT </dev/null 2>&1)"
RC2=$?
DONE2="$(jq -r '.steps | to_entries[] | select(.value.status=="done") | .key' "$FW/setup-state.json" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
BOTS_EV_AFTER="$(jq -c '.steps.bots.evidence' "$FW/setup-state.json" 2>/dev/null)"
CHAN_EV_AFTER="$(jq -c '.steps.channels.evidence' "$FW/setup-state.json" 2>/dev/null)"

if [ "$RC2" -eq 0 ] \
   && grep -q "step 'preflight': done — skipping" <<<"$OUT2" \
   && grep -q "step 'bots': done — skipping" <<<"$OUT2" \
   && grep -q "step 'channels': done — skipping" <<<"$OUT2" \
   && ! grep -q "step 'linear': done — skipping" <<<"$OUT2" \
   && [ "$BOTS_EV_BEFORE" = "$BOTS_EV_AFTER" ] && [ "$CHAN_EV_BEFORE" = "$CHAN_EV_AFTER" ] \
   && [ "$DONE2" = "preflight skeleton model_key bots channels linear config services finish digest" ]; then
  pass "R2 resume: steps 1-5 skipped untouched (bot/channel evidence unchanged), linear re-runs, all 10 land done"
else
  fail "R2 rc=$RC2 done='$DONE2' botsChanged=$([ "$BOTS_EV_BEFORE" != "$BOTS_EV_AFTER" ] && echo yes || echo no)"
fi

PJ="$FW/projects.json"
if [ -f "$PJ" ] && [ "$(jq -r '.[0].generalChannel' "$PJ" 2>/dev/null)" = "C-gen" ] \
   && node "$VALIDATOR" "$PJ" >/dev/null 2>&1; then
  pass "R3 hydrated Discord values from run 1 land in projects.json + pass the REAL validator"
else
  fail "R3 pj=$(jq -c '.[0] | {generalChannel}' "$PJ" 2>/dev/null)"
fi

# ── R4: idempotency — a THIRD run with ZERO answer env vars is a clean no-op ──
OUT3="$(env -i HOME="$PH" USER="tester" PATH="$STUB_BIN:$PATH" \
  FLYWHEEL_PLATFORM=linux FLYWHEEL_SETUP_HEALTH_TRIES=1 FLYWHEEL_SETUP_HEALTH_SLEEP=0 \
  bash "$SETUP" --project qa-resume --cos-persona Cass --eng-persona Tad --linear-team QAT </dev/null 2>&1)"
RC3=$?
SKIPPED="$(grep -c "done — skipping" <<<"$OUT3")"
if [ "$RC3" -eq 0 ] && [ "$SKIPPED" -eq 10 ]; then
  pass "R4 idempotent re-run (zero answer env vars) is a total no-op — would fail loud if it re-asked anything"
else
  fail "R4 rc=$RC3 skipped=$SKIPPED out: $(tail -5 <<<"$OUT3")"
fi

echo ""
echo "flywheel-setup-resume-e2e.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
