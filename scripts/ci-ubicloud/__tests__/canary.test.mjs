import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(
	new URL("../../../packages/teamlead/package.json", import.meta.url),
);
const { parse } = require("yaml");

const githubExpression = (body) => `\${{ ${body} }}`;
const runnerExpression = githubExpression(
	"inputs.runner == 'ubicloud-standard-2' && 'ubicloud-standard-2' || 'ubuntu-latest'",
);
const sourceFixtureUrl = new URL("../fixtures/ci-source.yml", import.meta.url);
const sourceFixtureSha256 =
	"710f6e255daa24691eaff115e89acdc8f07bcd024e324b32454971f6a53e7286";
const canaryUrl = new URL(
	"../../../.github/workflows/ci-ubicloud-canary.yml",
	import.meta.url,
);
const actionlintConfigUrl = new URL(
	"../../../.github/actionlint.yaml",
	import.meta.url,
);

const clone = (value) => structuredClone(value);

function wrapperStep(step) {
	return typeof step?.name === "string" && step.name.startsWith("Canary —");
}

function normalizedCopiedSteps(steps) {
	return steps
		.filter((step) => !wrapperStep(step))
		.map((step) => {
			const normalized = clone(step);
			if (normalized.uses === "actions/checkout@v4") {
				assert.equal(
					normalized.with?.["persist-credentials"],
					false,
					"canary checkout must not persist the repository credential",
				);
				delete normalized.with["persist-credentials"];
				if (Object.keys(normalized.with).length === 0) delete normalized.with;
			}
			return normalized;
		});
}

function expectedCopiedJob(sourceJob, { name, matrixEntry, condition }) {
	const expected = clone(sourceJob);
	expected.name = name;
	expected["runs-on"] = runnerExpression;
	expected.needs = ["preflight"];
	expected.if = condition;
	if (matrixEntry) expected.strategy.matrix.include = [matrixEntry];
	return expected;
}

function actualCopiedJob(canaryJob) {
	const actual = clone(canaryJob);
	actual.steps = normalizedCopiedSteps(actual.steps);
	return actual;
}

function validateParity(workflow, source) {
	const payloadCondition = githubExpression(
		"needs.preflight.result == 'success' && inputs.capacity == '0'",
	);
	const sourceUnit = source.jobs["unit-tests"];
	const matrixEntry = sourceUnit.strategy.matrix.include.find(
		(entry) => entry.name === "teamlead 1 of 4",
	);
	assert.ok(matrixEntry, "frozen source must contain teamlead 1 of 4");

	for (const [canaryId, sourceId, name, selectedEntry] of [
		["quick-gate", "quick-gate", "Ubicloud Canary / Quick Gate", undefined],
		[
			"unit-tests",
			"unit-tests",
			`Ubicloud Canary / Unit (${githubExpression("matrix.name")})`,
			matrixEntry,
		],
		[
			"script-tests-2",
			"script-tests-2",
			"Ubicloud Canary / Script 2",
			undefined,
		],
	]) {
		const expected = expectedCopiedJob(source.jobs[sourceId], {
			name,
			matrixEntry: selectedEntry,
			condition: payloadCondition,
		});
		assert.deepEqual(
			actualCopiedJob(workflow.jobs[canaryId]),
			expected,
			`${canaryId} must preserve the frozen source workload`,
		);
	}
}

function validateIsolation(workflow) {
	const paths = [
		"/tmp/fly2684-vm-sentinel",
		"$HOME/.fly2684-vm-sentinel",
		"/var/tmp/fly2684-vm-sentinel",
	];
	const writer = workflow.jobs["isolation-write"];
	const reader = workflow.jobs["isolation-read"];
	assert.deepEqual(reader.needs, ["preflight", "isolation-write"]);
	assert.equal(writer["runs-on"], runnerExpression);
	assert.equal(reader["runs-on"], runnerExpression);
	const writerRun = writer.steps.map((step) => step.run ?? "").join("\n");
	const readerRun = reader.steps.map((step) => step.run ?? "").join("\n");
	for (const sentinel of paths) {
		assert.match(writerRun, new RegExp(sentinel.replaceAll("$", "\\$")));
		assert.match(readerRun, new RegExp(sentinel.replaceAll("$", "\\$")));
	}
	assert.match(writerRun, /test ! -e/);
	assert.match(readerRun, /test ! -e/);
	assert.match(writerRun, /test -s/);
	assert.match(readerRun, /\/proc\/sys\/kernel\/random\/boot_id/);
	assert.doesNotMatch(
		`${writerRun}\n${readerRun}`,
		/github\.run_id|GITHUB_RUN_ID/,
	);
	assert.doesNotMatch(writerRun, /\brm\b|\bunlink\b|\btrap\b/);
	assert.doesNotMatch(
		readerRun,
		/printf.+fly2684-vm-sentinel|\brm\b|\bunlink\b/,
	);
}

function validateSecretProbe(workflow, raw) {
	const probe = workflow.jobs["quick-gate"].steps.find(
		(step) => step.env?.CANARY_PROBE,
	);
	assert.ok(probe, "dedicated secret probe must be present");
	assert.equal(
		probe.env.CANARY_PROBE,
		githubExpression("secrets.UBICLOUD_CANARY_PROBE"),
	);
	assert.match(probe.run, /set \+x/);
	assert.match(probe.run, /test -n "\$CANARY_PROBE"/);
	assert.match(probe.run, /secret_present=true/);
	assert.doesNotMatch(
		probe.run,
		/echo.+CANARY_PROBE|printf.+CANARY_PROBE|sha|base64/,
	);
	assert.doesNotMatch(raw, /toJSON\((?:secrets|env)\)|set -x|upload-artifact/);
}

function validateCapacity(workflow) {
	const job = workflow.jobs["capacity-probe"];
	assert.equal(job["runs-on"], runnerExpression);
	assert.equal(job["timeout-minutes"], 10);
	assert.equal(job.strategy["fail-fast"], false);
	assert.equal(job.strategy["max-parallel"], 54);
	assert.equal(
		job.strategy.matrix.slot,
		githubExpression("fromJSON(needs.preflight.outputs.slots)"),
	);
	assert.deepEqual(job.needs, ["preflight"]);
	assert.equal(job.steps.length, 1);
	assert.match(job.steps[0].run, /^sleep 180\s*$/);
}

function validateCacheProbe(workflow) {
	for (const id of ["quick-gate", "unit-tests", "script-tests-2"]) {
		const step = workflow.jobs[id].steps.find(
			(candidate) => candidate.id === "cache-probe",
		);
		assert.ok(step, `${id} must contain the non-secret cache probe`);
		assert.equal(step.uses, "actions/cache@v4");
		assert.equal(
			step.with.path,
			`${githubExpression("runner.temp")}/fly2684-cache-probe`,
		);
		assert.match(step.with.key, /inputs\.runner/);
		assert.match(step.with.key, /github\.job/);
		assert.match(step.with.key, /hashFiles\('pnpm-lock\.yaml'\)/);
	}
}

function validateDiagnosticSteps(workflow) {
	for (const [jobId, job] of Object.entries(workflow.jobs)) {
		for (const step of job.steps ?? []) {
			assert.ok(
				!step.name?.startsWith("Canary -"),
				`${jobId} uses an unrecognized canary wrapper prefix`,
			);
			assert.doesNotMatch(
				step.run ?? "",
				/(?:^|\n)\s*(?:env|printenv)(?:\s|$)/,
				`${jobId} must not dump the runner environment`,
			);
		}
	}
}

function validateCanary(workflow, source, raw) {
	assert.equal(workflow.name, "Ubicloud Canary");
	assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
	assert.deepEqual(workflow.on.workflow_dispatch.inputs.runner.options, [
		"ubuntu-latest",
		"ubicloud-standard-2",
	]);
	assert.deepEqual(workflow.on.workflow_dispatch.inputs.capacity.options, [
		"0",
		"1",
		"8",
		"33",
		"54",
	]);
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.equal(
		workflow.concurrency.group,
		`ubicloud-canary-${githubExpression("github.ref")}`,
	);
	assert.equal(workflow.concurrency["cancel-in-progress"], false);

	const jobs = workflow.jobs;
	assert.deepEqual(Object.keys(jobs), [
		"preflight",
		"quick-gate",
		"unit-tests",
		"script-tests-2",
		"isolation-write",
		"isolation-read",
		"capacity-probe",
		"result",
	]);
	for (const [id, job] of Object.entries(jobs)) {
		assert.ok(
			Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] > 0,
			`${id} must have a positive timeout`,
		);
		assert.notEqual(job.name, "CI OK");
		assert.notEqual(job.name, "CI Scope OK");
	}
	assert.doesNotMatch(raw, /name:\s*(?:CI OK|CI Scope OK)\s*$/m);
	assert.doesNotMatch(
		raw,
		/(?:^|\s)[&*]a\d+\b/m,
		"workflow must not rely on YAML aliases",
	);

	const preflight = jobs.preflight;
	assert.equal(preflight["runs-on"], "ubuntu-latest");
	assert.equal(
		preflight.env.CANARY_AUTHORIZED,
		githubExpression("vars.UBICLOUD_CANARY_AUTHORIZED"),
	);
	assert.equal(
		preflight.env.DEFAULT_BRANCH_REF,
		`refs/heads/${githubExpression("github.event.repository.default_branch")}`,
	);
	const preflightRun = preflight.steps.map((step) => step.run ?? "").join("\n");
	assert.match(preflightRun, /xrliAnnie\/flywheel/);
	assert.match(preflightRun, /workflow_dispatch/);
	assert.match(preflightRun, /DEFAULT_BRANCH_REF/);
	assert.match(preflightRun, /ubuntu-latest\|ubicloud-standard-2/);
	assert.match(preflightRun, /0\|1\|8\|33\|54/);
	assert.match(preflightRun, /CANARY_AUTHORIZED.+true/);

	validateParity(workflow, source);
	validateIsolation(workflow);
	validateSecretProbe(workflow, raw);
	validateCapacity(workflow);
	validateCacheProbe(workflow);
	validateDiagnosticSteps(workflow);

	const result = jobs.result;
	assert.equal(result["runs-on"], "ubuntu-latest");
	assert.deepEqual(result.needs, [
		"preflight",
		"quick-gate",
		"unit-tests",
		"script-tests-2",
		"isolation-write",
		"isolation-read",
		"capacity-probe",
	]);
	assert.equal(result.if, githubExpression("always()"));
	const resultRun = result.steps.map((step) => step.run ?? "").join("\n");
	assert.match(resultRun, /\$needs\["preflight"\]\.result == "success"/);
	const payloadJobs =
		'["quick-gate", "unit-tests", "script-tests-2", "isolation-write", "isolation-read"]';
	assert.equal(
		resultRun.split(payloadJobs).length - 1,
		2,
		"result must verify every payload job in both canary modes",
	);
	assert.match(resultRun, /\$needs\["capacity-probe"\]\.result == "success"/);
	assert.match(resultRun, /\$needs\["capacity-probe"\]\.result == "skipped"/);
}

test("canary workflow is manual, bounded, isolated, and source-equivalent", () => {
	const sourceRaw = fs.readFileSync(sourceFixtureUrl, "utf8");
	assert.equal(
		crypto.createHash("sha256").update(sourceRaw).digest("hex"),
		sourceFixtureSha256,
		"frozen source fixture changed without re-baselining",
	);
	const raw = fs.readFileSync(canaryUrl, "utf8");
	validateCanary(parse(raw), parse(sourceRaw), raw);

	const actionlintConfig = parse(fs.readFileSync(actionlintConfigUrl, "utf8"));
	assert.deepEqual(actionlintConfig, {
		"self-hosted-runner": { labels: ["ubicloud-standard-2"] },
	});
});

test("canary validator rejects security and parity regressions", () => {
	const sourceRaw = fs.readFileSync(sourceFixtureUrl, "utf8");
	const raw = fs.readFileSync(canaryUrl, "utf8");
	const source = parse(sourceRaw);
	const original = parse(raw);
	const mutations = [
		(workflow) => {
			workflow.on.push = {};
		},
		(workflow) => {
			workflow.jobs.result.name = "CI OK";
		},
		(workflow) => {
			workflow.permissions.actions = "write";
		},
		(workflow) => {
			workflow.on.workflow_dispatch.inputs.runner.options.push("arbitrary");
		},
		(workflow) => {
			workflow.jobs["quick-gate"].steps = workflow.jobs[
				"quick-gate"
			].steps.filter(
				(step) => step.name !== "Enforce FLY-2006 retention consumer gate",
			);
		},
		(workflow) => {
			delete workflow.jobs["unit-tests"].steps.find((step) =>
				step.name?.includes("FLY-1883 stub-hygiene pairing"),
			).if;
		},
		(workflow) => {
			workflow.jobs["script-tests-2"].steps = workflow.jobs[
				"script-tests-2"
			].steps.filter((step) => !step.name?.includes("capacity tripwire"));
		},
		(workflow) => {
			workflow.jobs["isolation-write"].steps[0].run = workflow.jobs[
				"isolation-write"
			].steps[0].run.replaceAll(
				"fly2684-vm-sentinel",
				"fly2684-$GITHUB_RUN_ID",
			);
		},
		(workflow) => {
			workflow.jobs["isolation-read"].needs = ["preflight"];
		},
		(workflow) => {
			workflow.jobs["quick-gate"].steps.find(
				(step) => step.env?.CANARY_PROBE,
			).run = "set +x\nprintf '%s\\n' 'secret_present=true'";
		},
		(workflow) => {
			workflow.jobs.result.steps[0].run =
				workflow.jobs.result.steps[0].run.replace(
					'$needs["preflight"].result == "success"',
					"true",
				);
		},
		(workflow) => {
			workflow.jobs.result.steps[0].run =
				workflow.jobs.result.steps[0].run.replace(', "isolation-read"', "");
		},
		(workflow) => {
			workflow.jobs.result.steps[0].run =
				workflow.jobs.result.steps[0].run.replace(
					'$needs["capacity-probe"].result == "success"',
					"true",
				);
		},
		(workflow) => {
			workflow.jobs["isolation-read"].steps.push({
				name: "Canary - dump env",
				run: "env",
			});
		},
	];
	for (const mutate of mutations) {
		const changed = clone(original);
		mutate(changed);
		assert.throws(() => validateCanary(changed, source, raw));
	}
});
