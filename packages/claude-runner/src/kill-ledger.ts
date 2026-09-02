import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type KillLedgerTargetKind = "pid" | "pgid" | "tmux-window";

export interface KillLedgerEntry {
	ts: string;
	source: string;
	signal: string;
	targetKind: KillLedgerTargetKind;
	target: number | string;
	execId?: string;
	reason: string;
	schemaVersion: 1;
}

export interface AuditedSignalInput {
	source: string;
	signal: string;
	targetKind: KillLedgerTargetKind;
	target: number | string;
	execId?: string;
	reason: string;
	failureMode?: "fail-closed" | "forced-shutdown-fail-open";
}

export type AuditedSignalResult =
	| {
			ok: true;
			ledger: "ndjson" | "stderr-fallback";
			entry: KillLedgerEntry;
	  }
	| {
			ok: false;
			kind: "invalid_target" | "ledger_failed" | "signal_failed";
			error: string;
			entry: KillLedgerEntry;
	  };

export interface AuditedSignalDeps {
	ledgerRoot?: string;
	now?: () => Date;
	fsync?: (fd: number) => void;
	mutate?: (target: number | string, signal: string) => void;
	stderr?: (line: string) => void;
}

export interface AuditedSignalAsyncDeps
	extends Omit<AuditedSignalDeps, "mutate"> {
	mutate?: (target: number | string, signal: string) => void | Promise<void>;
}

function defaultLedgerRoot(env: NodeJS.ProcessEnv = process.env): string {
	const stateRoot =
		env.FLYWHEEL_STATE_DIR ?? join(homedir(), ".flywheel", "state");
	return env.FLYWHEEL_KILL_LEDGER_ROOT ?? join(stateRoot, "kill-ledger");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function mutationTarget(
	input: AuditedSignalInput,
): number | string | undefined {
	if (input.targetKind === "tmux-window") {
		return typeof input.target === "string" && input.target.length > 0
			? input.target
			: undefined;
	}
	if (
		typeof input.target !== "number" ||
		!Number.isSafeInteger(input.target) ||
		input.target <= 1
	) {
		return undefined;
	}
	return input.targetKind === "pgid" ? -input.target : input.target;
}

function defaultMutation(target: number | string, signal: string): void {
	if (typeof target !== "number") {
		throw new Error(
			"tmux-window mutations require an injected mutate function",
		);
	}
	process.kill(target, signal as NodeJS.Signals);
}

/**
 * Persist a durable process-mutation receipt before sending the signal.
 *
 * Runner-affecting mutations fail closed when the append or fsync fails. The
 * only fail-open mode is the explicitly named forced-shutdown escape hatch;
 * even that path writes a structured stderr receipt before mutating.
 */
export function auditedSignal(
	input: AuditedSignalInput,
	deps: AuditedSignalDeps = {},
): AuditedSignalResult {
	const now = (deps.now ?? (() => new Date()))();
	const entry: KillLedgerEntry = {
		ts: now.toISOString(),
		source: input.source,
		signal: input.signal,
		targetKind: input.targetKind,
		target: input.target,
		...(input.execId ? { execId: input.execId } : {}),
		reason: input.reason,
		schemaVersion: 1,
	};
	const target = mutationTarget(input);
	if (target === undefined) {
		return {
			ok: false,
			kind: "invalid_target",
			error: `invalid ${input.targetKind} target: ${String(input.target)}`,
			entry,
		};
	}

	let durableLedger: "ndjson" | "stderr-fallback" = "ndjson";
	try {
		const root = deps.ledgerRoot ?? defaultLedgerRoot();
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const day = entry.ts.slice(0, 10).replaceAll("-", "");
		const path = join(root, `${day}.ndjson`);
		const fd = openSync(path, "a", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(entry)}\n`, undefined, "utf8");
			(deps.fsync ?? fsyncSync)(fd);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		const detail = errorMessage(error);
		if (input.failureMode !== "forced-shutdown-fail-open") {
			return { ok: false, kind: "ledger_failed", error: detail, entry };
		}
		durableLedger = "stderr-fallback";
		const fallback = {
			kind: "KILL_LEDGER_FALLBACK",
			entry,
			ledgerError: detail,
		};
		(deps.stderr ?? console.error)(JSON.stringify(fallback));
	}

	try {
		(deps.mutate ?? defaultMutation)(target, input.signal);
		return { ok: true, ledger: durableLedger, entry };
	} catch (error) {
		return {
			ok: false,
			kind: "signal_failed",
			error: errorMessage(error),
			entry,
		};
	}
}

/** Async mutation variant for tmux/process wrappers that return a Promise. */
export async function auditedSignalAsync(
	input: AuditedSignalInput,
	deps: AuditedSignalAsyncDeps = {},
): Promise<AuditedSignalResult> {
	const now = (deps.now ?? (() => new Date()))();
	const entry: KillLedgerEntry = {
		ts: now.toISOString(),
		source: input.source,
		signal: input.signal,
		targetKind: input.targetKind,
		target: input.target,
		...(input.execId ? { execId: input.execId } : {}),
		reason: input.reason,
		schemaVersion: 1,
	};
	const target = mutationTarget(input);
	if (target === undefined) {
		return {
			ok: false,
			kind: "invalid_target",
			error: `invalid ${input.targetKind} target: ${String(input.target)}`,
			entry,
		};
	}

	let durableLedger: "ndjson" | "stderr-fallback" = "ndjson";
	try {
		const root = deps.ledgerRoot ?? defaultLedgerRoot();
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const day = entry.ts.slice(0, 10).replaceAll("-", "");
		const path = join(root, `${day}.ndjson`);
		const fd = openSync(path, "a", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(entry)}\n`, undefined, "utf8");
			(deps.fsync ?? fsyncSync)(fd);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		const detail = errorMessage(error);
		if (input.failureMode !== "forced-shutdown-fail-open") {
			return { ok: false, kind: "ledger_failed", error: detail, entry };
		}
		durableLedger = "stderr-fallback";
		(deps.stderr ?? console.error)(
			JSON.stringify({
				kind: "KILL_LEDGER_FALLBACK",
				entry,
				ledgerError: detail,
			}),
		);
	}

	try {
		await (deps.mutate ?? defaultMutation)(target, input.signal);
		return { ok: true, ledger: durableLedger, entry };
	} catch (error) {
		return {
			ok: false,
			kind: "signal_failed",
			error: errorMessage(error),
			entry,
		};
	}
}
