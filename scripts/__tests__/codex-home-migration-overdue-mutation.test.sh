#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE="$ROOT/packages/claude-runner/dist/codex-home-reconcile.js"
TMP="$(mktemp -d /tmp/fly2523-overdue-mutant.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
[ -f "$SOURCE" ] || { echo "build flywheel-claude-runner before this test" >&2; exit 1; }

cat > "$TMP/contract.mjs" <<'JS'
import { pathToFileURL } from "node:url";
const [modulePath, mode] = process.argv.slice(2);
const api = await import(`${pathToFileURL(modulePath).href}?case=${mode}`);
const digest = "a".repeat(64);
const home = "/tmp/fly2523-mutation-home";
const state = {
  schemaVersion: 1,
  inventoryDigest: digest,
  overdueDays: 1,
  enrolledAt: "2026-09-17T00:00:00.000Z",
  homes: [{id: "flywheel/implement", home, ownership: "managed", enrolledAt: "2026-09-17T00:00:00.000Z"}],
};
const receipts = mode === "satisfied" ? [{
  schemaVersion: 1,
  attemptId: "8e237eaa-b23c-432f-a507-ad28052b51bc",
  at: "2026-09-17T12:00:00.000Z",
  homeId: "flywheel/implement",
  home,
  inventoryDigest: digest,
  source: "health",
  buildSha: "b".repeat(40),
  result: "done",
  reason: "linked",
  satisfied: true,
  backupRef: null,
  postcondition: {},
}] : [];
const [status] = api.evaluateCodexHomeMigrationDeadlines(
  state,
  receipts,
  new Date("2026-09-18T00:00:00.000Z"),
);
const expected = mode === "missing";
if (status.overdue !== expected) {
  throw new Error(`mutation contract failed: mode=${mode} overdue=${status.overdue} expected=${expected}`);
}
JS

node "$TMP/contract.mjs" "$SOURCE" missing
node "$TMP/contract.mjs" "$SOURCE" satisfied

cp "$SOURCE" "$TMP/threshold-mutant.mjs"
perl -0pi -e 's/return nowMs >= Date\.parse\(enrolledAt\) \+ days \* 24 \* 60 \* 60 \* 1000;/return false;/' "$TMP/threshold-mutant.mjs"
grep -F 'return false;' "$TMP/threshold-mutant.mjs" >/dev/null
if node "$TMP/contract.mjs" "$TMP/threshold-mutant.mjs" missing >"$TMP/threshold.out" 2>&1; then
	echo "threshold mutant survived" >&2
	exit 1
fi

cp "$SOURCE" "$TMP/satisfied-mutant.mjs"
perl -0pi -e 's/if \(satisfied\)\n        return false;/if (!satisfied)\n        return false;/' "$TMP/satisfied-mutant.mjs"
grep -F 'if (!satisfied)' "$TMP/satisfied-mutant.mjs" >/dev/null
if node "$TMP/contract.mjs" "$TMP/satisfied-mutant.mjs" satisfied >"$TMP/satisfied.out" 2>&1; then
	echo "satisfied mutant survived" >&2
	exit 1
fi

echo "PASS Codex home migration overdue mutants are killed"
