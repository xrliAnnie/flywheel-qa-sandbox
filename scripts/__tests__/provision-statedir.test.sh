#!/bin/bash
# FLY-650: provision honors a custom host.json stateDir + phase_skills tolerates
# an empty canonicalRepo (Codex R2 MED-A / MED-B). Platform-agnostic config tests.
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROVISION="${REPO_ROOT}/scripts/provision-fleet-host.sh"
SANDBOX="$(mktemp -d -t fly650-statedir-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
for b in brew git launchctl curl pnpm systemctl; do
  printf '#!/bin/bash\nexit 0\n' > "$STUB_BIN/$b"; chmod +x "$STUB_BIN/$b"
done
export PATH="$STUB_BIN:$PATH"

FLEET="$SANDBOX/fleet"; mkdir -p "$FLEET"
cat > "$FLEET/projects.json" <<'EOF'
[ { "projectName": "flywheel", "projectRoot": "Dev/flywheel", "projectRepo": "xrliAnnie/flywheel",
    "leads": [ { "agentId": "flywheel-cos-lead", "chatChannel": "1", "match": { "labels": ["cos"] }, "botTokenEnv": "CASS_BOT_TOKEN", "canSpawnRunners": false } ] } ]
EOF
printf 'CASS_BOT_TOKEN=\n' > "$FLEET/env.example"

H="$SANDBOX/home"; mkdir -p "$H"
CUSTOM="$SANDBOX/custom-state"
# artifact host.json with a CUSTOM stateDir.
cat > "$FLEET/host.json" <<EOF
{ "schemaVersion": 1, "skillsRepo": "xrliAnnie/flywheel-skills", "stateDir": "$CUSTOM" }
EOF
cat > "$FLEET/manifest.json" <<'EOF'
{ "schemaVersion": 1, "meta": { "capturedAt": "2026-06-28T00:00:00Z" },
  "deps": [], "repos": [], "launchdJobs": [],
  "skills": { "skillsSyncPresent": false, "skillsUpdatePlistPresent": false, "canonicalRepo": "xrliAnnie/flywheel-skills" } }
EOF

prov() { env -i HOME="$H" PATH="$PATH" FLYWHEEL_PLATFORM=darwin bash "$PROVISION" --home "$H" --repo-root "$REPO_ROOT" --fleet-dir "$FLEET" "$@"; }

# ── MED-A: custom stateDir — state under CUSTOM, host.json at bootstrap ──
prov --apply --skip-token-check --only flywheel-home >/dev/null 2>&1
if [ -f "$CUSTOM/projects.json" ] && [ -f "$H/.flywheel/host.json" ] && [ ! -f "$H/.flywheel/projects.json" ]; then
  pass "MED-A custom stateDir: projects.json under CUSTOM, host.json at bootstrap, NOT split into ~/.flywheel"
else
  fail "MED-A: custom=$(ls "$CUSTOM" 2>/dev/null) bootstrap=$(ls "$H/.flywheel" 2>/dev/null)"
fi
prov --apply --skip-token-check --only tokens >/dev/null 2>&1
[ -f "$CUSTOM/.env" ] && pass "MED-A .env written under custom stateDir" || fail "MED-A .env not under custom stateDir"

# ── MED-B: canonicalRepo null → skills phase exits 0 (not abort) ──
H2="$SANDBOX/home2"; mkdir -p "$H2"
FLEET2="$SANDBOX/fleet2"; mkdir -p "$FLEET2"
cp "$FLEET/projects.json" "$FLEET/env.example" "$FLEET2/"
echo '{ "schemaVersion": 1, "skillsRepo": "x/y" }' > "$FLEET2/host.json"
cat > "$FLEET2/manifest.json" <<'EOF'
{ "schemaVersion": 1, "meta": { "capturedAt": "2026-06-28T00:00:00Z" },
  "deps": [], "repos": [], "launchdJobs": [],
  "skills": { "skillsSyncPresent": false, "skillsUpdatePlistPresent": false, "canonicalRepo": null } }
EOF
env -i HOME="$H2" PATH="$PATH" FLYWHEEL_PLATFORM=darwin bash "$PROVISION" --home "$H2" --repo-root "$REPO_ROOT" --fleet-dir "$FLEET2" --apply --skip-token-check --only skills >/dev/null 2>&1
[ $? -eq 0 ] && pass "MED-B skills phase exits 0 on canonicalRepo:null" || fail "MED-B skills phase aborted on null canonicalRepo"

# ── R3 HIGH: custom stateDir must NOT bypass the live-fleet guard ──
# An existing live fleet at the DEFAULT ~/.flywheel must still be detected even
# when host.json redirects the resolved state dir elsewhere.
H3="$SANDBOX/home3"; mkdir -p "$H3/.flywheel"
cat > "$H3/.flywheel/projects.json" <<'EOF'
[ { "projectName":"flywheel","projectRoot":"x","leads":[{"agentId":"a","chatChannel":"1","match":{"labels":["x"]},"canSpawnRunners":false}] } ]
EOF
env -i HOME="$H3" PATH="$PATH" FLYWHEEL_PLATFORM=darwin bash "$PROVISION" \
  --home "$H3" --repo-root "$REPO_ROOT" --fleet-dir "$FLEET" --apply --skip-token-check --only preflight >/dev/null 2>&1
[ $? -ne 0 ] && pass "R3 custom stateDir does NOT bypass live-fleet guard (default ~/.flywheel detected)" \
             || fail "R3 custom stateDir bypassed the live-fleet guard"
# ...and --force still overrides
env -i HOME="$H3" PATH="$PATH" FLYWHEEL_PLATFORM=darwin bash "$PROVISION" \
  --home "$H3" --repo-root "$REPO_ROOT" --fleet-dir "$FLEET" --apply --skip-token-check --force --only preflight >/dev/null 2>&1
[ $? -eq 0 ] && pass "R3 --force overrides the guard" || fail "R3 --force should override"

# ── R4 HIGH: the guard protects destructive --only/--from entrypoints, not just
# a full run through preflight. --only flywheel-home must ALSO refuse + write nothing.
H4="$SANDBOX/home4"; mkdir -p "$H4/.flywheel"
cp "$H3/.flywheel/projects.json" "$H4/.flywheel/projects.json"   # existing live default fleet
env -i HOME="$H4" PATH="$PATH" FLYWHEEL_PLATFORM=darwin bash "$PROVISION" \
  --home "$H4" --repo-root "$REPO_ROOT" --fleet-dir "$FLEET" --apply --skip-token-check --only flywheel-home >/dev/null 2>&1
RC=$?
# refused AND wrote no bootstrap host.json / no custom state
if [ "$RC" -ne 0 ] && [ ! -f "$H4/.flywheel/host.json" ]; then
  pass "R4 --only flywheel-home guarded (refused, no destructive write)"
else
  fail "R4 --only flywheel-home bypassed guard: rc=$RC host.json=$([ -f "$H4/.flywheel/host.json" ] && echo present)"
fi

echo ""
echo "provision-statedir.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
