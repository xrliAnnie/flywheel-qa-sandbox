#!/bin/bash
# FLY-231: restart-services production-candidate resolver test (Codex code-review
# MEDIUM-4). Sources scripts/lib/restart-candidate.sh and verifies the deploy-gating
# classification: production match → restart, test-slot → skip, drift → fail, and
# that the resolver reads HOST config (ignoring a leaked FLYWHEEL_PROJECTS).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# FLYWHEEL_DIR = repo root (the lib reads ${FLYWHEEL_DIR}/packages/teamlead/dist/ProjectConfig.js).
FLYWHEEL_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
export FLYWHEEL_DIR
LIB="${FLYWHEEL_DIR}/scripts/lib/restart-candidate.sh"

if [ ! -f "${FLYWHEEL_DIR}/packages/teamlead/dist/ProjectConfig.js" ]; then
  echo "SKIP: dist/ProjectConfig.js not built" >&2; exit 0
fi
# shellcheck source=/dev/null
source "$LIB"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1 (got: '$2')"; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2"; }

# Host projects.json fixture: one production lead (geoforge3d/product-lead).
H=$(mktemp -d "/tmp/fly231-rc.XXXXXX")
mkdir -p "$H/.flywheel"
cat > "$H/.flywheel/projects.json" <<JSON
[{"projectName":"geoforge3d","projectRoot":"/tmp/gf","leads":[
  {"agentId":"product-lead","chatChannel":"1","match":{"labels":["Product"]}}]}]
JSON

# Run helpers under the isolated HOME (so loadProjects reads our fixture).
mem()      { env HOME="$H" PATH="$PATH" FLYWHEEL_DIR="$FLYWHEEL_DIR" bash -c "source '$LIB'; _prod_membership \"\$1\" \"\$2\"" _ "$1" "$2"; }
classify() { env HOME="$H" PATH="$PATH" FLYWHEEL_DIR="$FLYWHEEL_DIR" bash -c "source '$LIB'; _classify_restart_manifest \"\$1\" \"\$2\"" _ "$1" "$2"; }

# ── _prod_membership ──
eq "prod lead in host config → ok"          "$(mem geoforge3d product-lead)" "ok"
eq "lead not in host config → missing"      "$(mem geoforge3d ghost-lead)"   "missing"
eq "project not in host config → missing"   "$(mem nope product-lead)"       "missing"

# Resolver IGNORES a leaked FLYWHEEL_PROJECTS (host config is authoritative):
# env has a fixture WITH ghost-lead, but host projects.json does NOT → still missing.
LEAK='[{"projectName":"geoforge3d","projectRoot":"/tmp/gf","leads":[{"agentId":"ghost-lead","chatChannel":"9","match":{"labels":["X"]}}]}]'
got=$(env HOME="$H" PATH="$PATH" FLYWHEEL_DIR="$FLYWHEEL_DIR" FLYWHEEL_PROJECTS="$LEAK" bash -c "source '$LIB'; _prod_membership geoforge3d ghost-lead")
eq "ignores leaked FLYWHEEL_PROJECTS (host wins)" "$got" "missing"

# ── _classify_restart_manifest ──
eq "production match → restart"             "$(classify product-lead geoforge3d)" "restart"
eq "test-slot leadId → skip-test"          "$(classify flywheel-test-3 test-slot-3)" "skip-test"
eq "drifted/unknown prod manifest → fail"  "$(classify ghost-lead geoforge3d)" "fail"

# ── error: corrupt host config → fail (not silently skipped) ──
echo "{ corrupt json" > "$H/.flywheel/projects.json"
eq "corrupt host config → fail (blocks deploy)" "$(classify product-lead geoforge3d)" "fail"

rm -rf "$H"
echo ""
echo "FLY-231 restart-candidate resolver test: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
