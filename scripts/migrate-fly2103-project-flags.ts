#!/usr/bin/env npx tsx

import { createHash } from "node:crypto";
import {
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StateStore } from "../packages/teamlead/dist/StateStore.js";
import {
	type ConfigSnapshot,
	FLY2103_MIGRATED_FLAG_NAMES,
	FLY2103_PRE_CUTOVER_ORDER_WARNING,
	FLY2103_PROJECTS,
	type MigrationRow,
	type PreCutoverReceipt,
	runFly2103Migration,
	stageAndApplyMigrationRow,
} from "./lib/fly2103-project-flag-migration.js";

const requireFromConfig = createRequire(
	new URL("../packages/config/package.json", import.meta.url),
);
const { parse: parseYaml } = requireFromConfig("yaml") as {
	parse: (content: string) => unknown;
};

const USAGE = `Usage:
  pnpm exec tsx scripts/migrate-fly2103-project-flags.ts \\
    --phase pre-cutover|post-deploy [--dry-run|--apply] \\
    [--projects <projects.json>] [--db <teamlead.db>] \\
    [--bridge-url <loopback-url>] [--receipt <G1.json>] \\
    [--receipt-out <G1.json>]

Dry-run is the default. post-deploy requires an explicit --receipt.`;

interface Args {
	phase: "pre-cutover" | "post-deploy";
	apply: boolean;
	projectsPath: string;
	dbPath: string;
	bridgeTarget: string;
	receiptPath?: string;
	receiptOutPath: string;
}

function parseArgs(argv: readonly string[]): Args {
	const values = new Map<string, string>();
	let apply = false;
	let dryRun = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--apply") {
			apply = true;
			continue;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			console.log(USAGE);
			process.exit(0);
		}
		if (
			![
				"--phase",
				"--projects",
				"--db",
				"--bridge-url",
				"--receipt",
				"--receipt-out",
			].includes(arg)
		) {
			throw new Error(`unknown argument: ${arg}\n${USAGE}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`${arg} requires a value\n${USAGE}`);
		}
		values.set(arg, value);
		index += 1;
	}
	if (apply && dryRun)
		throw new Error("--apply and --dry-run are mutually exclusive");
	const phase = values.get("--phase");
	if (phase !== "pre-cutover" && phase !== "post-deploy") {
		throw new Error(`--phase pre-cutover|post-deploy is required\n${USAGE}`);
	}
	const receiptPath = values.get("--receipt");
	if (phase === "pre-cutover" && receiptPath) {
		throw new Error(
			"pre-cutover does not accept --receipt; it produces the G1 receipt",
		);
	}
	if (phase === "post-deploy" && !receiptPath) {
		throw new Error(`post-deploy requires --receipt <G1.json>\n${USAGE}`);
	}
	if (phase === "post-deploy" && values.has("--receipt-out")) {
		throw new Error("post-deploy does not produce a new receipt");
	}
	const flywheelHome = join(homedir(), ".flywheel");
	return {
		phase,
		apply,
		projectsPath: resolve(
			values.get("--projects") ??
				process.env.FLYWHEEL_PROJECTS_FILE ??
				join(flywheelHome, "projects.json"),
		),
		dbPath: resolve(
			values.get("--db") ??
				process.env.TEAMLEAD_DB_PATH ??
				join(flywheelHome, "teamlead.db"),
		),
		bridgeTarget: canonicalBridgeTarget(
			values.get("--bridge-url") ??
				process.env.FLYWHEEL_BRIDGE_URL ??
				`http://127.0.0.1:${process.env.TEAMLEAD_PORT ?? "9876"}`,
		),
		receiptPath: receiptPath ? resolve(receiptPath) : undefined,
		receiptOutPath: resolve(
			values.get("--receipt-out") ??
				join(flywheelHome, "state", "migrations", "FLY-2103-g1.json"),
		),
	};
}

function canonicalBridgeTarget(raw: string): string {
	const url = new URL(raw);
	if (
		!(["http:", "https:"] as const).includes(
			url.protocol as "http:" | "https:",
		) ||
		!(["localhost", "127.0.0.1", "::1", "[::1]"] as const).includes(
			url.hostname as "localhost" | "127.0.0.1" | "::1" | "[::1]",
		) ||
		url.username ||
		url.password ||
		(url.pathname !== "/" && url.pathname !== "") ||
		url.search ||
		url.hash
	) {
		throw new Error(
			`Bridge URL must be a bare loopback http(s) origin: ${raw}`,
		);
	}
	return url.origin;
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

async function loadConfigSnapshots(
	projectsPath: string,
): Promise<ConfigSnapshot[]> {
	const raw = JSON.parse(await readFile(projectsPath, "utf8")) as unknown;
	if (!Array.isArray(raw))
		throw new Error(`${projectsPath} must contain a project array`);
	const roots = new Map<string, string>();
	for (const entry of raw) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof (entry as { projectName?: unknown }).projectName !== "string" ||
			typeof (entry as { projectRoot?: unknown }).projectRoot !== "string"
		) {
			throw new Error(`${projectsPath} contains an invalid project entry`);
		}
		const project = entry as { projectName: string; projectRoot: string };
		if (roots.has(project.projectName)) {
			throw new Error(
				`${projectsPath} contains duplicate project ${project.projectName}`,
			);
		}
		roots.set(project.projectName, project.projectRoot);
	}
	const snapshots: ConfigSnapshot[] = [];
	for (const projectName of FLY2103_PROJECTS) {
		const projectRoot = roots.get(projectName);
		if (!projectRoot)
			throw new Error(`${projectsPath} is missing project ${projectName}`);
		const path = join(projectRoot, ".flywheel", "config.yaml");
		const content = await readFile(path, "utf8");
		const config = parseYaml(content);
		if (
			typeof config !== "object" ||
			config === null ||
			Array.isArray(config)
		) {
			throw new Error(`${path} must contain a YAML mapping`);
		}
		snapshots.push({
			projectName,
			path,
			contentSha: sha256(content),
			config: config as Record<string, unknown>,
		});
	}
	return snapshots;
}

async function readMigrationRows(dbPath: string): Promise<MigrationRow[]> {
	const store = await StateStore.openForMaintenance(dbPath, { readonly: true });
	try {
		return store
			.listScopedFlagValueRows()
			.filter((row) => FLY2103_MIGRATED_FLAG_NAMES.has(row.flagName))
			.map((row) => {
				if (!row.hasOverride || (row.raw !== "0" && row.raw !== "1")) {
					throw new Error(
						`FLY-2103 invalid stored row ${row.flagName}/${row.scope}: hasOverride=${row.hasOverride} raw=${String(row.raw)}`,
					);
				}
				return { name: row.flagName, scope: row.scope, raw: row.raw };
			});
	} finally {
		store.close();
	}
}

async function atomicWriteReceipt(
	path: string,
	receipt: PreCutoverReceipt,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempPath, `${JSON.stringify(receipt, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		await rename(tempPath, path);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.phase === "pre-cutover") {
		console.warn(FLY2103_PRE_CUTOVER_ORDER_WARNING);
	}
	const dbRealpath = await realpath(args.dbPath);
	const configSnapshots = await loadConfigSnapshots(args.projectsPath);
	const currentRows = await readMigrationRows(dbRealpath);
	const receipt = args.receiptPath
		? JSON.parse(await readFile(args.receiptPath, "utf8"))
		: undefined;
	const result = await runFly2103Migration({
		phase: args.phase,
		apply: args.apply,
		configSnapshots,
		currentRows,
		dbRealpath,
		bridgeTarget: args.bridgeTarget,
		receipt,
		writeRow: (row) => stageAndApplyMigrationRow(row, args.bridgeTarget),
		readRows: () => readMigrationRows(dbRealpath),
		writeReceipt: (value) => atomicWriteReceipt(args.receiptOutPath, value),
		now: () => new Date(),
	});
	console.log(
		JSON.stringify(
			{
				issue: "FLY-2103",
				phase: args.phase,
				mode: args.apply ? "apply" : "dry-run",
				dbRealpath,
				bridgeTarget: args.bridgeTarget,
				actions: result.actions,
				...(result.receipt ? { receipt: args.receiptOutPath } : {}),
			},
			null,
			2,
		),
	);
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
