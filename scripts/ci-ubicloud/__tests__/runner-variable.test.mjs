import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(
	new URL("../../../packages/teamlead/package.json", import.meta.url),
);
const { parse } = require("yaml");

const workflowsDir = fileURLToPath(
	new URL("../../../.github/workflows/", import.meta.url),
);

// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression literal
const ciRunnerExpression = "${{ vars.CI_RUNNER || 'ubuntu-latest' }}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression literal
const shipRunnerExpression = "${{ vars.SHIP_RUNNER || 'ubuntu-latest' }}";

/** Workflows whose every job must schedule through `CI_RUNNER`. */
const ciRunnerWorkflows = {
	"ci.yml": { name: "CI" },
};

/**
 * Workflows explicitly excluded from the `CI_RUNNER` contract. Each entry
 * carries the reason, and each file must still exist, so a rename, removal or
 * newly added workflow forces a deliberate decision here instead of silently
 * dropping out of the contract.
 *
 * `ship-on-comment.yml` is excluded on purpose: `issue_comment` workflows only
 * load from the default branch, so the ship path cannot be exercised on a new
 * runner before merge, and its hard dependencies (real `gh`, `jq`, `timeout`,
 * `actions/github-script`) are not proven by any `ci.yml` job. It therefore
 * has its own knob, `SHIP_RUNNER`, so a CI cutover never flips the
 * merge-authorization path blindly. That knob is still asserted per job.
 */
const excludedFromCiRunner = {
	"ship-on-comment.yml": {
		reason:
			"issue_comment workflow loads from the default branch; unprovable before merge, so it uses its own SHIP_RUNNER knob",
		name: "Ship on :cool: Comment",
		runsOn: shipRunnerExpression,
	},
	"payload-activation.yml": {
		reason: "release/payload pipeline, out of FLY-2746 scope",
	},
	"payload-auto-release.yml": {
		reason: "release/payload pipeline, out of FLY-2746 scope",
	},
	"payload-beta-release.yml": {
		reason: "release/payload pipeline, out of FLY-2746 scope",
	},
	"payload-cleanup.yml": {
		reason: "release/payload pipeline, out of FLY-2746 scope",
	},
	"payload-promote-commit.yml": {
		reason: "release/payload pipeline, out of FLY-2746 scope",
	},
	"payload-promote.yml": {
		reason: "release/payload pipeline, out of FLY-2746 scope",
	},
};

function readJobs(file, expectedName) {
	const parsed = parse(fs.readFileSync(path.join(workflowsDir, file), "utf8"));
	assert.equal(parsed.name, expectedName, `${file} workflow name`);
	const jobs = Object.entries(parsed.jobs ?? {});
	assert.ok(jobs.length > 0, `${file} must contain jobs`);
	return jobs;
}

test("every workflow file is CI_RUNNER-governed or explicitly excluded with a reason", () => {
	const files = fs
		.readdirSync(workflowsDir)
		.filter((file) => /\.ya?ml$/.test(file))
		.sort();
	assert.ok(files.length > 0, "no workflow files found");
	for (const file of files) {
		assert.ok(
			file in ciRunnerWorkflows || file in excludedFromCiRunner,
			`${file} is neither CI_RUNNER-governed nor explicitly excluded`,
		);
	}
	for (const [file, entry] of Object.entries(excludedFromCiRunner)) {
		assert.ok(
			files.includes(file),
			`excluded workflow ${file} no longer exists`,
		);
		assert.ok(
			typeof entry.reason === "string" && entry.reason.length > 0,
			`excluded workflow ${file} needs a reason`,
		);
	}
	for (const file of Object.keys(ciRunnerWorkflows)) {
		assert.ok(
			files.includes(file),
			`governed workflow ${file} no longer exists`,
		);
	}
});

test("every CI job uses the rollback-safe CI_RUNNER variable", () => {
	for (const [file, expected] of Object.entries(ciRunnerWorkflows)) {
		for (const [jobId, job] of readJobs(file, expected.name)) {
			assert.equal(
				job["runs-on"],
				ciRunnerExpression,
				`${file} job ${jobId} must use CI_RUNNER`,
			);
		}
	}
});

test("ship jobs use their own SHIP_RUNNER variable, never CI_RUNNER", () => {
	for (const [file, entry] of Object.entries(excludedFromCiRunner)) {
		if (!entry.runsOn) continue;
		for (const [jobId, job] of readJobs(file, entry.name)) {
			assert.equal(
				job["runs-on"],
				entry.runsOn,
				`${file} job ${jobId} must use ${entry.runsOn}`,
			);
		}
	}
});
