import assert from "node:assert/strict";
import { test } from "node:test";
import {
	JUDGMENT_PROMPT,
	judgmentModelSnapshot,
} from "../../packages/teamlead/dist/ship-judgment/subscription-evaluator.js";
import { replayJudgment } from "../replay-ship-judgment.mjs";

const packet = () => ({
	questionId: "qa-fixture",
	channelId: "qa-channel",
	bindingDigest: "a".repeat(64),
	targets: [
		{
			repo_identity: "repo",
			pr_number: 1,
			head_sha: "b".repeat(40),
			diff_base_sha: "c".repeat(40),
		},
	],
	sources: [],
	files: [],
	requirements: [],
	prompt: JUDGMENT_PROMPT,
	model: judgmentModelSnapshot(),
});
test("replay saves raw output and production validation without passing QA expectations into the model", async () => {
	const input = Buffer.from(JSON.stringify(packet()));
	let calls = 0;
	const raw = JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "invalid model output",
	});
	const report = await replayJudgment(input, {
		bin: "/fixture/model",
		run: async (options) => {
			calls++;
			assert.deepEqual(JSON.parse(options.input), packet());
			return { ok: true, spawned: true, stdout: raw };
		},
	});
	assert.equal(calls, 1);
	assert.equal(report.rawEnvelope, raw);
	assert.equal(report.evaluation.resultCode, "output_schema_invalid");
	assert.equal(report.evaluation.alignment, "undetermined");
	assert.equal(report.acceptance, "not_assessed");
	assert.equal(report.authorityWrites, 0);
	assert.match(report.inputSha256, /^[a-f0-9]{64}$/);
});
test("rejects oversized or answer-bearing packets before starting the model; failures are not QA passes", async () => {
	let calls = 0;
	const options = {
		bin: "/fixture/model",
		run: async () => {
			calls++;
			return { ok: false, spawned: false, reason: "model_spawn_failed" };
		},
	};
	await assert.rejects(
		replayJudgment(Buffer.alloc(98305), options),
		/input_budget_exceeded/,
	);
	await assert.rejects(
		replayJudgment(
			Buffer.from(JSON.stringify({ ...packet(), expected: "can" })),
			options,
		),
	);
	assert.equal(calls, 0);
	const report = await replayJudgment(
		Buffer.from(JSON.stringify(packet())),
		options,
	);
	assert.equal(report.spawned, false);
	assert.equal(report.rawEnvelope, null);
	assert.equal(report.evaluation.resultCode, "model_spawn_failed");
	assert.equal(report.acceptance, "not_assessed");
});

test("CLI refuses existing artifacts before model work and records real spawn failure", async () => {
	const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { runReplay } = await import("../replay-ship-judgment.mjs");
	const root = await mkdtemp(join(tmpdir(), "judgment-replay-test-"));
	try {
		const source = join(root, "input.json"),
			output = join(root, "report.json");
		const original = JSON.stringify(packet());
		await writeFile(source, original);
		await assert.rejects(
			runReplay([
				"--input",
				source,
				"--output",
				source,
				"--bin",
				join(root, "absent-model"),
			]),
			/EEXIST/,
		);
		assert.equal(await readFile(source, "utf8"), original);
		const report = await runReplay([
			"--input",
			source,
			"--output",
			output,
			"--bin",
			join(root, "absent-model"),
		]);
		assert.equal(report.spawned, false);
		assert.equal(report.transport, "isolated_subscription_process");
		assert.equal(report.acceptance, "not_assessed");
		assert.deepEqual(JSON.parse(await readFile(output, "utf8")), report);
		await assert.rejects(
			runReplay([
				"--input",
				source,
				"--output",
				output,
				"--bin",
				join(root, "absent-model"),
			]),
			/EEXIST/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
