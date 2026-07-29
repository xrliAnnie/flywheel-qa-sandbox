#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseTargetManifest } from "./manifest.js";
import { adjudicateManual } from "./manual-adjudication.js";
import { rollbackT1, runCutover } from "./run.js";

export type CutoverCliOptions =
	| {
			verb: "run";
			targetPath: string;
			step?: number;
			yes: boolean;
	  }
	| {
			verb: "rollback-t1";
			targetPath: string;
	  }
	| {
			verb: "adjudicate-manual";
			targetPath: string;
			sourceKind: "discord" | "legacy-comm" | "legacy-json";
			sourceId: string;
			payloadDigest: string;
			disposition: "migrate" | "dead" | "tombstone";
			reason: string;
	  };

export function parseCutoverCliArgs(
	argv: readonly string[],
): CutoverCliOptions {
	const verb = argv[0];
	if (
		verb !== "run" &&
		verb !== "rollback-t1" &&
		verb !== "adjudicate-manual"
	) {
		throw new TypeError(
			"first argument must be run, rollback-t1, or adjudicate-manual",
		);
	}
	let targetPath: string | undefined;
	let step: number | undefined;
	let yes = false;
	let sourceKind: "discord" | "legacy-comm" | "legacy-json" | undefined;
	let sourceId: string | undefined;
	let payloadDigest: string | undefined;
	let disposition: "migrate" | "dead" | "tombstone" | undefined;
	let reason: string | undefined;
	for (let index = 1; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--yes") {
			if (verb !== "run") {
				throw new TypeError("rollback-t1 does not accept --yes");
			}
			if (yes) throw new TypeError("duplicate option --yes");
			yes = true;
			continue;
		}
		if (
			flag !== "--target" &&
			flag !== "--step" &&
			flag !== "--source-kind" &&
			flag !== "--source-id" &&
			flag !== "--payload-digest" &&
			flag !== "--disposition" &&
			flag !== "--reason"
		) {
			throw new TypeError(`unknown ${verb} option ${flag}`);
		}
		const value = argv[++index];
		if (!value || value.startsWith("--")) {
			throw new TypeError(`${flag} requires a value`);
		}
		if (flag === "--target") {
			if (targetPath) throw new TypeError("duplicate option --target");
			if (!isAbsolute(value)) {
				throw new TypeError("--target must be absolute");
			}
			targetPath = value;
		} else if (flag === "--step") {
			if (verb !== "run") {
				throw new TypeError(`${verb} does not accept --step`);
			}
			if (step !== undefined) throw new TypeError("duplicate option --step");
			step = Number(value);
			if (
				!Number.isSafeInteger(step) ||
				step < 1 ||
				step > 9 ||
				String(step) !== value
			) {
				throw new TypeError("--step must be a canonical integer in 1..9");
			}
		} else {
			if (verb !== "adjudicate-manual") {
				throw new TypeError(`${verb} does not accept ${flag}`);
			}
			if (flag === "--source-kind") {
				if (sourceKind) throw new TypeError("duplicate option --source-kind");
				if (
					value !== "discord" &&
					value !== "legacy-comm" &&
					value !== "legacy-json"
				) {
					throw new TypeError(
						"--source-kind must be discord, legacy-comm, or legacy-json",
					);
				}
				sourceKind = value;
			} else if (flag === "--source-id") {
				if (sourceId) throw new TypeError("duplicate option --source-id");
				sourceId = value.trim();
			} else if (flag === "--payload-digest") {
				if (payloadDigest) {
					throw new TypeError("duplicate option --payload-digest");
				}
				if (!/^[0-9a-f]{64}$/.test(value)) {
					throw new TypeError(
						"--payload-digest must be a lowercase SHA-256 digest",
					);
				}
				payloadDigest = value;
			} else if (flag === "--disposition") {
				if (disposition) {
					throw new TypeError("duplicate option --disposition");
				}
				if (value !== "migrate" && value !== "dead" && value !== "tombstone") {
					throw new TypeError(
						"--disposition must be migrate, dead, or tombstone",
					);
				}
				disposition = value;
			} else {
				if (reason) throw new TypeError("duplicate option --reason");
				reason = value.trim();
			}
		}
	}
	if (!targetPath) throw new TypeError("--target is required");
	if (verb === "run") {
		return {
			verb,
			targetPath,
			...(step === undefined ? {} : { step }),
			yes,
		};
	}
	if (verb === "rollback-t1") return { verb, targetPath };
	if (!sourceKind) throw new TypeError("--source-kind is required");
	if (!sourceId) throw new TypeError("--source-id is required");
	if (!payloadDigest) throw new TypeError("--payload-digest is required");
	if (!disposition) throw new TypeError("--disposition is required");
	if (!reason) throw new TypeError("--reason is required");
	return {
		verb,
		targetPath,
		sourceKind,
		sourceId,
		payloadDigest,
		disposition,
		reason,
	};
}

export interface FounderQuestionReader {
	question(query: string): Promise<string>;
	close(): void;
}

export function createFounderConfirmation(
	reader: FounderQuestionReader,
): (prompt: string) => Promise<string> {
	return (prompt) =>
		reader.question(
			`Founder confirmation required (${prompt}); enter the exact manifest phrase:\n`,
		);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const parsed = parseCutoverCliArgs(argv);
	const target = parseTargetManifest(
		JSON.parse(readFileSync(parsed.targetPath, "utf8")) as unknown,
	);
	if (parsed.verb === "rollback-t1") {
		await rollbackT1(target);
		process.stdout.write(
			`${JSON.stringify({ status: "rolled_back", windowId: target.windowId })}\n`,
		);
		return 0;
	}
	if (target.mode === "production" && !process.stdin.isTTY) {
		throw new Error("production cutover confirmations require an attended TTY");
	}
	if (parsed.verb === "adjudicate-manual") {
		const adjudication = adjudicateManual(target, {
			sourceKind: parsed.sourceKind,
			sourceId: parsed.sourceId,
			payloadDigest: parsed.payloadDigest,
			disposition: parsed.disposition,
			reason: parsed.reason,
		});
		process.stdout.write(
			`${JSON.stringify({
				status: "manual_adjudicated",
				adjudication,
			})}\n`,
		);
		return 0;
	}
	const reader = createInterface({
		input: process.stdin,
		output: process.stderr,
		terminal: Boolean(process.stdin.isTTY),
	});
	let result: Awaited<ReturnType<typeof runCutover>>;
	try {
		result = await runCutover(target, {
			...(parsed.step === undefined ? {} : { step: parsed.step }),
			yes: parsed.yes,
			confirm: createFounderConfirmation(reader),
		});
	} finally {
		reader.close();
	}
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return result.status === "done" ? 0 : 1;
}

const invokedPath = process.argv[1]
	? pathToFileURL(process.argv[1]).href
	: undefined;
if (invokedPath === import.meta.url) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(
				`flywheel-v2-cutover: ${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
			process.exitCode = 1;
		});
}
