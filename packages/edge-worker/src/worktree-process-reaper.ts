import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { auditedSignal } from "flywheel-claude-runner";
import { canonicalizeWorktreePath } from "./worktree-paths.js";

export interface ReapTarget {
	lexicalPath: string;
	canonicalPath: string;
	expectedParentDir: string;
	repoSlugPrefix: string;
	rootProof: "live-dir" | "gone";
}

export interface CwdRow {
	pid: number;
	rawCwd: string;
	logicalCwd: string | null;
	deletedMarker: boolean;
}

export interface ProcessRow {
	pid: number;
	ppid: number;
	pgid: number;
	lstart: string;
	command: string;
}

export interface ReapSummary {
	matched: number;
	reaped: number[];
	survivors: number[];
	verified: boolean;
	identityMismatchSkipped: number;
	scanError?: string;
	verifyError?: string;
	refusedReason?: string;
}

export function isReapIncomplete(summary: ReapSummary): boolean {
	return (
		!summary.verified ||
		summary.survivors.length > 0 ||
		Boolean(summary.scanError || summary.verifyError || summary.refusedReason)
	);
}

export interface ReapDeps {
	listCwds(): Promise<CwdRow[]>;
	listProcesses(): Promise<ProcessRow[]>;
	kill(pid: number, sig: "SIGTERM" | "SIGKILL" | 0): boolean;
	killGroup(pgid: number, sig: "SIGTERM" | "SIGKILL"): boolean;
	sleep(ms: number): Promise<void>;
	now(): number;
	lstat(p: string): { isDir: boolean; isSymlink: boolean } | null;
	realpath(p: string): string | null;
	selfPid: number;
}

export const REAP_TOTAL_DEADLINE_MS = 25_000;
const TERM_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const POLL_MS = 250;
const MAX_CONVERGENCE_ROUNDS = 2;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function runFile(
	command: string,
	args: string[],
	options?: { env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{
				env: options?.env,
				timeout: options?.timeout ?? 10_000,
				maxBuffer: 16 * 1024 * 1024,
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
	});
}

/** Parse the process/file records emitted by `lsof -a -d cwd -F pfn`. */
export function parseLsofCwdOutput(output: string): CwdRow[] {
	const rows: CwdRow[] = [];
	let pid: number | null = null;
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) {
			const parsed = Number.parseInt(line.slice(1), 10);
			pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
			continue;
		}
		if (!line.startsWith("n") || pid === null) continue;
		const rawCwd = line.slice(1);
		const deletedMarker = rawCwd.endsWith(" (deleted)");
		const logical = deletedMarker
			? rawCwd.slice(0, -" (deleted)".length)
			: rawCwd;
		rows.push({
			pid,
			rawCwd,
			logicalCwd: path.isAbsolute(logical) ? logical : null,
			deletedMarker,
		});
	}
	return rows;
}

export function parseProcessOutput(output: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of output.split("\n")) {
		const match = line
			.trim()
			.match(
				/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/,
			);
		if (!match) continue;
		const pid = Number.parseInt(match[1]!, 10);
		const ppid = Number.parseInt(match[2]!, 10);
		const pgid = Number.parseInt(match[3]!, 10);
		if (![pid, ppid, pgid].every(Number.isSafeInteger) || pid <= 0) continue;
		rows.push({
			pid,
			ppid,
			pgid,
			lstart: match.slice(4, 9).join(" "),
			command: match[9]!,
		});
	}
	return rows;
}

/** Shared system cwd census for teardown and orphan-convergence discovery. */
export async function listSystemCwds(): Promise<CwdRow[]> {
	return parseLsofCwdOutput(
		await runFile("lsof", ["-a", "-d", "cwd", "-F", "pfn"]),
	);
}

const defaultDeps: ReapDeps = {
	listCwds: listSystemCwds,
	listProcesses: async () =>
		parseProcessOutput(
			await runFile("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="], {
				env: { ...process.env, LC_ALL: "C" },
			}),
		),
	kill: (pid, signal) => {
		if (signal === 0) {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				throw error;
			}
		}
		const result = auditedSignal({
			source: "worktree_process_reaper",
			signal,
			targetKind: "pid",
			target: pid,
			reason: "worktree_owner_reap",
		});
		if (result.ok) return true;
		if (result.kind === "signal_failed" && result.error.includes("ESRCH")) {
			return false;
		}
		throw new Error(`audited pid signal blocked: ${result.error}`);
	},
	killGroup: (pgid, signal) => {
		const result = auditedSignal({
			source: "worktree_process_reaper",
			signal,
			targetKind: "pgid",
			target: pgid,
			reason: "worktree_owner_group_reap",
		});
		if (result.ok) return true;
		if (result.kind === "signal_failed" && result.error.includes("ESRCH")) {
			return false;
		}
		throw new Error(`audited group signal blocked: ${result.error}`);
	},
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => performance.now(),
	lstat: (candidate) => {
		try {
			const stat = fs.lstatSync(candidate);
			return { isDir: stat.isDirectory(), isSymlink: stat.isSymbolicLink() };
		} catch {
			return null;
		}
	},
	realpath: (candidate) => {
		try {
			return fs.realpathSync(candidate);
		} catch {
			return null;
		}
	},
	selfPid: process.pid,
};

function emptySummary(): ReapSummary {
	return {
		matched: 0,
		reaped: [],
		survivors: [],
		verified: false,
		identityMismatchSkipped: 0,
	};
}

function strippedWorktreeBasename(candidate: string): string {
	return path.basename(candidate).replace(/\.removing(?:-|\.)\d+$/, "");
}

function guardTarget(target: ReapTarget, deps: ReapDeps): string | null {
	if (
		!path.isAbsolute(target.lexicalPath) ||
		!path.isAbsolute(target.canonicalPath) ||
		!path.isAbsolute(target.expectedParentDir)
	) {
		return "target paths must be absolute";
	}
	const parts = target.canonicalPath
		.slice(path.parse(target.canonicalPath).root.length)
		.split(path.sep)
		.filter(Boolean);
	if (parts.length < 3) return "target path is too shallow";
	const expectedParent = path.resolve(target.expectedParentDir);
	if (path.dirname(path.resolve(target.canonicalPath)) !== expectedParent) {
		return "target is not a direct child of the expected parent";
	}
	if (
		!target.repoSlugPrefix ||
		!strippedWorktreeBasename(target.lexicalPath).startsWith(
			target.repoSlugPrefix,
		)
	) {
		return "target basename does not match the repository prefix";
	}
	const stat = deps.lstat(target.lexicalPath);
	if (target.rootProof === "gone") {
		if (stat !== null) return "gone target exists on disk";
		return null;
	}
	if (stat?.isSymlink) return "live target is a symlink";
	if (!stat?.isDir) return "live target is not a directory";
	const real = deps.realpath(target.lexicalPath);
	if (
		real === null ||
		path.resolve(real) !== path.resolve(target.canonicalPath)
	) {
		return "live target realpath drifted";
	}
	return null;
}

function rowIdentityEquals(a: ProcessRow, b: ProcessRow): boolean {
	return a.pid === b.pid && a.lstart === b.lstart && a.command === b.command;
}

function matchingCwdPids(rows: CwdRow[], target: ReapTarget): Set<number> {
	const result = new Set<number>();
	const root = path.resolve(target.canonicalPath);
	for (const row of rows) {
		if (row.logicalCwd === null) continue;
		const cwd = canonicalizeWorktreePath(row.logicalCwd);
		if (cwd === root || cwd.startsWith(`${root}${path.sep}`))
			result.add(row.pid);
	}
	return result;
}

function expandTargets(
	matched: Set<number>,
	rows: ProcessRow[],
): { targets: Set<number>; captured: Map<number, ProcessRow> } {
	const targets = new Set<number>();
	const captured = new Map<number, ProcessRow>();
	for (const row of rows) {
		if (matched.has(row.pid)) targets.add(row.pid);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			if (!targets.has(row.pid) && targets.has(row.ppid)) {
				targets.add(row.pid);
				changed = true;
			}
		}
	}
	for (const row of rows) {
		if (targets.has(row.pid)) captured.set(row.pid, row);
	}
	return { targets, captured };
}

function protectedPids(selfPid: number, rows: ProcessRow[]): Set<number> {
	const protectedSet = new Set<number>([1, selfPid]);
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	let cursor = selfPid;
	while (cursor > 1) {
		const parent = byPid.get(cursor)?.ppid;
		if (!parent || protectedSet.has(parent)) break;
		protectedSet.add(parent);
		cursor = parent;
	}
	return protectedSet;
}

/**
 * Reap every process rooted in a worktree cwd. Detection is path/census based;
 * command names are retained only as a PID-generation identity fence.
 */
export async function reapWorktreeProcesses(
	target: ReapTarget,
	overrides?: Partial<ReapDeps>,
): Promise<ReapSummary> {
	const deps: ReapDeps = { ...defaultDeps, ...overrides };
	const summary = emptySummary();
	const deadline = deps.now() + REAP_TOTAL_DEADLINE_MS;
	const mismatched = new Set<number>();
	const allTargets = new Set<number>();
	const captured = new Map<number, ProcessRow>();
	let signalsStarted = false;
	let lastKnownAlive = new Set<number>();

	const refuse = guardTarget(target, deps);
	if (refuse) return { ...summary, refusedReason: refuse };

	let initialMatches: Set<number>;
	try {
		initialMatches = matchingCwdPids(await deps.listCwds(), target);
	} catch (error) {
		return { ...summary, scanError: errorMessage(error) };
	}
	summary.matched = initialMatches.size;
	if (initialMatches.size === 0) return { ...summary, verified: true };

	let initialRows: ProcessRow[];
	try {
		initialRows = await deps.listProcesses();
	} catch (error) {
		return {
			...summary,
			survivors: [...initialMatches].sort((a, b) => a - b),
			scanError: errorMessage(error),
		};
	}
	const initial = expandTargets(initialMatches, initialRows);
	const protectedSet = protectedPids(deps.selfPid, initialRows);
	for (const pid of initial.targets) {
		if (pid <= 1 || protectedSet.has(pid)) continue;
		allTargets.add(pid);
		const identity = initial.captured.get(pid);
		if (identity) captured.set(pid, identity);
	}
	lastKnownAlive = new Set(allTargets);

	const failAfterStart = (message: string): ReapSummary => {
		// Once signaling has begun, an uncertain terminal census must never be
		// rendered as an empty survivor set. Conservatively carry every captured
		// target when the last known-alive set is empty but verification failed.
		const uncertain =
			signalsStarted && lastKnownAlive.size === 0
				? new Set(allTargets)
				: lastKnownAlive;
		return {
			...summary,
			reaped: [...allTargets]
				.filter((pid) => !uncertain.has(pid))
				.sort((a, b) => a - b),
			survivors: [...uncertain].sort((a, b) => a - b),
			verified: false,
			identityMismatchSkipped: mismatched.size,
			...(signalsStarted ? { verifyError: message } : { scanError: message }),
		};
	};

	const signalWave = async (
		candidatePids: Set<number>,
		signal: "SIGTERM" | "SIGKILL",
	): Promise<string | null> => {
		const guardFailure = guardTarget(target, deps);
		if (guardFailure) return guardFailure;
		let current: ProcessRow[];
		try {
			current = await deps.listProcesses();
		} catch (error) {
			return errorMessage(error);
		}
		lastKnownAlive = new Set(
			current.filter((row) => allTargets.has(row.pid)).map((row) => row.pid),
		);
		const byPid = new Map(current.map((row) => [row.pid, row]));
		const groupMembers = new Map<number, ProcessRow[]>();
		for (const row of current) {
			const members = groupMembers.get(row.pgid) ?? [];
			members.push(row);
			groupMembers.set(row.pgid, members);
		}
		const handled = new Set<number>();
		for (const pid of candidatePids) {
			if (handled.has(pid)) continue;
			const row = byPid.get(pid);
			if (!row) continue;
			const members = groupMembers.get(row.pgid) ?? [];
			const wholeGroupOwned =
				row.pgid > 1 &&
				members.length > 0 &&
				members.every((member) => {
					const identity = captured.get(member.pid);
					return (
						candidatePids.has(member.pid) &&
						!protectedSet.has(member.pid) &&
						identity !== undefined &&
						rowIdentityEquals(identity, member)
					);
				});
			if (!wholeGroupOwned) continue;
			try {
				if (deps.killGroup(row.pgid, signal)) signalsStarted = true;
				for (const member of members) handled.add(member.pid);
			} catch (error) {
				return errorMessage(error);
			}
		}
		for (const pid of candidatePids) {
			if (handled.has(pid)) continue;
			const row = byPid.get(pid);
			if (!row) continue;
			const identity = captured.get(pid);
			if (!identity || !rowIdentityEquals(identity, row)) {
				mismatched.add(pid);
				continue;
			}
			try {
				if (deps.kill(pid, signal)) signalsStarted = true;
			} catch (error) {
				return errorMessage(error);
			}
		}
		return null;
	};

	const waitForExit = async (
		candidatePids: Set<number>,
		maxWaitMs: number,
	): Promise<{ alive: Set<number>; error?: string }> => {
		const stageDeadline = Math.min(deadline, deps.now() + maxWaitMs);
		while (true) {
			const alive = new Set<number>();
			try {
				for (const pid of candidatePids) {
					if (deps.kill(pid, 0)) alive.add(pid);
				}
			} catch (error) {
				return { alive, error: errorMessage(error) };
			}
			lastKnownAlive = alive;
			if (alive.size === 0 || deps.now() >= stageDeadline) return { alive };
			await deps.sleep(Math.min(POLL_MS, stageDeadline - deps.now()));
		}
	};

	const terminateSet = async (
		candidatePids: Set<number>,
	): Promise<string | null> => {
		if (deps.now() >= deadline) return "reap deadline exhausted before TERM";
		let failure = await signalWave(candidatePids, "SIGTERM");
		if (failure) return failure;
		let waited = await waitForExit(candidatePids, TERM_GRACE_MS);
		if (waited.error) return waited.error;
		if (waited.alive.size === 0) return null;
		if (deps.now() >= deadline) return "reap deadline exhausted after TERM";
		failure = await signalWave(waited.alive, "SIGKILL");
		if (failure) return failure;
		waited = await waitForExit(waited.alive, KILL_GRACE_MS);
		if (waited.error) return waited.error;
		if (waited.alive.size > 0) return "processes survived SIGKILL grace";
		return null;
	};

	let failure = await terminateSet(new Set(allTargets));
	if (failure) return failAfterStart(failure);

	for (let round = 0; round <= MAX_CONVERGENCE_ROUNDS; round += 1) {
		if (deps.now() >= deadline)
			return failAfterStart("reap deadline exhausted");
		const guardFailure = guardTarget(target, deps);
		if (guardFailure) return failAfterStart(guardFailure);
		let cwdRows: CwdRow[];
		let processRows: ProcessRow[];
		try {
			cwdRows = await deps.listCwds();
			processRows = await deps.listProcesses();
		} catch (error) {
			return failAfterStart(errorMessage(error));
		}
		const matchedNow = matchingCwdPids(cwdRows, target);
		const rowByPid = new Map(processRows.map((row) => [row.pid, row]));
		lastKnownAlive = new Set(
			[...allTargets].filter((pid) => rowByPid.has(pid)),
		);
		if (matchedNow.size === 0 && lastKnownAlive.size === 0) {
			return {
				...summary,
				reaped: [...allTargets].sort((a, b) => a - b),
				survivors: [],
				verified: true,
				identityMismatchSkipped: mismatched.size,
			};
		}
		if (round === MAX_CONVERGENCE_ROUNDS) {
			const survivors = new Set([...lastKnownAlive, ...matchedNow]);
			return {
				...summary,
				reaped: [...allTargets]
					.filter((pid) => !survivors.has(pid))
					.sort((a, b) => a - b),
				survivors: [...survivors].sort((a, b) => a - b),
				verified: false,
				identityMismatchSkipped: mismatched.size,
				verifyError: "target processes remain after bounded convergence",
			};
		}
		const expanded = expandTargets(matchedNow, processRows);
		const newTargets = new Set<number>();
		for (const pid of expanded.targets) {
			if (pid <= 1 || protectedSet.has(pid)) continue;
			newTargets.add(pid);
			allTargets.add(pid);
			if (!captured.has(pid)) {
				const identity = expanded.captured.get(pid);
				if (identity) captured.set(pid, identity);
			}
		}
		failure = await terminateSet(newTargets);
		if (failure) return failAfterStart(failure);
	}

	return failAfterStart("bounded convergence ended unexpectedly");
}
