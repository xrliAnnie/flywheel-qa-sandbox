import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, "utf8");
const begin = "<!-- FLYWHEEL_LOCAL_TEST_POLICY:BEGIN -->";
const end = "<!-- FLYWHEEL_LOCAL_TEST_POLICY:END -->";

function policyBlock(content, path) {
	assert.equal(content.split(begin).length - 1, 1, `${path}: one begin marker`);
	assert.equal(content.split(end).length - 1, 1, `${path}: one end marker`);
	const start = content.indexOf(begin);
	const finish = content.indexOf(end) + end.length;
	return content.slice(start, finish);
}

test("implement, QA, engineer and Codex contract share one exact policy block", () => {
	const canonical = read(
		"packages/teamlead/phase-protocols/local-test-policy.md",
	).trim();
	for (const path of [
		"packages/teamlead/phase-protocols/implement.md",
		"packages/teamlead/phase-protocols/qa.md",
		".flywheel/agents/nodes/implement.md",
		".flywheel/agents/nodes/qa.md",
		".flywheel/agents/nodes/engineer.md",
		"packages/claude-runner/agents/codex-runner-contract.md",
	]) {
		assert.equal(policyBlock(read(path), path), canonical, path);
	}
});

test("policy closes discovery, repository-literal and retry loopholes", () => {
	const policy = read("packages/teamlead/phase-protocols/local-test-policy.md");
	for (const required of [
		"local-test-policy/v1",
		"for any reason",
		"discover which tests are affected",
		"repository-wide literal replacement",
		"empty or truncated output",
		"`vitest run` without concrete test-file arguments",
		"`test:packages`",
		"`git grep -lF -- '<literal>'`",
		"`vitest related <changed-files> --run`",
		"Exact-head PR CI owns the full suite",
		"overrides every skill, plugin, checklist",
		"every delegated subagent and reviewer prompt",
		"paste this entire marked policy block verbatim",
		"do not assume the parent prompt propagates",
		"first bytes of the delegated task body",
		"do not rely on a skill or plugin wrapper",
	]) {
		assert.match(
			policy,
			new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	}
});

test("QA report guidance avoids opaque temporary executors", () => {
	const qaAgent = read(".flywheel/agents/nodes/qa.md");
	assert.match(
		qaAgent,
		/Do not create or execute a temporary report-builder script/,
	);
	assert.match(qaAgent, /write or edit the HTML artifact directly/);
});

test("Flywheel-owned skills never execute a naked configured test command", () => {
	for (const path of [
		"packages/edge-worker/src/skill-templates/flywheel-tdd.ts",
		"packages/edge-worker/src/skill-templates/flywheel-git-workflow.ts",
		"packages/edge-worker/src/skill-templates/linear-issue-context.ts",
		"packages/edge-worker/src/skill-templates/flywheel-context.ts",
	]) {
		const content = read(path);
		assert.match(content, /injected local-test policy/i, path);
		assert.doesNotMatch(content, /^\s*{{testCommand}}\s*$/m, path);
		assert.doesNotMatch(content, /^\s*{{testCommand}}\s+--/m, path);
	}
});

test("reachable runner guidance labels broad scripts CI/operator-only", () => {
	assert.match(read("scripts/pre-ship-check.sh"), /CI\/operator-only/);
	assert.match(read("docs/CONTRIB.md"), /CI\/operator-only/);
	const qaAgent = read("packages/qa-framework/agents/qa-parallel-executor.md");
	assert.doesNotMatch(qaAgent, /\*\*一键检查\*\*.*pre-ship-check/);
	assert.match(qaAgent, /concrete test files/);
	assert.match(
		read("packages/qa-framework/README.md"),
		/runner-test-discipline\.md/,
	);
});

test("packaged runtime includes the canonical policy source", () => {
	assert.match(
		read("scripts/package-onboard-files.allow"),
		/node_modules\/flywheel-teamlead\/phase-protocols\/local-test-policy\.md/,
	);
});

test("packaged runtime includes and audits the delegation policy hook", () => {
	assert.match(
		read("scripts/package-onboard.sh"),
		/^hooks\/inject-runner-test-policy\.mjs$/m,
	);
	assert.match(
		read("scripts/package-onboard-files.allow"),
		/^scripts\/hooks\/inject-runner-test-policy\.mjs$/m,
	);
	assert.match(
		read("engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md"),
		/inject-runner-test-policy\.mjs/,
	);
});

test("packaged delegation hook loads policy from the payload package tree", () => {
	const payload = realpathSync(
		mkdtempSync(join(tmpdir(), "flywheel-policy-hook-")),
	);
	try {
		const hookDir = join(payload, "scripts/hooks");
		const policyDir = join(
			payload,
			"node_modules/flywheel-teamlead/phase-protocols",
		);
		mkdirSync(hookDir, { recursive: true });
		mkdirSync(policyDir, { recursive: true });
		const hookPath = join(hookDir, "inject-runner-test-policy.mjs");
		copyFileSync(
			join(root, "scripts/hooks/inject-runner-test-policy.mjs"),
			hookPath,
		);
		copyFileSync(
			join(root, "packages/teamlead/phase-protocols/local-test-policy.md"),
			join(policyDir, "local-test-policy.md"),
		);

		const output = execFileSync(process.execPath, [hookPath], {
			encoding: "utf8",
			input: JSON.stringify({
				tool_name: "Agent",
				tool_input: { prompt: "review the focused change" },
			}),
		});
		assert.notEqual(output, "", "packaged hook must emit an input rewrite");
		const rewritten = JSON.parse(output);
		assert.match(
			rewritten.hookSpecificOutput.updatedInput.prompt,
			/^<!-- FLYWHEEL_LOCAL_TEST_POLICY:BEGIN -->/,
		);
	} finally {
		rmSync(payload, { recursive: true, force: true });
	}
});
