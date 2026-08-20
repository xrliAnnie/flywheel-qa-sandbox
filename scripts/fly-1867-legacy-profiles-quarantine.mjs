#!/usr/bin/env node

/** FLY-1867 P3 — one-shot, quarantine-first legacy profile cleanup. */

import { execFile } from "node:child_process";
import {
	appendFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFreshTeamleadDist } from "./fly-1867-playwright-orphan-census.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const defaultCacheRoot = join(
	homedir(),
	"Library",
	"Caches",
	"ms-playwright-mcp",
);
const defaultManifestPath = join(
	repoRoot,
	"scripts",
	"lib",
	"fly1867-legacy-profiles.manifest.json",
);
const OBSERVATION_PERIOD_MS = 7 * 24 * 60 * 60_000;

function pathInsideRoot(path, root) {
	const child = relative(resolve(root), resolve(path));
	return Boolean(
		child &&
			child !== ".." &&
			!child.startsWith(`..${sep}`) &&
			!isAbsolute(child),
	);
}

async function pathState(path) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

export function classifyLsofResult(code, stdout, stderr) {
	if (code === 1 && stdout.trim() === "") {
		return { status: "empty", reason: "no_open_files", output: "" };
	}
	return {
		status: "blocked",
		reason:
			code === 0
				? "open_files"
				: code === 1
					? "ambiguous_output"
					: `sensor_rc_${code}`,
		output: [stdout, stderr].filter(Boolean).join("\n").trim(),
	};
}

export async function probeTreeOpenFiles(path) {
	return await new Promise((resolveProbe) => {
		execFile(
			"lsof",
			["-Fn", "+D", path],
			{ timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const code = error ? Number(error.code) : 0;
				resolveProbe(
					classifyLsofResult(
						Number.isInteger(code) ? code : 2,
						stdout ?? "",
						stderr ?? "",
					),
				);
			},
		);
	});
}

export async function validateLegacyProfileManifest({ manifest, cacheRoot }) {
	if (
		manifest?.version !== 1 ||
		manifest?.issue !== "FLY-1867" ||
		!Array.isArray(manifest?.entries) ||
		!Number.isFinite(Date.parse(manifest?.reviewed_at ?? ""))
	) {
		throw new Error("manifest schema is invalid");
	}
	const canonicalRoot = await realpath(cacheRoot).catch(() => undefined);
	if (!canonicalRoot || canonicalRoot !== resolve(cacheRoot)) {
		throw new Error(
			"manifest cache root is missing, non-canonical, or a symlink",
		);
	}
	const seenPaths = new Set();
	const seenTokens = new Set();
	for (const [index, entry] of manifest.entries.entries()) {
		if (
			!entry ||
			typeof entry.profile_path !== "string" ||
			typeof entry.profile_token !== "string" ||
			typeof entry.inferred_root !== "string" ||
			typeof entry.provenance !== "string" ||
			!entry.provenance ||
			!isAbsolute(entry.profile_path) ||
			resolve(entry.profile_path) !== entry.profile_path ||
			!isAbsolute(entry.inferred_root) ||
			resolve(entry.inferred_root) !== entry.inferred_root ||
			!pathInsideRoot(entry.profile_path, canonicalRoot) ||
			dirname(entry.profile_path) !== canonicalRoot ||
			!/^[a-f0-9]{7}$/.test(entry.profile_token) ||
			!new RegExp(`^mcp-[a-z]+-${entry.profile_token}$`).test(
				basename(entry.profile_path),
			)
		) {
			throw new Error(`manifest entry ${index} is invalid`);
		}
		if (
			seenPaths.has(entry.profile_path) ||
			seenTokens.has(entry.profile_token)
		) {
			throw new Error(`manifest duplicate entry ${index}`);
		}
		seenPaths.add(entry.profile_path);
		seenTokens.add(entry.profile_token);
		const source = await pathState(entry.profile_path);
		if (source?.isSymbolicLink()) {
			throw new Error(`manifest entry ${index} is a symlink`);
		}
	}
	return {
		...manifest,
		cacheRoot: canonicalRoot,
		reviewedAtMs: Date.parse(manifest.reviewed_at),
	};
}

async function ensureOwnedDirectory(path, uid) {
	await mkdir(path, { recursive: true });
	const state = await lstat(path);
	if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== uid) {
		throw new Error(`unsafe quarantine directory: ${path}`);
	}
}

async function appendLedgerRow(ledgerPath, row) {
	const state = await pathState(ledgerPath);
	if (state && (!state.isFile() || state.isSymbolicLink())) {
		throw new Error(`unsafe quarantine ledger: ${ledgerPath}`);
	}
	await appendFile(ledgerPath, `${JSON.stringify(row)}\n`, "utf8");
}

async function directorySize(path) {
	const state = await pathState(path);
	if (!state) return 0;
	if (!state.isDirectory()) return state.size;
	let total = state.size;
	for (const name of await readdir(path))
		total += await directorySize(join(path, name));
	return total;
}

function quarantineName(reviewedAt) {
	return `.fly1867-quarantine-${reviewedAt.replaceAll(":", "-").replaceAll(".", "-")}`;
}

function countsFor(decisions) {
	const counts = {
		moved: 0,
		preserved: 0,
		missing: 0,
		operator_required: 0,
		would_move: 0,
	};
	for (const decision of decisions) {
		if (decision.action === "skipped_missing") counts.missing++;
		else if (decision.action in counts) counts[decision.action]++;
	}
	return counts;
}

export async function runLegacyProfileQuarantine({
	manifestPath,
	cacheRoot,
	dryRun,
	now = () => new Date(),
	probeMcpProcesses,
	probeTree = probeTreeOpenFiles,
	uid = process.getuid?.(),
}) {
	if (!Number.isInteger(uid)) throw new Error("current uid is unavailable");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const validated = await validateLegacyProfileManifest({
		manifest,
		cacheRoot,
	});
	const quiet = await probeMcpProcesses();
	if (quiet.overall !== "clean") {
		throw new Error(
			`quiet gate failed closed: ${quiet.overall}${quiet.reason ? ` (${quiet.reason})` : ""}`,
		);
	}
	const quarantinePath = join(
		validated.cacheRoot,
		quarantineName(validated.reviewed_at),
	);
	const ledgerPath = join(quarantinePath, "ledger.jsonl");
	if (!dryRun) await ensureOwnedDirectory(quarantinePath, uid);
	const decisions = [];
	let exitCode = 0;
	let recoveryContext;

	for (const entry of validated.entries) {
		const at = now().toISOString();
		const record = async (action, reason, extra = {}) => {
			const decision = { entry, action, reason, at, ...extra };
			decisions.push(decision);
			if (!dryRun) {
				await appendLedgerRow(ledgerPath, {
					...decision,
					quarantine_path: quarantinePath,
				});
			}
			return decision;
		};

		const source = await pathState(entry.profile_path);
		if (!source) {
			await record("skipped_missing", "source_missing");
			continue;
		}
		if (!source.isDirectory() || source.isSymbolicLink()) {
			await record("preserved", "source_not_plain_directory");
			continue;
		}
		if (source.uid !== uid) {
			await record("preserved", "owner_mismatch");
			continue;
		}
		if (source.mtimeMs >= validated.reviewedAtMs) {
			await record("preserved", "mtime_not_before_review");
			continue;
		}
		if (await pathState(entry.inferred_root)) {
			await record("preserved", "inferred_root_exists");
			continue;
		}
		const preRename = await probeTree(entry.profile_path);
		if (preRename.status !== "empty") {
			await record("preserved", `lsof:${preRename.reason}`);
			continue;
		}
		if (dryRun) {
			await record("would_move", "eligible");
			continue;
		}
		const destination = join(quarantinePath, basename(entry.profile_path));
		if (await pathState(destination)) {
			await record("preserved", "quarantine_destination_exists");
			continue;
		}
		await rename(entry.profile_path, destination);
		const postRename = await probeTree(destination);
		if (postRename.status !== "empty") {
			recoveryContext = {
				entry,
				quarantine_path: destination,
				lsof_reason: postRename.reason,
				lsof_output: postRename.output,
				original_path_exists: Boolean(await pathState(entry.profile_path)),
			};
			await record(
				"operator_required",
				`post_rename_lsof:${postRename.reason}`,
				{
					recovery_context: recoveryContext,
				},
			);
			exitCode = 2;
			break;
		}
		await record("moved", "quarantined", { destination });
	}

	return {
		exitCode,
		quarantinePath,
		decisions,
		counts: countsFor(decisions),
		quarantineBytes: dryRun ? 0 : await directorySize(quarantinePath),
		...(recoveryContext ? { recoveryContext } : {}),
	};
}

export async function deleteLegacyProfileQuarantine({
	cacheRoot,
	quarantinePath,
	now = () => new Date(),
	probeTree = probeTreeOpenFiles,
	uid = process.getuid?.(),
}) {
	if (!Number.isInteger(uid)) throw new Error("current uid is unavailable");
	const canonicalRoot = await realpath(cacheRoot).catch(() => undefined);
	if (
		!canonicalRoot ||
		canonicalRoot !== resolve(cacheRoot) ||
		!isAbsolute(quarantinePath) ||
		resolve(quarantinePath) !== quarantinePath ||
		dirname(quarantinePath) !== canonicalRoot ||
		!basename(quarantinePath).startsWith(".fly1867-quarantine-")
	) {
		throw new Error("delete path is not an exact FLY-1867 quarantine");
	}
	const state = await lstat(quarantinePath);
	if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== uid) {
		throw new Error("delete quarantine ownership/type gate failed");
	}
	const ledgerPath = join(quarantinePath, "ledger.jsonl");
	const ledgerState = await lstat(ledgerPath).catch(() => undefined);
	if (!ledgerState?.isFile() || ledgerState.isSymbolicLink()) {
		throw new Error("delete quarantine ledger is missing or unsafe");
	}
	const rows = (await readFile(ledgerPath, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	if (
		rows.length === 0 ||
		rows.some((row) => row.quarantine_path !== quarantinePath)
	) {
		throw new Error("delete path is not exactly bound by its ledger");
	}
	const firstAt = Math.min(...rows.map((row) => Date.parse(row.at)));
	if (
		!Number.isFinite(firstAt) ||
		now().getTime() - firstAt < OBSERVATION_PERIOD_MS
	) {
		throw new Error("delete observation period is less than seven days");
	}
	const open = await probeTree(quarantinePath);
	if (open.status !== "empty") {
		throw new Error(`delete lsof gate failed: ${open.reason}`);
	}
	const bytes = await directorySize(quarantinePath);
	await rm(quarantinePath, { recursive: true });
	return { deleted: true, quarantinePath, bytes };
}

function parseArgs(argv) {
	if (argv.length === 0) return { mode: "apply" };
	if (argv.length === 1 && argv[0] === "--dry-run") return { mode: "dry-run" };
	if (argv.length === 2 && argv[0] === "--delete-quarantine") {
		return { mode: "delete", quarantinePath: argv[1] };
	}
	throw new Error(
		"usage: fly-1867-legacy-profiles-quarantine.mjs [--dry-run | --delete-quarantine <exact-path>]",
	);
}

async function defaultMcpQuietProbe() {
	const bridgeDist = join(repoRoot, "packages", "teamlead", "dist", "bridge");
	const [{ defaultListProcesses }, { classifyMcpSnapshot }] = await Promise.all(
		[
			import(pathToFileURL(join(bridgeDist, "mcp-descendant-reaper.js")).href),
			import(pathToFileURL(join(bridgeDist, "mcp-process-classifier.js")).href),
		],
	);
	const processes = await defaultListProcesses({ timeoutMs: 5_000 });
	if (processes.status === "unknown") {
		return { overall: "unknown", rows: [], reason: processes.error };
	}
	return classifyMcpSnapshot(processes.rows);
}

export async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	assertFreshTeamleadDist(repoRoot, [
		"packages/teamlead/src/bridge/mcp-descendant-reaper.ts",
		"packages/teamlead/src/bridge/mcp-process-classifier.ts",
	]);
	const result =
		args.mode === "delete"
			? await deleteLegacyProfileQuarantine({
					cacheRoot: defaultCacheRoot,
					quarantinePath: args.quarantinePath,
				})
			: await runLegacyProfileQuarantine({
					manifestPath: defaultManifestPath,
					cacheRoot: defaultCacheRoot,
					dryRun: args.mode === "dry-run",
					probeMcpProcesses: defaultMcpQuietProbe,
				});
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	if ("exitCode" in result && result.exitCode !== 0)
		process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
