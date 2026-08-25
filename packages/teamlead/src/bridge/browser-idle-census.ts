/**
 * FLY-2026 — read-only census for idle Playwright MCP and browser processes.
 *
 * The classifier consumes one established ChromeSweepSample. It has no store,
 * signal, or notification capability: ownership only decides which processes
 * enter the single-digit denominator and which are disclosed as external.
 */

import { basename } from "node:path";
import {
	type ChromeSweepSample,
	collectChromeSweepSample,
	isChromeFamilyComm,
	parseChromeProc,
} from "./chrome-session-reaper.js";
import { splitMcpPsCommand } from "./mcp-descendant-reaper.js";
import { classifyMcpProcess } from "./mcp-process-classifier.js";
import {
	exactPlaywrightMcpProfileToken,
	extractPlaywrightUserDataDir,
	PLAYWRIGHT_MCP_PROFILE_ROOT,
} from "./playwright-orphan-census.js";

export interface BrowserProcessIdentity {
	pid: number;
	lstart: string;
	startedAtEpochMs: number;
	comm: string;
}

export interface BrowserProcessBucket {
	playwrightMcpRoots: BrowserProcessIdentity[];
	playwrightChromeMains: BrowserProcessIdentity[];
	proofshotChromeMains: BrowserProcessIdentity[];
	processes: BrowserProcessIdentity[];
}

export interface OrphanedBrowserProcessBucket {
	playwrightMcpRoots: BrowserProcessIdentity[];
	playwrightChromeMains: BrowserProcessIdentity[];
	agentBrowserChromeMains: BrowserProcessIdentity[];
	processes: BrowserProcessIdentity[];
}

export interface ExternalMcpRoot extends BrowserProcessIdentity {
	holder: BrowserProcessIdentity;
}

export interface RuledOutBrowserProcessBucket {
	unattributedPpid1CrashpadHandlers: BrowserProcessIdentity[];
}

export interface BrowserIdleCensus {
	schemaVersion: 1;
	observedAt: string;
	observedAtEpochMs: number;
	status: "ok" | "unknown";
	singleDigit: boolean | null;
	inScopeProcessCount: number | null;
	activeManaged: BrowserProcessBucket;
	orphanedManaged: OrphanedBrowserProcessBucket;
	inScopeProcesses: BrowserProcessIdentity[];
	external: {
		mcpRoots: ExternalMcpRoot[];
		processes: BrowserProcessIdentity[];
	};
	ruledOut: RuledOutBrowserProcessBucket;
	errors: string[];
}

export interface ClassifyBrowserIdleCensusInput {
	sample: ChromeSweepSample;
	observedAtEpochMs: number;
	playwrightProfileRoot?: string;
}

export interface CollectBrowserIdleCensusDeps {
	collectSample?: () => Promise<ChromeSweepSample>;
	nowMs?: () => number;
	playwrightProfileRoot?: string;
}

type Ownership =
	| { kind: "active" }
	| { kind: "orphaned" }
	| { kind: "external"; holder: BrowserProcessIdentity }
	| { kind: "unknown" };

const playwrightMcpPackageToken = /^@playwright\/mcp(?:@[^/\s]+)?$/;
const chromeCrashpadHandlerComm = "chrome_crashpad_handler";

function isChromeCrashpadHandlerExecutable(executable: string): boolean {
	return basename(executable) === chromeCrashpadHandlerComm;
}

function hasChromeCrashpadHandlerPath(command: string): boolean {
	return /\/chrome_crashpad_handler(?:\s|$)/.test(command);
}

function isReparentedChromeCrashpadHandler(
	ppid: number,
	comm: string | undefined,
	argv: readonly string[],
): boolean {
	if (ppid !== 1) return false;
	return [comm, argv[0]].some(
		(executable) =>
			executable !== undefined && isChromeCrashpadHandlerExecutable(executable),
	);
}

function looksLikePlaywrightMcpLauncher(
	comm: string,
	argv: readonly string[],
): boolean {
	const packageIndex = argv.findIndex((token) =>
		playwrightMcpPackageToken.test(token),
	);
	if (packageIndex < 1) return false;
	const binary = basename(argv[0] ?? comm);
	if (binary === "npx" || binary === "bunx") {
		return argv.slice(1, packageIndex).every((token) => token.startsWith("-"));
	}
	if (binary === "npm") return argv[1] === "exec";
	if (binary === "pnpm") return argv[1] === "dlx" || argv[1] === "exec";
	return binary === "yarn" && argv[1] === "dlx";
}

function emptyActiveBucket(): BrowserProcessBucket {
	return {
		playwrightMcpRoots: [],
		playwrightChromeMains: [],
		proofshotChromeMains: [],
		processes: [],
	};
}

function emptyOrphanedBucket(): OrphanedBrowserProcessBucket {
	return {
		playwrightMcpRoots: [],
		playwrightChromeMains: [],
		agentBrowserChromeMains: [],
		processes: [],
	};
}

function unknownCensus(
	observedAtEpochMs: number,
	errors: readonly string[],
): BrowserIdleCensus {
	return {
		schemaVersion: 1,
		observedAt: new Date(observedAtEpochMs).toISOString(),
		observedAtEpochMs,
		status: "unknown",
		singleDigit: null,
		inScopeProcessCount: null,
		activeManaged: emptyActiveBucket(),
		orphanedManaged: emptyOrphanedBucket(),
		inScopeProcesses: [],
		external: { mcpRoots: [], processes: [] },
		ruledOut: { unattributedPpid1CrashpadHandlers: [] },
		errors: [...new Set(errors)].sort(),
	};
}

function sortedPids(pids: ReadonlySet<number>): number[] {
	return [...pids].sort((left, right) => left - right);
}

function descendantsIncludingRoot(
	rootPid: number,
	commands: ReadonlyMap<number, { ppid: number; command: string }>,
): Set<number> {
	const byParent = new Map<number, number[]>();
	for (const [pid, row] of commands) {
		const children = byParent.get(row.ppid) ?? [];
		children.push(pid);
		byParent.set(row.ppid, children);
	}
	const result = new Set<number>();
	const stack = [rootPid];
	while (stack.length > 0) {
		const pid = stack.pop();
		if (pid === undefined || result.has(pid)) continue;
		result.add(pid);
		for (const child of byParent.get(pid) ?? []) stack.push(child);
	}
	return result;
}

function addAll(target: Set<number>, source: ReadonlySet<number>): void {
	for (const pid of source) target.add(pid);
}

export function classifyBrowserIdleCensus(
	input: ClassifyBrowserIdleCensusInput,
): BrowserIdleCensus {
	const { sample, observedAtEpochMs } = input;
	const playwrightProfileRoot =
		input.playwrightProfileRoot ?? PLAYWRIGHT_MCP_PROFILE_ROOT;
	const errors: string[] = [];
	const sensors = [
		["comm", sample.comm],
		["command", sample.command],
		["age", sample.age],
	] as const;
	for (const [name, sensor] of sensors) {
		if (sensor.status === "unknown") errors.push(`${name}:${sensor.error}`);
	}
	if (
		sample.comm.status !== "ok" ||
		sample.command.status !== "ok" ||
		sample.age.status !== "ok"
	) {
		return unknownCensus(observedAtEpochMs, errors);
	}

	const comms = sample.comm.rows;
	const commands = sample.command.rows;
	const ages = sample.age.rows;
	const addJoinError = (pid: number, missing: readonly string[]) => {
		if (missing.length > 0) {
			errors.push(`join:pid=${pid}:missing=${missing.join(",")}`);
		}
	};
	const identityFor = (pid: number): BrowserProcessIdentity | undefined => {
		const comm = comms.get(pid);
		const age = ages.get(pid);
		const missing: string[] = [];
		if (comm === undefined) missing.push("comm");
		if (age === undefined) missing.push("age");
		addJoinError(pid, missing);
		if (comm === undefined || age === undefined) return undefined;
		return {
			pid,
			lstart: age.lstart,
			startedAtEpochMs: observedAtEpochMs - age.ageMs,
			comm,
		};
	};

	// Chrome-family rows are relevant even when another pass missed their
	// command/age row. Do not apply this join rule to unrelated process churn.
	for (const [pid, comm] of comms) {
		if (!isChromeFamilyComm(comm) && !isChromeCrashpadHandlerExecutable(comm)) {
			continue;
		}
		const missing: string[] = [];
		if (!commands.has(pid)) missing.push("command");
		if (!ages.has(pid)) missing.push("age");
		addJoinError(pid, missing);
	}
	for (const [pid, row] of commands) {
		if (row.ppid !== 1 || !hasChromeCrashpadHandlerPath(row.command)) continue;
		const missing: string[] = [];
		if (!comms.get(pid)) missing.push("comm");
		if (!ages.has(pid)) missing.push("age");
		addJoinError(pid, missing);
	}

	const matchedMcpPids = new Set<number>();
	const unattributedPpid1CrashpadHandlers = new Set<number>();
	for (const [pid, row] of commands) {
		const argv = splitMcpPsCommand(row.command);
		if (isReparentedChromeCrashpadHandler(row.ppid, comms.get(pid), argv)) {
			const missing: string[] = [];
			if (!comms.has(pid)) missing.push("comm");
			if (!ages.has(pid)) missing.push("age");
			addJoinError(pid, missing);
			if (missing.length === 0) unattributedPpid1CrashpadHandlers.add(pid);
		}
		const classification = classifyMcpProcess({
			pid,
			ppid: row.ppid,
			lstart: ages.get(pid)?.lstart ?? "",
			comm: comms.get(pid) ?? argv[0] ?? "",
			argv,
		});
		if (classification.verdict === "unknown") {
			errors.push(`classifier:pid=${pid}:${classification.reason}`);
		}
		if (classification.verdict === "no_match") {
			if (classification.shape) {
				errors.push(
					`classifier:pid=${pid}:integrity_check_failed:${classification.reason}`,
				);
			} else if (looksLikePlaywrightMcpLauncher(comms.get(pid) ?? "", argv)) {
				errors.push(
					`classifier:pid=${pid}:unmatched_playwright_mcp_package_token`,
				);
			}
		}
		if (classification.verdict === "match") {
			const missing: string[] = [];
			if (!comms.has(pid)) missing.push("comm");
			if (!ages.has(pid)) missing.push("age");
			addJoinError(pid, missing);
			if (missing.length === 0) matchedMcpPids.add(pid);
		}

		const userDataDir = extractPlaywrightUserDataDir(row.command);
		if (
			userDataDir &&
			(exactPlaywrightMcpProfileToken(userDataDir, playwrightProfileRoot) ||
				userDataDir.includes("agent-browser-chrome-"))
		) {
			const missing: string[] = [];
			if (!comms.has(pid)) missing.push("comm");
			if (!ages.has(pid)) missing.push("age");
			addJoinError(pid, missing);
		}
	}
	if (errors.length > 0) return unknownCensus(observedAtEpochMs, errors);

	const hasMatchedAncestor = (pid: number): boolean => {
		let parentPid = commands.get(pid)?.ppid ?? 0;
		const seen = new Set<number>([pid]);
		while (parentPid > 1) {
			if (seen.has(parentPid)) {
				errors.push(`ancestor:pid=${pid}:cycle=${parentPid}`);
				return false;
			}
			seen.add(parentPid);
			if (matchedMcpPids.has(parentPid)) return true;
			const parent = commands.get(parentPid);
			if (!parent) {
				errors.push(`ancestor:pid=${pid}:missing=${parentPid}`);
				return false;
			}
			parentPid = parent.ppid;
		}
		return false;
	};
	const mcpRootPids = sortedPids(matchedMcpPids).filter(
		(pid) => !hasMatchedAncestor(pid),
	);
	if (errors.length > 0) return unknownCensus(observedAtEpochMs, errors);

	const ownershipForRoot = (rootPid: number): Ownership => {
		const root = commands.get(rootPid);
		if (!root) {
			errors.push(`ownership:pid=${rootPid}:missing_root_command`);
			return { kind: "unknown" };
		}
		if (root.ppid === 1) return { kind: "orphaned" };

		let parentPid = root.ppid;
		let directHolder: BrowserProcessIdentity | undefined;
		const seen = new Set<number>([rootPid]);
		while (parentPid > 1) {
			if (seen.has(parentPid)) {
				errors.push(`ownership:pid=${rootPid}:cycle=${parentPid}`);
				return { kind: "unknown" };
			}
			seen.add(parentPid);
			const parentCommand = commands.get(parentPid);
			const parentIdentity = identityFor(parentPid);
			if (!parentCommand || !parentIdentity) {
				if (!parentCommand) {
					errors.push(`ownership:pid=${rootPid}:missing=${parentPid}`);
				}
				return { kind: "unknown" };
			}
			directHolder ??= parentIdentity;
			if (basename(parentIdentity.comm) === "claude") {
				return { kind: "active" };
			}
			parentPid = parentCommand.ppid;
		}
		if (!directHolder) {
			errors.push(`ownership:pid=${rootPid}:missing_holder`);
			return { kind: "unknown" };
		}
		return { kind: "external", holder: directHolder };
	};

	const activeMcpRoots = new Set<number>();
	const orphanedMcpRoots = new Set<number>();
	const activeProcesses = new Set<number>();
	const orphanedProcesses = new Set<number>();
	const externalProcesses = new Set<number>();
	const externalRootHolders = new Map<number, BrowserProcessIdentity>();
	for (const rootPid of mcpRootPids) {
		const ownership = ownershipForRoot(rootPid);
		const tree = descendantsIncludingRoot(rootPid, commands);
		if (ownership.kind === "active") {
			activeMcpRoots.add(rootPid);
			addAll(activeProcesses, tree);
		} else if (ownership.kind === "orphaned") {
			orphanedMcpRoots.add(rootPid);
			addAll(orphanedProcesses, tree);
		} else if (ownership.kind === "external") {
			externalRootHolders.set(rootPid, ownership.holder);
			addAll(externalProcesses, tree);
		}
	}
	if (errors.length > 0) return unknownCensus(observedAtEpochMs, errors);

	const activePlaywrightMains = new Set<number>();
	const activeProofshotMains = new Set<number>();
	const orphanedPlaywrightMains = new Set<number>();
	const orphanedAgentBrowserMains = new Set<number>();
	for (const [pid, comm] of comms) {
		if (!isChromeFamilyComm(comm)) continue;
		const commandRow = commands.get(pid);
		if (!commandRow || !ages.has(pid)) continue;
		if (/(?:^|\s)--type=/.test(commandRow.command)) continue;

		const userDataDir = extractPlaywrightUserDataDir(commandRow.command);
		const playwrightToken = userDataDir
			? exactPlaywrightMcpProfileToken(userDataDir, playwrightProfileRoot)
			: undefined;
		if (playwrightToken) {
			if (activeProcesses.has(pid)) {
				activePlaywrightMains.add(pid);
			} else if (orphanedProcesses.has(pid)) {
				orphanedPlaywrightMains.add(pid);
			} else if (externalProcesses.has(pid)) {
				// Its positive non-Claude ownership was already established by the
				// external MCP tree. Disclosure stays in that process bucket.
			} else if (commandRow.ppid === 1) {
				orphanedPlaywrightMains.add(pid);
				addAll(orphanedProcesses, descendantsIncludingRoot(pid, commands));
			} else {
				errors.push(`ownership:playwright_chrome:pid=${pid}:unattributed`);
			}
			continue;
		}

		const agentBrowser = parseChromeProc(
			pid,
			commandRow.ppid,
			comm,
			commandRow.command,
		);
		if (!agentBrowser) continue;
		const tree = descendantsIncludingRoot(pid, commands);
		if (agentBrowser.execId) {
			activeProofshotMains.add(pid);
			addAll(activeProcesses, tree);
		} else {
			orphanedAgentBrowserMains.add(pid);
			addAll(orphanedProcesses, tree);
		}
	}
	if (errors.length > 0) return unknownCensus(observedAtEpochMs, errors);

	const identities = (pids: ReadonlySet<number>): BrowserProcessIdentity[] => {
		const result: BrowserProcessIdentity[] = [];
		for (const pid of sortedPids(pids)) {
			const identity = identityFor(pid);
			if (identity) result.push(identity);
		}
		return result;
	};
	const activeIdentities = identities(activeProcesses);
	const orphanedIdentities = identities(orphanedProcesses);
	const externalIdentities = identities(externalProcesses);
	const activeMcpIdentities = identities(activeMcpRoots);
	const orphanedMcpIdentities = identities(orphanedMcpRoots);
	const activePlaywrightIdentities = identities(activePlaywrightMains);
	const activeProofshotIdentities = identities(activeProofshotMains);
	const orphanedPlaywrightIdentities = identities(orphanedPlaywrightMains);
	const orphanedAgentIdentities = identities(orphanedAgentBrowserMains);
	const unattributedCrashpadIdentities = identities(
		unattributedPpid1CrashpadHandlers,
	);
	if (errors.length > 0) return unknownCensus(observedAtEpochMs, errors);

	const inScopePids = new Set<number>([
		...activeProcesses,
		...orphanedProcesses,
	]);
	const inScopeIdentities = identities(inScopePids);
	const externalRoots: ExternalMcpRoot[] = [];
	for (const rootPid of [...externalRootHolders.keys()].sort(
		(left, right) => left - right,
	)) {
		const identity = identityFor(rootPid);
		const holder = externalRootHolders.get(rootPid);
		if (identity && holder) externalRoots.push({ ...identity, holder });
	}
	if (errors.length > 0) return unknownCensus(observedAtEpochMs, errors);

	return {
		schemaVersion: 1,
		observedAt: new Date(observedAtEpochMs).toISOString(),
		observedAtEpochMs,
		status: "ok",
		singleDigit: inScopeIdentities.length < 10,
		inScopeProcessCount: inScopeIdentities.length,
		activeManaged: {
			playwrightMcpRoots: activeMcpIdentities,
			playwrightChromeMains: activePlaywrightIdentities,
			proofshotChromeMains: activeProofshotIdentities,
			processes: activeIdentities,
		},
		orphanedManaged: {
			playwrightMcpRoots: orphanedMcpIdentities,
			playwrightChromeMains: orphanedPlaywrightIdentities,
			agentBrowserChromeMains: orphanedAgentIdentities,
			processes: orphanedIdentities,
		},
		inScopeProcesses: inScopeIdentities,
		external: {
			mcpRoots: externalRoots,
			processes: externalIdentities,
		},
		ruledOut: {
			unattributedPpid1CrashpadHandlers: unattributedCrashpadIdentities,
		},
		errors: [],
	};
}

export async function collectBrowserIdleCensus(
	deps: CollectBrowserIdleCensusDeps = {},
): Promise<BrowserIdleCensus> {
	const sample = await (deps.collectSample ?? collectChromeSweepSample)();
	return classifyBrowserIdleCensus({
		sample,
		observedAtEpochMs: (deps.nowMs ?? Date.now)(),
		playwrightProfileRoot: deps.playwrightProfileRoot,
	});
}
