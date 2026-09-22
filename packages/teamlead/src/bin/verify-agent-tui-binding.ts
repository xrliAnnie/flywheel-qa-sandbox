#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
	legacyTuiBindingExpectation,
	verifyAgentTuiBinding,
} from "../lead-backends/codex/agent-tui-binding.js";

type Input = {
	observed?: unknown;
	grammar?: unknown;
	legacy?: {
		codexHome?: unknown;
		cwd?: unknown;
		threadId?: unknown;
		codexBin?: unknown;
	};
	capability?: {
		codexHome?: unknown;
		cwd?: unknown;
		threadId?: unknown;
		codexBin?: unknown;
		projectName?: unknown;
		leadId?: unknown;
		remoteSocket?: unknown;
	};
};

function main(): number {
	let input: Input;
	try {
		const raw = readFileSync(0);
		if (raw.byteLength === 0 || raw.byteLength > 262_144) return 64;
		input = JSON.parse(raw.toString("utf8")) as Input;
	} catch {
		return 64;
	}
	if (input.grammar === "capability-v2") {
		const capability = input.capability;
		if (
			typeof input.observed !== "string" ||
			!capability ||
			[
				capability.codexHome,
				capability.cwd,
				capability.threadId,
				capability.codexBin,
				capability.projectName,
				capability.leadId,
				capability.remoteSocket,
			].some((value) => typeof value !== "string")
		)
			return 64;
		const verdict = verifyAgentTuiBinding(input.observed, {
			kind: "capability-v2",
			codexHome: capability.codexHome as string,
			cwd: capability.cwd as string,
			threadId: capability.threadId as string,
			codexBin: capability.codexBin as string,
			projectName: capability.projectName as string,
			leadId: capability.leadId as string,
			remoteSocket: capability.remoteSocket as string,
		});
		process.stdout.write(`${JSON.stringify(verdict)}\n`);
		return verdict.ok ? 0 : 1;
	}
	const legacy = input.legacy;
	if (
		typeof input.observed !== "string" ||
		!legacy ||
		typeof legacy.codexHome !== "string" ||
		typeof legacy.cwd !== "string" ||
		typeof legacy.threadId !== "string" ||
		!(
			[undefined, false].includes(legacy.codexBin as undefined | false) ||
			typeof legacy.codexBin === "string"
		)
	)
		return 64;
	const verdict = verifyAgentTuiBinding(input.observed, {
		kind: "legacy",
		...legacyTuiBindingExpectation({
			codexHome: legacy.codexHome,
			cwd: legacy.cwd,
			threadId: legacy.threadId,
			...(legacy.codexBin === false
				? { codexBin: false as const }
				: typeof legacy.codexBin === "string"
					? { codexBin: legacy.codexBin }
					: {}),
		}),
	});
	process.stdout.write(`${JSON.stringify(verdict)}\n`);
	return verdict.ok ? 0 : 1;
}

process.exitCode = main();
