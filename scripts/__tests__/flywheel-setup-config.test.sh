#!/bin/bash
# FLY-648 WI-B: config writer + pre-write real-loader gate + CoS skeleton
# identity alignment (R1#3).
#
# Hermetic. Needs the built teamlead dist (validate-projects CLI) — CI runs
# `pnpm build` before shell tests; locally: pnpm -C packages/teamlead build.
#
# Covers:
#   B1  setup-new-project.sh WITHOUT new flags = default ids (reverse-compat)
#   B2  --cos-id/--dept-id name the .lead/ dirs + identity frontmatter
#   B2b bad override id rejected; cos==dept id rejected
#   B3  fs_generate_fleet_artifact: rev1 field contracts (cos-lead literal,
#       lowercase grammar, absolute projectRoot, explicit department,
#       Triage⇒canSpawnRunners:false, persona→botTokenEnv, exact env key set)
#   B4  real-loader gate: valid passes; Triage w/o canSpawnRunners rejected
#   B5  artifact passes scan_for_secrets; env.example secret keys EMPTY
#   B6  real materializer on the generated projects.json: leadId==cos-lead,
#       projectDir == skeleton target, identity dirs match agentIds
#   B7  claude-lead.sh CoS detection contract pin (literal "cos-lead")
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="${REPO_ROOT}/scripts/flywheel-setup.sh"
SNP="${REPO_ROOT}/scripts/setup-new-project.sh"
VALIDATOR="${REPO_ROOT}/packages/teamlead/dist/bin/validate-projects.js"
[ -f "$VALIDATOR" ] || { echo "ERROR: built validator missing — pnpm -C packages/teamlead build"; exit 1; }

SANDBOX="$(mktemp -d -t fly648-config-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
H="$SANDBOX/home"; mkdir -p "$H"

# ── B1: no new flags → default lead ids (reverse-compat) ──
T1="$SANDBOX/proj-default"
HOME="$H" bash "$SNP" defproj engineering --target "$T1" --two-layer >/dev/null 2>&1
if [ -f "$T1/.lead/defproj-cos-lead/identity.md" ] \
   && [ -f "$T1/.lead/defproj-engineering-lead/identity.md" ]; then
  pass "B1 default behavior unchanged (project-prefixed lead ids)"
else
  fail "B1 dirs: $(ls "$T1/.lead" 2>/dev/null)"
fi

# ── B2: --cos-id / --dept-id override dirs + frontmatter names ──
T2="$SANDBOX/proj-override"
HOME="$H" bash "$SNP" ovrproj engineering --target "$T2" --two-layer \
  --cos-id cos-lead --dept-id tad-eng-lead >/dev/null 2>&1
B2_OK=1
[ -f "$T2/.lead/cos-lead/identity.md" ] || B2_OK=0
[ -f "$T2/.lead/tad-eng-lead/identity.md" ] || B2_OK=0
[ -e "$T2/.lead/ovrproj-cos-lead" ] && B2_OK=0
[ -e "$T2/.lead/ovrproj-engineering-lead" ] && B2_OK=0
grep -q '^name: cos-lead$' "$T2/.lead/cos-lead/identity.md" 2>/dev/null || B2_OK=0
grep -q '^name: tad-eng-lead$' "$T2/.lead/tad-eng-lead/identity.md" 2>/dev/null || B2_OK=0
if [ "$B2_OK" -eq 1 ]; then
  pass "B2 --cos-id/--dept-id: dirs + frontmatter aligned, no default-named strays"
else
  fail "B2 dirs: $(ls "$T2/.lead" 2>/dev/null)"
fi

# ── B2b: invalid override rejected; identical ids rejected ──
HOME="$H" bash "$SNP" badproj engineering --target "$SANDBOX/nope1" --cos-id "Bad_Id" >/dev/null 2>&1
B2B_A=$?
HOME="$H" bash "$SNP" badproj engineering --target "$SANDBOX/nope2" --two-layer \
  --cos-id same-lead --dept-id same-lead >/dev/null 2>&1
B2B_B=$?
if [ "$B2B_A" -ne 0 ] && [ "$B2B_B" -ne 0 ]; then
  pass "B2b invalid --cos-id grammar + cos==dept collision both rejected"
else
  fail "B2b rcA=$B2B_A rcB=$B2B_B"
fi

# ── generator harness: source flywheel-setup.sh + drive fs_generate_fleet_artifact ──
# gen_artifact <out-dir> <complete:0|1> [extra-var=value...]
gen_artifact() {
  local out="$1" complete="$2"; shift 2
  (
    export FLYWHEEL_SETUP_SOURCED=1
    export HOME="$H"
    # shellcheck source=../flywheel-setup.sh
    source "$SETUP" || exit 97
    FS_PROJECT="husband-ecom"; FS_DEPT="engineering"
    FS_COS_PERSONA="Cass"; FS_ENG_PERSONA="Tad"
    FS_PROJECT_SLUG=""; FS_LINEAR_TEAM="HUS"; FS_LINEAR_WORKSPACE_SLUG="fake-workspace"
    FS_SKILLS_REPO="xrliAnnie/flywheel-skills"
    FS_GUILD_ID="100000000000000000"; FS_FOUNDER_ID="100000000000000009"
    FS_CHANNEL_GENERAL="100000000000000001"; FS_CHANNEL_COS="100000000000000002"; FS_CHANNEL_ENG="100000000000000003"
    local kv
    for kv in "$@"; do eval "$kv"; done
    fs_derive_identity || exit 96
    fs_generate_fleet_artifact "$out" "$complete"
  )
}

# ── B3: generated projects.json honors every rev1 field contract ──
A3="$SANDBOX/art3"
gen_artifact "$A3" 1 >/dev/null 2>&1
B3_RC=$?
PJ="$A3/projects.json"
B3_OK=1
[ "$B3_RC" -eq 0 ] || B3_OK=0
[ "$(jq -r '.[0].leads[0].agentId' "$PJ" 2>/dev/null)" = "cos-lead" ] || B3_OK=0
[ "$(jq -r '.[0].leads[1].agentId' "$PJ" 2>/dev/null)" = "tad-eng-lead" ] || B3_OK=0
[ "$(jq -r '.[0].leads[0].canSpawnRunners' "$PJ" 2>/dev/null)" = "false" ] || B3_OK=0
[ "$(jq -r '.[0].leads[0].match.labels[0]' "$PJ" 2>/dev/null)" = "Triage" ] || B3_OK=0
[ "$(jq -r '.[0].leads[1].department' "$PJ" 2>/dev/null)" = "engineering" ] || B3_OK=0
[ "$(jq -r '.[0].projectRoot' "$PJ" 2>/dev/null)" = "$H/Dev/husband-ecom" ] || B3_OK=0
[ "$(jq -r '.[0].leads[0].botTokenEnv' "$PJ" 2>/dev/null)" = "CASS_BOT_TOKEN" ] || B3_OK=0
[ "$(jq -r '.[0].leads[1].botTokenEnv' "$PJ" 2>/dev/null)" = "TAD_BOT_TOKEN" ] || B3_OK=0
[ "$(jq -r '.[0].linear.team' "$PJ" 2>/dev/null)" = "HUS" ] || B3_OK=0
# full binding (Codex R1 MEDIUM): runtime auto-association needs project+label
[ "$(jq -r '.[0].linear.project' "$PJ" 2>/dev/null)" = "husband-ecom" ] || B3_OK=0
[ "$(jq -r '.[0].linear.label' "$PJ" 2>/dev/null)" = "Husband-ecom" ] || B3_OK=0
[ "$(jq -r '.[0].generalChannel' "$PJ" 2>/dev/null)" = "100000000000000001" ] || B3_OK=0
[ "$(jq -r '.[0].memoryAllowedUsers[0]' "$PJ" 2>/dev/null)" = "100000000000000009" ] || B3_OK=0
if [ "$B3_OK" -eq 1 ]; then
  pass "B3 projects.json field contracts (rev1 fixes preserved) + real IDs landed"
else
  fail "B3 rc=$B3_RC pj: $(cat "$PJ" 2>/dev/null | head -30)"
fi

# ── B3b: exact env contract (R1#5): required keys only, secrets EMPTY ──
EX="$A3/env.example"
B3B_OK=1
grep -Eq '^CASS_BOT_TOKEN=$' "$EX" || B3B_OK=0
grep -Eq '^TAD_BOT_TOKEN=$' "$EX" || B3B_OK=0
grep -Eq '^LINEAR_API_KEY=$' "$EX" || B3B_OK=0
grep -Eq '^DISCORD_GUILD_ID=100000000000000000$' "$EX" || B3B_OK=0
grep -Eq '^DISCORD_OWNER_USER_ID=100000000000000009$' "$EX" || B3B_OK=0
grep -Eq '^LINEAR_WORKSPACE_SLUG=' "$EX" || B3B_OK=0
# no optional model keys may appear as ACTIVE keys (would trip validate_tokens)
grep -Eq '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|NOTION_TOKEN)=' "$EX" && B3B_OK=0
if [ "$B3B_OK" -eq 1 ]; then
  pass "B3b env.example: exact required key set, secrets empty, no optional secret-named keys"
else
  fail "B3b env.example: $(grep -E '^[A-Z]' "$EX" 2>/dev/null)"
fi

# ── B4: pre-write gate = the REAL loader ──
# valid artifact already passed inside gen (B3 rc==0). Now break it: Triage
# lead without canSpawnRunners must be rejected by fs_validate_projects.
BAD="$SANDBOX/bad-projects.json"
jq 'map(.leads[0] |= del(.canSpawnRunners))' "$PJ" > "$BAD"
OUT4="$(
  export FLYWHEEL_SETUP_SOURCED=1 HOME="$H"
  source "$SETUP" || exit 97
  fs_validate_projects "$BAD" 2>&1
)"
B4_RC=$?
if [ "$B4_RC" -ne 0 ] && grep -qi "canSpawnRunners" <<<"$OUT4"; then
  pass "B4 real-loader gate rejects Triage lead w/o canSpawnRunners:false"
else
  fail "B4 rc=$B4_RC out: $(head -5 <<<"$OUT4")"
fi

# ── B4b: incomplete values (internal placeholder left) → complete-mode gen fails ──
A4="$SANDBOX/art4"
gen_artifact "$A4" 1 'FS_CHANNEL_COS="__FILL_DISCORD_CHANNEL_ID_COS__"' >/dev/null 2>&1
B4B_RC=$?
if [ "$B4B_RC" -ne 0 ]; then
  pass "B4b complete-mode generation fails on internal placeholder residue"
else
  fail "B4b placeholder residue accepted (rc=0)"
fi

# ── B5: artifact zero-secret ──
if bash -c "source '$REPO_ROOT/scripts/lib/fleet-sanitize.sh'; scan_for_secrets '$A3'" >/dev/null 2>&1; then
  pass "B5 generated artifact passes scan_for_secrets"
else
  fail "B5 secret scan flagged artifact"
fi

# ── B6: real materializer alignment ──
# skeleton with matching ids exists (like the wizard's skeleton step would)
HOME="$H" bash "$SNP" husband-ecom engineering --target "$H/Dev/husband-ecom" \
  --two-layer --cos-id cos-lead --dept-id tad-eng-lead >/dev/null 2>&1
MDIR="$SANDBOX/manifests"
bash "$REPO_ROOT/scripts/materialize-lead-manifests.sh" \
  --home "$H" --projects "$PJ" --manifests-dir "$MDIR" >/dev/null 2>&1
B6_OK=1
COS_MAN="$MDIR/husband-ecom-cos-lead.json"
[ "$(jq -r '.leadId' "$COS_MAN" 2>/dev/null)" = "cos-lead" ] || B6_OK=0
[ "$(jq -r '.projectDir' "$COS_MAN" 2>/dev/null)" = "$H/Dev/husband-ecom" ] || B6_OK=0
[ -f "$H/Dev/husband-ecom/.lead/cos-lead/identity.md" ] || B6_OK=0
[ -f "$H/Dev/husband-ecom/.lead/tad-eng-lead/identity.md" ] || B6_OK=0
[ -f "$MDIR/husband-ecom-tad-eng-lead.json" ] || B6_OK=0
if [ "$B6_OK" -eq 1 ]; then
  pass "B6 materializer: leadId==cos-lead, projectDir==skeleton dir, identity dirs match agentIds"
else
  fail "B6 manifests: $(ls "$MDIR" 2>/dev/null); leads: $(ls "$H/Dev/husband-ecom/.lead" 2>/dev/null)"
fi

# ── B7: claude-lead.sh CoS detection contract pin ──
if grep -q '"\$LEAD_ID" = "cos-lead"' "$REPO_ROOT/packages/teamlead/scripts/claude-lead.sh"; then
  pass "B7 claude-lead.sh still keys CoS role off the literal cos-lead (contract pin)"
else
  fail "B7 cos-lead detection literal changed in claude-lead.sh — realign the generator"
fi

echo ""
echo "flywheel-setup-config.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
