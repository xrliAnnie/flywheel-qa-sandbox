/**
 * FLY-1185 / FLY-1867 — bounded MCP descendant teardown.
 *
 * Signals require three fresh facts: exact pid+lstart+command identity, an
 * exact structured MCP classifier match, and the caller's sticky lifecycle
 * authority. Sensor failures are unknown and never authorize SIGKILL.
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { classifyMcpProcess } from "./mcp-process-classifier.js";

export const MCP_ORPHAN_MIN_ELAPSED_SECONDS = 30 * 60;
export const MCP_DISPATCH_BUDGET_MS = 5_000;
export const MCP_GRACEFUL_BUDGET_MS = 16_000;
export const MCP_CONFIRMATION_BUDGET_MS = 2_000;
export const MCP_AUTHORITY_BUDGET_MS = 5_000;
export const MCP_PREKILL_PROBE_BUDGET_MS = 1_000;
export const MCP_DEFAULT_TOTAL_LOGICAL_BUDGET_MS =
	MCP_DISPATCH_BUDGET_MS +
	MCP_AUTHORITY_BUDGET_MS +
	MCP_GRACEFUL_BUDGET_MS +
	MCP_PREKILL_PROBE_BUDGET_MS +
	MCP_AUTHORITY_BUDGET_MS +
	MCP_CONFIRMATION_BUDGET_MS;

export interface ProcessRow {
	pid: number;
	ppid: number;
	elapsedSeconds: number;
	/** LC_ALL=C ps lstart value, trimmed at both ends. */
	lstart: string;
	comm: string;
	argv: string[];
	/** Stable reconstructed argv used as part of the exact identity fence. */
	command: string;
}

export type ProcessProbeResult =
	| { status: "ok"; rows: ProcessRow[] }
	| { status: "unknown"; error: string };

export interface ProcessProbeOptions {
	timeoutMs?: number;
}

export type ListProcessesFn = (
	options?: ProcessProbeOptions,
) => Promise<ProcessProbeResult>;
export type KillFn = (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
export type SleepFn = (ms: number) => Promise<void>;

function execPs(args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"ps",
			args,
			{
				timeout: Math.max(1, Math.floor(timeoutMs)),
				maxBuffer: 32 * 1024 * 1024,
				env: { ...process.env, LC_ALL: "C" },
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
	});
}

function splitPsCommand(command: string): string[] {
	// ps command output does not expose a portable NUL-delimited argv on macOS.
	// The supported Playwright shapes have whitespace-free executable/package
	// paths; refuse to infer quoting and classify all other shapes as no-match.
	return command.trim().split(/\s+/).filter(Boolean);
}

/** Parse BSD/macOS `ps etime` (`[[dd-]hh:]mm:ss`, plus seconds-only). */
function parseEtimeSeconds(raw: string): number | null {
	if (/^\d+$/.test(raw)) {
		const seconds = Number(raw);
		return Number.isSafeInteger(seconds) ? seconds : null;
	}
	const daySplit = raw.split("-");
	if (daySplit.length > 2) return null;
	const days = daySplit.length === 2 ? Number(daySplit[0]) : 0;
	const clock = daySplit.at(-1)?.split(":") ?? [];
	if (clock.length !== 2 && clock.length !== 3) return null;
	if (daySplit.length === 2 && clock.length !== 3) return null;
	const values = clock.map(Number);
	if (
		!Number.isSafeInteger(days) ||
		days < 0 ||
		values.some((value) => !Number.isSafeInteger(value) || value < 0)
	) {
		return null;
	}
	const [hours, minutes, seconds] =
		clock.length === 3 ? values : [0, values[0], values[1]];
	if (
		hours === undefined ||
		minutes === undefined ||
		seconds === undefined ||
		minutes >= 60 ||
		seconds >= 60 ||
		(daySplit.length === 2 && hours >= 24)
	) {
		return null;
	}
	const elapsedSeconds =
		days * 24 * 60 * 60 + hours * 60 * 60 + minutes * 60 + seconds;
	return Number.isSafeInteger(elapsedSeconds) ? elapsedSeconds : null;
}

export function parseMcpPsProcessRow(line: string): ProcessRow | null {
	const match = line.match(
		/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
	);
	if (!match) return null;
	const pid = Number(match[1]);
	const ppid = Number(match[2]);
	const elapsedSeconds = parseEtimeSeconds(match[3] ?? "");
	const lstart = (match[4] ?? "").trim();
	const command = (match[5] ?? "").trim();
	const argv = splitPsCommand(command);
	if (
		!Number.isInteger(pid) ||
		!Number.isInteger(ppid) ||
		elapsedSeconds === null ||
		!lstart ||
		argv.length === 0
	) {
		return null;
	}
	return {
		pid,
		ppid,
		elapsedSeconds,
		lstart,
		comm: basename(argv[0] ?? ""),
		argv,
		command,
	};
}

export async function defaultListProcesses(
	options: ProcessProbeOptions = {},
): Promise<ProcessProbeResult> {
	const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
	try {
		// One BSD-compatible pass keeps pid/ppid/etime/lstart/argv from the same
		// process-table snapshot. `etimes` is Linux-only; macOS exposes `etime`.
		const primaryOutput = await execPs(
			["-axo", "pid=,ppid=,etime=,lstart=,command="],
			timeoutMs,
		);
		const rows: ProcessRow[] = [];
		for (const line of primaryOutput.split("\n")) {
			const row = parseMcpPsProcessRow(line);
			if (row) rows.push(row);
		}
		if (primaryOutput.trim() && rows.length === 0) {
			return {
				status: "unknown",
				error: "ps output did not match the BSD etime/lstart row shape",
			};
		}
		return { status: "ok", rows };
	} catch (error) {
		return {
			status: "unknown",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function defaultKill(
	pid: number,
	signal: "SIGTERM" | "SIGKILL",
): boolean {
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

export function collectDescendants(
	rows: ProcessRow[],
	rootPid: number,
): ProcessRow[] {
	const byParent = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		const children = byParent.get(row.ppid) ?? [];
		children.push(row);
		byParent.set(row.ppid, children);
	}
	const descendants: ProcessRow[] = [];
	const stack = [rootPid];
	const seen = new Set<number>();
	while (stack.length > 0) {
		const pid = stack.pop();
		if (pid === undefined || seen.has(pid)) continue;
		seen.add(pid);
		for (const child of byParent.get(pid) ?? []) {
			descendants.push(child);
			stack.push(child.pid);
		}
	}
	return descendants;
}

export interface McpReapDeps {
	listProcesses?: ListProcessesFn;
	kill?: KillFn;
	sleep?: SleepFn;
	dispatchMs?: number;
	graceMs?: number;
	pollMs?: number;
	confirmationMs?: number;
	confirmationPollMs?: number;
	/** Shared per-signal-stage budget for lifecycle-authority I/O. */
	authorityTimeoutMs?: number;
	/** Monotonic clock; injectable for deterministic deadline tests. */
	now?: () => number;
	audit?: (event: string, detail: Record<string, unknown>) => void;
	/** Sticky lifecycle authority. False, throw, or timeout blocks outer close. */
	authorityCheck?: () => Promise<boolean>;
}

export interface McpReapResult {
	matched: number;
	terminated: number;
	killSent: number;
	confirmedGone: number;
	survivors: number;
	identityMismatchSkipped: number;
	classifierBlocked: number;
	probeUnknown: number;
	authorityLost?: boolean;
	incompleteReason?:
		| "process_probe_unknown"
		| "dispatch_budget_exhausted"
		| "authority_timeout"
		| "classifier_unknown";
}

const emptyResult = (): McpReapResult => ({
	matched: 0,
	terminated: 0,
	killSent: 0,
	confirmedGone: 0,
	survivors: 0,
	identityMismatchSkipped: 0,
	classifierBlocked: 0,
	probeUnknown: 0,
});

function exactIdentity(left: ProcessRow, right: ProcessRow): boolean {
	return (
		left.pid === right.pid &&
		left.lstart === right.lstart &&
		left.command === right.command
	);
}

function identityKey(row: ProcessRow): string {
	return `${row.pid}\u0000${row.lstart}\u0000${row.command}`;
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<{ status: "ok"; value: T } | { status: "timeout" }> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise.then((value) => ({ status: "ok" as const, value })),
			new Promise<{ status: "timeout" }>((resolve) => {
				timer = setTimeout(
					() => resolve({ status: "timeout" }),
					Math.max(1, timeoutMs),
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function reapCandidates(
	candidates: ProcessRow[],
	deps: McpReapDeps,
	dispatchDeadline: number,
): Promise<McpReapResult> {
	const listProcesses = deps.listProcesses ?? defaultListProcesses;
	const kill = deps.kill ?? defaultKill;
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = deps.now ?? (() => performance.now());
	const audit = deps.audit ?? (() => {});
	const graceMs = deps.graceMs ?? MCP_GRACEFUL_BUDGET_MS;
	const pollMs = deps.pollMs ?? 500;
	const confirmationMs = deps.confirmationMs ?? MCP_CONFIRMATION_BUDGET_MS;
	const confirmationPollMs = deps.confirmationPollMs ?? 250;
	const authorityTimeoutMs = deps.authorityTimeoutMs ?? MCP_AUTHORITY_BUDGET_MS;
	let processDispatchDeadline = dispatchDeadline;
	const result = emptyResult();
	result.matched = candidates.length;
	if (candidates.length === 0) return result;

	const markIncomplete = (
		reason: NonNullable<McpReapResult["incompleteReason"]>,
		detail: Record<string, unknown> = {},
	) => {
		result.incompleteReason ??= reason;
		audit("mcp_reap_incomplete", { reason, ...detail });
	};
	const remaining = (deadline: number, cap: number) =>
		Math.max(1, Math.min(cap, deadline - now()));
	const probe = async (
		deadline: number,
		cap = MCP_PREKILL_PROBE_BUDGET_MS,
	): Promise<ProcessProbeResult> => {
		try {
			return await listProcesses({ timeoutMs: remaining(deadline, cap) });
		} catch (error) {
			return {
				status: "unknown",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};

	let authorityLostSticky = false;
	const authorityDeadlines = new Map<string, number>();
	const gateAuthority = async (stage: string): Promise<boolean> => {
		if (authorityLostSticky) return false;
		if (!deps.authorityCheck) return true;
		// Authority can require network I/O and gets a bounded clock of its own.
		// Reusing the dispatch deadline here would reduce the post-grace check to
		// 1 ms and make every legitimate SIGKILL path fail closed.
		const authorityDeadline =
			authorityDeadlines.get(stage) ?? now() + authorityTimeoutMs;
		authorityDeadlines.set(stage, authorityDeadline);
		const budget = remaining(authorityDeadline, authorityTimeoutMs);
		let checked: Awaited<ReturnType<typeof withTimeout<boolean>>>;
		const startedAt = now();
		try {
			checked = await withTimeout(deps.authorityCheck(), budget);
		} catch {
			checked = { status: "ok", value: false };
		} finally {
			if (stage === "pre_sigterm") {
				// Lifecycle authority may cross a network boundary. Give process
				// enumeration/classification/dispatch its full separate budget.
				processDispatchDeadline += Math.max(0, now() - startedAt);
			}
		}
		if (checked.status === "timeout") {
			authorityLostSticky = true;
			result.authorityLost = true;
			markIncomplete("authority_timeout", { stage });
			return false;
		}
		if (!checked.value) {
			authorityLostSticky = true;
			result.authorityLost = true;
			audit("mcp_reap_authority_lost", { stage });
			return false;
		}
		return true;
	};

	const preTerm = await probe(processDispatchDeadline);
	if (preTerm.status === "unknown") {
		result.probeUnknown++;
		markIncomplete("process_probe_unknown", {
			stage: "pre_sigterm",
			error: preTerm.error,
		});
		return result;
	}
	const preTermByPid = new Map(preTerm.rows.map((row) => [row.pid, row]));
	const termed: ProcessRow[] = [];
	for (const candidate of candidates) {
		if (now() >= processDispatchDeadline) {
			markIncomplete("dispatch_budget_exhausted", {
				stage: "sigterm",
				pid: candidate.pid,
			});
			break;
		}
		const current = preTermByPid.get(candidate.pid);
		if (!current || !exactIdentity(candidate, current)) {
			result.identityMismatchSkipped++;
			continue;
		}
		const classification = classifyMcpProcess(current);
		if (classification.verdict !== "match") {
			result.classifierBlocked++;
			if (classification.verdict === "unknown") {
				markIncomplete("classifier_unknown", {
					stage: "pre_sigterm",
					pid: candidate.pid,
				});
			}
			continue;
		}
		if (!(await gateAuthority("pre_sigterm"))) break;
		if (kill(candidate.pid, "SIGTERM")) {
			result.terminated++;
			termed.push(candidate);
			audit("mcp_reap_sigterm", {
				pid: candidate.pid,
				lstart: candidate.lstart,
			});
		}
	}
	if (termed.length === 0) return result;

	const gone = new Set<string>();
	let survivors = [...termed];
	const gracefulDeadline = now() + graceMs;
	while (survivors.length > 0 && now() < gracefulDeadline) {
		const snapshot = await probe(gracefulDeadline);
		if (snapshot.status === "unknown") {
			result.probeUnknown++;
			await sleep(Math.min(pollMs, Math.max(0, gracefulDeadline - now())));
			continue;
		}
		const byPid = new Map(snapshot.rows.map((row) => [row.pid, row]));
		const next: ProcessRow[] = [];
		for (const candidate of survivors) {
			const current = byPid.get(candidate.pid);
			if (!current || !exactIdentity(candidate, current)) {
				if (current) result.identityMismatchSkipped++;
				gone.add(identityKey(candidate));
				continue;
			}
			next.push(candidate);
		}
		survivors = next;
		if (survivors.length > 0) {
			await sleep(Math.min(pollMs, Math.max(0, gracefulDeadline - now())));
		}
	}

	const preKill = await probe(now() + Math.max(1, confirmationMs));
	if (preKill.status === "unknown") {
		result.probeUnknown++;
		markIncomplete("process_probe_unknown", {
			stage: "pre_sigkill",
			error: preKill.error,
		});
		result.confirmedGone = gone.size;
		result.survivors = survivors.length;
		return result;
	}
	const preKillByPid = new Map(preKill.rows.map((row) => [row.pid, row]));
	const sent: ProcessRow[] = [];
	let blockedAlive = 0;
	for (const candidate of survivors) {
		const current = preKillByPid.get(candidate.pid);
		if (!current || !exactIdentity(candidate, current)) {
			if (current) result.identityMismatchSkipped++;
			gone.add(identityKey(candidate));
			continue;
		}
		const classification = classifyMcpProcess(current);
		if (classification.verdict !== "match") {
			result.classifierBlocked++;
			blockedAlive++;
			if (classification.verdict === "unknown") {
				markIncomplete("classifier_unknown", {
					stage: "pre_sigkill",
					pid: candidate.pid,
				});
			}
			continue;
		}
		if (!(await gateAuthority("pre_sigkill"))) {
			blockedAlive++;
			continue;
		}
		if (kill(candidate.pid, "SIGKILL")) {
			result.killSent++;
			sent.push(candidate);
			audit("mcp_reap_sigkill_sent", {
				pid: candidate.pid,
				lstart: candidate.lstart,
			});
		} else {
			blockedAlive++;
		}
	}

	let unconfirmed = [...sent];
	const confirmationDeadline = now() + confirmationMs;
	let firstConfirmation = true;
	while (
		unconfirmed.length > 0 &&
		(firstConfirmation || now() < confirmationDeadline)
	) {
		firstConfirmation = false;
		const snapshot = await probe(confirmationDeadline);
		if (snapshot.status === "unknown") {
			result.probeUnknown++;
			if (now() < confirmationDeadline) {
				await sleep(
					Math.min(
						confirmationPollMs,
						Math.max(0, confirmationDeadline - now()),
					),
				);
			}
			continue;
		}
		const byPid = new Map(snapshot.rows.map((row) => [row.pid, row]));
		const next: ProcessRow[] = [];
		for (const candidate of unconfirmed) {
			const current = byPid.get(candidate.pid);
			if (!current || !exactIdentity(candidate, current)) {
				gone.add(identityKey(candidate));
				continue;
			}
			next.push(candidate);
		}
		unconfirmed = next;
		if (unconfirmed.length > 0 && now() < confirmationDeadline) {
			await sleep(
				Math.min(confirmationPollMs, Math.max(0, confirmationDeadline - now())),
			);
		}
	}

	result.confirmedGone = gone.size;
	result.survivors = blockedAlive + unconfirmed.length;
	if (unconfirmed.length > 0) {
		audit("mcp_reap_survivors", {
			identities: unconfirmed.map((row) => ({
				pid: row.pid,
				lstart: row.lstart,
			})),
		});
	}
	return result;
}

export async function reapMcpDescendants(
	panePid: number,
	deps: McpReapDeps = {},
): Promise<McpReapResult> {
	const now = deps.now ?? (() => performance.now());
	const dispatchDeadline = now() + (deps.dispatchMs ?? MCP_DISPATCH_BUDGET_MS);
	const listProcesses = deps.listProcesses ?? defaultListProcesses;
	try {
		const initial = await listProcesses({
			timeoutMs: Math.max(1, dispatchDeadline - now()),
		});
		if (initial.status === "unknown") {
			const result = emptyResult();
			result.probeUnknown = 1;
			result.incompleteReason = "process_probe_unknown";
			deps.audit?.("mcp_reap_incomplete", {
				reason: result.incompleteReason,
				stage: "initial",
				error: initial.error,
			});
			return result;
		}
		const descendants = collectDescendants(initial.rows, panePid);
		const candidates: ProcessRow[] = [];
		let classifierUnknown = 0;
		for (const row of descendants) {
			const classification = classifyMcpProcess(row);
			if (classification.verdict === "match") candidates.push(row);
			else if (classification.verdict === "unknown") classifierUnknown++;
		}
		const result = await reapCandidates(candidates, deps, dispatchDeadline);
		if (classifierUnknown > 0) {
			result.classifierBlocked += classifierUnknown;
			result.incompleteReason ??= "classifier_unknown";
			deps.audit?.("mcp_reap_incomplete", {
				reason: "classifier_unknown",
				stage: "initial",
				count: classifierUnknown,
			});
		}
		return result;
	} catch (error) {
		deps.audit?.("mcp_reap_failed", {
			panePid,
			error: error instanceof Error ? error.message : String(error),
		});
		const result = emptyResult();
		result.probeUnknown = 1;
		result.incompleteReason = "process_probe_unknown";
		return result;
	}
}

export async function reapMcpOrphans(
	deps: McpReapDeps = {},
): Promise<McpReapResult> {
	const now = deps.now ?? (() => performance.now());
	const dispatchDeadline = now() + (deps.dispatchMs ?? MCP_DISPATCH_BUDGET_MS);
	const listProcesses = deps.listProcesses ?? defaultListProcesses;
	try {
		const initial = await listProcesses({
			timeoutMs: Math.max(1, dispatchDeadline - now()),
		});
		if (initial.status === "unknown") {
			const result = emptyResult();
			result.probeUnknown = 1;
			result.incompleteReason = "process_probe_unknown";
			deps.audit?.("mcp_orphan_reap_incomplete", {
				reason: result.incompleteReason,
				error: initial.error,
			});
			return result;
		}
		const candidates: ProcessRow[] = [];
		let classifierUnknown = 0;
		for (const row of initial.rows) {
			if (
				row.ppid !== 1 ||
				row.elapsedSeconds < MCP_ORPHAN_MIN_ELAPSED_SECONDS
			) {
				continue;
			}
			const classification = classifyMcpProcess(row);
			if (classification.verdict === "match") candidates.push(row);
			else if (classification.verdict === "unknown") classifierUnknown++;
		}
		const result = await reapCandidates(candidates, deps, dispatchDeadline);
		if (classifierUnknown > 0) {
			result.classifierBlocked += classifierUnknown;
			result.incompleteReason ??= "classifier_unknown";
			deps.audit?.("mcp_orphan_reap_incomplete", {
				reason: "classifier_unknown",
				count: classifierUnknown,
			});
		}
		return result;
	} catch (error) {
		deps.audit?.("mcp_orphan_reap_failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		const result = emptyResult();
		result.probeUnknown = 1;
		result.incompleteReason = "process_probe_unknown";
		return result;
	}
}
