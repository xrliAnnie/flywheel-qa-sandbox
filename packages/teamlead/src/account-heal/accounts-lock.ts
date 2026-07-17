import { execFile as nodeExecFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { getLeaseProof, type LeaseProof, withMkdirLock } from "./mkdir-lock.js";

export type TransitionConflictReason =
	| "malformed_journal"
	| "keychain_unreadable"
	| "digest_mismatch_both";

export type TransitionReconcileResult =
	| { outcome: "none" | "cleared" }
	| { outcome: "completed"; activeAccount: string; generation: number }
	| { outcome: "writer_alive" }
	| { outcome: "conflict"; reason: TransitionConflictReason };

export type LockRunResult<T> =
	| { kind: "ok"; value: T }
	| { kind: "reconciled"; activeAccount: string; generation: number }
	| {
			kind: "blocked";
			reason:
				| { kind: "writer_alive" }
				| { kind: "conflict"; detail: TransitionConflictReason };
	  };

export type AccountsLock = <T>(
	lockPath: string,
	fn: (lease: LeaseProof) => Promise<T>,
) => Promise<LockRunResult<T>>;

type ExecFileFn = (
	file: string,
	args: string[],
	options: { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface AccountsLockDeps {
	withLock?: typeof withMkdirLock;
	getProof?: typeof getLeaseProof;
	reconcile?: (lease: LeaseProof) => Promise<TransitionReconcileResult>;
}

export function defaultTransitionJournalPath(): string {
	return (
		process.env.FLYWHEEL_CLAUDE_TRANSITION_JOURNAL ??
		`${homedir()}/.flywheel/claude-account-transition.json`
	);
}

/**
 * Invoke the bash-owned reconciler. A missing journal is handled locally so
 * ordinary lock acquisitions remain byte-compatible and do not spawn a child.
 */
export async function reconcileTransitionJournal(
	lease: LeaseProof,
	opts: {
		binPath?: string;
		journalPath?: string;
		execFile?: ExecFileFn;
	} = {},
): Promise<TransitionReconcileResult> {
	const journalPath = opts.journalPath ?? defaultTransitionJournalPath();
	try {
		lstatSync(journalPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { outcome: "none" };
		}
		return { outcome: "conflict", reason: "malformed_journal" };
	}
	const exec =
		opts.execFile ?? (promisify(nodeExecFile) as unknown as ExecFileFn);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		FLYWHEEL_CLAUDE_ACCOUNTS_LOCK: lease.lockPath,
		FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
		FLYWHEEL_LEASE_PROOF: JSON.stringify(lease),
		FLYWHEEL_CLAUDE_TRANSITION_JOURNAL: journalPath,
		FLYWHEEL_NODE_BIN: process.execPath,
	};
	const { stdout } = await exec(
		opts.binPath ??
			process.env.FLYWHEEL_CLAUDE_PROFILE_BIN ??
			"flywheel-claude-profile",
		["reconcile-journal"],
		{ env },
	);
	const line = stdout
		.trim()
		.split("\n")
		.reverse()
		.find((value: string) => value.trim().startsWith("{"));
	if (!line) return { outcome: "conflict", reason: "malformed_journal" };
	try {
		const parsed = JSON.parse(line) as TransitionReconcileResult;
		switch (parsed.outcome) {
			case "none":
			case "cleared":
			case "writer_alive":
				return parsed;
			case "completed":
				return typeof parsed.activeAccount === "string" &&
					Number.isInteger(parsed.generation)
					? parsed
					: { outcome: "conflict", reason: "malformed_journal" };
			case "conflict":
				return parsed.reason === "keychain_unreadable" ||
					parsed.reason === "digest_mismatch_both" ||
					parsed.reason === "malformed_journal"
					? parsed
					: { outcome: "conflict", reason: "malformed_journal" };
			default:
				return { outcome: "conflict", reason: "malformed_journal" };
		}
	} catch {
		return { outcome: "conflict", reason: "malformed_journal" };
	}
}

/**
 * The sole account-domain lock wrapper. Reconciliation always happens after
 * acquisition and before the caller can read or mutate shared account state.
 */
export async function withAccountsLock<T>(
	lockPath: string,
	fn: (lease: LeaseProof) => Promise<T>,
	deps: AccountsLockDeps = {},
): Promise<LockRunResult<T>> {
	const withLock = deps.withLock ?? withMkdirLock;
	const getProof = deps.getProof ?? getLeaseProof;
	const reconcile = deps.reconcile ?? reconcileTransitionJournal;
	return withLock(lockPath, async () => {
		const lease = getProof(lockPath);
		if (lease === null) {
			throw new Error(`account lock acquired without lease proof: ${lockPath}`);
		}
		const result = await reconcile(lease);
		switch (result.outcome) {
			case "none":
			case "cleared":
				return { kind: "ok", value: await fn(lease) };
			case "completed":
				return {
					kind: "reconciled",
					activeAccount: result.activeAccount,
					generation: result.generation,
				};
			case "writer_alive":
				return { kind: "blocked", reason: { kind: "writer_alive" } };
			case "conflict":
				return {
					kind: "blocked",
					reason: { kind: "conflict", detail: result.reason },
				};
		}
	});
}
