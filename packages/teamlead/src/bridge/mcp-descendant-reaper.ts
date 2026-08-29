/**
 * FLY-1185 §2.5 / research §3 — MCP server child-process reaper.
 *
 * A runner's claude session spawns MCP server child processes (playwright-mcp
 * et al). When the tmux pane is killed (close-runner / post-merge / crash
 * reap / OOM) those children reparent to launchd (ppid=1) and never exit —
 * production found ppid-1 orphans up to 12 days old.
 *
 * Two capabilities, both AUDIT-ONLY on failure (never throw):
 *   - `reapMcpDescendants(panePid)`  — BEFORE a pane kill: enumerate the
 *     pane's descendant tree, match against the MCP family table, SIGTERM →
 *     grace → SIGKILL. Identity is re-verified (same pid + same command)
 *     immediately before EVERY signal — a recycled pid is never signaled.
 *   - `reapMcpOrphans()` — periodic backstop: ppid==1 + family match +
 *     elapsed ≥ 30min (hardcoded, no flag) → same TERM→KILL sequence.
 *
 * The family table is data — adding a future MCP server is one row.
 */

import { execFile } from "node:child_process";

/** v1 family table (research §3.2). argv substring OR exact basename match. */
export interface McpFamilyEntry {
	name: string;
	argvIncludes?: string;
	basename?: string;
}

export const MCP_PROCESS_FAMILIES: readonly McpFamilyEntry[] = [
	{ name: "playwright-mcp", argvIncludes: "@playwright/mcp" },
	{ name: "playwright-mcp", basename: "playwright-mcp" },
];

/** Orphan grace — hardcoded per the no-new-flag contract (plan §0 hard rule). */
export const MCP_ORPHAN_MIN_ELAPSED_SECONDS = 30 * 60;

export interface ProcessRow {
	pid: number;
	ppid: number;
	/** elapsed seconds since process start (ps etimes). */
	elapsedSeconds: number;
	command: string;
}

export type ListProcessesFn = () => Promise<ProcessRow[]>;
export type KillFn = (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
export type SleepFn = (ms: number) => Promise<void>;

export function defaultListProcesses(): Promise<ProcessRow[]> {
	return new Promise((resolve) => {
		execFile(
			"ps",
			["-axo", "pid=,ppid=,etimes=,command="],
			{ timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					resolve([]);
					return;
				}
				const rows: ProcessRow[] = [];
				for (const line of stdout.split("\n")) {
					const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
					if (!m) continue;
					rows.push({
						pid: Number(m[1]),
						ppid: Number(m[2]),
						elapsedSeconds: Number(m[3]),
						command: m[4] ?? "",
					});
				}
				resolve(rows);
			},
		);
	});
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

export function matchesMcpFamily(
	command: string,
	families: readonly McpFamilyEntry[] = MCP_PROCESS_FAMILIES,
): McpFamilyEntry | undefined {
	for (const fam of families) {
		if (fam.argvIncludes && command.includes(fam.argvIncludes)) return fam;
		if (fam.basename) {
			const argv0 = command.split(/\s+/)[0] ?? "";
			const base = argv0.split("/").pop() ?? "";
			if (base === fam.basename) return fam;
		}
	}
	return undefined;
}

/** All transitive descendants of `rootPid` in one snapshot. */
export function collectDescendants(
	rows: ProcessRow[],
	rootPid: number,
): ProcessRow[] {
	const byParent = new Map<number, ProcessRow[]>();
	for (const r of rows) {
		const list = byParent.get(r.ppid) ?? [];
		list.push(r);
		byParent.set(r.ppid, list);
	}
	const out: ProcessRow[] = [];
	const stack = [rootPid];
	const seen = new Set<number>();
	while (stack.length > 0) {
		const pid = stack.pop();
		if (pid === undefined || seen.has(pid)) continue;
		seen.add(pid);
		for (const child of byParent.get(pid) ?? []) {
			out.push(child);
			stack.push(child.pid);
		}
	}
	return out;
}

export interface McpReapDeps {
	listProcesses?: ListProcessesFn;
	kill?: KillFn;
	sleep?: SleepFn;
	families?: readonly McpFamilyEntry[];
	graceMs?: number;
	audit?: (event: string, detail: Record<string, unknown>) => void;
	/**
	 * FLY-1185 (Codex R5#2): fail-closed authority re-check threaded INTO the
	 * reap — the SIGTERM and (post-grace) SIGKILL passes each await external
	 * process state, so a Linear reopen landing between them must stop the
	 * remaining signals. Called before EACH signal pass; `false` (or a throw —
	 * fail-closed) aborts that pass. Absent → byte-compatible (no re-check).
	 */
	authorityCheck?: () => Promise<boolean>;
}

export interface McpReapResult {
	matched: number;
	terminated: number;
	killed: number;
	identityMismatchSkipped: number;
	/** R6#2: the reap aborted mid-pass because authority was lost (a reopen).
	 * The caller (closeRunner) already fail-closes via its own authorityCheck
	 * after the reap; this makes the loss observable. */
	authorityLost?: boolean;
}

const emptyResult = (): McpReapResult => ({
	matched: 0,
	terminated: 0,
	killed: 0,
	identityMismatchSkipped: 0,
});

/**
 * TERM → grace → verify → KILL for a set of candidate processes, with an
 * identity re-check (same pid AND same command in a FRESH snapshot)
 * immediately before every signal.
 */
async function reapCandidates(
	candidates: ProcessRow[],
	deps: McpReapDeps,
): Promise<McpReapResult> {
	const listProcesses = deps.listProcesses ?? defaultListProcesses;
	const kill = deps.kill ?? defaultKill;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const graceMs = deps.graceMs ?? 3_000;
	const audit = deps.audit ?? (() => {});
	const result = emptyResult();
	result.matched = candidates.length;
	if (candidates.length === 0) return result;

	// R5#2 + R7#2: STICKY fail-closed authority gate — a throw counts as lost,
	// and once authority is observed lost in this run it STAYS lost (a later
	// transient success can't revive it). Checked before EACH signal (plan.md:
	// 156 "before every mutation"), so a reopen between two PIDs still stops the
	// remaining kills.
	let authorityLostSticky = false;
	const gateSignal = async (stage: string): Promise<boolean> => {
		if (authorityLostSticky) return false;
		let ok: boolean;
		try {
			ok = deps.authorityCheck ? await deps.authorityCheck() : true;
		} catch {
			ok = false;
		}
		if (!ok) {
			authorityLostSticky = true;
			result.authorityLost = true;
			audit("mcp_reap_authority_lost", { stage });
		}
		return ok;
	};

	// (1) SIGTERM pass — identity re-verified against a fresh snapshot; the
	// authority gate runs before EACH kill.
	const fresh1 = await listProcesses();
	const byPid1 = new Map(fresh1.map((r) => [r.pid, r]));
	const termed: ProcessRow[] = [];
	for (const c of candidates) {
		const now = byPid1.get(c.pid);
		if (!now || now.command !== c.command) {
			result.identityMismatchSkipped++;
			continue;
		}
		if (!(await gateSignal("pre_sigterm"))) return result;
		if (kill(c.pid, "SIGTERM")) {
			result.terminated++;
			termed.push(c);
			audit("mcp_reap_sigterm", {
				pid: c.pid,
				command: c.command.slice(0, 200),
			});
		}
	}
	if (termed.length === 0) return result;

	await sleep(graceMs);

	// (2) SIGKILL pass for survivors — identity re-verified AGAIN; the authority
	// gate runs before EACH kill.
	const fresh2 = await listProcesses();
	const byPid2 = new Map(fresh2.map((r) => [r.pid, r]));
	for (const c of termed) {
		const now = byPid2.get(c.pid);
		if (!now || now.command !== c.command) continue; // exited (or recycled) — done
		if (!(await gateSignal("pre_sigkill"))) return result;
		if (kill(c.pid, "SIGKILL")) {
			result.killed++;
			audit("mcp_reap_sigkill", {
				pid: c.pid,
				command: c.command.slice(0, 200),
			});
		}
	}
	return result;
}

/**
 * Reap MCP-family descendants of a (still-alive) tmux pane pid. Call BEFORE
 * the pane kill so the tree is still enumerable. Never throws.
 */
export async function reapMcpDescendants(
	panePid: number,
	deps: McpReapDeps = {},
): Promise<McpReapResult> {
	try {
		const listProcesses = deps.listProcesses ?? defaultListProcesses;
		const families = deps.families ?? MCP_PROCESS_FAMILIES;
		const rows = await listProcesses();
		const candidates = collectDescendants(rows, panePid).filter((r) =>
			matchesMcpFamily(r.command, families),
		);
		return await reapCandidates(candidates, deps);
	} catch (err) {
		deps.audit?.("mcp_reap_failed", {
			panePid,
			error: err instanceof Error ? err.message : String(err),
		});
		return emptyResult();
	}
}

/**
 * Periodic orphan backstop: ppid==1 + family match + elapsed ≥ 30min.
 * Never throws.
 */
export async function reapMcpOrphans(
	deps: McpReapDeps = {},
): Promise<McpReapResult> {
	try {
		const listProcesses = deps.listProcesses ?? defaultListProcesses;
		const families = deps.families ?? MCP_PROCESS_FAMILIES;
		const rows = await listProcesses();
		const candidates = rows.filter(
			(r) =>
				r.ppid === 1 &&
				r.elapsedSeconds >= MCP_ORPHAN_MIN_ELAPSED_SECONDS &&
				matchesMcpFamily(r.command, families),
		);
		return await reapCandidates(candidates, deps);
	} catch (err) {
		deps.audit?.("mcp_orphan_reap_failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return emptyResult();
	}
}
