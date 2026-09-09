#!/bin/bash
# FLY-2444: installable generalized Lead runtime and packaged summary migration.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; shift; [ "$#" -eq 0 ] || echo "        $*"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d -t fly2444-lead-package-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

export PACKAGE_ONBOARD_SOURCED=1
# shellcheck source=../package-onboard.sh
source "$REPO_ROOT/scripts/package-onboard.sh"

SCRIPT_CLOSURE="flywheel-lead.sh
flywheel-config-lock.sh
flywheel-config-lock.py
migrate-summary-registry.sh
lib/lead-host-tmux-gate.sh"
SCRIPT_CLOSURE_OK=1
while IFS= read -r file; do
  grep -Fxq "$file" <<<"$PO_SCRIPT_FILES" || SCRIPT_CLOSURE_OK=0
  grep -Fxq "scripts/$file" "$REPO_ROOT/scripts/package-onboard-files.allow" \
    || SCRIPT_CLOSURE_OK=0
done <<<"$SCRIPT_CLOSURE"
if [ "$SCRIPT_CLOSURE_OK" -eq 1 ]; then
  pass "package script manifest and allowlist include the generalized Lead closure"
else
  fail "package script manifest or allowlist is missing a Lead runtime dependency"
fi

if grep -Fxq 'teamlead:scripts/lib/canonical-lead-identity.sh' \
  <<<"$PO_PACKAGE_ASSET_FILES" \
  && grep -Fxq 'node_modules/flywheel-teamlead/scripts/lib/canonical-lead-identity.sh' \
    "$REPO_ROOT/scripts/package-onboard-files.allow"; then
  pass "package assets include the canonical Lead identity resolver"
else
  fail "canonical Lead identity resolver is absent from packaged assets"
fi

CONVERGE_OK=1
while IFS= read -r declaration; do
  [ -z "$declaration" ] && continue
  case "$declaration" in
    *flywheel-lead.sh*) ;;
    *) CONVERGE_OK=0 ;;
  esac
  case "$declaration" in
    *lib/lead-host-tmux-gate.sh*) ;;
    *) CONVERGE_OK=0 ;;
  esac
done < <(grep '^[[:space:]]*FILES=' "$REPO_ROOT/scripts/converge-flywheel-bin.sh")
if [ "$CONVERGE_OK" -eq 1 ] \
  && [ "$(grep -c '^[[:space:]]*FILES=' "$REPO_ROOT/scripts/converge-flywheel-bin.sh")" -eq 2 ]; then
  pass "monorepo and prebuilt convergence both own launcher and host-gate helper"
else
  fail "converge-flywheel-bin does not own the Lead closure in both modes"
fi

PACKAGED="$SANDBOX/package"
FIXTURE_HOME="$SANDBOX/home"
STATE="$FIXTURE_HOME/.flywheel"
mkdir -p "$PACKAGED/scripts/lib" "$PACKAGED/packages" "$STATE/state/summary-registry" \
  "$SANDBOX/bin"
for file in flywheel-config-lock.sh flywheel-config-lock.py migrate-summary-registry.sh; do
  cp "$REPO_ROOT/scripts/$file" "$PACKAGED/scripts/$file"
done
cp "$REPO_ROOT/scripts/lib/host-config.sh" "$PACKAGED/scripts/lib/host-config.sh"
ln -s "$REPO_ROOT/packages/flywheel-comm" "$PACKAGED/packages/flywheel-comm"
ln -s "$REPO_ROOT/packages/teamlead" "$PACKAGED/packages/teamlead"
cat > "$STATE/host.json" <<JSON
{"flywheelDir":"$PACKAGED","stateDir":"$STATE"}
JSON
cat > "$STATE/projects.json" <<JSON
[
  {
    "projectName":"external",
    "projectRoot":"$SANDBOX/external",
    "leads":[{
      "agentId":"external-lead",
      "summaryRole":"producer",
      "chatChannel":"10000000000000001",
      "match":{"labels":["external-lead"]},
      "botTokenEnv":"EXTERNAL_BOT_TOKEN",
      "botUserId":"20000000000000001",
      "canSpawnRunners":false,
      "backend":"claude-code",
      "carrier":"v2"
    }]
  }
]
JSON
printf '%s\n' '{"granularity":"per-lead","setBy":"founder","setAt":"2026-09-08T00:00:00.000Z"}' \
  > "$STATE/summary-config.json"
printf '%s\n' '{"assignments":[{"projectName":"external","leadId":"external-lead","summaryRole":"producer"}],"projectAggregators":[]}' \
  > "$SANDBOX/assignments.json"
printf '%s\n' '#!/bin/bash' 'touch "$PNPM_CALLED"' 'exit 99' > "$SANDBOX/bin/pnpm"
chmod +x "$SANDBOX/bin/pnpm"
PROJECTS_SHA="$(shasum -a 256 "$STATE/projects.json" | awk '{print $1}')"
MIGRATE_RC=0
env -u FLYWHEEL_COMM_CLI -u FLYWHEEL_DIR \
  HOME="$FIXTURE_HOME" FLYWHEEL_STATE_DIR="$STATE" \
  FLYWHEEL_HOST_CONFIG="$STATE/host.json" \
  PATH="$SANDBOX/bin:$PATH" PNPM_CALLED="$SANDBOX/pnpm.called" \
  bash "$PACKAGED/scripts/migrate-summary-registry.sh" \
    "$STATE/projects.json" "$SANDBOX/assignments.json" \
    "$STATE/state/summary-registry/migration-receipt.json" "$PROJECTS_SHA" \
    > "$SANDBOX/migrate.out" 2> "$SANDBOX/migrate.err" || MIGRATE_RC=$?
VERIFY_RC=0
HOME="$FIXTURE_HOME" \
FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$PACKAGED/packages/teamlead/dist/bin/validate-projects.js" \
  node "$REPO_ROOT/packages/flywheel-comm/dist/index.js" \
  summary-registry verify-activation --projects-file "$STATE/projects.json" \
  --receipt-file "$STATE/state/summary-registry/migration-receipt.json" \
  > "$SANDBOX/verify.out" 2> "$SANDBOX/verify.err" || VERIFY_RC=$?
if [ "$MIGRATE_RC" -eq 0 ] && [ "$VERIFY_RC" -eq 0 ] \
  && [ ! -e "$SANDBOX/pnpm.called" ] \
  && jq -e '.schemaVersion == 1 and .granularity == "per-lead"' \
    "$SANDBOX/migrate.out" >/dev/null 2>&1; then
  pass "installed migration wrapper re-mints and verifies a receipt through packaged dist"
else
  fail "installed migration wrapper did not use packaged dist" \
    "migrate=$MIGRATE_RC verify=$VERIFY_RC $(cat "$SANDBOX/migrate.err" 2>/dev/null)"
fi

echo ""
echo "flywheel-lead-packaging: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
