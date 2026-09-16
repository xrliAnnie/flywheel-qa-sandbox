import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

const workflow = JSON.parse(
	execFileSync(
		"python3",
		[
			"-c",
			'import json,yaml; print(json.dumps(yaml.safe_load(open(".github/workflows/payload-promote.yml"))))',
		],
		{ encoding: "utf8" },
	),
);
const steps = workflow.jobs.prepare.steps;
test("rebind skips every build and derived checkout, keeping the reviewed main helper and beta-only authority", () => {
	const inputs = (workflow.on ?? workflow.true).workflow_dispatch.inputs;
	assert.deepEqual(inputs.mode.options, ["prepare", "rebind"]);
	assert.equal(inputs.mode.default, "prepare");
	assert.equal(inputs.beta.required, false);
	const rebind = steps.find(
		(s) =>
			s.name ===
			"Rebind abandoned prepared artifact (same bytes, new operation)",
	);
	assert.ok(rebind);
	assert.equal(rebind.if, "inputs.mode == 'rebind'");
	assert.match(rebind.run, /rebind-prepared-artifact/);
	for (const flag of [
		"source-release-id",
		"source-binding-digest",
		"release-id",
	])
		assert.ok(rebind.run.includes(`--${flag}`));
	for (const step of steps.slice(2)) {
		if (step === rebind) continue;
		assert.equal(step.if, "inputs.mode != 'rebind'", step.name ?? step.uses);
	}
	assert.match(steps[1].uses, /^actions\/checkout@[0-9a-f]{40}$/);
	assert.equal(steps[1].with["persist-credentials"], false);
	const derived = steps.find((s) => s.name === "Check out the DERIVED commit");
	assert.equal(
		derived.with.ref,
		["$", "{{ steps.derive.outputs.commit }}"].join(""),
	);
	assert.equal(derived.with["persist-credentials"], false);
	assert.equal(derived.uses, steps[1].uses);
	assert.deepEqual(
		[...new Set(JSON.stringify(workflow).match(/secrets\.[A-Z_]+/g))],
		["secrets.FW_BETA_PUBLISH_TOKEN"],
	);
});
test("actual dispatch guard rejects partial or mixed rebind inputs before any checkout", () => {
	const run = (patch) =>
		spawnSync("bash", ["-c", steps[0].run], {
			env: {
				...process.env,
				GH_REF: "refs/heads/main",
				MODE_INPUT: "prepare",
				RELEASE_ID_INPUT: "new-release",
				BETA_INPUT: "1.2.3-beta.1",
				SOURCE_RELEASE_ID_INPUT: "",
				SOURCE_BINDING_DIGEST_INPUT: "",
				...patch,
			},
			encoding: "utf8",
		}).status;
	assert.equal(run({}), 0);
	const rebind = {
		MODE_INPUT: "rebind",
		BETA_INPUT: "",
		SOURCE_RELEASE_ID_INPUT: "old-release",
		SOURCE_BINDING_DIGEST_INPUT: "a".repeat(64),
	};
	assert.equal(run(rebind), 0);
	for (const patch of [
		{ SOURCE_RELEASE_ID_INPUT: "" },
		{ SOURCE_RELEASE_ID_INPUT: "new-release" },
		{ SOURCE_BINDING_DIGEST_INPUT: "" },
		{ SOURCE_BINDING_DIGEST_INPUT: "../bad" },
		{ BETA_INPUT: "1.2.3-beta.1" },
		{ GH_REF: "refs/heads/other" },
		{ MODE_INPUT: "unknown" },
		{ RELEASE_ID_INPUT: "bad/operation" },
	])
		assert.notEqual(run({ ...rebind, ...patch }), 0);
	assert.notEqual(run({ SOURCE_RELEASE_ID_INPUT: "old-release" }), 0);
	assert.notEqual(run({ BETA_INPUT: "" }), 0);
});
