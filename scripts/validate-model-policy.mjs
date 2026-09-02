#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configEntry =
	process.env.FLYWHEEL_CONFIG_DIST ??
	resolve(repoRoot, "packages/config/dist/index.js");

function fail(error) {
	const code =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: "MODEL_POLICY_ERROR";
	process.stderr.write(
		`${code}: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 2;
}

async function main() {
	const { getModelConfigSnapshot, validateModelWrite } = await import(
		pathToFileURL(configEntry).href
	);
	const snapshot = getModelConfigSnapshot();
	const command = process.argv[2];
	if (command === "fable-binding") {
		const model = snapshot.bindings.fable;
		const entry = snapshot.getModelRegistryEntry(model);
		process.stdout.write(
			JSON.stringify({
				model,
				contextWindowTokens: entry?.contextWindowTokens ?? null,
				revision: snapshot.revision,
			}),
		);
		return;
	}
	if (command === "model") {
		const raw = process.argv[3];
		const surface = process.argv[4] ?? "lead";
		if (raw === undefined) throw new Error("usage: model <id|null> [surface]");
		const canonical = validateModelWrite(raw === "null" ? null : raw, {
			surface,
			snapshot,
		});
		process.stdout.write(canonical ?? "null");
		return;
	}
	if (command === "changes-file") {
		const path = process.argv[3];
		if (!path) throw new Error("usage: changes-file <path> [surface]");
		const surface = process.argv[4] ?? "lead";
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(parsed?.changes))
			throw new Error("changes must be an array");
		for (const change of parsed.changes) {
			const raw = change?.to?.model;
			if (raw !== null && typeof raw !== "string") {
				throw new Error(`to.model must be string|null: ${String(change?.key)}`);
			}
			// In projects.json, null means authoritative absence, whose launch
			// semantics are the built-in Fable default. It is not the management
			// console's opaque account-default sentinel.
			validateModelWrite(raw === null ? snapshot.bindings.fable : raw, {
				surface,
				snapshot,
			});
		}
		process.stdout.write(snapshot.revision);
		return;
	}
	throw new Error(
		"usage: validate-model-policy.mjs <fable-binding|model|changes-file> ...",
	);
}

main().catch(fail);
