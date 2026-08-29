#!/bin/bash
# FLY-648 WI-E: Linear step — substeps a–e (R1#2): key validation, team
# find-or-create with explicit-consent reuse, label + project find-or-create,
# permission-denied → guided fallback, and writing the runtime-consumed values
# (config.yaml linear.team_id; the projects.json linear binding lands at the
# config step).
#
# Hermetic: curl stubbed (GraphQL dispatch by request body, state in files).
#
# Covers:
#   L1  fresh workspace: key validates → team/label/project created → evidence
#       + LINEAR_API_KEY/LINEAR_WORKSPACE_SLUG in .env + config.yaml team_id
#   L2  invalid key → step fails
#   L3  team key already exists → explicit user consent → reused (no create)
#   L3b consent denied → step fails
#   L4  teamCreate permission-denied → guided UI-create fallback → re-query ok
#   L5  API key never in curl argv nor journal
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="${REPO_ROOT}/scripts/flywheel-setup.sh"

SANDBOX="$(mktemp -d -t fly648-linear-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
H="$SANDBOX/home"; mkdir -p "$H"

STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
ARGV_LOG="$SANDBOX/curl-argv.log"
cat > "$STUB_BIN/curl" <<'EOF'
#!/bin/bash
echo "$*" >> "${FLY648_ARGV_LOG:?}"
cfg="$(cat)"
key="$(printf '%s' "$cfg" | sed -nE 's/.*Authorization: ([^"]*).*/\1/p')"
body=""; prev=""
for a in "$@"; do case "$prev" in -d) body="$a";; esac; prev="$a"; done
sd="${FLY648_STUB_DIR:?}"; mode="${FLY648_STUB_MODE:-ok}"
if [ "$mode" = "badkey" ] || [ -z "$key" ]; then
  printf '{"errors":[{"message":"Authentication required"}]}\n400'; exit 0
fi
team_json='{"data":{"teams":{"nodes":[{"id":"T1","key":"HUS","name":"husband-ecom"}]}}}'
case "$body" in
  *viewer*organization*)
    printf '{"data":{"viewer":{"id":"u1","name":"Founder"},"organization":{"urlKey":"fake-workspace","name":"Fake"}}}\n200' ;;
  *teamCreate*)
    if [ "$mode" = "team-create-403" ]; then
      printf '{"errors":[{"message":"You do not have permission to create teams"}]}\n200'
    else
      touch "$sd/team-exists"
      printf '{"data":{"teamCreate":{"success":true,"team":{"id":"T1","key":"HUS","name":"husband-ecom"}}}}\n200'
    fi ;;
  *issueLabelCreate*)
    touch "$sd/label-exists"
    printf '{"data":{"issueLabelCreate":{"success":true,"issueLabel":{"id":"LBL1","name":"Husband-ecom"}}}}\n200' ;;
  *projectCreate*)
    touch "$sd/project-exists"
    printf '{"data":{"projectCreate":{"success":true,"project":{"id":"P1","name":"husband-ecom"}}}}\n200' ;;
  *teams*nodes*)
    # FLY648_TEAMS_EMPTY_ONCE: first teams query is empty, later ones find the
    # team — emulates the user creating it in the Linear UI during the guided
    # fallback pause.
    if [ -n "${FLY648_TEAMS_EMPTY_ONCE:-}" ]; then
      if [ -f "$sd/teams-asked" ]; then printf '%s\n200' "$team_json"
      else touch "$sd/teams-asked"; printf '{"data":{"teams":{"nodes":[]}}}\n200'; fi
    elif [ -f "$sd/team-exists" ]; then printf '%s\n200' "$team_json"
    else printf '{"data":{"teams":{"nodes":[]}}}\n200'; fi ;;
  *issueLabels*)
    if [ -f "$sd/label-exists" ]; then
      printf '{"data":{"issueLabels":{"nodes":[{"id":"LBL1","name":"Husband-ecom"}]}}}\n200'
    else
      printf '{"data":{"issueLabels":{"nodes":[]}}}\n200'
    fi ;;
  *projects*)
    if [ -f "$sd/project-exists" ]; then
      printf '{"data":{"projects":{"nodes":[{"id":"P1","name":"husband-ecom"}]}}}\n200'
    else
      printf '{"data":{"projects":{"nodes":[]}}}\n200'
    fi ;;
  *) printf '{"data":{}}\n200' ;;
esac
EOF
chmod +x "$STUB_BIN/curl"

# minimal skeleton config.yaml fixture (what setup-new-project would write)
mk_config_yaml() {
  mkdir -p "$H/Dev/husband-ecom/.flywheel"
  cat > "$H/Dev/husband-ecom/.flywheel/config.yaml" <<'YML'
project: husband-ecom
linear:
  team_id: TEAM
YML
}

run_linear() {
  local sdir="$1" stubd="$2"; shift 2
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
    FS_LINEAR_TEAM="HUS"
    fs_derive_identity || exit 96
    STEP_IDS=(linear)
    setup_main_loop
  )
}

# ── L1: fresh workspace — validate, create team/label/project, write values ──
S1="$SANDBOX/state1"; SD1="$SANDBOX/stub1"; mkdir -p "$S1"
mk_config_yaml; : > "$ARGV_LOG"
OUT1="$(run_linear "$S1" "$SD1" \
  FLYWHEEL_SETUP_ANSWER_LINEAR_API_KEY_INPUT=lin_api_fakekey123 2>&1)"
L1_RC=$?
EV="$(jq -c '.steps.linear.evidence' "$S1/setup-state.json" 2>/dev/null)"
L1_OK=1
[ "$L1_RC" -eq 0 ] || L1_OK=0
[ "$(jq -r '.teamKey' <<<"$EV" 2>/dev/null)" = "HUS" ] || L1_OK=0
[ "$(jq -r '.teamId' <<<"$EV" 2>/dev/null)" = "T1" ] || L1_OK=0
[ "$(jq -r '.labelName' <<<"$EV" 2>/dev/null)" = "Husband-ecom" ] || L1_OK=0
[ "$(jq -r '.projectId' <<<"$EV" 2>/dev/null)" = "P1" ] || L1_OK=0
[ "$(jq -r '.workspaceSlug' <<<"$EV" 2>/dev/null)" = "fake-workspace" ] || L1_OK=0
grep -q '^LINEAR_API_KEY=lin_api_fakekey123$' "$S1/.env" || L1_OK=0
grep -q '^LINEAR_WORKSPACE_SLUG=fake-workspace$' "$S1/.env" || L1_OK=0
grep -q '^  team_id: HUS$' "$H/Dev/husband-ecom/.flywheel/config.yaml" || L1_OK=0
if [ "$L1_OK" -eq 1 ]; then
  pass "L1 fresh workspace: team/label/project created + env + config.yaml team_id"
else
  fail "L1 rc=$L1_RC ev=$EV cfg=$(grep team_id "$H/Dev/husband-ecom/.flywheel/config.yaml"); out: $(tail -4 <<<"$OUT1")"
fi

# ── L2: invalid key → fail ──
S2="$SANDBOX/state2"; SD2="$SANDBOX/stub2"; mkdir -p "$S2"
run_linear "$S2" "$SD2" FLY648_STUB_MODE=badkey \
  FLYWHEEL_SETUP_ANSWER_LINEAR_API_KEY_INPUT=badkey >/dev/null 2>&1
L2_RC=$?
if [ "$L2_RC" -ne 0 ] && [ "$(jq -r '.steps.linear.status // "pending"' "$S2/setup-state.json")" != "done" ]; then
  pass "L2 invalid Linear key → step fails"
else
  fail "L2 rc=$L2_RC"
fi

# ── L3: team key exists → explicit consent → reuse (no teamCreate call) ──
S3="$SANDBOX/state3"; SD3="$SANDBOX/stub3"; mkdir -p "$SD3"; touch "$SD3/team-exists"
mk_config_yaml; : > "$ARGV_LOG"
run_linear "$S3" "$SD3" \
  FLYWHEEL_SETUP_ANSWER_LINEAR_API_KEY_INPUT=lin_api_fakekey123 \
  FLYWHEEL_SETUP_ANSWER_LINEAR_USE_EXISTING_TEAM=y >/dev/null 2>&1
L3_RC=$?
if [ "$L3_RC" -eq 0 ] && ! grep -q "teamCreate" "$ARGV_LOG" \
   && [ "$(jq -r '.steps.linear.evidence.teamId' "$S3/setup-state.json")" = "T1" ]; then
  pass "L3 existing team reused only with explicit consent"
else
  fail "L3 rc=$L3_RC creates=$(grep -c teamCreate "$ARGV_LOG")"
fi

# ── L3b: consent denied → fail (never silently adopt someone's team) ──
S3B="$SANDBOX/state3b"; SD3B="$SANDBOX/stub3b"; mkdir -p "$SD3B"; touch "$SD3B/team-exists"
run_linear "$S3B" "$SD3B" \
  FLYWHEEL_SETUP_ANSWER_LINEAR_API_KEY_INPUT=lin_api_fakekey123 \
  FLYWHEEL_SETUP_ANSWER_LINEAR_USE_EXISTING_TEAM=n >/dev/null 2>&1
L3B_RC=$?
if [ "$L3B_RC" -ne 0 ]; then
  pass "L3b consent denied → step fails with guidance"
else
  fail "L3b rc=0"
fi

# ── L4: teamCreate permission-denied → guided UI-create → re-query verifies ──
S4="$SANDBOX/state4"; SD4="$SANDBOX/stub4"; mkdir -p "$S4" "$SD4"
mk_config_yaml
OUT4="$(run_linear "$S4" "$SD4" FLY648_STUB_MODE=team-create-403 \
  FLY648_TEAMS_EMPTY_ONCE=1 \
  FLYWHEEL_SETUP_ANSWER_LINEAR_API_KEY_INPUT=lin_api_fakekey123 \
  FLYWHEEL_SETUP_ANSWER_LINEAR_TEAM_CREATED_MANUALLY=y 2>&1)"
L4_RC=$?
if [ "$L4_RC" -eq 0 ] \
   && grep -qiE "create .*team|Linear UI|yourself" <<<"$OUT4" \
   && [ "$(jq -r '.steps.linear.evidence.teamId' "$S4/setup-state.json" 2>/dev/null)" = "T1" ]; then
  pass "L4 create-permission-denied → guided UI-create fallback verified by re-query"
else
  fail "L4 rc=$L4_RC out: $(grep -iE 'permission|create|team' <<<"$OUT4" | head -3)"
fi

# ── L5: key hygiene — never in argv nor journal ──
if ! grep -q "lin_api_fakekey123" "$ARGV_LOG" \
   && ! grep -q "lin_api_fakekey123" "$S1/setup-state.json"; then
  pass "L5 Linear key absent from curl argv + journal"
else
  fail "L5 argv-hit=$(grep -c lin_api_fakekey123 "$ARGV_LOG") journal-hit=$(grep -c lin_api_fakekey123 "$S1/setup-state.json")"
fi

echo ""
echo "flywheel-setup-linear.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
