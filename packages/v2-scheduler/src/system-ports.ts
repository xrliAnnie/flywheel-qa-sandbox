import { execFile } from "node:child_process";
import {
	lstat,
	mkdir,
	readFile,
	rename,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import type { SchedulerConfig } from "./config.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./config.js";
import {
	deriveMemoryThresholds,
	type MemorySample,
	type MemoryThresholds,
	parseVmStat,
} from "./memory-watermark.js";
import type {
	LaunchdPort,
	RestartCoordinationPort,
	RestartGatePort,
	RestartGateRecordResult,
	RestartGateState,
	RestartGateStatus,
	RestartMutationResult,
	SchedulerMemoryPort,
} from "./scheduler-once.js";
import { RestartCoordinationError } from "./scheduler-once.js";

export interface SystemCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type SystemCommandRunner = (
	file: string,
	args: readonly string[],
	timeoutMs: number,
) => Promise<SystemCommandResult>;

export const runSystemCommand: SystemCommandRunner = (file, args, timeoutMs) =>
	new Promise((resolve) => {
		execFile(
			file,
			[...args],
			{ encoding: "utf8", timeout: timeoutMs },
			(error, stdout, stderr) => {
				const exitCode =
					error === null
						? 0
						: typeof error.code === "number"
							? error.code
							: error.killed
								? 124
								: 127;
				resolve({
					exitCode,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? error?.message ?? ""),
				});
			},
		);
	});

const GATE_STATES = new Set<RestartGateState>([
	"active",
	"resumed",
	"held_alert_pending",
	"held_alert_attempted",
]);

function parseGateOutput(
	output: string,
	requireRecorded: boolean,
): RestartGateStatus | RestartGateRecordResult {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error("restart gate returned malformed JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("restart gate returned malformed output");
	}
	const row = value as Record<string, unknown>;
	if (
		typeof row.state !== "string" ||
		!GATE_STATES.has(row.state as RestartGateState) ||
		!Number.isSafeInteger(row.ledger_seq) ||
		(row.ledger_seq as number) < 0
	) {
		throw new Error("restart gate returned malformed status");
	}
	const status = {
		state: row.state as RestartGateState,
		ledgerSeq: row.ledger_seq as number,
	};
	if (!requireRecorded) return status;
	if (typeof row.recorded !== "boolean") {
		throw new Error("restart gate returned malformed record result");
	}
	return { ...status, recorded: row.recorded };
}

export interface ProcessRestartGateOptions {
	gateBin: string;
	ledgerRoot?: string;
	run?: SystemCommandRunner;
	timeoutMs?: number;
}

export class ProcessRestartGate implements RestartGatePort {
	private readonly run: SystemCommandRunner;
	private readonly timeoutMs: number;

	constructor(private readonly options: ProcessRestartGateOptions) {
		if (!options.gateBin.startsWith("/")) {
			throw new TypeError("restart gate executable must be an absolute path");
		}
		if (
			options.ledgerRoot !== undefined &&
			!options.ledgerRoot.startsWith("/")
		) {
			throw new TypeError("restart ledger root must be an absolute path");
		}
		this.run = options.run ?? runSystemCommand;
		this.timeoutMs = options.timeoutMs ?? 5000;
	}

	private rootArgs(): string[] {
		return this.options.ledgerRoot ? ["--root", this.options.ledgerRoot] : [];
	}

	async status(childKey: string): Promise<RestartGateStatus> {
		const result = await this.run(
			this.options.gateBin,
			["status", "--with-seq", ...this.rootArgs(), childKey],
			this.timeoutMs,
		);
		if (result.exitCode !== 0) {
			throw new Error(
				`restart gate status exit ${result.exitCode}: ${result.stderr.trim()}`,
			);
		}
		return parseGateOutput(result.stdout, false) as RestartGateStatus;
	}

	async recordFailure(
		childKey: string,
		expectedSeq: number,
	): Promise<RestartGateRecordResult> {
		if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 0) {
			throw new TypeError("expected restart ledger seq is invalid");
		}
		const result = await this.run(
			this.options.gateBin,
			[
				"record-failure",
				"--expected-seq",
				String(expectedSeq),
				...this.rootArgs(),
				childKey,
			],
			this.timeoutMs,
		);
		if (result.exitCode !== 0 && result.exitCode !== 3) {
			throw new Error(
				`restart gate record-failure exit ${result.exitCode}: ${result.stderr.trim()}`,
			);
		}
		return parseGateOutput(result.stdout, true) as RestartGateRecordResult;
	}
}

const LAUNCHD_TARGET =
	/^gui\/[0-9]+\/com\.flywheel\.lead\.[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class LaunchctlPort implements LaunchdPort {
	private readonly run: SystemCommandRunner;
	private readonly timeoutMs: number;

	constructor(options: { run?: SystemCommandRunner; timeoutMs?: number } = {}) {
		this.run = options.run ?? runSystemCommand;
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	async requestGracefulRestart(jobLabel: string): Promise<void> {
		if (!LAUNCHD_TARGET.test(jobLabel)) {
			throw new TypeError("launchd target is invalid");
		}
		const result = await this.run(
			"launchctl",
			["kill", "SIGTERM", jobLabel],
			this.timeoutMs,
		);
		if (result.exitCode !== 0) {
			throw new Error(
				`launchctl SIGTERM exit ${result.exitCode}: ${result.stderr.trim()}`,
			);
		}
	}
}

interface RestartLockOwner {
	pid: number;
	pid_lstart: string;
	created_at: string;
}

function parseRestartLockOwner(raw: string): RestartLockOwner {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("scheduler restart lock owner is malformed");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("scheduler restart lock owner is malformed");
	}
	const row = value as Record<string, unknown>;
	let canonicalTimestamp = false;
	if (typeof row.created_at === "string") {
		try {
			canonicalTimestamp =
				new Date(row.created_at).toISOString() === row.created_at;
		} catch {
			canonicalTimestamp = false;
		}
	}
	if (
		!Number.isSafeInteger(row.pid) ||
		(row.pid as number) <= 0 ||
		typeof row.pid_lstart !== "string" ||
		row.pid_lstart.trim() !== row.pid_lstart ||
		row.pid_lstart.length === 0 ||
		!canonicalTimestamp ||
		Object.keys(row).some(
			(key) => !["pid", "pid_lstart", "created_at"].includes(key),
		)
	) {
		throw new Error("scheduler restart lock owner is malformed");
	}
	return row as unknown as RestartLockOwner;
}

function sameRestartLockOwner(
	left: RestartLockOwner,
	right: RestartLockOwner,
): boolean {
	return (
		left.pid === right.pid &&
		left.pid_lstart === right.pid_lstart &&
		left.created_at === right.created_at
	);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export interface FilesystemRestartCoordinationOptions {
	globalLockDir: string;
	mutationLockDir: string;
	run?: SystemCommandRunner;
	timeoutMs?: number;
	pid?: number;
	nowIso?: () => string;
}

/**
 * Serializes the scheduler's bounded SIGTERM beneath restart-services' global
 * lock. The scheduler only observes the global lock and never creates it.
 */
export class FilesystemRestartCoordinationPort
	implements RestartCoordinationPort
{
	private readonly run: SystemCommandRunner;
	private readonly timeoutMs: number;
	private readonly pid: number;
	private readonly nowIso: () => string;

	constructor(private readonly options: FilesystemRestartCoordinationOptions) {
		if (
			!options.globalLockDir.startsWith("/") ||
			!options.mutationLockDir.startsWith("/") ||
			options.globalLockDir === options.mutationLockDir
		) {
			throw new TypeError(
				"restart coordination paths must be distinct absolute paths",
			);
		}
		this.run = options.run ?? runSystemCommand;
		this.timeoutMs = options.timeoutMs ?? 2000;
		this.pid = options.pid ?? process.pid;
		this.nowIso = options.nowIso ?? (() => new Date().toISOString());
	}

	async globalRestartActive(): Promise<boolean> {
		return pathExists(this.options.globalLockDir);
	}

	private async processLstart(pid: number): Promise<string | null> {
		const result = await this.run(
			"ps",
			["-p", String(pid), "-o", "lstart="],
			this.timeoutMs,
		);
		if (result.exitCode !== 0) return null;
		const lstart = result.stdout.trim();
		return lstart.length > 0 && !lstart.includes("\n") ? lstart : null;
	}

	private async readOwner(): Promise<{
		owner: RestartLockOwner;
		raw: string;
	}> {
		const ownerPath = `${this.options.mutationLockDir}/owner.json`;
		const directory = await lstat(this.options.mutationLockDir);
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			(directory.mode & 0o777) !== 0o700
		) {
			throw new Error("scheduler restart lock is not a real directory");
		}
		const ownerStat = await lstat(ownerPath);
		if (
			!ownerStat.isFile() ||
			ownerStat.isSymbolicLink() ||
			(ownerStat.mode & 0o777) !== 0o600
		) {
			throw new Error("scheduler restart lock owner is not a real file");
		}
		const raw = await readFile(ownerPath, "utf8");
		return { owner: parseRestartLockOwner(raw), raw };
	}

	private async reclaimStaleOwner(): Promise<boolean> {
		const before = await this.readOwner();
		const actualLstart = await this.processLstart(before.owner.pid);
		if (actualLstart === before.owner.pid_lstart) return false;

		const after = await this.readOwner();
		if (
			after.raw !== before.raw ||
			!sameRestartLockOwner(after.owner, before.owner)
		) {
			throw new Error("scheduler restart lock owner changed during reclaim");
		}
		await unlink(`${this.options.mutationLockDir}/owner.json`);
		await rmdir(this.options.mutationLockDir);
		return true;
	}

	private async acquireOwner(): Promise<RestartLockOwner | null> {
		const pidLstart = await this.processLstart(this.pid);
		if (pidLstart === null) {
			throw new Error("cannot establish scheduler restart lock identity");
		}

		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await mkdir(this.options.mutationLockDir, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (attempt > 0 || !(await this.reclaimStaleOwner())) return null;
				continue;
			}

			const owner = {
				pid: this.pid,
				pid_lstart: pidLstart,
				created_at: this.nowIso(),
			};
			parseRestartLockOwner(JSON.stringify(owner));
			const ownerPath = `${this.options.mutationLockDir}/owner.json`;
			const temporary = `${ownerPath}.${this.pid}.tmp`;
			try {
				await writeFile(temporary, `${JSON.stringify(owner)}\n`, {
					encoding: "utf8",
					flag: "wx",
					mode: 0o600,
				});
				await rename(temporary, ownerPath);
				return owner;
			} catch (error) {
				await unlink(temporary).catch(() => undefined);
				await rmdir(this.options.mutationLockDir).catch(() => undefined);
				throw error;
			}
		}
		return null;
	}

	private async releaseOwner(expected: RestartLockOwner): Promise<void> {
		const current = await this.readOwner();
		if (!sameRestartLockOwner(current.owner, expected)) {
			throw new Error(
				"scheduler restart lock ownership changed before release",
			);
		}
		await unlink(`${this.options.mutationLockDir}/owner.json`);
		await rmdir(this.options.mutationLockDir);
	}

	async withMutationLock(
		action: () => Promise<void>,
	): Promise<RestartMutationResult> {
		let owner: RestartLockOwner | null;
		try {
			if (await this.globalRestartActive()) return "deferred";
			owner = await this.acquireOwner();
		} catch {
			throw new RestartCoordinationError(
				"scheduler restart coordination acquisition failed",
				false,
			);
		}
		if (owner === null) return "deferred";
		let actionAttempted = false;
		let result: RestartMutationResult = "deferred";
		let primaryError: unknown;
		try {
			if (!(await this.globalRestartActive())) {
				actionAttempted = true;
				await action();
				result = "executed";
			}
		} catch (error) {
			primaryError = error;
		}
		try {
			await this.releaseOwner(owner);
		} catch {
			throw new RestartCoordinationError(
				"scheduler restart coordination release failed",
				actionAttempted,
			);
		}
		if (primaryError !== undefined) {
			if (actionAttempted) throw primaryError;
			throw new RestartCoordinationError(
				"scheduler restart coordination postcheck failed",
				false,
			);
		}
		return result;
	}
}

function parsePositiveDecimal(output: string, name: string): number {
	const raw = output.trim();
	if (!/^[1-9][0-9]*$/.test(raw)) {
		throw new Error(`${name} did not return a canonical positive integer`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) {
		throw new Error(`${name} exceeds the safe integer range`);
	}
	return value;
}

export class DarwinMemoryPort implements SchedulerMemoryPort {
	private constructor(
		readonly thresholds: MemoryThresholds,
		private readonly pageSizeBytes: number,
		private readonly run: SystemCommandRunner,
		private readonly timeoutMs: number,
	) {}

	static async create(
		run: SystemCommandRunner = runSystemCommand,
		config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG },
		timeoutMs = 5000,
	): Promise<DarwinMemoryPort> {
		const ram = await run("sysctl", ["-n", "hw.memsize"], timeoutMs);
		const page = await run("sysctl", ["-n", "hw.pagesize"], timeoutMs);
		if (ram.exitCode !== 0 || page.exitCode !== 0) {
			throw new Error("cannot establish v2 memory dimensions");
		}
		const ramBytes = parsePositiveDecimal(ram.stdout, "hw.memsize");
		const pageSizeBytes = parsePositiveDecimal(page.stdout, "hw.pagesize");
		return new DarwinMemoryPort(
			deriveMemoryThresholds(ramBytes, pageSizeBytes, config),
			pageSizeBytes,
			run,
			timeoutMs,
		);
	}

	async sample(): Promise<MemorySample | null> {
		const result = await this.run("vm_stat", [], this.timeoutMs);
		if (result.exitCode !== 0) return null;
		return parseVmStat(result.stdout, this.pageSizeBytes);
	}
}
