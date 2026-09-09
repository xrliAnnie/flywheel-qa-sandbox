#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const repoRoot = resolve(dirname(scriptPath), "..");

export function alertSnapshotRefusal(
	result,
	notify = (args) =>
		spawnSync(resolve(repoRoot, "scripts/meta-alert.sh"), args, {
			stdio: "ignore",
			timeout: 15_000,
		}),
) {
	if (
		result?.reason !== "insufficient_data_volume" &&
		result?.reason !== "data_volume_unavailable"
	)
		return;
	notify([
		"snapshot-storage-refused",
		"Flywheel database snapshot refused",
		`reason=${result.reason} volume=/System/Volumes/Data write_refused=yes`,
	]);
}

async function runSnapshotCli(args, env) {
	const module = await import(
		pathToFileURL(
			resolve(repoRoot, "packages/flywheel-comm/dist/commands/snapshot.js"),
		).href
	);
	if (typeof module.runSnapshotCommand !== "function") {
		throw new Error("snapshot_helper_missing");
	}
	let output = "";
	const exitCode = await module.runSnapshotCommand(args, {
		env,
		stdout: (text) => {
			output += text;
		},
		stderr: (text) => {
			output += text;
		},
	});
	const result = JSON.parse(output.trim().split("\n").at(-1) || "null");
	if (exitCode !== 0 || !result?.ok) {
		alertSnapshotRefusal(result);
		throw new Error(result?.reason || "snapshot_cli_failed");
	}
	return result;
}

function validateSources(sources) {
	if (!Array.isArray(sources) || sources.length === 0)
		throw new Error("snapshot sources are required");
	const names = new Set();
	for (const source of sources) {
		if (
			!source ||
			!/^[-A-Za-z0-9_.]+$/.test(source.name) ||
			names.has(source.name) ||
			typeof source.source !== "string" ||
			!source.source ||
			(source.kind !== "teamlead" && source.kind !== "comm") ||
			(source.kind === "teamlead" && source.project !== undefined) ||
			(source.kind === "comm" && !source.project)
		) {
			throw new Error("invalid snapshot source");
		}
		names.add(source.name);
	}
}

export async function withManagedSnapshots(input, use, deps = {}) {
	validateSources(input.sources);
	const env = input.env ?? process.env;
	const runCli = deps.runCli ?? ((args) => runSnapshotCli(args, env));
	const withBudget = async (executionDirectory, additionalBytes, operation) => {
		const implementation =
			deps.withManagedSnapshotBudget ??
			(
				await import(
					pathToFileURL(
						resolve(
							repoRoot,
							"packages/flywheel-comm/dist/snapshot-storage.js",
						),
					).href
				)
			).withManagedSnapshotBudget;
		return implementation({ executionDirectory, additionalBytes }, operation);
	};
	if (Object.hasOwn(env, "FLYWHEEL_EXEC_ID")) {
		const paths = {};
		let primaryFailure;
		let value;
		try {
			for (const source of input.sources) {
				const args = [
					"runner",
					"--source",
					source.source,
					"--kind",
					source.kind,
				];
				if (source.project) args.push("--project", source.project);
				paths[source.name] = (await runCli(args)).path;
			}
			const directories = new Set(Object.values(paths).map(dirname));
			if (directories.size !== 1)
				throw new Error("snapshot paths span multiple owner directories");
			const directory = directories.values().next().value;
			value = await use({
				paths,
				directory,
				ownerKind: "runner",
				withBudget: (additionalBytes, operation) =>
					withBudget(directory, additionalBytes, operation),
			});
		} catch (error) {
			primaryFailure = error;
		}
		let cleanupFailure;
		try {
			await runCli(["release"]);
		} catch (error) {
			cleanupFailure = error;
		}
		if (primaryFailure) {
			if (cleanupFailure) {
				process.stderr.write(
					`${JSON.stringify({ ok: false, reason: "snapshot_cleanup_pending", retryable: true })}\n`,
				);
			}
			throw primaryFailure;
		}
		if (cleanupFailure) throw cleanupFailure;
		return value;
	}

	const withOperatorSnapshots =
		deps.withOperatorSnapshots ??
		(
			await import(
				pathToFileURL(
					resolve(repoRoot, "packages/flywheel-comm/dist/snapshot-storage.js"),
				).href
			)
		).withOperatorSnapshots;
	return withOperatorSnapshots(
		{ label: input.label },
		async ({ createSnapshot }) => {
			const paths = {};
			for (const source of input.sources) {
				paths[source.name] = (
					await createSnapshot({
						source: source.source,
						databaseKind: source.kind,
						project: source.project,
					})
				).path;
			}
			const directory = dirname(Object.values(paths)[0]);
			return use({
				paths,
				directory,
				ownerKind: "operator",
				withBudget: (additionalBytes, operation) =>
					withBudget(directory, additionalBytes, operation),
			});
		},
	);
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
	try {
		const module = await import(
			pathToFileURL(
				resolve(repoRoot, "packages/flywheel-comm/dist/commands/snapshot.js"),
			).href
		);
		if (typeof module.runSnapshotCommand !== "function") {
			throw new Error("snapshot helper export missing");
		}
		let diagnostic = "";
		process.exitCode = await module.runSnapshotCommand(process.argv.slice(2), {
			stderr: (text) => {
				diagnostic += text;
				process.stderr.write(text);
			},
		});
		if (process.exitCode !== 0) {
			try {
				alertSnapshotRefusal(
					JSON.parse(diagnostic.trim().split("\n").at(-1) || "null"),
				);
			} catch {
				// The original structured failure remains authoritative.
			}
		}
	} catch {
		process.stderr.write(
			`${JSON.stringify({
				ok: false,
				reason: "snapshot_helper_missing",
				retryable: false,
				unavailable: ["structural: snapshot_helper_missing"],
			})}\n`,
		);
		process.exitCode = 1;
	}
}
