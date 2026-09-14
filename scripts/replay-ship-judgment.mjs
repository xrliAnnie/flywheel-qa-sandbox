#!/usr/bin/env node
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frozenPacketSchema } from "../packages/teamlead/dist/ship-judgment/contract.js";
import { evaluateSubscription } from "../packages/teamlead/dist/ship-judgment/subscription-evaluator.js";
import { runSubscriptionProcess } from "../packages/teamlead/dist/ship-judgment/subscription-process.js";

/** One frozen input and one isolated production evaluator call. No database, bot, approval or retry. */
export async function replayJudgment(input, options) {
	if (!Buffer.isBuffer(input) || input.length > 98304)
		throw new Error("input_budget_exceeded");
	const packet = frozenPacketSchema.parse(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)),
	);
	let rawEnvelope = null;
	const result = await evaluateSubscription(packet, {
		bin: options.bin,
		signal: options.signal,
		run: async (processOptions) => {
			const response = await (options.run ?? runSubscriptionProcess)(
				processOptions,
			);
			if (response.ok) rawEnvelope = response.stdout;
			return response;
		},
	});
	return {
		schemaVersion: 1,
		inputSha256: createHash("sha256").update(input).digest("hex"),
		model: packet.model,
		targets: packet.targets,
		questionId: packet.questionId,
		transport: options.run
			? "injected_test_transport"
			: "isolated_subscription_process",
		acceptance: "not_assessed",
		authorityWrites: 0,
		rawEnvelope,
		...result,
	};
}

export async function runReplay(args) {
	const values = {};
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i],
			value = args[i + 1];
		if (
			!["--input", "--output", "--bin"].includes(key) ||
			!value ||
			values[key]
		)
			throw new Error(
				"usage: --input frozen.json --output new-report.json --bin /absolute/model-binary",
			);
		values[key] = value;
	}
	if (Object.keys(values).length !== 3 || !isAbsolute(values["--bin"]))
		throw new Error("input_output_absolute_bin_required");
	const source = await open(values["--input"], "r");
	let input;
	try {
		const buffer = Buffer.alloc(98305);
		let bytes = 0;
		while (bytes < buffer.length) {
			const result = await source.read(
				buffer,
				bytes,
				buffer.length - bytes,
				null,
			);
			if (!result.bytesRead) break;
			bytes += result.bytesRead;
		}
		if (bytes > 98304) throw new Error("input_budget_exceeded");
		input = buffer.subarray(0, bytes);
	} finally {
		await source.close();
	}
	// Refuse overwrite before spending a model call; reserve the new local artifact.
	const output = await open(values["--output"], "wx", 0o600);
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.on("SIGINT", abort);
	process.on("SIGTERM", abort);
	try {
		const report = await replayJudgment(input, {
			bin: values["--bin"],
			signal: controller.signal,
		});
		await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
		return report;
	} finally {
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
		await output.close();
	}
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	runReplay(process.argv.slice(2))
		.then((report) => {
			if (!report.spawned || report.evaluation.resultCode !== "evaluated")
				process.exitCode = 1;
		})
		.catch(() => {
			process.stderr.write("ship_judgment_replay_failed\n");
			process.exitCode = 1;
		});
}
