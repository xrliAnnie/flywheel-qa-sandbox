#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Kernel, migrateDatabase } from "flywheel-v2-kernel";
import { resolveSchedulerConfig, type SchedulerConfig } from "./config.js";
import type { SchedulerMemoryPort } from "./scheduler-once.js";
import { runSchedulerOnce } from "./scheduler-once.js";
import { finishSchedulerRun, startSchedulerRun } from "./scheduler-store.js";
import {
	DarwinMemoryPort,
	LaunchctlPort,
	ProcessRestartGate,
} from "./system-ports.js";

interface CommonOptions {
	dbPath: string;
}

export interface SchedulerRunCliOptions extends CommonOptions {
	mode: "run";
	projectName: string;
	backend: "launchd";
	gateBin: string;
	ledgerRoot?: string;
	uid: number;
	runId: string;
	host: string;
}

export interface SchedulerProbeCliOptions extends CommonOptions {
	mode: "probe";
	backend: "launchd";
	runId: string;
	host: string;
}

export interface SchedulerReceiptCliOptions extends CommonOptions {
	mode: "check-receipt";
	afterIso: string;
}

export type SchedulerCliOptions =
	| SchedulerRunCliOptions
	| SchedulerProbeCliOptions
	| SchedulerReceiptCliOptions;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALUE_FLAGS = new Set([
	"--db",
	"--project",
	"--backend",
	"--gate-bin",
	"--ledger-root",
	"--uid",
	"--run-id",
	"--host",
	"--check-receipt-after",
]);

function requireAbsolute(value: string | undefined, name: string): string {
	if (!value || !isAbsolute(value)) {
		throw new TypeError(`${name} must be an absolute path`);
	}
	return value;
}

function requireIso(value: string, name: string): string {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new TypeError(`${name} must be canonical UTC ISO-8601`);
	}
	return value;
}

function parseValues(argv: readonly string[]): Map<string, string | true> {
	const values = new Map<string, string | true>();
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index]!;
		if (flag === "--probe") {
			if (values.has(flag)) throw new TypeError(`duplicate option ${flag}`);
			values.set(flag, true);
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) {
			throw new TypeError(`unknown scheduler option ${flag}`);
		}
		if (values.has(flag)) throw new TypeError(`duplicate option ${flag}`);
		const value = argv[++index];
		if (!value || value.startsWith("--")) {
			throw new TypeError(`${flag} requires a value`);
		}
		values.set(flag, value);
	}
	return values;
}

function stringValue(
	values: Map<string, string | true>,
	flag: string,
): string | undefined {
	const value = values.get(flag);
	return typeof value === "string" ? value : undefined;
}

function requireBackend(values: Map<string, string | true>): "launchd" {
	const backend = stringValue(values, "--backend");
	if (backend !== "launchd") {
		throw new TypeError(
			"--backend must be launchd; fallback and native Windows are not implemented",
		);
	}
	return backend;
}

export function parseSchedulerCliArgs(
	argv: readonly string[],
): SchedulerCliOptions {
	const values = parseValues(argv);
	const dbPath = requireAbsolute(stringValue(values, "--db"), "--db");
	const after = stringValue(values, "--check-receipt-after");
	if (after !== undefined) {
		if (values.size !== 2) {
			throw new TypeError("--check-receipt-after accepts only itself and --db");
		}
		return {
			mode: "check-receipt",
			dbPath,
			afterIso: requireIso(after, "--check-receipt-after"),
		};
	}

	const backend = requireBackend(values);
	const runId = stringValue(values, "--run-id") ?? randomUUID();
	const host = stringValue(values, "--host") ?? hostname();
	if (!SAFE_ID.test(runId) || !SAFE_ID.test(host)) {
		throw new TypeError("run-id and host must use safe identifier grammar");
	}
	if (values.has("--probe")) {
		const allowed = new Set([
			"--db",
			"--backend",
			"--run-id",
			"--host",
			"--probe",
		]);
		for (const flag of values.keys()) {
			if (!allowed.has(flag)) {
				throw new TypeError(`probe mode does not accept ${flag}`);
			}
		}
		return { mode: "probe", dbPath, backend, runId, host };
	}

	const projectName = stringValue(values, "--project");
	if (!projectName || !SAFE_ID.test(projectName)) {
		throw new TypeError(
			"--project must use ProjectConfig safe identifier grammar",
		);
	}
	const gateBin = requireAbsolute(
		stringValue(values, "--gate-bin"),
		"--gate-bin",
	);
	const ledgerRaw = stringValue(values, "--ledger-root");
	const ledgerRoot =
		ledgerRaw === undefined
			? undefined
			: requireAbsolute(ledgerRaw, "--ledger-root");
	const uidRaw = stringValue(values, "--uid");
	const uid = uidRaw === undefined ? process.getuid?.() : Number(uidRaw);
	if (!Number.isSafeInteger(uid) || (uid as number) < 0) {
		throw new TypeError("--uid must be a canonical non-negative integer");
	}
	if (uidRaw !== undefined && String(uid) !== uidRaw) {
		throw new TypeError("--uid must be a canonical non-negative integer");
	}
	return {
		mode: "run",
		dbPath,
		projectName,
		backend,
		gateBin,
		...(ledgerRoot ? { ledgerRoot } : {}),
		uid: uid as number,
		runId,
		host,
	};
}

function unknownMemory(config: SchedulerConfig): SchedulerMemoryPort {
	return {
		thresholds: {
			ramBytes: config.freeClearFloorBytes,
			pageSizeBytes: 4096,
			freeTriggerBytes: config.freeTriggerFloorBytes,
			freeClearBytes: config.freeClearFloorBytes,
			swapoutMinPagesPerTick: config.swapoutFloorPages,
		},
		async sample() {
			return null;
		},
	};
}

async function runProbe(options: SchedulerProbeCliOptions): Promise<number> {
	migrateDatabase({ path: options.dbPath });
	const kernel = Kernel.open({ path: options.dbPath });
	try {
		const now = new Date();
		const acquired = startSchedulerRun(kernel, {
			runId: options.runId,
			backend: options.backend,
			host: options.host,
			nowIso: now.toISOString(),
			leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
		});
		if (!acquired) return 1;
		finishSchedulerRun(kernel, {
			runId: options.runId,
			result: "probe",
			detail: '{"probe":true}',
			nowIso: new Date().toISOString(),
		});
		process.stdout.write(
			`${JSON.stringify({ status: "probe", runId: options.runId })}\n`,
		);
		return 0;
	} finally {
		kernel.close();
	}
}

function checkReceipt(options: SchedulerReceiptCliOptions): number {
	const kernel = Kernel.open({ path: options.dbPath });
	try {
		const receipt = kernel.read((tx) =>
			tx.get<{
				run_id: string;
				started_at: string;
				finished_at: string;
				result: string;
				host: string;
				backend: string;
			}>(
				`SELECT run_id,started_at,finished_at,result,host,backend
				 FROM scheduler_runs
				 WHERE started_at >= @afterIso AND finished_at IS NOT NULL
				 ORDER BY started_at DESC LIMIT 1`,
				options,
			),
		);
		if (!receipt) return 1;
		process.stdout.write(`${JSON.stringify(receipt)}\n`);
		return ["succeeded", "partial", "lease_busy", "probe"].includes(
			receipt.result,
		)
			? 0
			: 1;
	} finally {
		kernel.close();
	}
}

async function runSweep(options: SchedulerRunCliOptions): Promise<number> {
	const config = resolveSchedulerConfig();
	migrateDatabase({ path: options.dbPath });
	const kernel = Kernel.open({ path: options.dbPath });
	const timeout = setTimeout(() => {
		process.stderr.write("scheduler-once hard timeout\n");
		process.exit(124);
	}, config.hardTimeoutMs);
	try {
		let memory: SchedulerMemoryPort;
		try {
			memory = await DarwinMemoryPort.create(undefined, config);
		} catch {
			memory = unknownMemory(config);
		}
		const clock = {
			nowMs: () => Date.now(),
			nowIso: () => new Date().toISOString(),
			sleep: (ms: number) =>
				new Promise<void>((resolve) => setTimeout(resolve, ms)),
		};
		const result = await runSchedulerOnce({
			kernel,
			runId: options.runId,
			backend: options.backend,
			host: options.host,
			projectName: options.projectName,
			uid: options.uid,
			config,
			clock,
			memory,
			launchd: new LaunchctlPort(),
			restartGate: new ProcessRestartGate({
				gateBin: options.gateBin,
				ledgerRoot: options.ledgerRoot,
			}),
		});
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return result.status === "succeeded" || result.status === "lease_busy"
			? 0
			: 1;
	} finally {
		clearTimeout(timeout);
		kernel.close();
	}
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const options = parseSchedulerCliArgs(argv);
	if (options.mode === "check-receipt") return checkReceipt(options);
	if (options.mode === "probe") return runProbe(options);
	return runSweep(options);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(
				`scheduler-once: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 2;
		});
}
