#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function usage() {
	return `Usage:
  node scripts/fly1645-receipt-teardown-closeout.mjs [--db PATH ...]
    [--state-db PATH] [--resolution-manifest PATH]
    [--manifest-out PATH] [--apply --confirm-quiesced]

Dry-run is the default. It opens every CommDB physically readonly, inventories
legacy external chat rows and relay/schema residue, and writes nothing. Apply
requires a disposition for every live external chat row, a quiescence proof,
online backups of every CommDB plus StateStore, and then performs one immediate
transaction per shard. This Runner must not execute --apply in production.`;
}

function discoverCommDbs(flywheelHome) {
	const candidates = new Set();
	const rootDb = join(flywheelHome, "comm.db");
	if (existsSync(rootDb)) candidates.add(rootDb);
	const commRoot = join(flywheelHome, "comm");
	if (existsSync(commRoot)) {
		for (const entry of readdirSync(commRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dbPath = join(commRoot, entry.name, "comm.db");
			if (existsSync(dbPath)) candidates.add(dbPath);
		}
	}
	if (process.env.FLYWHEEL_COMM_DB) {
		candidates.add(resolve(process.env.FLYWHEEL_COMM_DB));
	}
	return [...candidates].sort();
}

function parseArgs(argv) {
	const flywheelHome = resolve(
		process.env.FLYWHEEL_HOME ?? join(homedir(), ".flywheel"),
	);
	const parsed = {
		apply: false,
		confirmQuiesced: false,
		dbPaths: [],
		stateDbPath: join(flywheelHome, "teamlead.db"),
		resolutionManifest: undefined,
		manifestPath: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--apply") parsed.apply = true;
		else if (arg === "--confirm-quiesced") parsed.confirmQuiesced = true;
		else if (arg === "--db") parsed.dbPaths.push(resolve(argv[++index] ?? ""));
		else if (arg === "--state-db")
			parsed.stateDbPath = resolve(argv[++index] ?? "");
		else if (arg === "--resolution-manifest")
			parsed.resolutionManifest = resolve(argv[++index] ?? "");
		else if (arg === "--manifest-out")
			parsed.manifestPath = resolve(argv[++index] ?? "");
		else if (arg === "--help" || arg === "-h") {
			process.stdout.write(`${usage()}\n`);
			process.exit(0);
		} else throw new Error(`unknown_argument:${arg}`);
	}
	if (parsed.dbPaths.length === 0) {
		parsed.dbPaths = discoverCommDbs(flywheelHome);
	}
	if (parsed.dbPaths.length === 0)
		throw new Error("closeout_database_list_empty");
	if (parsed.apply && !parsed.manifestPath) {
		const stamp = new Date()
			.toISOString()
			.replaceAll(":", "-")
			.replaceAll(".", "-");
		parsed.manifestPath = join(
			dirname(parsed.dbPaths[0]),
			"backups",
			`fly1645-closeout-manifest-${stamp}.json`,
		);
	}
	return parsed;
}

function readResolutions(path) {
	if (!path) return [];
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	const resolutions = Array.isArray(parsed) ? parsed : parsed?.resolutions;
	if (!Array.isArray(resolutions)) {
		throw new Error("resolution_manifest_invalid");
	}
	return resolutions;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const moduleUrl = pathToFileURL(
		join(
			repoRoot,
			"packages",
			"flywheel-comm",
			"dist",
			"receipt-teardown-closeout.js",
		),
	).href;
	let runReceiptTeardownCloseout;
	try {
		({ runReceiptTeardownCloseout } = await import(moduleUrl));
	} catch (error) {
		throw new Error(
			`flywheel_comm_dist_unavailable: run pnpm --filter flywheel-comm build first (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const result = await runReceiptTeardownCloseout({
		dbPaths: args.dbPaths,
		stateDbPath: args.stateDbPath,
		apply: args.apply,
		confirmQuiesced: args.confirmQuiesced,
		resolutions: readResolutions(args.resolutionManifest),
		...(args.manifestPath ? { manifestPath: args.manifestPath } : {}),
	});
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
	process.stderr.write(
		`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
	);
	process.exitCode = 1;
});
