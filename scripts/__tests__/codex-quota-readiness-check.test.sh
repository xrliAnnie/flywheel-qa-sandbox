#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/state/codex-quota" "$TMP/canonical" "$TMP/home"
printf '{}' > "$TMP/canonical/auth.json"
chmod 600 "$TMP/canonical/auth.json"
ln -s "$TMP/canonical/auth.json" "$TMP/home/auth.json"

node --input-type=module - "$TMP" <<'NODE'
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeCodexHomeInventoryDigest } from "./packages/claude-runner/dist/index.js";
const root = process.argv[2], home = join(root, "home"), stateRoot = join(root, "state");
const roster = [{ id: "flywheel/implement", home, ownership: "managed" }];
const inventoryDigest = computeCodexHomeInventoryDigest(roster);
const buildSha = "a".repeat(40), at = "2026-09-18T00:00:00.000Z";
writeFileSync(join(root, "snapshot.json"), JSON.stringify({
  stateRoot, canonicalHome: join(root, "canonical"), roster,
  expectedBuildSha: buildSha,
  migrationState: { schemaVersion: 1, inventoryDigest, overdueDays: 1, enrolledAt: at, homes: roster.map(value => ({ ...value, enrolledAt: at })) },
  attemptReceipts: [{ schemaVersion: 1, attemptId: randomUUID(), at, homeId: roster[0].id, home, inventoryDigest, source: "health", buildSha, result: "done", reason: "linked", satisfied: true, backupRef: "backup/auth.json", postcondition: {} }],
  manifest: { schemaVersion: 1, buildSha, inventoryDigest, createdAt: at, homes: [{ home, ownership: "managed", credentialShared: true, checkedAt: at }] },
  inventory: { complete: false, registeredComplete: true, inventoryDigest, buildSha, homes: [{ home, ownership: "managed", activity: "active" }], activeUnsharedAccountKeys: [], canonicalChainActive: true, diagnostics: [{ reason: "process_home_unknown", scope: "global" }], unattributedReaders: [{ pid: 77, startIdentity: "desktop-start", executable: "/Applications/ChatGPT.app/codex", reason: "process_home_unknown" }] },
  global: { ready: false, failures: [{ reason: "authority_unavailable" }] },
  dependencies: { "FLY-2729": { status: "pending" }, desktopCredentialAuthority: { status: "unknown", issueId: null } }
}, null, 2));
NODE

if node "$ROOT/scripts/codex-quota-readiness-check.mjs" --snapshot-input "$TMP/snapshot.json" > "$TMP/default.json"; then
	echo 'default scope must fail while global readiness is false' >&2
	exit 1
fi
node "$ROOT/scripts/codex-quota-readiness-check.mjs" --acceptance-scope registered_homes --snapshot-input "$TMP/snapshot.json" > "$TMP/registered.json"
node --input-type=module - "$TMP/default.json" "$TMP/registered.json" <<'NODE'
import { lstatSync, readFileSync } from "node:fs";
const [defaultPath, registeredPath] = process.argv.slice(2);
for (const path of [defaultPath, registeredPath]) {
  const value = JSON.parse(readFileSync(path));
  if (Object.hasOwn(value, "ready") || value.registered?.ready !== true || value.global?.ready !== false || value.activation?.authorized !== false || value.unattributedReaders?.[0]?.pid !== 77) process.exit(1);
  const evidence = lstatSync(value.evidence.path);
  if (!evidence.isFile() || evidence.isSymbolicLink() || (evidence.mode & 0o777) !== 0o600) process.exit(1);
}
NODE
echo 'PASS registered readiness preserves global unknown and CLI exit scopes'
