import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(
	new URL("../../packages/teamlead/package.json", import.meta.url),
);
const { parse } = require("yaml");
function validate(workflow) {
	assert.equal(workflow.concurrency, undefined);
	assert.ok(workflow.jobs.preflight);
	assert.equal(workflow.jobs["beta-release"].needs, "preflight");
	assert.equal(
		workflow.jobs["beta-release"].if,
		"needs.preflight.outputs.eligible == 'true' && needs.preflight.outputs.activated == 'true'",
	);
	assert.deepEqual(workflow.jobs["beta-release"].concurrency, {
		group: "payload-release",
		queue: "max",
		"cancel-in-progress": false,
	});
	assert.ok(workflow.jobs["not-activated-receipt"]);
	assert.equal(
		workflow.jobs["not-activated-receipt"].if,
		"needs.preflight.outputs.eligible == 'true' && needs.preflight.outputs.bridge == 'true' && needs.preflight.outputs.activated == 'false'",
	);
	for (const step of workflow.jobs["not-activated-receipt"].steps) {
		assert.ok(
			["actions/github-script@v7", "actions/upload-artifact@v4"].includes(
				step.uses,
			),
		);
		assert.equal(step.run, undefined);
		assert.ok(!JSON.stringify(step).includes("secrets."));
		assert.ok(
			!/child_process|\bfetch\(|\bexec\(|\bspawn\(|FW_ENDPOINT/.test(
				step.with?.script ?? "",
			),
		);
	}
	assert.equal(workflow.jobs.preflight.steps.length, 1);
	assert.equal(
		workflow.jobs.preflight.steps[0].uses,
		"actions/github-script@v7",
	);
	assert.ok(!JSON.stringify(workflow.jobs.preflight).includes("secrets."));
}
test("beta admission runs outside the shared publish queue and only admitted activated work can publish", () => {
	const workflow = parse(
		fs.readFileSync(
			new URL(
				"../../.github/workflows/payload-beta-release.yml",
				import.meta.url,
			),
			"utf8",
		),
	);
	validate(workflow);
	for (const mutate of [
		(w) => {
			w.concurrency = { group: "payload-release" };
		},
		(w) => delete w.jobs["beta-release"].if,
		(w) => delete w.jobs["beta-release"].concurrency.queue,
		(w) => {
			w.jobs["beta-release"].concurrency.group = "separate";
		},
		(w) => delete w.jobs["not-activated-receipt"].if,
		(w) => w.jobs["not-activated-receipt"].steps.push({ run: "pnpm build" }),
		(w) => {
			w.jobs["not-activated-receipt"].steps[0].env.BAD = [
				"$",
				"{{ secrets.FW_BETA_PUBLISH_TOKEN }}",
			].join("");
		},
	]) {
		const changed = structuredClone(workflow);
		mutate(changed);
		assert.throws(() => validate(changed));
	}
});
test("all four publishers retain queued customer runs", () => {
	for (const name of [
		"payload-beta-release",
		"payload-promote",
		"payload-promote-commit",
		"payload-activation",
	]) {
		const workflow = parse(
			fs.readFileSync(
				new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
				"utf8",
			),
		);
		const concurrency =
			name === "payload-beta-release"
				? workflow.jobs["beta-release"].concurrency
				: workflow.concurrency;
		assert.equal(concurrency.group, "payload-release");
		assert.equal(concurrency.queue, "max");
		assert.notEqual(concurrency["cancel-in-progress"], true);
	}
});
test("embedded receiver scripts parse as JavaScript and shell", async () => {
	const { execFileSync } = await import("node:child_process");
	const workflow = parse(
		fs.readFileSync(
			new URL(
				"../../.github/workflows/payload-beta-release.yml",
				import.meta.url,
			),
			"utf8",
		),
	);
	for (const job of Object.values(workflow.jobs))
		for (const step of job.steps) {
			if (step.with?.script)
				new (Object.getPrototypeOf(async () => {}).constructor)(
					step.with.script,
				);
			if (step.run) {
				execFileSync("bash", ["-n"], { input: step.run });
				const embedded = step.run.match(/<<'NODE'\n([\s\S]*?)\nNODE/);
				if (embedded)
					execFileSync(process.execPath, ["--check", "--input-type=module"], {
						input: embedded[1],
					});
			}
		}
});
test("the actual embedded preflight rejects wrong refs and tuples and the inactive job only writes a receipt", async () => {
	const workflow = parse(
		fs.readFileSync(
			new URL(
				"../../.github/workflows/payload-beta-release.yml",
				import.meta.url,
			),
			"utf8",
		),
	);
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
	const preflight = new AsyncFunction(
		"process",
		"core",
		"github",
		"context",
		workflow.jobs.preflight.steps[0].with.script,
	);
	const env = {
		GITHUB_REF: "refs/heads/main",
		GITHUB_EVENT_NAME: "workflow_dispatch",
		FW_BETA_SCHEDULER_OWNER: "bridge",
		FW_ENDPOINT: "",
		EXPECTED_PROJECT_KEY: "flywheel",
		PROJECT_KEY: "flywheel",
		SCHEDULE_KEY: "a".repeat(64),
		SOURCE_COMMIT: "b".repeat(40),
	};
	const outputs = {};
	const core = {
		setOutput: (k, v) => {
			outputs[k] = v;
		},
	};
	const github = {
		rest: {
			actions: { getWorkflowRun: async () => ({ data: { workflow_id: 2 } }) },
		},
	};
	const context = { repo: { owner: "test", repo: "a" }, runId: 3 };
	await preflight({ env }, core, github, context);
	assert.deepEqual(outputs, {
		eligible: "true",
		activated: "false",
		bridge: "true",
		workflow_id: "2",
	});
	for (const patch of [
		{ GITHUB_REF: "refs/heads/other" },
		{ PROJECT_KEY: "other" },
		{ SCHEDULE_KEY: "" },
		{ RELEASE_ID_INPUT: "force" },
	])
		await assert.rejects(
			preflight({ env: { ...env, ...patch } }, core, github, context),
		);
	const paths = [];
	let receipt;
	const script = new AsyncFunction(
		"process",
		"require",
		workflow.jobs["not-activated-receipt"].steps[0].with.script,
	);
	const onlyFs = (name) => {
		assert.equal(name, "node:fs");
		return {
			mkdirSync: (p) => paths.push(p),
			writeFileSync: (p, data) => {
				paths.push(p);
				receipt = JSON.parse(data);
			},
		};
	};
	await script(
		{
			env: {
				...env,
				GITHUB_REPOSITORY_ID: "1",
				GITHUB_RUN_ID: "3",
				WORKFLOW_ID: "2",
				RUNNER_TEMP: "/test/tmp",
			},
		},
		onlyFs,
	);
	assert.deepEqual(paths, [
		"/test/tmp/beta-schedule-receipt",
		"/test/tmp/beta-schedule-receipt/receipt.json",
	]);
	assert.equal(receipt.outcome, "not_activated");
	assert.equal(receipt.publishedVersion, null);
	assert.equal(receipt.repositoryId, 1);
	assert.equal(receipt.workflowId, 2);
	assert.equal(receipt.runId, 3);
});
