#!/bin/bash
# FLY-648 WI-H: POC — the FULL wizard chain on the hermetic Linux APPLY path
# (primary evidence), plus target-state isolation assertions (R1#7) and the
# live-fleet negative case, plus a darwin dry-run of the generated artifact
# (secondary byte-compat evidence).
#
# Hermetic: env -i with a fixture HOME; curl/systemctl/loginctl/apt-get/sudo
# stubbed; FLYWHEEL_SYSTEMD_USER_DIR redirects unit rendering; every guided
# input answered via FLYWHEEL_SETUP_ANSWER_*. Needs the built teamlead dist
# (real-loader gate) — CI runs pnpm build first.
#
# Covers:
#   H1  full 10-step run exits 0, journal all-done
#   H2  projects.json landed at the state root + REAL validator passes it
#   H3  both lead manifests materialized (cos-lead contract, projectDir ==
#       skeleton dir, dir exists)
#   H4  systemd units rendered + supervisor_install called (bridge + 2 leads)
#   H5  .env at state root only (0600) with every required key
#   H6  isolation: nothing landed in the OUTER real ~/.flywheel
#   H7  negative: a foreign live fleet in the state root → wizard refuses,
#       writes nothing
#   H8  darwin dry-run of the generated artifact: full plan, exit 0
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="${REPO_ROOT}/scripts/flywheel-setup.sh"
PROVISION="${REPO_ROOT}/scripts/provision-fleet-host.sh"
VALIDATOR="${REPO_ROOT}/packages/teamlead/dist/bin/validate-projects.js"
[ -f "$VALIDATOR" ] || { echo "ERROR: built validator missing — pnpm -C packages/teamlead build"; exit 1; }

REAL_FW="$HOME/.flywheel"   # outer real home — H6 asserts we never touch it
SANDBOX="$(mktemp -d -t fly648-poc-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
PH="$SANDBOX/home"; mkdir -p "$PH"
UNIT_DIR="$SANDBOX/systemd-user"
CALLS="$SANDBOX/stub-calls.log"

# ── stubs: system verbs + Discord/Linear/Bridge network ──
STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
for b in systemctl loginctl apt-get dnf sudo brew; do
  cat > "$STUB_BIN/$b" <<EOF
#!/bin/bash
echo "$b \$*" >> "$CALLS"
exit 0
EOF
  chmod +x "$STUB_BIN/$b"
done
SD="$SANDBOX/stubstate"; mkdir -p "$SD"
cat > "$STUB_BIN/curl" <<'EOF'
#!/bin/bash
echo "curl $*" >> "${FLY648_CALLS:?}"
[ -t 0 ] || cat >/dev/null
url=""; method="GET"; body=""; prev=""
for a in "$@"; do
  case "$prev" in -X) method="$a" ;; -d) body="$a" ;; esac
  case "$a" in http://*|https://*) url="$a" ;; esac
  prev="$a"
done
sd="${FLY648_SD:?}"
chan_full='[{"id":"C-cos","name":"cos-chat","type":0},{"id":"C-eng","name":"eng-chat","type":0},{"id":"C-gen","name":"general","type":0}]'
case "$method $url" in
  "GET "*discord.com*/guilds/*/channels)
    if [ -f "$sd/channels-exist" ]; then printf '%s\n200' "$chan_full"; else printf '[]\n200'; fi ;;
  "POST "*discord.com*/guilds/*/channels)
    name="$(printf '%s' "$body" | sed -nE 's/.*"name":"([^"]*)".*/\1/p')"
    touch "$sd/created-$name"
    [ -f "$sd/created-cos-chat" ] && [ -f "$sd/created-eng-chat" ] && [ -f "$sd/created-general" ] && touch "$sd/channels-exist"
    printf '{"id":"C-%s","name":"%s","type":0}\n201' "${name%-chat}" "$name" ;;
  "GET "*discord.com*/channels/*/messages*) printf '[{"id":"M1","author":{"id":"900000000000000001","bot":false}}]\n200' ;;
  "POST "*discord.com*/channels/*/messages) printf '{"id":"PROBE1"}\n200' ;;
  "DELETE "*discord.com*/channels/*/messages/*) printf '\n204' ;;
  "GET "*discord.com*/users/@me/guilds) printf '[{"id":"G1","name":"Test"}]\n200' ;;
  "GET "*discord.com*/users/@me) printf '{"id":"stub-bot-id","username":"stub"}\n200' ;;
  "GET "*discord.com*/users/*) printf '{"id":"stub-user"}\n200' ;;
  "POST "*api.linear.app*)
    case "$body" in
      *viewer*organization*) printf '{"data":{"viewer":{"id":"u1"},"organization":{"urlKey":"fake-workspace"}}}\n200' ;;
      *teamCreate*) touch "$sd/team-exists"; printf '{"data":{"teamCreate":{"success":true,"team":{"id":"T1","key":"HUS","name":"husband-ecom"}}}}\n200' ;;
      *issueLabelCreate*) printf '{"data":{"issueLabelCreate":{"success":true,"issueLabel":{"id":"LBL1","name":"Husband-ecom"}}}}\n200' ;;
      *projectCreate*) printf '{"data":{"projectCreate":{"success":true,"project":{"id":"P1","name":"husband-ecom"}}}}\n200' ;;
      *teams*nodes*)
        if [ -f "$sd/team-exists" ]; then printf '{"data":{"teams":{"nodes":[{"id":"T1","key":"HUS","name":"husband-ecom"}]}}}\n200'
        else printf '{"data":{"teams":{"nodes":[]}}}\n200'; fi ;;
      *issueLabels*) printf '{"data":{"issueLabels":{"nodes":[]}}}\n200' ;;
      *projects*) printf '{"data":{"projects":{"nodes":[]}}}\n200' ;;
      *) printf '{"data":{}}\n200' ;;
    esac ;;
  *) printf '{}\n200' ;;   # bridge health etc.
esac
exit 0
EOF
chmod +x "$STUB_BIN/curl"

REAL_MARKER="$REAL_FW/setup-state.json"
REAL_FLEET_MARKER="$REAL_FW/setup-fleet"
PRE_REAL_STATE=0; [ -e "$REAL_MARKER" ] || [ -e "$REAL_FLEET_MARKER" ] && PRE_REAL_STATE=1

# ── H1: full 10-step run ──
OUT1="$(env -i HOME="$PH" USER="tester" PATH="$STUB_BIN:$PATH" \
  FLYWHEEL_PLATFORM=linux FLYWHEEL_SYSTEMD_USER_DIR="$UNIT_DIR" \
  FLY648_CALLS="$CALLS" FLY648_SD="$SD" \
  FLYWHEEL_SETUP_HEALTH_TRIES=1 FLYWHEEL_SETUP_HEALTH_SLEEP=0 \
  FLYWHEEL_SETUP_ANSWER_MODEL_AUTH_MODE=login \
  FLYWHEEL_SETUP_ANSWER_CLAUDE_LOGIN_CONFIRMED=y \
  FLYWHEEL_SETUP_ANSWER_BOT_APP_ID_COS=111111111111111111 \
  FLYWHEEL_SETUP_ANSWER_BOT_TOKEN_COS=fake-cos-token-value \
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_COS=y \
  FLYWHEEL_SETUP_ANSWER_BOT_APP_ID_ENG=222222222222222222 \
  FLYWHEEL_SETUP_ANSWER_BOT_TOKEN_ENG=fake-eng-token-value \
  FLYWHEEL_SETUP_ANSWER_BOT_INVITED_ENG=y \
  FLYWHEEL_SETUP_ANSWER_FOUNDER_USER_ID=100000000000000009 \
  FLYWHEEL_SETUP_ANSWER_LINEAR_API_KEY_INPUT=lin_api_fakekey123 \
  bash "$SETUP" --project husband-ecom --cos-persona Cass --eng-persona Tad \
    --linear-team HUS 2>&1)"
H1_RC=$?
FW="$PH/.flywheel"
N_DONE="$(jq '[.steps[] | select(.status=="done")] | length' "$FW/setup-state.json" 2>/dev/null)"
if [ "$H1_RC" -eq 0 ] && [ "${N_DONE:-0}" -eq 10 ]; then
  pass "H1 full 10-step wizard run exits 0, journal all-done"
else
  fail "H1 rc=$H1_RC done=$N_DONE; out: $(tail -8 <<<"$OUT1")"
fi

# ── H2: projects.json landed + real validator passes ──
if [ -f "$FW/projects.json" ] && node "$VALIDATOR" "$FW/projects.json" >/dev/null 2>&1 \
   && [ "$(jq -r '.[0].leads[0].agentId' "$FW/projects.json")" = "cos-lead" ] \
   && [ "$(jq -r '.[0].generalChannel' "$FW/projects.json")" = "C-gen" ]; then
  pass "H2 landed projects.json passes the REAL loader (cos-lead + collected IDs)"
else
  fail "H2 pj: $(jq -c '.[0] | {generalChannel, leads: [.leads[].agentId]}' "$FW/projects.json" 2>/dev/null)"
fi

# ── H3: manifests materialized with the cos-lead contract ──
COS_MAN="$FW/manifests/husband-ecom-cos-lead.json"
ENG_MAN="$FW/manifests/husband-ecom-tad-eng-lead.json"
if [ -f "$COS_MAN" ] && [ -f "$ENG_MAN" ] \
   && [ "$(jq -r '.leadId' "$COS_MAN")" = "cos-lead" ] \
   && [ "$(jq -r '.projectDir' "$COS_MAN")" = "$PH/Dev/husband-ecom" ] \
   && [ -d "$PH/Dev/husband-ecom" ] \
   && [ -f "$PH/Dev/husband-ecom/.lead/cos-lead/identity.md" ]; then
  pass "H3 manifests: leadId==cos-lead, projectDir==skeleton dir (exists, identity aligned)"
else
  fail "H3 manifests: $(ls "$FW/manifests" 2>/dev/null)"
fi

# ── H4: systemd units rendered + supervisor_install fired ──
if [ -f "$UNIT_DIR/flywheel-bridge.service" ] \
   && [ -f "$UNIT_DIR/flywheel-lead-husband-ecom-cos-lead.service" ] \
   && [ -f "$UNIT_DIR/flywheel-lead-husband-ecom-tad-eng-lead.service" ] \
   && grep -q "enable --now flywheel-lead-husband-ecom-cos-lead.service" "$CALLS" \
   && grep -q "enable-linger" "$CALLS"; then
  pass "H4 units rendered + supervisor_install (bridge + both leads + linger)"
else
  fail "H4 units=$(ls "$UNIT_DIR" 2>/dev/null) calls=$(grep -E 'enable' "$CALLS" | head -3)"
fi

# ── H5: .env at state root only, 0600, all required keys ──
PERMS="$(stat -c '%a' "$FW/.env" 2>/dev/null || stat -f '%Lp' "$FW/.env" 2>/dev/null)"
H5_OK=1
[ "$PERMS" = "600" ] || H5_OK=0
for k in CASS_BOT_TOKEN TAD_BOT_TOKEN LINEAR_API_KEY DISCORD_GUILD_ID DISCORD_OWNER_USER_ID LINEAR_WORKSPACE_SLUG; do
  grep -Eq "^$k=.+" "$FW/.env" || H5_OK=0
done
[ -e "$FW/setup-fleet/.env" ] && H5_OK=0
grep -q "fake-cos-token-value" "$FW/setup-state.json" && H5_OK=0
if [ "$H5_OK" -eq 1 ]; then
  pass "H5 .env 0600 at state root with all required keys; journal secret-free"
else
  fail "H5 perms=$PERMS keys: $(grep -Eo '^[A-Z_]+' "$FW/.env" 2>/dev/null | tr '\n' ' ')"
fi

# ── H6: isolation — the OUTER real ~/.flywheel untouched (R1#7) ──
POST_REAL_STATE=0; { [ -e "$REAL_MARKER" ] || [ -e "$REAL_FLEET_MARKER" ]; } && POST_REAL_STATE=1
if [ "$POST_REAL_STATE" -eq "$PRE_REAL_STATE" ]; then
  pass "H6 isolation: no setup artifacts appeared in the real ~/.flywheel"
else
  fail "H6 real-home leak: $(ls "$REAL_MARKER" "$REAL_FLEET_MARKER" 2>/dev/null)"
fi

# ── H7: negative — foreign live fleet → refuse, write nothing ──
PH7="$SANDBOX/home7"; mkdir -p "$PH7/.flywheel"
cat > "$PH7/.flywheel/projects.json" <<'EOF'
[ { "projectName": "foreign", "projectRoot": "Dev/foreign",
    "leads": [ { "agentId": "foreign-lead", "chatChannel": "1", "match": { "labels": ["Foreign"] } } ] } ]
EOF
BEFORE_SUM="$(cksum "$PH7/.flywheel/projects.json")"
OUT7="$(env -i HOME="$PH7" USER="tester" PATH="$STUB_BIN:$PATH" \
  FLYWHEEL_PLATFORM=linux \
  bash "$SETUP" --project husband-ecom 2>&1)"
H7_RC=$?
AFTER_SUM="$(cksum "$PH7/.flywheel/projects.json")"
if [ "$H7_RC" -ne 0 ] && grep -qi "live fleet" <<<"$OUT7" \
   && [ ! -e "$PH7/.flywheel/setup-state.json" ] \
   && [ "$BEFORE_SUM" = "$AFTER_SUM" ]; then
  pass "H7 foreign live fleet → wizard refuses before writing anything"
else
  fail "H7 rc=$H7_RC out: $(head -3 <<<"$OUT7")"
fi

# ── H8: darwin dry-run of the generated artifact (secondary evidence) ──
DH="$SANDBOX/darwin-home"; mkdir -p "$DH"
DOUT="$(env -i HOME="$DH" USER="tester" PATH="$STUB_BIN:$PATH" FLYWHEEL_PLATFORM=darwin \
  bash "$PROVISION" --home "$DH" --repo-root "$REPO_ROOT" --fleet-dir "$FW/setup-fleet" 2>&1)"
H8_RC=$?
if [ "$H8_RC" -eq 0 ] && grep -q "phase: preflight" <<<"$DOUT" && grep -q "phase: validate" <<<"$DOUT"; then
  pass "H8 darwin dry-run of the wizard's artifact: full plan, exit 0"
else
  fail "H8 rc=$H8_RC out: $(tail -5 <<<"$DOUT")"
fi

echo ""
echo "flywheel-setup-poc.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
