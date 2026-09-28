/**
 * FLY-2919: retry display cleanup after the common process-death transaction.
 * The independent body runtime owns death and CommDB projection. This worker
 * consumes its exact current-generation receipt; windows only locate resources.
 * A failed cleanup leaves the death committed and the cleanup receipt absent.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, StateStore } from "../StateStore.js";
import type { BodyDeathObligation } from "./execution-body-convergence.js";
import type { TmuxTargetLookup } from "./tmux-lookup.js";

/** Default durable crash-log location. */
export function crashLogDir(): string {
	return join(homedir(), ".flywheel", "crash-logs");
}

/**
 * Write a runner's captured scrollback to a durable crash log: dir `0700`, file
 * `0600`, via temp-file + atomic rename. Best-effort — returns `{ error }` on
 * failure instead of throwing so the reap still proceeds (Codex R1 LOW-7).
 */
export function defaultWriteCrashLog(
	executionId: string,
	text: string,
	stampMs: number,
): { path?: string; error?: string } {
	try {
		const dir = crashLogDir();
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		// mkdir's `mode` is ignored for an ALREADY-existing dir (and subject to
		// umask on create), so enforce 0700 explicitly (Codex code R1 MEDIUM).
		chmodSync(dir, 0o700);
		const safeId = executionId.replace(/[^A-Za-z0-9._-]/g, "_");
		const path = join(dir, `${safeId}-${stampMs}.log`);
		// `wx` fails if a stale temp exists rather than reusing its (possibly wrong)
		// mode; the stampMs + pid keep it unique per reap. chmod after write closes
		// the umask gap before the atomic rename.
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
		return { path };
	} catch (err) {
		return { error: (err as Error).message };
	}
}

/** Static deps supplied once by plugin.ts (tmux / discord / fs sinks). */
export interface CrashReaperInjectedDeps {
	/**
	 * FLY-1185 (Codex R2#3, entry C): serialize each crash reap with the
	 * unified lifecycle executor's per-issue mutex — a crash teardown can
	 * never interleave with a ship/park/apply closeout on the same issue.
	 * Absent → legacy behavior (tests / non-Bridge assembly).
	 */
	lifecycleMutex?: {
		withIssueMutex: <T>(keys: string[], fn: () => Promise<T>) => Promise<T>;
		resolveLockKeys: (issueId: string) => string[];
	};
	/** Display cleanup switch; process death is owned by the body runtime. */
	enabled: boolean;
	/** Must recheck managed policy and the exact current projected death on every read. */
	readCurrentDeath: (
		executionId: string,
	) => Pick<BodyDeathObligation, "obligationId" | "disposition"> | undefined;
	lookupTmuxTarget: (
		executionId: string,
		projectName: string,
	) => TmuxTargetLookup;
	/** UI ownership only; never process-death evidence. */
	inspectWindow: (
		executionId: string,
		tmuxWindow: string,
	) => Promise<"owned" | "absent" | "unknown">;
	captureScrollback: (
		tmuxWindow: string,
	) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
	killCmuxLinkedSession: (
		tmuxWindow: string,
		canCleanup: () => boolean,
	) => Promise<{ killed: boolean; error?: string }>;
	killTmuxWindow: (
		tmuxWindow: string,
	) => Promise<{ killed: boolean; error?: string }>;
	/** Best-effort terminal-view close (does NOT gate cleanup_pending). */
	closeTerminalView?: (session: Session, tmuxWindow: string) => Promise<void>;
	/** Archive only the failed body whose exact death is still current. */
	archiveThread?: (session: Session) => Promise<void>;
	/** Override crash-log writer (tests). */
	writeCrashLog?: (
		executionId: string,
		text: string,
		stampMs: number,
	) => { path?: string; error?: string };
}

/** Per-cycle deps supplied by HeartbeatService. */
export interface CrashReapCycleDeps {
	store: StateStore;
	/** Bounded durable inventory, including bodies already terminalized. */
	candidates: readonly string[];
	nowMs: number;
	/** Transport/closeout holds may defer display cleanup only. */
	isSuppressed: (executionId: string) => boolean;
	/** FLY-172 pending complete marker → that drain owns the session. */
	hasPendingCompleteMarker: (executionId: string) => boolean;
	/** Reconcile completion first; true also covers settled, held and unknown outcomes. */
	reconcileCompletionBeforeDeath?: (executionId: string) => Promise<boolean>;
	log?: (m: string) => void;
}

export type CrashReapDeps = CrashReaperInjectedDeps & CrashReapCycleDeps;

export interface CrashReapResult {
	/** Bodies with settled death or completion-owned/unknown bookkeeping. */
	bodyDeathOwned: Set<string>;
	confirmedBodyDeaths: number;
	reaped: number;
	cleanupPending: number;
	indeterminateSuppressed: number;
	transitionSkipped: number;
}

export async function reapCrashedRunners(
	deps: CrashReapDeps,
): Promise<CrashReapResult> {
	const log = deps.log ?? ((m: string) => console.log(m));
	const result: CrashReapResult = {
		bodyDeathOwned: new Set(),
		confirmedBodyDeaths: 0,
		reaped: 0,
		cleanupPending: 0,
		indeterminateSuppressed: 0,
		transitionSkipped: 0,
	};
	if (!deps.enabled) return result;

	for (const execId of deps.candidates) {
		const session = deps.store.getSession(execId);
		if (!session || deps.isSuppressed(execId)) continue;
		// Quota standby owns this same execution for a later resume. Even if a
		// stale cleanup receipt exists, its founder-visible resources stay intact.
		if (deps.store.isCodexQuotaStandby?.(execId) === true) continue;
		if (
			(await completionOwnsReap(execId, deps, result)) ||
			pendingCompletionOwnsReap(execId, deps, result)
		)
			continue;
		const death = deps.readCurrentDeath(execId);
		// Completed/standby bodies retain their existing closeout policy. Only
		// the common failed-body disposition enters crash display cleanup.
		if (!death || death.disposition !== "failed") {
			result.indeterminateSuppressed++;
			continue;
		}
		result.bodyDeathOwned.add(execId);
		result.confirmedBodyDeaths++;
		const cleanup = () =>
			reapOne(session, death.obligationId, deps, result, log);
		try {
			if (deps.lifecycleMutex) {
				await deps.lifecycleMutex.withIssueMutex(
					deps.lifecycleMutex.resolveLockKeys(session.issue_id),
					cleanup,
				);
			} else await cleanup();
		} catch (error) {
			result.cleanupPending++;
			log(
				`[crash-reaper] ${execId}: display cleanup deferred (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}

	return result;
}

/** No status mutation here: death and communication projection precede cleanup. */
async function reapOne(
	session: Session,
	obligationId: string,
	deps: CrashReapDeps,
	result: CrashReapResult,
	log: (m: string) => void,
): Promise<void> {
	const execId = session.execution_id;
	const current = () =>
		deps.readCurrentDeath(execId)?.obligationId === obligationId;
	const allowedNow = () =>
		current() && !pendingCompletionOwnsReap(execId, deps, result);
	const guarded = async () => {
		if (
			(await completionOwnsReap(execId, deps, result)) ||
			pendingCompletionOwnsReap(execId, deps, result)
		)
			return false;
		if (current()) return true;
		result.transitionSkipped++;
		return false;
	};
	if (!(await guarded()) || !allowedNow()) return;
	const lookup = deps.lookupTmuxTarget(execId, session.project_name);
	if (
		lookup.kind === "error" ||
		(lookup.kind === "found" && lookup.target.tmuxWindow.endsWith(":pending"))
	) {
		result.cleanupPending++;
		return;
	}
	let crashLogPath: string | undefined;
	let dumpError: string | undefined;
	let tmuxWindow = lookup.kind === "found" ? lookup.target.tmuxWindow : null;
	if (tmuxWindow) {
		const ownership = await deps.inspectWindow(execId, tmuxWindow);
		if (!(await guarded()) || !allowedNow()) return;
		if (ownership === "absent") tmuxWindow = null;
		else if (ownership !== "owned") {
			result.cleanupPending++;
			return;
		}
	}
	if (tmuxWindow) {
		try {
			const cap = await deps.captureScrollback(tmuxWindow);
			if (cap.ok) {
				const written = (deps.writeCrashLog ?? defaultWriteCrashLog)(
					execId,
					cap.text,
					deps.nowMs,
				);
				crashLogPath = written.path;
				dumpError = written.error;
			} else dumpError = cap.error;
		} catch (error) {
			dumpError = error instanceof Error ? error.message : String(error);
		}
		if (!(await guarded()) || !allowedNow()) return;
		// cmux resolves through the window. Preserve that locator on failure;
		// the durable death duty, not running status, makes the next pass retry.
		if ((await deps.inspectWindow(execId, tmuxWindow)) !== "owned") {
			result.cleanupPending++;
			return;
		}
		if (!(await guarded()) || !allowedNow()) return;
		const cmux = await deps.killCmuxLinkedSession(tmuxWindow, allowedNow);
		if (!cmux.killed) {
			result.cleanupPending++;
			return;
		}
		if (!(await guarded()) || !allowedNow()) return;
		if ((await deps.inspectWindow(execId, tmuxWindow)) !== "owned") {
			result.cleanupPending++;
			return;
		}
		if (!(await guarded()) || !allowedNow()) return;
		const win = await deps.killTmuxWindow(tmuxWindow);
		if (!win.killed) {
			result.cleanupPending++;
			return;
		}
		if (!(await guarded()) || !allowedNow()) return;
		try {
			await deps.closeTerminalView?.(session, tmuxWindow);
		} catch (error) {
			log(`[crash-reaper] ${execId}: terminal close warn: ${String(error)}`);
		}
	}
	if (!(await guarded()) || !allowedNow()) return;
	await deps.archiveThread?.(session);
	if (!(await guarded()) || !allowedNow()) return;
	deps.store.insertEvent({
		event_id: `${obligationId}:ui-cleaned`,
		execution_id: execId,
		issue_id: session.issue_id,
		project_name: session.project_name,
		event_type: "runner_crash_reaped",
		source: "bridge.crash-reaper",
		payload: {
			obligationId,
			tmuxWindow,
			crashLogPath: crashLogPath ?? null,
			dumpError: dumpError ?? null,
		},
	});
	result.reaped++;
}

function pendingCompletionOwnsReap(
	executionId: string,
	deps: CrashReapDeps,
	result: CrashReapResult,
): boolean {
	try {
		if (!deps.hasPendingCompleteMarker(executionId)) return false;
	} catch {
		// A failed read is unknown, never permission to replace real completion.
	}
	result.bodyDeathOwned.add(executionId);
	result.indeterminateSuppressed++;
	return true;
}

async function completionOwnsReap(
	executionId: string,
	deps: CrashReapDeps,
	result: CrashReapResult,
): Promise<boolean> {
	try {
		if (!(await deps.reconcileCompletionBeforeDeath?.(executionId)))
			return pendingCompletionOwnsReap(executionId, deps, result);
	} catch {
		// Replay uncertainty belongs to the completion drain, including read errors.
	}
	result.bodyDeathOwned.add(executionId);
	result.indeterminateSuppressed++;
	return true;
}
