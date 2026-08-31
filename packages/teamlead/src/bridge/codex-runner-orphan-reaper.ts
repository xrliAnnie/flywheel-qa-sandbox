/**
 * FLY-2169 — identity-safe cleanup for socket-hosted Codex app-server orphans.
 *
 * The forward axis starts from the adapter's durable session.json ownership
 * ledger. The reverse axis finds the crash shape where that ledger has already
 * disappeared but an old, reparented app-server still owns its execution socket.
 * Both axes fail closed: canonical CODEX_HOME inventory, exact app-server argv
 * + socket, fresh pgid, and fresh lsof holder identity are all required before
 * a process-group signal. The socket is unlinked only after that exact group
 * and its socket ownership are both proven gone.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
	codexHomeDir,
	codexHomesRoot,
	codexSessionStateDir,
	resolveDaemonSocketPath,
} from "flywheel-claude-runner";

export const CODEX_APP_SERVER_ORPHAN_MIN_ELAPSED_SECONDS = 2 * 60 * 60;

export interface CodexAppServerProcess {
	pid: number;
	ppid: number;
	pgid: number;
	elapsedSeconds: number;
	/** BSD ps command field. */
	command: string;
}

export interface CodexDaemonLedger {
	executionId: string;
	daemonPgid: number;
}

export type CodexProcessProbeResult =
	| { status: "ok"; rows: CodexAppServerProcess[] }
	| { status: "unknown"; error: string };

export type CodexLedgerProbeResult =
	| { status: "ok"; ledgers: CodexDaemonLedger[] }
	| { status: "unknown"; error: string };

export type CodexHomeProbeResult =
	| { status: "ok"; executionIds: string[] }
	| { status: "unknown"; error: string };

export type SocketHolderProbeResult =
	| { status: "ok"; pids: number[] }
	| { status: "unknown"; error: string };

export interface CodexRunnerOrphanSweepDeps {
	env?: NodeJS.ProcessEnv;
	listProcesses?: () => Promise<CodexProcessProbeResult>;
	listLedgers?: () => Promise<CodexLedgerProbeResult>;
	listHomes?: () => Promise<CodexHomeProbeResult>;
	socketHolderPids?: (socketPath: string) => Promise<SocketHolderProbeResult>;
	signalGroup?: (pgid: number, signal: NodeJS.Signals) => boolean;
	removeSocket?: (path: string) => void;
	sleep?: (ms: number) => Promise<void>;
	termGraceMs?: number;
	killConfirmMs?: number;
	minElapsedSeconds?: number;
	audit?: (event: string, detail: Record<string, unknown>) => void;
}

export interface CodexRunnerOrphanSweepResult {
	ledgerCandidates: number;
	processCandidates: number;
	reaped: number;
	identityMismatchSkipped: number;
	unparseableSkipped: number;
	probeUnknown: number;
	survivors: number;
}

interface AppServerIdentity {
	socketPath: string;
}

interface ReapCandidate extends AppServerIdentity {
	executionId: string;
	codexHome: string;
	pgid: number;
	pid: number;
	command: string;
	source: "ledger" | "process";
}

function parseElapsedSeconds(raw: string): number | null {
	if (/^\d+$/.test(raw)) {
		const seconds = Number(raw);
		return Number.isSafeInteger(seconds) ? seconds : null;
	}
	const dayParts = raw.split("-");
	if (dayParts.length > 2) return null;
	const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
	const clock = dayParts.at(-1)?.split(":").map(Number) ?? [];
	if (
		!Number.isSafeInteger(days) ||
		days < 0 ||
		(clock.length !== 2 && clock.length !== 3) ||
		clock.some((part) => !Number.isSafeInteger(part) || part < 0)
	) {
		return null;
	}
	const [hours, minutes, seconds] =
		clock.length === 3 ? clock : [0, clock[0], clock[1]];
	if (
		hours === undefined ||
		minutes === undefined ||
		seconds === undefined ||
		minutes >= 60 ||
		seconds >= 60 ||
		(dayParts.length === 2 && hours >= 24)
	) {
		return null;
	}
	return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/** Parse `ps -axo pid=,ppid=,pgid=,etime=,command=` output. */
export function parseCodexAppServerProcessRow(
	line: string,
): CodexAppServerProcess | null {
	const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
	if (!match) return null;
	const pid = Number(match[1]);
	const ppid = Number(match[2]);
	const pgid = Number(match[3]);
	const elapsedSeconds = parseElapsedSeconds(match[4] ?? "");
	const command = (match[5] ?? "").trim();
	if (
		!Number.isSafeInteger(pid) ||
		pid <= 1 ||
		!Number.isSafeInteger(ppid) ||
		ppid < 0 ||
		!Number.isSafeInteger(pgid) ||
		pgid <= 1 ||
		elapsedSeconds === null ||
		!command
	) {
		return null;
	}
	return { pid, ppid, pgid, elapsedSeconds, command };
}

function execPs(timeoutMs = 15_000): Promise<string> {
	return new Promise((resolveOutput, reject) => {
		execFile(
			"ps",
			["-axo", "pid=,ppid=,pgid=,etime=,command="],
			{
				timeout: timeoutMs,
				maxBuffer: 32 * 1024 * 1024,
				env: { ...process.env, LC_ALL: "C" },
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolveOutput(stdout);
			},
		);
	});
}

export async function defaultListCodexAppServerProcesses(): Promise<CodexProcessProbeResult> {
	try {
		const output = await execPs();
		const rows = output
			.split("\n")
			.map(parseCodexAppServerProcessRow)
			.filter((row): row is CodexAppServerProcess => row !== null);
		if (output.trim() && rows.length === 0) {
			return {
				status: "unknown",
				error:
					"ps output did not match the BSD pid/ppid/pgid/etime/command shape",
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

export async function defaultListCodexDaemonLedgers(
	env: NodeJS.ProcessEnv = process.env,
): Promise<CodexLedgerProbeResult> {
	// Passing an empty child returns the canonical root without duplicating the
	// path primitive owned by claude-runner.
	const root = codexSessionStateDir("", env);
	try {
		const ledgers: CodexDaemonLedger[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				const parsed = JSON.parse(
					readFileSync(join(root, entry.name, "session.json"), "utf8"),
				) as { executionId?: unknown; daemonPgid?: unknown };
				if (
					parsed.executionId !== entry.name ||
					typeof parsed.daemonPgid !== "number" ||
					!Number.isSafeInteger(parsed.daemonPgid) ||
					parsed.daemonPgid <= 1
				) {
					continue;
				}
				ledgers.push({
					executionId: entry.name,
					daemonPgid: parsed.daemonPgid,
				});
			} catch {
				// One corrupt or concurrently replaced ledger must not hide peers.
			}
		}
		return { status: "ok", ledgers };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { status: "ok", ledgers: [] };
		return {
			status: "unknown",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function defaultListCodexHomeExecutionIds(
	env: NodeJS.ProcessEnv = process.env,
): Promise<CodexHomeProbeResult> {
	const root = codexHomesRoot(env);
	try {
		return {
			status: "ok",
			executionIds: readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name),
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { status: "ok", executionIds: [] };
		return {
			status: "unknown",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function defaultSocketHolderPids(
	socketPath: string,
): Promise<SocketHolderProbeResult> {
	return new Promise((resolveProbe) => {
		execFile(
			"lsof",
			["-t", "--", socketPath],
			{
				timeout: 2_000,
				maxBuffer: 1024 * 1024,
				encoding: "utf8",
			},
			(error, stdout) => {
				const pids = String(stdout)
					.split("\n")
					.map((line) => Number.parseInt(line.trim(), 10))
					.filter((pid) => Number.isSafeInteger(pid) && pid > 1);
				if (!error) {
					resolveProbe({ status: "ok", pids });
					return;
				}
				// lsof exit 1 with no rows is the authoritative "no holder" shape.
				if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) {
					resolveProbe({ status: "ok", pids: [] });
					return;
				}
				resolveProbe({
					status: "unknown",
					error: error.message,
				});
			},
		);
	});
}

function splitCommand(command: string): string[] {
	// Flywheel's generated socket and CODEX_HOME paths are whitespace-free. If a
	// future deployment violates that invariant, parsing fails closed below.
	return command.trim().split(/\s+/).filter(Boolean);
}

function isCodexAppServerCommand(command: string): boolean {
	const tokens = splitCommand(command);
	for (let index = 0; index + 1 < tokens.length; index++) {
		if (
			basename(tokens[index] ?? "") === "codex" &&
			tokens[index + 1] === "app-server"
		) {
			return true;
		}
	}
	return false;
}

function parseAppServerIdentity(command: string): AppServerIdentity | null {
	if (!isCodexAppServerCommand(command)) return null;
	const tokens = splitCommand(command);
	if (!tokens.includes("--remote-control")) return null;
	let listen: string | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (token === "--listen") listen = tokens[index + 1];
		else if (token.startsWith("--listen="))
			listen = token.slice("--listen=".length);
	}
	if (!listen?.startsWith("unix://")) return null;
	const socketPath = listen.slice("unix://".length);
	if (!socketPath || !socketPath.startsWith("/")) return null;
	return { socketPath };
}

function exactIdentityForExecution(
	row: CodexAppServerProcess,
	executionId: string,
	env: NodeJS.ProcessEnv,
): AppServerIdentity | null {
	const identity = parseAppServerIdentity(row.command);
	if (!identity) return null;
	const expectedSocket = resolve(resolveDaemonSocketPath(executionId, env));
	return resolve(identity.socketPath) === expectedSocket ? identity : null;
}

function reverseExecutionIdentity(
	row: CodexAppServerProcess,
	socketOwners: ReadonlyMap<string, string | null>,
): { executionId: string; identity: AppServerIdentity } | null {
	const identity = parseAppServerIdentity(row.command);
	if (!identity) return null;
	const executionId = socketOwners.get(resolve(identity.socketPath));
	return executionId ? { executionId, identity } : null;
}

function isWithinSocketRoot(socketPath: string, socketRoot: string): boolean {
	return resolve(socketPath).startsWith(`${resolve(socketRoot)}${sep}`);
}

function defaultSignalGroup(pgid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch {
		return false;
	}
}

function emptyResult(): CodexRunnerOrphanSweepResult {
	return {
		ledgerCandidates: 0,
		processCandidates: 0,
		reaped: 0,
		identityMismatchSkipped: 0,
		unparseableSkipped: 0,
		probeUnknown: 0,
		survivors: 0,
	};
}

function sameCandidate(
	row: CodexAppServerProcess,
	candidate: ReapCandidate,
	env: NodeJS.ProcessEnv,
): boolean {
	return (
		row.pid === candidate.pid &&
		row.pgid === candidate.pgid &&
		row.command === candidate.command &&
		exactIdentityForExecution(row, candidate.executionId, env) !== null
	);
}

function matchingGroupRows(
	rows: CodexAppServerProcess[],
	candidate: ReapCandidate,
	env: NodeJS.ProcessEnv,
): CodexAppServerProcess[] {
	return rows.filter(
		(row) =>
			row.pgid === candidate.pgid &&
			exactIdentityForExecution(row, candidate.executionId, env) !== null,
	);
}

async function reapCandidate(
	candidate: ReapCandidate,
	deps: Required<
		Pick<
			CodexRunnerOrphanSweepDeps,
			| "listProcesses"
			| "socketHolderPids"
			| "signalGroup"
			| "removeSocket"
			| "sleep"
		>
	> & {
		env: NodeJS.ProcessEnv;
		termGraceMs: number;
		killConfirmMs: number;
		isExecutionActive: (executionId: string) => boolean;
		audit: (event: string, detail: Record<string, unknown>) => void;
	},
	result: CodexRunnerOrphanSweepResult,
): Promise<void> {
	const detail = {
		executionId: candidate.executionId,
		pid: candidate.pid,
		pgid: candidate.pgid,
		socketPath: candidate.socketPath,
		codexHome: candidate.codexHome,
		source: candidate.source,
		evidence: {
			canonicalHome: true,
			argvSocket: true,
			pgidFresh: true,
			socketHolder: true,
		},
	};
	try {
		if (deps.isExecutionActive(candidate.executionId)) {
			deps.audit("codex_app_server_orphan_readopted", detail);
			return;
		}
	} catch (error) {
		result.probeUnknown++;
		deps.audit("codex_app_server_orphan_probe_unknown", {
			...detail,
			stage: "active_runway",
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	const [fresh, freshHolders] = await Promise.all([
		deps.listProcesses(),
		deps.socketHolderPids(candidate.socketPath),
	]);
	if (fresh.status === "unknown") {
		result.probeUnknown++;
		deps.audit("codex_app_server_orphan_probe_unknown", {
			...detail,
			stage: "pre_signal",
			error: fresh.error,
		});
		return;
	}
	if (freshHolders.status === "unknown") {
		result.probeUnknown++;
		deps.audit("codex_app_server_orphan_probe_unknown", {
			...detail,
			stage: "pre_signal_lsof",
			error: freshHolders.error,
		});
		return;
	}
	if (!fresh.rows.some((row) => sameCandidate(row, candidate, deps.env))) {
		result.identityMismatchSkipped++;
		deps.audit("codex_app_server_orphan_identity_changed", detail);
		return;
	}
	if (!freshHolders.pids.includes(candidate.pid)) {
		result.identityMismatchSkipped++;
		deps.audit("codex_app_server_orphan_socket_holder_mismatch", {
			...detail,
			holderPids: freshHolders.pids,
		});
		return;
	}
	if (!deps.signalGroup(candidate.pgid, "SIGTERM")) {
		result.survivors++;
		deps.audit("codex_app_server_orphan_signal_failed", {
			...detail,
			signal: "SIGTERM",
		});
		return;
	}
	await deps.sleep(deps.termGraceMs);
	const [afterTerm, holdersAfterTerm] = await Promise.all([
		deps.listProcesses(),
		deps.socketHolderPids(candidate.socketPath),
	]);
	if (afterTerm.status === "unknown") {
		result.probeUnknown++;
		deps.audit("codex_app_server_orphan_probe_unknown", {
			...detail,
			stage: "after_term",
			error: afterTerm.error,
		});
		return;
	}
	if (holdersAfterTerm.status === "unknown") {
		result.probeUnknown++;
		deps.audit("codex_app_server_orphan_probe_unknown", {
			...detail,
			stage: "after_term_lsof",
			error: holdersAfterTerm.error,
		});
		return;
	}
	let groupRows = afterTerm.rows.filter((row) => row.pgid === candidate.pgid);
	const exactAfterTerm = matchingGroupRows(afterTerm.rows, candidate, deps.env);
	const exactHolderAfterTerm = exactAfterTerm.find((row) =>
		holdersAfterTerm.pids.includes(row.pid),
	);
	if (exactAfterTerm.length > 0 && !exactHolderAfterTerm) {
		result.identityMismatchSkipped++;
		deps.audit("codex_app_server_orphan_socket_holder_mismatch", {
			...detail,
			stage: "after_term",
			holderPids: holdersAfterTerm.pids,
		});
		return;
	}
	if (exactHolderAfterTerm) {
		try {
			if (deps.isExecutionActive(candidate.executionId)) {
				deps.audit("codex_app_server_orphan_readopted", {
					...detail,
					stage: "before_kill",
				});
				return;
			}
		} catch (error) {
			result.probeUnknown++;
			deps.audit("codex_app_server_orphan_probe_unknown", {
				...detail,
				stage: "active_runway_before_kill",
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (!deps.signalGroup(candidate.pgid, "SIGKILL")) {
			result.survivors++;
			deps.audit("codex_app_server_orphan_signal_failed", {
				...detail,
				signal: "SIGKILL",
			});
			return;
		}
		await deps.sleep(deps.killConfirmMs);
		const [confirmed, confirmedHolders] = await Promise.all([
			deps.listProcesses(),
			deps.socketHolderPids(candidate.socketPath),
		]);
		if (confirmed.status === "unknown") {
			result.probeUnknown++;
			deps.audit("codex_app_server_orphan_probe_unknown", {
				...detail,
				stage: "after_kill",
				error: confirmed.error,
			});
			return;
		}
		if (confirmedHolders.status === "unknown") {
			result.probeUnknown++;
			deps.audit("codex_app_server_orphan_probe_unknown", {
				...detail,
				stage: "after_kill_lsof",
				error: confirmedHolders.error,
			});
			return;
		}
		groupRows = confirmed.rows.filter((row) => row.pgid === candidate.pgid);
		const exactConfirmedHolderPids = matchingGroupRows(
			confirmed.rows,
			candidate,
			deps.env,
		)
			.filter((row) => confirmedHolders.pids.includes(row.pid))
			.map((row) => row.pid);
		if (exactConfirmedHolderPids.length > 0) {
			result.survivors++;
			deps.audit("codex_app_server_orphan_survived", {
				...detail,
				holderPids: exactConfirmedHolderPids,
			});
			return;
		}
	}
	if (groupRows.length > 0) {
		result.survivors++;
		deps.audit("codex_app_server_orphan_survived", detail);
		return;
	}
	try {
		if (deps.isExecutionActive(candidate.executionId)) {
			deps.audit("codex_app_server_orphan_readopted", {
				...detail,
				stage: "before_socket_cleanup",
			});
			return;
		}
	} catch (error) {
		result.probeUnknown++;
		deps.audit("codex_app_server_orphan_probe_unknown", {
			...detail,
			stage: "active_runway_before_socket_cleanup",
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	try {
		deps.removeSocket(candidate.socketPath);
	} catch (error) {
		deps.audit("codex_app_server_orphan_socket_cleanup_failed", {
			...detail,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	result.reaped++;
	deps.audit("codex_app_server_orphan_reaped", detail);
}

/** Run both ownership axes once. The caller owns scheduling and live-runway input. */
export async function sweepCodexRunnerOrphans(
	input: {
		activeExecutionIds: ReadonlySet<string>;
		isExecutionActive?: (executionId: string) => boolean;
	},
	deps: CodexRunnerOrphanSweepDeps = {},
): Promise<CodexRunnerOrphanSweepResult> {
	const env = deps.env ?? process.env;
	const audit = deps.audit ?? (() => {});
	const listProcesses =
		deps.listProcesses ?? defaultListCodexAppServerProcesses;
	const listLedgers =
		deps.listLedgers ?? (() => defaultListCodexDaemonLedgers(env));
	const listHomes =
		deps.listHomes ?? (() => defaultListCodexHomeExecutionIds(env));
	const result = emptyResult();
	const [ledgerProbe, homeProbe, processProbe] = await Promise.all([
		listLedgers(),
		listHomes(),
		listProcesses(),
	]);
	if (ledgerProbe.status === "unknown") {
		result.probeUnknown++;
		audit("codex_app_server_orphan_probe_unknown", {
			stage: "ledger",
			error: ledgerProbe.error,
		});
	}
	if (homeProbe.status === "unknown") {
		result.probeUnknown++;
		audit("codex_app_server_orphan_probe_unknown", {
			stage: "codex_home_inventory",
			error: homeProbe.error,
		});
	}
	if (processProbe.status === "unknown") {
		result.probeUnknown++;
		audit("codex_app_server_orphan_probe_unknown", {
			stage: "process",
			error: processProbe.error,
		});
		return result;
	}
	if (homeProbe.status === "unknown") return result;

	const homeExecutionIds = new Set(homeProbe.executionIds);
	const socketRoot = dirname(
		resolveDaemonSocketPath("__flywheel_socket_root_probe__", env),
	);
	const socketOwners = new Map<string, string | null>();
	for (const executionId of homeExecutionIds) {
		const socketPath = resolve(resolveDaemonSocketPath(executionId, env));
		if (socketOwners.has(socketPath)) socketOwners.set(socketPath, null);
		else socketOwners.set(socketPath, executionId);
	}

	const candidates = new Map<number, ReapCandidate>();
	const minElapsedSeconds =
		deps.minElapsedSeconds ?? CODEX_APP_SERVER_ORPHAN_MIN_ELAPSED_SECONDS;
	if (ledgerProbe.status === "ok") {
		for (const ledger of ledgerProbe.ledgers) {
			if (input.activeExecutionIds.has(ledger.executionId)) continue;
			result.ledgerCandidates++;
			if (!homeExecutionIds.has(ledger.executionId)) {
				result.identityMismatchSkipped++;
				audit("codex_app_server_orphan_identity_mismatch", {
					executionId: ledger.executionId,
					pgid: ledger.daemonPgid,
					socketPath: resolveDaemonSocketPath(ledger.executionId, env),
					evidence: {
						canonicalHome: false,
						argvSocket: false,
						pgidFresh: false,
						socketHolder: false,
					},
				});
				continue;
			}
			const groupRows = processProbe.rows.filter(
				(row) => row.pgid === ledger.daemonPgid,
			);
			const exact = groupRows.find(
				(row) =>
					exactIdentityForExecution(row, ledger.executionId, env) !== null,
			);
			if (!exact) {
				result.identityMismatchSkipped++;
				audit("codex_app_server_orphan_identity_mismatch", {
					executionId: ledger.executionId,
					pgid: ledger.daemonPgid,
					socketPath: resolveDaemonSocketPath(ledger.executionId, env),
					evidence: {
						canonicalHome: true,
						argvSocket: false,
						pgidFresh: groupRows.length > 0,
						socketHolder: false,
					},
				});
				continue;
			}
			if (exact.ppid !== 1 || exact.elapsedSeconds < minElapsedSeconds) {
				continue;
			}
			const identity = exactIdentityForExecution(
				exact,
				ledger.executionId,
				env,
			);
			if (!identity) continue;
			candidates.set(ledger.daemonPgid, {
				...identity,
				executionId: ledger.executionId,
				codexHome: codexHomeDir(ledger.executionId, env),
				pid: exact.pid,
				pgid: exact.pgid,
				command: exact.command,
				source: "ledger",
			});
		}
	}

	for (const row of processProbe.rows) {
		if (!isCodexAppServerCommand(row.command)) continue;
		if (candidates.has(row.pgid)) continue;
		const reverse = reverseExecutionIdentity(row, socketOwners);
		if (!reverse) {
			result.unparseableSkipped++;
			const parsed = parseAppServerIdentity(row.command);
			if (parsed && isWithinSocketRoot(parsed.socketPath, socketRoot)) {
				audit("codex_app_server_orphan_unparseable", {
					pid: row.pid,
					pgid: row.pgid,
					socketPath: parsed.socketPath,
					evidence: {
						canonicalHome: false,
						argvSocket: true,
						pgidFresh: true,
						socketHolder: false,
					},
				});
			}
			continue;
		}
		if (
			input.activeExecutionIds.has(reverse.executionId) ||
			row.ppid !== 1 ||
			row.elapsedSeconds < minElapsedSeconds
		) {
			continue;
		}
		result.processCandidates++;
		candidates.set(row.pgid, {
			...reverse.identity,
			executionId: reverse.executionId,
			codexHome: codexHomeDir(reverse.executionId, env),
			pid: row.pid,
			pgid: row.pgid,
			command: row.command,
			source: "process",
		});
	}

	const runtimeDeps = {
		env,
		listProcesses,
		socketHolderPids: deps.socketHolderPids ?? defaultSocketHolderPids,
		signalGroup: deps.signalGroup ?? defaultSignalGroup,
		removeSocket:
			deps.removeSocket ?? ((path: string) => rmSync(path, { force: true })),
		sleep:
			deps.sleep ??
			((ms: number) => new Promise((done) => setTimeout(done, ms))),
		termGraceMs: deps.termGraceMs ?? 1_000,
		killConfirmMs: deps.killConfirmMs ?? 250,
		isExecutionActive:
			input.isExecutionActive ??
			((executionId: string) => input.activeExecutionIds.has(executionId)),
		audit,
	};
	for (const candidate of candidates.values()) {
		await reapCandidate(candidate, runtimeDeps, result);
	}
	return result;
}
