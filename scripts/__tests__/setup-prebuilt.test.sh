#!/bin/bash
# FLY-1062 P2: flywheel-setup.sh prebuilt branches in the fleet-artifact
# generator — both sides:
#   prebuilt (FS_REPO_ROOT carries .flywheel-prebuilt):
#     T1 deps_json drops pnpm, gains the cc (build-essential) fallback entry
#     T2 manifest flywheel repo slug = null (customer manifests never carry
#        the private slug — zero-repo-access invariant, gate④ registration)
#     T3 host.json carries flywheelDir=~/.flywheel/runtime/current
#   monorepo (no sentinel) — reverse-compat sentinel:
#     T4 deps_json keeps pnpm required, no cc entry
#     T5 manifest flywheel slug = xrliAnnie/flywheel
#     T6 host.json has NO flywheelDir key (byte-identical shape)
#
# Hermetic: sourced generator (FLYWHEEL_SETUP_SOURCED=1) + fixture HOME +
# fixture FS_REPO_ROOT. Mirrors the flywheel-setup-config.test.sh harness.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="$REPO_ROOT/scripts/flywheel-setup.sh"

SANDBOX="$(mktemp -d -t fly1062-setup-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
H="$SANDBOX/home"; mkdir -p "$H"

FIX_PRE="$SANDBOX/prebuilt-root"; mkdir -p "$FIX_PRE"; echo "1.0.0" > "$FIX_PRE/.flywheel-prebuilt"
FIX_MONO="$SANDBOX/monorepo-root"; mkdir -p "$FIX_MONO"

# gen <out-dir> <repo-root> — run the sourced generator with fixture identity.
gen() {
  local out="$1" rroot="$2"
  (
    export FLYWHEEL_SETUP_SOURCED=1
    export HOME="$H"
    # shellcheck source=../flywheel-setup.sh
    source "$SETUP" || exit 97
    FS_PROJECT="cust-proj"; FS_DEPT="engineering"
    FS_COS_PERSONA="Cass"; FS_ENG_PERSONA="Tad"
    FS_PROJECT_SLUG=""; FS_LINEAR_TEAM="CUS"; FS_LINEAR_WORKSPACE_SLUG="fake-workspace"
    FS_SKILLS_REPO="xrliAnnie/flywheel-skills"
    FS_GUILD_ID="100000000000000000"; FS_FOUNDER_ID="100000000000000009"
    FS_CHANNEL_GENERAL="100000000000000001"; FS_CHANNEL_COS="100000000000000002"; FS_CHANNEL_ENG="100000000000000003"
    fs_derive_identity || exit 96
    FS_REPO_ROOT="$rroot"
    fs_generate_fleet_artifact "$out" 0
  )
}

# ── prebuilt side ────────────────────────────────────────────────────────────
OUT_P="$SANDBOX/artifact-prebuilt"
if ! gen "$OUT_P" "$FIX_PRE" >/dev/null 2>&1; then
  fail "prebuilt artifact generation failed"; echo "setup-prebuilt: PASSED=$PASSED FAILED=$FAILED"; exit 1
fi
M="$OUT_P/manifest.json"

if [ "$(jq -r '[.deps[].name] | index("pnpm")' "$M")" = "null" ] \
   && [ "$(jq -r '[.deps[].name] | index("cc") != null' "$M")" = "true" ] \
   && [ "$(jq -r '.deps[] | select(.name=="node") | .required' "$M")" = "true" ]; then
  pass "T1 prebuilt deps: pnpm gone, cc fallback in, node still required"
else
  fail "T1 prebuilt deps wrong: $(jq -c '[.deps[].name]' "$M")"
fi

if [ "$(jq -r '.repos[] | select(.name=="flywheel") | .slug' "$M")" = "null" ]; then
  pass "T2 prebuilt manifest: flywheel repo slug=null (no private slug on customer machines)"
else
  fail "T2 flywheel slug leaked: $(jq -c '.repos' "$M")"
fi

if [ "$(jq -r '.flywheelDir' "$OUT_P/host.json")" = "~/.flywheel/runtime/current" ]; then
  pass "T3 prebuilt host.json: flywheelDir points at the stable runtime root"
else
  fail "T3 host.json wrong: $(cat "$OUT_P/host.json")"
fi

# ── monorepo side (reverse-compat sentinel) ──────────────────────────────────
OUT_M="$SANDBOX/artifact-monorepo"
if ! gen "$OUT_M" "$FIX_MONO" >/dev/null 2>&1; then
  fail "monorepo artifact generation failed"; echo "setup-prebuilt: PASSED=$PASSED FAILED=$FAILED"; exit 1
fi
M2="$OUT_M/manifest.json"

if [ "$(jq -r '.deps[] | select(.name=="pnpm") | .required' "$M2")" = "true" ] \
   && [ "$(jq -r '[.deps[].name] | index("cc")' "$M2")" = "null" ]; then
  pass "T4 monorepo sentinel: pnpm required, no cc entry"
else
  fail "T4 monorepo deps drifted: $(jq -c '[.deps[].name]' "$M2")"
fi

if [ "$(jq -r '.repos[] | select(.name=="flywheel") | .slug' "$M2")" = "xrliAnnie/flywheel" ]; then
  pass "T5 monorepo sentinel: flywheel slug unchanged"
else
  fail "T5 flywheel slug drifted: $(jq -c '.repos' "$M2")"
fi

if [ "$(jq -r 'has("flywheelDir")' "$OUT_M/host.json")" = "false" ]; then
  pass "T6 monorepo sentinel: host.json has no flywheelDir key (byte-compat shape)"
else
  fail "T6 host.json drifted: $(cat "$OUT_M/host.json")"
fi

echo ""
echo "setup-prebuilt: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
