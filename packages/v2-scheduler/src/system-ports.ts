import { execFile } from "node:child_process";
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
	RestartGatePort,
	RestartGateRecordResult,
	RestartGateState,
	RestartGateStatus,
	SchedulerMemoryPort,
} from "./scheduler-once.js";

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

	async kickstart(jobLabel: string): Promise<void> {
		if (!LAUNCHD_TARGET.test(jobLabel)) {
			throw new TypeError("launchd target is invalid");
		}
		const result = await this.run(
			"launchctl",
			["kickstart", "-k", jobLabel],
			this.timeoutMs,
		);
		if (result.exitCode !== 0) {
			throw new Error(
				`launchctl kickstart exit ${result.exitCode}: ${result.stderr.trim()}`,
			);
		}
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
