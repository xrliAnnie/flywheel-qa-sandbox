import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const expression = (name) => ["$", "{{ ", name, " }}"].join("");
const source = readFileSync(
	new URL("../../.github/workflows/payload-auto-release.yml", import.meta.url),
	"utf8",
);
const workflow = JSON.parse(
	execFileSync(
		"python3",
		[
			"-c",
			"import sys,json,yaml;print(json.dumps(yaml.safe_load(sys.stdin.read())))",
		],
		{ input: source, encoding: "utf8" },
	),
);
function verify(w) {
	const trigger = w.on ?? w.true;
	assert.deepEqual(Object.keys(trigger), ["workflow_dispatch"]);
	assert.deepEqual(trigger.workflow_dispatch.inputs.operation.options, [
		"execute",
		"fence",
	]);
	assert.equal(trigger.workflow_dispatch.inputs.operation.default, "execute");
	assert.deepEqual(w.permissions, { contents: "read" });
	assert.equal(w.concurrency.group, "payload-release");
	assert.equal(w.concurrency.queue, "max");
	assert.equal(w.concurrency["cancel-in-progress"], undefined);
	assert.deepEqual(Object.keys(w.jobs), ["execute"]);
	const j = w.jobs.execute;
	assert.equal(j.environment, "release-auto");
	assert.match(j.if, /github.ref == 'refs\/heads\/main'/);
	assert.match(j.if, /github.event_name == 'workflow_dispatch'/);
	const secrets =
		JSON.stringify(w).match(/secrets\.[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
	assert.deepEqual(
		[...new Set(secrets)],
		["secrets.FW_AUTO_RELEASE_EXECUTOR_TOKEN"],
	);
	const guard = j.steps.find(
		(s) => s.name === "Validate immutable workflow and inputs",
	);
	assert.ok(guard);
	assert.equal(j.steps[0], guard);
	assert.equal(
		guard.env.REVIEWED_CODE_SHA,
		expression("vars.FW_AUTO_RELEASE_CODE_SHA"),
	);
	assert.equal(guard.env.WORKFLOW_SHA, expression("github.workflow_sha"));
	assert.match(guard.run, /WORKFLOW_SHA.*REVIEWED_CODE_SHA/);
	assert.match(guard.run, /\{40\}/);
	const checkout = j.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
	assert.equal(checkout.with.ref, expression("vars.FW_AUTO_RELEASE_CODE_SHA"));
	assert.equal(checkout.with["persist-credentials"], false);
	for (const s of j.steps) if (s.uses) assert.match(s.uses, /@[a-f0-9]{40}$/);
	const execute = j.steps.find((s) => s.id === "attempt");
	assert.ok(execute);
	assert.equal(
		execute.env.FW_AUTO_RELEASE_EXECUTOR_TOKEN,
		expression("secrets.FW_AUTO_RELEASE_EXECUTOR_TOKEN"),
	);
	assert.match(execute.run, /node scripts\/release\/payload-auto-release.mjs/);
	assert.match(execute.run, /--attempt-id/);
	assert.match(execute.run, /--operation/);
	assert.equal(
		execute.env.OPERATION,
		expression("inputs.operation || 'execute'"),
	);
	assert.match(execute.env.FW_AUTO_RELEASE_RECEIPT_FILE, /runner.temp/);
	const artifact = j.steps.find((s) =>
		s.uses?.startsWith("actions/upload-artifact@"),
	);
	assert.equal(artifact.if, "always()");
	assert.equal(artifact.with.path, execute.env.FW_AUTO_RELEASE_RECEIPT_FILE);
	const commands = j.steps.map((s) => s.run ?? "").join("\n");
	assert.doesNotMatch(
		commands,
		/pnpm|npm |build|payload-promote.mjs|\/admin\/manifest|\$\{\{\s*inputs\./,
	);
}
test("auto release workflow has fixed reviewed code, single queue, narrow capability and durable recovery artifact", () =>
	verify(workflow));
for (const mutate of [
	(w) => {
		w.jobs.execute.environment = "release";
	},
	(w) => {
		w.jobs.execute.if = "true";
	},
	(w) => {
		w.jobs.execute.steps[0].env.WORKFLOW_SHA = "fake";
	},
	(w) => {
		w.jobs.execute.steps.find((s) =>
			s.uses?.startsWith("actions/checkout@"),
		).with.ref = "main";
	},
	(w) => {
		w.jobs.execute.steps.find((s) => s.id === "attempt").env.BAD = expression(
			"secrets.FW_CUSTOMER_RELEASE_TOKEN",
		);
	},
	(w) => {
		w.jobs.execute.steps.find((s) =>
			s.uses?.startsWith("actions/upload-artifact@"),
		).if = "success()";
	},
	(w) => {
		w.jobs.execute.steps.find((s) => s.id === "attempt").run +=
			"\nnpm run build";
	},
	(w) => {
		w.concurrency["cancel-in-progress"] = true;
	},
])
	test("workflow guard rejects privilege, pin, recovery or build mutation", () => {
		const copy = structuredClone(workflow);
		mutate(copy);
		assert.throws(() => verify(copy));
	});

test("fence dispatch guard requires exact recovery attempt and rejects unknown operations", () => {
	const guard = workflow.jobs.execute.steps[0];
	const run = (patch) =>
		spawnSync("bash", ["-c", guard.run], {
			env: {
				...process.env,
				REVIEWED_CODE_SHA: "a".repeat(40),
				WORKFLOW_SHA: "a".repeat(40),
				CYCLE_ID: "cycle-1",
				RELEASE_ID: "candidate",
				BINDING_DIGEST: "b".repeat(64),
				ATTEMPT_ID: "",
				OPERATION: "execute",
				...patch,
			},
			encoding: "utf8",
		}).status;
	assert.equal(run({}), 0);
	assert.notEqual(run({ OPERATION: "fence" }), 0);
	assert.notEqual(run({ OPERATION: "other" }), 0);
	assert.equal(
		run({
			OPERATION: "fence",
			ATTEMPT_ID: "12345678-1234-1234-1234-123456789abc",
		}),
		0,
	);
});

test("Bridge dispatches expose a bounded persistent recovery marker in both workflow run titles", () => {
	const prepare = JSON.parse(
		execFileSync(
			"python3",
			[
				"-c",
				'import json,yaml; print(json.dumps(yaml.safe_load(open(".github/workflows/payload-promote.yml"))))',
			],
			{ encoding: "utf8" },
		),
	);
	for (const [w, operationInput] of [
		[workflow, "inputs.operation"],
		[prepare, "inputs.mode"],
	]) {
		assert.equal(
			w["run-name"],
			`customer-release:${expression("inputs.dispatch-id || github.run_id")}:${expression(operationInput)}:${expression("inputs.release-id")}`,
		);
		assert.equal(
			(w.on ?? w.true).workflow_dispatch.inputs["dispatch-id"].required,
			false,
		);
		const job = Object.values(w.jobs)[0];
		const guard = job.steps[0];
		assert.equal(guard.env.DISPATCH_ID, expression("inputs.dispatch-id"));
		assert.match(guard.run, /invalid dispatch identity/);
	}
});
