#!/bin/bash
# FLY-1945: execute the trusted helper from source, managed symlink, and payload.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/patrol-launcher.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
HELPER="$ROOT/scripts/flywheel-patrol-continuity.mjs"
printf 'patrol_schema=2\nMECHANISM_REVIEW result=none count=0\n' > "$TMP/report.md"
mkdir -p "$TMP/managed/bin" "$TMP/unrelated"
ln -s "$HELPER" "$TMP/managed/bin/flywheel-patrol-continuity"
for entry in "$HELPER" "$TMP/managed/bin/flywheel-patrol-continuity"; do
 (cd "$TMP/unrelated" && FLYWHEEL_STATE_DB_PATH="$TMP/does-not-exist" "$entry" validate-report --report "$TMP/report.md") | grep -q '"valid":true'
done
# Assemble exactly the helper's compiled module closure in the payload layout;
# installed dependencies stand in for package-onboard's bundled node_modules.
PAYLOAD="$TMP/payload"
mkdir -p "$PAYLOAD/scripts" "$PAYLOAD/packages/teamlead/dist/bridge" "$PAYLOAD/packages/teamlead/dist/lead-backends/codex"
cp "$HELPER" "$PAYLOAD/scripts/flywheel-patrol-continuity.mjs"
printf '{"type":"module"}\n' > "$PAYLOAD/packages/teamlead/package.json"
for module in patrol-continuity-cli patrol-continuity patrol-continuity-collector package-gate-queue patrol-report process-lock; do
 cp "$ROOT/packages/teamlead/dist/$module.js" "$PAYLOAD/packages/teamlead/dist/$module.js"
done
cp "$ROOT/packages/teamlead/dist/bridge/stage-utils.js" "$PAYLOAD/packages/teamlead/dist/bridge/stage-utils.js"
cp "$ROOT/packages/teamlead/dist/lead-backends/codex/ProcessLifetimeFileLock.js" "$PAYLOAD/packages/teamlead/dist/lead-backends/codex/ProcessLifetimeFileLock.js"
ln -s "$ROOT/packages/teamlead/node_modules" "$PAYLOAD/packages/teamlead/node_modules"
(cd "$TMP/unrelated" && "$PAYLOAD/scripts/flywheel-patrol-continuity.mjs" validate-report --report "$TMP/report.md") | grep -q '"valid":true'
printf 'MECHANISM_DEFECT id=%064d step=2 class_key=%064d root_cause_ref=reason counterexample_ref=reason\n' 1 2 >> "$TMP/report.md"
if "$HELPER" validate-report --report "$TMP/report.md" >/dev/null 2>&1; then
 echo 'FAIL: missing mechanism disposition passed' >&2; exit 1
fi
rm "$PAYLOAD/packages/teamlead/dist/patrol-continuity-cli.js"
if "$PAYLOAD/scripts/flywheel-patrol-continuity.mjs" validate-report --report "$TMP/report.md" > "$TMP/missing.log" 2>&1; then
 echo 'FAIL: missing payload module fell back to another checkout' >&2; exit 1
fi
grep -q 'helper_load_failed' "$TMP/missing.log"
printf 'PASS: source, managed, payload helper closure and fail-closed validation\n'
