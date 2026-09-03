import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);

export const MEMORY_PRESSURE_BIN = "/usr/bin/memory_pressure";
export const MEMORY_PRESSURE_ARGV: readonly string[] = Object.freeze([]);
export const MEMORY_PRESSURE_TIMEOUT_MS = 2_000;

type ExecFileFn = (
	file: string,
	args: readonly string[],
	options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface MemoryFreePctReading {
	freePct: number | null;
	observedAt: string;
	unavailable?: string;
}

export const CAPACITY_UNAVAILABLE_TOKENS: ReadonlySet<string> = new Set([
	"structural: memory_pressure_unsupported_platform",
	"structural: memory_pressure_missing",
	"transient: memory_pressure_timeout",
	"transient: memory_pressure_parse_failed",
	"structural: admission_controller_absent",
	"transient: load_probe_failed",
	"transient: state_store_unreadable",
	"transient: session_store_unreadable",
	"structural: account_pool_not_provisioned",
	"transient: account_store_unreadable",
	"transient: account_store_invalid",
	"transient: account_entry_invalid",
	"structural: codex_no_usage_api",
]);

const CAPACITY_UNAVAILABLE_GRAMMAR =
	/^(structural|transient): [a-z][a-z0-9_]{0,47}$/;
const CAPACITY_EXIT_TOKEN = /^transient: memory_pressure_exit_[0-9]{1,3}$/;

export function isCapacityUnavailableToken(value: unknown): value is string {
	return (
		typeof value === "string" &&
		CAPACITY_UNAVAILABLE_GRAMMAR.test(value) &&
		(CAPACITY_UNAVAILABLE_TOKENS.has(value) || CAPACITY_EXIT_TOKEN.test(value))
	);
}

/** Parse the free percentage reported by a bare macOS memory-pressure probe. */
export function parseMemoryPressureFreePct(stdout: string): number | null {
	const lastLine = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	if (lastLine === undefined) return null;
	const match = lastLine.match(
		/^System-wide memory free percentage:\s+(\d{1,3})%$/,
	);
	if (!match) return null;
	const freePct = Number(match[1]);
	return Number.isInteger(freePct) && freePct >= 0 && freePct <= 100
		? freePct
		: null;
}

export async function readMemoryFreePct(
	opts: {
		execFile?: ExecFileFn;
		platform?: NodeJS.Platform;
		now?: () => number;
	} = {},
): Promise<MemoryFreePctReading> {
	const observedAt = new Date((opts.now ?? Date.now)()).toISOString();
	if ((opts.platform ?? process.platform) !== "darwin") {
		return {
			freePct: null,
			observedAt,
			unavailable: "structural: memory_pressure_unsupported_platform",
		};
	}
	const runExecFile = opts.execFile ?? (execFileAsync as ExecFileFn);
	try {
		const { stdout } = await runExecFile(
			MEMORY_PRESSURE_BIN,
			MEMORY_PRESSURE_ARGV,
			{
				timeout: MEMORY_PRESSURE_TIMEOUT_MS,
				maxBuffer: 64 * 1024,
			},
		);
		const freePct = parseMemoryPressureFreePct(stdout);
		return freePct === null
			? {
					freePct: null,
					observedAt,
					unavailable: "transient: memory_pressure_parse_failed",
				}
			: { freePct, observedAt };
	} catch (error) {
		const details =
			typeof error === "object" && error !== null
				? (error as { code?: unknown; signal?: unknown })
				: {};
		const unavailable =
			details.code === "ENOENT"
				? "structural: memory_pressure_missing"
				: Number.isInteger(details.code) &&
						(details.code as number) > 0 &&
						(details.code as number) <= 999
					? `transient: memory_pressure_exit_${details.code as number}`
					: "transient: memory_pressure_timeout";
		return { freePct: null, observedAt, unavailable };
	}
}
