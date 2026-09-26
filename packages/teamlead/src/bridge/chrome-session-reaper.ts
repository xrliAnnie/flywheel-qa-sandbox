/**
 * FLY-766: reaper for leaked `agent-browser` Chrome-for-Testing instances.
 *
 * Background: any Runner (QA runners MUST keep claude-in-chrome; ordinary
 * runners sometimes use it too) drives ProofShot / `flywheel-comm
 * visual-capture` / browser skills, which shell out to the `agent-browser`
 * CLI. That CLI launches an ephemeral Google Chrome for Testing with
 * `--user-data-dir=$TMPDIR/agent-browser-chrome-<uuid> --headless=new`, kept
 * resident for CDP reuse. When the CLI exits, Chrome reparents to launchd
 * (`ppid=1`) *while still in use*, so bare `ppid=1` cannot distinguish in-use
 * from abandoned. Nothing kills it when the owning session reaches a terminal
 * state → N sessions stack N Chrome sets → fleet-level memory spikes.
 *
 * Deterministic attribution (FLY-766 A): TmuxAdapter points each claude-tmux
 * runner's `TMPDIR` at `~/.flywheel/runner-state/<execId>/browser-tmp/`, so the
 * launched Chrome's `--user-data-dir` embeds the execId and a
 * `.flywheel-owner.json` marker carries the OWNING Bridge's actual StateStore
 * db path. This reaper maps each Chrome back to its session + Bridge and kills
 * ONLY those whose owning session (proven by the marker to belong to THIS
 * Bridge) reached a terminal state or is gone.
 *
 * Safety (the Eng Lead mis-killed the FLY-766 runner itself via process-name
 * grep): the selector matches on the OS-reported executable identity (`comm`),
 * NOT argv substrings — a `claude`/`node` runner whose command line happens to
 * contain the Chrome path + `--user-data-dir=...agent-browser-chrome...` (e.g.
 * a runner reviewing this very issue) never matches. Annie's real
 * `/Applications/Google Chrome.app` (default profile, no `agent-browser-chrome-`
 * user-data-dir) never matches.
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { OUTCOME_STATUSES, type StateStore } from "../StateStore.js";

const PS_TIMEOUT_MS = 5_000;
const CHROME_FOR_TESTING_COMM = "Google Chrome for Testing";
const AGENT_BROWSER_BROWSERS_SEG = `${sep}.agent-browser${sep}browsers${sep}`;
const AGENT_BROWSER_PROFILE_MARKER = "agent-browser-chrome-";
const RUNNER_STATE_SEG = `${sep}runner-state${sep}`;
const BROWSER_TMP_SEG = `${sep}browser-tmp${sep}`;
const OWNER_MARKER_FILE = ".flywheel-owner.json";

/**
 * Outcome states whose owning session's Chrome is safe to reap.
 * `approved_to_ship` is in OUTCOME_STATUSES but the Runner is still alive (it
 * ships next), so it is excluded — same exclusion as viewer-session-reaper.
 */
const KILL_STATUSES = new Set<string>(OUTCOME_STATUSES);
KILL_STATUSES.delete("approved_to_ship");

/** A live session status whose Chrome must NEVER be reaped. */
function isActiveStatus(status: string): boolean {
	return !KILL_STATUSES.has(status);
}

export interface OwnerMarker {
	execId: string;
	stateDbPath: string | null;
}

export interface ParsedChrome {
	pid: number;
	ppid: number;
	userDataDir: string;
	/** null = unattributed (user-data-dir not under a runner-state/browser-tmp). */
	execId: string | null;
}

export interface ChromeReapResult {
	scanned: number;
	killedAttributedTerminal: number;
	killedAttributedOrphan: number;
	killedUnattributedIdle: number;
	skippedActive: number;
	skippedForeign: number;
	skippedUnattributedFresh: number;
	wouldKillUnattributed: number;
	racedSkipped: number;
	errors: string[];
}

export interface ReapChromeDeps {
	store: StateStore;
	/** = store.getDbPath(); this Bridge's actual opened db path (ownership truth). */
	ownStateDbPath: string;
	mode: "boot" | "periodic";
	/**
	 * FLY-766 (Codex R2 MED-1): unattributed Chrome default log-only. Only when
	 * true does a boot pass actually SIGTERM ppid==1 + idle unattributed Chrome
	 * (the one-time ops lever to clear the pre-fix backlog).
	 */
	migrateUnattributed: boolean;
	/** idle grace (minutes) for attributed no-row + unattributed-migrate kills. */
	unattributedIdleGraceMinutes: number;
	nowMs: number;
	// Injectable IO (real defaults below; tests mock).
	listCommByPid?: () => Promise<Map<number, string>>;
	listCmdByPid?: () => Promise<Map<number, { ppid: number; command: string }>>;
	readOwnerMarker?: (markerPath: string) => Promise<OwnerMarker | null>;
	statMtimeMs?: (path: string) => Promise<number | null>;
	revalidatePid?: (pid: number) => Promise<ParsedChrome | null>;
	killProc?: (pid: number) => void;
	log?: (m: string) => void;
}

function execFilePromise(
	cmd: string,
	args: string[],
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
			if (err) reject(err);
			else resolve(stdout ?? "");
		});
	});
}

/** Default: `ps -Awwo pid=,comm=` → Map<pid, comm>. `comm` may contain spaces. */
async function defaultListCommByPid(): Promise<Map<number, string>> {
	const out = await execFilePromise(
		"ps",
		["-Awwo", "pid=,comm="],
		PS_TIMEOUT_MS,
	);
	const map = new Map<number, string>();
	for (const line of out.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(.*)$/);
		const pidStr = m?.[1];
		const comm = m?.[2];
		if (pidStr === undefined || comm === undefined) continue;
		const pid = Number.parseInt(pidStr, 10);
		if (!Number.isFinite(pid)) continue;
		map.set(pid, comm);
	}
	return map;
}

/** Default: `ps -Awwo pid=,ppid=,command=` → Map<pid, {ppid, command}>. */
async function defaultListCmdByPid(): Promise<
	Map<number, { ppid: number; command: string }>
> {
	const out = await execFilePromise(
		"ps",
		["-Awwo", "pid=,ppid=,command="],
		PS_TIMEOUT_MS,
	);
	const map = new Map<number, { ppid: number; command: string }>();
	for (const line of out.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
		const pidStr = m?.[1];
		const ppidStr = m?.[2];
		const command = m?.[3];
		if (
			pidStr === undefined ||
			ppidStr === undefined ||
			command === undefined
		) {
			continue;
		}
		const pid = Number.parseInt(pidStr, 10);
		const ppid = Number.parseInt(ppidStr, 10);
		if (!Number.isFinite(pid)) continue;
		map.set(pid, { ppid: Number.isFinite(ppid) ? ppid : 0, command });
	}
	return map;
}

async function defaultReadOwnerMarker(
	markerPath: string,
): Promise<OwnerMarker | null> {
	try {
		const raw = await readFile(markerPath, "utf-8");
		const parsed = JSON.parse(raw) as OwnerMarker;
		if (parsed && typeof parsed.execId === "string") {
			return {
				execId: parsed.execId,
				stateDbPath:
					typeof parsed.stateDbPath === "string" ? parsed.stateDbPath : null,
			};
		}
		return null;
	} catch {
		return null;
	}
}

async function defaultStatMtimeMs(path: string): Promise<number | null> {
	try {
		const s = await stat(path);
		return s.mtimeMs;
	} catch {
		return null;
	}
}

async function defaultRevalidatePid(pid: number): Promise<ParsedChrome | null> {
	try {
		const [comm, command] = await Promise.all([
			execFilePromise("ps", ["-p", String(pid), "-o", "comm="], PS_TIMEOUT_MS),
			execFilePromise(
				"ps",
				["-p", String(pid), "-o", "command="],
				PS_TIMEOUT_MS,
			),
		]);
		return parseChromeProc(pid, 0, comm.trim(), command.trim());
	} catch {
		return null;
	}
}

function defaultKillProc(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch (err) {
		// ESRCH = the process is already gone → success (nothing to kill).
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
		throw err;
	}
}

/** OS-reported executable is agent-browser's Chrome for Testing (not argv). */
function isChromeForTestingComm(comm: string): boolean {
	if (!comm) return false;
	if (basename(comm) === CHROME_FOR_TESTING_COMM) return true;
	return comm.includes(AGENT_BROWSER_BROWSERS_SEG);
}

function extractUserDataDir(command: string): string | null {
	// Temp profile paths (runner-state / $TMPDIR / agent-browser-chrome-<uuid>)
	// contain no spaces, so a non-space run is the whole value and stops at the
	// next flag.
	return command.match(/--user-data-dir=(\S+)/)?.[1] ?? null;
}

/**
 * execId = the `<execId>` in `.../runner-state/<execId>/browser-tmp/
 * agent-browser-chrome-<uuid>`. Returns null when the user-data-dir is NOT
 * under a runner-state/browser-tmp (e.g. legacy system `$TMPDIR`) = unattributed.
 */
function extractExecId(userDataDir: string): string | null {
	const idx = userDataDir.indexOf(RUNNER_STATE_SEG);
	if (idx < 0) return null;
	const rest = userDataDir.slice(idx + RUNNER_STATE_SEG.length);
	const seg = rest.indexOf(sep);
	if (seg <= 0) return null;
	const execId = rest.slice(0, seg);
	// Must continue `<execId>/browser-tmp/…` (the injected per-runner layout).
	if (!rest.slice(seg).startsWith(BROWSER_TMP_SEG)) return null;
	return execId || null;
}

/**
 * Pure classifier: a Chrome process line → structured result, or null when it
 * is NOT an agent-browser Chrome-for-Testing MAIN process. Match requires ALL:
 *  (1) executable identity from `comm` (never argv) is Chrome for Testing;
 *  (2) argv has `--user-data-dir=<path>` whose path contains
 *      `agent-browser-chrome-`;
 *  (3) it is the MAIN process (argv has no `--type=` → renderers/gpu excluded).
 */
export function parseChromeProc(
	pid: number,
	ppid: number,
	comm: string,
	command: string,
): ParsedChrome | null {
	if (!isChromeForTestingComm(comm)) return null;
	if (/(^|\s)--type=/.test(command)) return null;
	const userDataDir = extractUserDataDir(command);
	if (!userDataDir || !userDataDir.includes(AGENT_BROWSER_PROFILE_MARKER)) {
		return null;
	}
	return { pid, ppid, userDataDir, execId: extractExecId(userDataDir) };
}

/** Marker path co-located next to the ephemeral profile (…/browser-tmp/…). */
function ownerMarkerPathFor(userDataDir: string): string {
	return join(dirname(userDataDir), OWNER_MARKER_FILE);
}

/**
 * Scan + reap. Best-effort: every failure is collected into `errors`, never
 * thrown. Missing `ps` / no processes is benign (empty result).
 */
export async function reapChromeSessions(
	deps: ReapChromeDeps,
): Promise<ChromeReapResult> {
	const log = deps.log ?? ((m: string) => console.log(m));
	const listCommByPid = deps.listCommByPid ?? defaultListCommByPid;
	const listCmdByPid = deps.listCmdByPid ?? defaultListCmdByPid;
	const readOwnerMarker = deps.readOwnerMarker ?? defaultReadOwnerMarker;
	const statMtimeMs = deps.statMtimeMs ?? defaultStatMtimeMs;
	const revalidatePid = deps.revalidatePid ?? defaultRevalidatePid;
	const killProc = deps.killProc ?? defaultKillProc;
	const graceMs = deps.unattributedIdleGraceMinutes * 60_000;

	const result: ChromeReapResult = {
		scanned: 0,
		killedAttributedTerminal: 0,
		killedAttributedOrphan: 0,
		killedUnattributedIdle: 0,
		skippedActive: 0,
		skippedForeign: 0,
		skippedUnattributedFresh: 0,
		wouldKillUnattributed: 0,
		racedSkipped: 0,
		errors: [],
	};

	let commByPid: Map<number, string>;
	let cmdByPid: Map<number, { ppid: number; command: string }>;
	try {
		[commByPid, cmdByPid] = await Promise.all([
			listCommByPid(),
			listCmdByPid(),
		]);
	} catch {
		// ps unavailable → nothing to reap.
		return result;
	}

	for (const [pid, { ppid, command }] of cmdByPid) {
		const comm = commByPid.get(pid) ?? "";
		const chrome = parseChromeProc(pid, ppid, comm, command);
		if (!chrome) continue;
		result.scanned++;

		try {
			if (chrome.execId != null) {
				await handleAttributed(chrome, deps, result, {
					readOwnerMarker,
					statMtimeMs,
					revalidatePid,
					killProc,
					graceMs,
					log,
				});
			} else {
				await handleUnattributed(chrome, deps, result, {
					statMtimeMs,
					revalidatePid,
					killProc,
					graceMs,
					log,
				});
			}
		} catch (e) {
			result.errors.push(`pid ${pid}: ${(e as Error).message}`);
		}
	}

	return result;
}

interface Handlers {
	readOwnerMarker?: (markerPath: string) => Promise<OwnerMarker | null>;
	statMtimeMs: (path: string) => Promise<number | null>;
	revalidatePid: (pid: number) => Promise<ParsedChrome | null>;
	killProc: (pid: number) => void;
	graceMs: number;
	log: (m: string) => void;
}

async function handleAttributed(
	chrome: ParsedChrome,
	deps: ReapChromeDeps,
	result: ChromeReapResult,
	h: Handlers & {
		readOwnerMarker: (markerPath: string) => Promise<OwnerMarker | null>;
	},
): Promise<void> {
	const execId = chrome.execId as string;
	// Ownership proof (Codex R1/R2/R3 HIGH-1): only act when the marker proves
	// this browser-tmp belongs to THIS Bridge's StateStore.
	const marker = await h.readOwnerMarker(
		ownerMarkerPathFor(chrome.userDataDir),
	);
	if (!marker || marker.stateDbPath !== deps.ownStateDbPath) {
		result.skippedForeign++;
		return;
	}

	const session = deps.store.getSession(execId);
	if (session) {
		if (isActiveStatus(session.status)) {
			result.skippedActive++;
			return;
		}
		// Terminal: deterministic use-done-must-close (boot + periodic).
		if (!(await revalidateAndKill(chrome, h))) {
			result.racedSkipped++;
			return;
		}
		result.killedAttributedTerminal++;
		insertReapEvent(deps.store, {
			execution_id: execId,
			issue_id: session.issue_id,
			project_name: session.project_name,
			reason: `outcome:${session.status}`,
			mode: deps.mode,
			chrome,
		});
		return;
	}

	// No row (pruned orphan, but marker proves it is ours): boot-only + ppid==1
	// + profile idle ≥ grace (idle gate avoids killing a just-spawned Chrome
	// whose marker is written before the StateStore row registers). Never on the
	// periodic tick.
	if (deps.mode !== "boot" || chrome.ppid !== 1) {
		result.skippedActive++;
		return;
	}
	if (!(await idleEnough(chrome.userDataDir, deps.nowMs, h))) {
		result.skippedActive++;
		return;
	}
	if (!(await revalidateAndKill(chrome, h))) {
		result.racedSkipped++;
		return;
	}
	result.killedAttributedOrphan++;
	insertReapEvent(deps.store, {
		execution_id: execId,
		issue_id: "unknown",
		project_name: "unknown",
		reason: "orphan:no-row",
		mode: deps.mode,
		chrome,
	});
}

async function handleUnattributed(
	chrome: ParsedChrome,
	deps: ReapChromeDeps,
	result: ChromeReapResult,
	h: Handlers,
): Promise<void> {
	// Unattributed (legacy system $TMPDIR / Bridge-side ProofShot): periodic
	// never touches it; boot only when ppid==1 + idle ≥ grace.
	if (deps.mode !== "boot" || chrome.ppid !== 1) {
		result.skippedUnattributedFresh++;
		return;
	}
	if (!(await idleEnough(chrome.userDataDir, deps.nowMs, h))) {
		result.skippedUnattributedFresh++;
		return;
	}
	// Default log-only (Codex R2 MED-1): a live pre-fix Chrome paused at a 49h
	// human gate is also ppid==1 + idle. Only the explicit ops migrate lever
	// actually kills.
	if (!deps.migrateUnattributed) {
		result.wouldKillUnattributed++;
		h.log(
			`[chrome-reaper] wouldKillUnattributed pid=${chrome.pid} userDataDir=${chrome.userDataDir} (set FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED=1 to reap)`,
		);
		return;
	}
	if (!(await revalidateAndKill(chrome, h))) {
		result.racedSkipped++;
		return;
	}
	result.killedUnattributedIdle++;
	insertReapEvent(deps.store, {
		execution_id: `chrome-unattributed:${chrome.pid}`,
		issue_id: "unknown",
		project_name: "unknown",
		reason: "unattributed:migrate",
		mode: deps.mode,
		chrome,
	});
}

async function idleEnough(
	userDataDir: string,
	nowMs: number,
	h: Handlers,
): Promise<boolean> {
	const mtime = await h.statMtimeMs(userDataDir);
	if (mtime == null) return false; // can't prove idle → conservative skip
	return nowMs - mtime >= h.graceMs;
}

/**
 * PID-reuse guard (Codex R1 MED-5): re-read the pid immediately before SIGTERM
 * and require it still parses to the SAME userDataDir + Chrome-main identity.
 * Returns false when it no longer matches (a race → skip).
 */
async function revalidateAndKill(
	chrome: ParsedChrome,
	h: Handlers,
): Promise<boolean> {
	const fresh = await h.revalidatePid(chrome.pid);
	if (!fresh || fresh.userDataDir !== chrome.userDataDir) return false;
	h.killProc(chrome.pid);
	return true;
}

function insertReapEvent(
	store: StateStore,
	e: {
		execution_id: string;
		issue_id: string;
		project_name: string;
		reason: string;
		mode: string;
		chrome: ParsedChrome;
	},
): void {
	store.insertEvent({
		event_id: `chrome-reaper-${e.chrome.pid}-${Date.now()}`,
		execution_id: e.execution_id,
		issue_id: e.issue_id,
		project_name: e.project_name,
		event_type: "chrome_session_reaped",
		source: "bridge.chrome-session-reaper",
		payload: {
			pid: e.chrome.pid,
			ppid: e.chrome.ppid,
			userDataDir: e.chrome.userDataDir,
			execId: e.chrome.execId,
			reason: e.reason,
			mode: e.mode,
		},
	});
}
