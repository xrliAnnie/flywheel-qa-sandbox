import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
	new URL(
		"../../.github/workflows/payload-promote-commit.yml",
		import.meta.url,
	),
	"utf8",
);
const w = JSON.parse(
	execFileSync(
		"python3",
		[
			"-c",
			"import sys,json,yaml;print(json.dumps(yaml.safe_load(sys.stdin.read())))",
		],
		{ input: source, encoding: "utf8" },
	),
);
const expr = (name) => ["$", "{{ ", name, " }}"].join("");
function verify(workflow) {
	const j = workflow.jobs.commit,
		steps = j.steps,
		inputs = (workflow.on ?? workflow.true).workflow_dispatch.inputs;
	for (const field of ["cycle-id", "binding-digest", "attempt-id"])
		assert.equal(inputs[field].required, false);
	assert.equal(j.environment, "release");
	const legacy = steps.find(
		(s) => s.name === "Validate production manifest snapshot",
	);
	assert.equal(legacy.if, "inputs.cycle-id == ''");
	const run = steps.find((s) => s.name === "Run commit");
	assert.equal(
		run.env.FW_CUSTOMER_RELEASE_TOKEN,
		expr("inputs.cycle-id == '' && secrets.FW_CUSTOMER_RELEASE_TOKEN || ''"),
	);
	assert.equal(
		run.env.FW_AUTO_RELEASE_EXECUTOR_TOKEN,
		expr(
			"inputs.cycle-id != '' && secrets.FW_AUTO_RELEASE_EXECUTOR_TOKEN || ''",
		),
	);
	for (const flag of ["cycle-id", "binding-digest", "attempt-id"])
		assert.ok(run.run.includes(`--${flag}`));
	const recovery = steps.find(
		(s) => s.name === "Preserve manual attempt recovery receipt",
	);
	assert.equal(recovery.if, "always() && inputs.cycle-id != ''");
	assert.equal(recovery.with.path, run.env.FW_AUTO_RELEASE_RECEIPT_FILE);
	assert.match(recovery.uses, /^actions\/upload-artifact@[a-f0-9]{40}$/);
}
test("manual workflow routes decision inputs to isolated executor and preserves legacy mode", () =>
	verify(w));
for (const mutate of [
	(w) => {
		w.jobs.commit.steps.find(
			(s) => s.name === "Run commit",
		).env.FW_CUSTOMER_RELEASE_TOKEN = expr("secrets.FW_CUSTOMER_RELEASE_TOKEN");
	},
	(w) => {
		w.jobs.commit.steps.find(
			(s) => s.name === "Validate production manifest snapshot",
		).if = "always()";
	},
	(w) => {
		w.jobs.commit.steps.find(
			(s) => s.name === "Preserve manual attempt recovery receipt",
		).if = "success()";
	},
])
	test("manual workflow isolation guard rejects mutation", () => {
		const copy = structuredClone(w);
		mutate(copy);
		assert.throws(() => verify(copy));
	});
test("manual workflow input guard requires complete decision identity and rejects it on withdraw/abandon", () => {
	const guard = w.jobs.commit.steps[0];
	const values = {
		GH_REF: "refs/heads/main",
		GH_EVENT: "workflow_dispatch",
		CONFIRM_INPUT: "COMMIT",
		ACTION_INPUT: "commit",
		RELEASE_ID_INPUT: "manual-new",
		EXPECTED_SHA256_INPUT: "a".repeat(64),
		WITHDRAW_VERSION_INPUT: "",
		FALLBACK_VERSION_INPUT: "",
		ALLOW_PAUSE_INPUT: "false",
		CYCLE_ID_INPUT: "cycle-1",
		BINDING_DIGEST_INPUT: "b".repeat(64),
		ATTEMPT_ID_INPUT: "",
	};
	const run = (patch) =>
		execFileSync("bash", ["-c", guard.run], {
			env: { ...process.env, ...values, ...patch },
			stdio: "pipe",
		});
	run({});
	for (const patch of [
		{ CYCLE_ID_INPUT: "" },
		{ BINDING_DIGEST_INPUT: "bad" },
		{ ATTEMPT_ID_INPUT: "bad" },
		{ CYCLE_ID_INPUT: "../x" },
		{ ACTION_INPUT: "abandon", EXPECTED_SHA256_INPUT: "" },
		{
			ACTION_INPUT: "withdraw",
			RELEASE_ID_INPUT: "",
			EXPECTED_SHA256_INPUT: "",
			WITHDRAW_VERSION_INPUT: "1.55.0",
		},
	])
		assert.throws(() => run(patch));
	run({ CYCLE_ID_INPUT: "", BINDING_DIGEST_INPUT: "" });
});
