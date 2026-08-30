#!/usr/bin/env bash
# FLY-2121 QA3 regressions: graph implementation prompt contracts and legacy
# setup config resolution. Hermetic; no services, network, or real project data.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMPLEMENT_MD="$ROOT/.flywheel/agents/nodes/implement.md"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }
assert_contains() {
	local needle="$1" label="$2"
	if grep -qF -- "$needle" "$IMPLEMENT_MD"; then pass "$label"; else fail "$label (missing: $needle)"; fi
}

assert_contains 'pnpm lint' 'implement node names the whole-repo lint gate'
assert_contains 'pnpm -r build' 'implement node names the topological build gate'
assert_contains 'pnpm test:packages:run' 'implement node names the package test gate'
assert_contains 'codex:rescue' 'implement node names the supported code-review command'
assert_contains 'never raw `codex exec`' 'implement node forbids raw codex exec'
assert_contains 'engineering/doc/milestones/<ID>.md' 'implement node pins the per-issue milestone path'
assert_contains 'do not touch `CLAUDE.md`' 'implement node protects the shared CLAUDE milestone table'
assert_contains 'parallel PRs conflict' 'implement node records the FLY-2045 concurrency reason'
assert_contains 'DOC-FLOW' 'implement node preserves injected doc-flow requirements'
assert_contains 'Merge and deployment are separate' 'implement node separates merge from deployment'
assert_contains 'independent updater' 'implement node names the deployment owner'

SETUP_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2121-setup.XXXXXX")"
trap 'rm -rf "$SETUP_TEST_ROOT"' EXIT
mkdir -p "$SETUP_TEST_ROOT/legacy/.flywheel" "$SETUP_TEST_ROOT/node/.flywheel"
cat > "$SETUP_TEST_ROOT/legacy/.flywheel/config.yaml" <<'YAML'
project: legacy-project
linear: { team_id: FLY }
runners:
  default: claude
  available: { claude: { type: claude } }
teams:
  - name: engineering
    orchestrators:
      - { type: code, runner: claude, budget_per_issue: 1 }
decision_layer: { autonomy_level: observer, escalation_channel: test }
agents:
  engineer:
    agent_file: .flywheel/agents/engineer.md
    match: { labels: [code] }
YAML
cat > "$SETUP_TEST_ROOT/node/.flywheel/config.yaml" <<'YAML'
project: node-project
linear: { team_id: FLY }
runners:
  default: claude
  available: { claude: { type: claude } }
teams:
  - name: engineering
    orchestrators:
      - { type: code, runner: claude, budget_per_issue: 1 }
decision_layer: { autonomy_level: observer, escalation_channel: test }
agents:
  engineer:
    node: engineer
    match: { labels: [code] }
YAML

if FLY2121_TEST_ROOT="$SETUP_TEST_ROOT" FLY2121_REPO_ROOT="$ROOT" \
	pnpm --silent exec tsx --eval '
		import assert from "node:assert/strict";
		import { join } from "node:path";
		import { loadBundledRegistry } from "./packages/config/dist/agent-registry.js";
		import { loadSetupProjectConfig } from "./scripts/lib/setup.ts";
		void (async () => {
			const testRoot = process.env.FLY2121_TEST_ROOT;
			const repoRoot = process.env.FLY2121_REPO_ROOT;
			assert.ok(testRoot && repoRoot);
			const bundledAgentRegistry = loadBundledRegistry(join(repoRoot, ".flywheel/agents/registry.yaml"));
			const missingLogs = [];
			const legacyRoot = join(testRoot, "legacy");
			const legacy = await loadSetupProjectConfig({
			configPath: join(legacyRoot, ".flywheel/config.yaml"),
			projectName: "legacy-project",
			projectRoot: legacyRoot,
			bundledAgentRegistry,
			onMissingConfig: (message) => missingLogs.push(message),
			});
			assert.equal(legacy.flywheelConfig?.project, "legacy-project");
			assert.equal(legacy.resolvedAgents.engineer?.nodeName, "engineer");
			assert.equal(missingLogs.length, 0);

			const absent = await loadSetupProjectConfig({
			configPath: join(testRoot, "absent/.flywheel/config.yaml"),
			projectName: "absent-project",
			projectRoot: join(testRoot, "absent"),
			bundledAgentRegistry,
			onMissingConfig: (message) => missingLogs.push(message),
			});
			assert.equal(absent.flywheelConfig, undefined);
			assert.deepEqual(absent.resolvedAgents, {});
			assert.deepEqual(missingLogs, ["No .flywheel/config.yaml — using defaults"]);

			const nodeRoot = join(testRoot, "node");
			await assert.rejects(
			loadSetupProjectConfig({
				configPath: join(nodeRoot, ".flywheel/config.yaml"),
				projectName: "node-project",
				projectRoot: nodeRoot,
				bundledAgentRegistry,
				onMissingConfig: (message) => missingLogs.push(message),
			}),
			(error) => error?.code === "ENOENT" && /registry\.yaml/.test(String(error?.path ?? error?.message)),
			);
			assert.equal(missingLogs.length, 1);
		})();
	' >/dev/null; then
	pass 'setup keeps legacy agent_file config and fails loud for a missing required registry'
else
	fail 'setup config/registry ENOENT classification behavior'
fi

echo "fly2121-node-contract-and-setup: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
