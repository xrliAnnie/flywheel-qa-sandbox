import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TmuxSocketInspection } from "./server-loss.js";

type ExecResult = { stdout: string | Buffer; stderr?: string | Buffer };
type ExecFn = (
	file: string,
	args: string[],
	options: { timeout: number; maxBuffer: number; encoding: "utf8" },
) => Promise<ExecResult>;

const defaultExec = promisify(execFile) as unknown as ExecFn;
const VERDICTS = new Set<TmuxSocketInspection["verdict"]>([
	"reachable",
	"missing_single_orphan",
	"saturated",
	"dead",
	"split_brain",
	"ambiguous",
	"unknown",
]);

function lastJsonLine(raw: string | Buffer): string {
	const line = String(raw).trim().split(/\r?\n/).filter(Boolean).at(-1);
	if (!line) throw new Error("tmux rescue CLI returned no JSON");
	return line;
}

export function parseTmuxSocketInspection(
	raw: string | Buffer,
): TmuxSocketInspection {
	let value: unknown;
	try {
		value = JSON.parse(lastJsonLine(raw));
	} catch (error) {
		throw new Error(`invalid tmux inspect JSON: ${String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("invalid tmux inspect object");
	}
	const row = value as Record<string, unknown>;
	if (
		typeof row.verdict !== "string" ||
		!VERDICTS.has(row.verdict as TmuxSocketInspection["verdict"]) ||
		typeof row.socketPresent !== "boolean" ||
		typeof row.socketPath !== "string" ||
		!row.socketPath.startsWith("/") ||
		typeof row.scanComplete !== "boolean" ||
		!Array.isArray(row.candidatePids) ||
		!row.candidatePids.every(
			(pid) => Number.isSafeInteger(pid) && (pid as number) > 0,
		)
	) {
		throw new Error("invalid tmux inspect schema");
	}
	if (
		row.reachablePid !== undefined &&
		(!Number.isSafeInteger(row.reachablePid) ||
			(row.reachablePid as number) <= 0)
	) {
		throw new Error("invalid reachablePid");
	}
	return {
		verdict: row.verdict as TmuxSocketInspection["verdict"],
		socketPresent: row.socketPresent,
		socketPath: row.socketPath,
		reachablePid: row.reachablePid as number | undefined,
		candidatePids: row.candidatePids as number[],
		scanComplete: row.scanComplete,
	};
}

export function createTmuxRescueClient(input: {
	cliPath: string;
	socketPath: string;
	exec?: ExecFn;
	timeoutMs?: number;
}): { inspect(): Promise<TmuxSocketInspection>; recover(): Promise<boolean> } {
	const run = input.exec ?? defaultExec;
	const options = {
		timeout: input.timeoutMs ?? 10_000,
		maxBuffer: 256 * 1024,
		encoding: "utf8" as const,
	};
	return {
		async inspect() {
			const result = await run(
				input.cliPath,
				["inspect", input.socketPath],
				options,
			);
			return parseTmuxSocketInspection(result.stdout);
		},
		async recover() {
			let raw: string | Buffer;
			try {
				const result = await run(
					input.cliPath,
					["recover", input.socketPath],
					options,
				);
				raw = result.stdout;
			} catch (error) {
				raw =
					error && typeof error === "object" && "stdout" in error
						? ((error as { stdout?: string | Buffer }).stdout ?? "")
						: "";
			}
			try {
				const value = JSON.parse(lastJsonLine(raw)) as Record<string, unknown>;
				return value.action === "reachable" || value.action === "rescued";
			} catch {
				return false;
			}
		},
	};
}
