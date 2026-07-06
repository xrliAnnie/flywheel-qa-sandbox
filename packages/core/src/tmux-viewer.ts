import { execFile, execFileSync } from "node:child_process";
import { formatViewTitle } from "./terminal-view-identity.js";

/**
 * FLY-116 — Runner Terminal Auto-Close.
 * FLY-128 — Process-local serialization of openTmuxViewer to fix concurrent
 * spawn race (3 Runners → only 1 tab in production 2026-05-05).
 *
 * Architecture: per-viewer linked tmux session + window-aware Terminal.app close
 * + status-dominant cleanup (drives by external state, not in-tab polling).
 *
 * Key design (Codex Round 7 APPROVED for FLY-116, Round 6 APPROVED for FLY-128):
 *   - openTmuxViewer({...}) takes per-runner identity (executionId, windowId,
 *     sessionRole, projectName, baseSessionName) and creates a per-viewer linked
 *     tmux session "viewer-<executionId>" pointing at the runner's window.
 *   - Each Terminal tab gets a unique custom title from formatViewTitle().
 *   - closeRunnerTerminalView({...}) kills the linked viewer session (which makes
 *     `tmux attach` exit) AND osascript closes the tab by exact title.
 *   - cancelOpener(executionId) cancels an in-flight opener if close runs first
 *     (race guard for fast-completing runners).
 *   - FLY-128: process-local Promise-chain queue (`openQueue`) serializes the
 *     full opener pipeline (dedup → tmux setup → final do-script → verify) so
 *     concurrent Apple Events do not collide on Terminal.app. Per-step
 *     `execFile`/`execFileSync` `timeout` options give bounded recovery; no
 *     whole-opener `Promise.race` (cannot cancel in-flight execFile).
 *
 * No Phase-2 polling watcher — that was dead code under the shared-session model
 * (the base session's tmux process is always alive while sibling runners exist).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Process-local state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-process dedup guard for concurrent openTmuxViewer() calls with the same
 * custom title (TOCTOU between osascript dedup scan and tab spawn).
 *
 * Process-boundary assumption: openTmuxViewer() and closeRunnerTerminalView()
 * run in the same Bridge Node process today. If that ever changes (worker
 * process split, separate service), this guard must move to shared state
 * (SQLite row, Redis).
 */
const openingTitles = new Set<string>();

/**
 * Cancellation registry — closeRunnerTerminalView() calls cancelOpener() at
 * the start, so an in-flight opener for a fast-completing runner skips
 * spawning the Terminal tab (would otherwise leak a stale tab).
 *
 * 5-minute TTL covers slow opener spawn windows.
 */
const cancelledExecutions = new Set<string>();

/**
 * FLY-128 — process-local opener queue.
 *
 * Serializes the full opener pipeline (dedup → tmux setup → final do-script →
 * in-queue verify) so concurrent calls do NOT race on Terminal.app Apple Events.
 *
 * Process-boundary: same as openingTitles — single Bridge Node process today.
 * If the Bridge ever splits into multiple processes (worker pool, separate
 * service), this queue must move to shared coordination (file lock, named pipe).
 *
 * Failure of one opener never blocks subsequent — `.catch()` swallows so the
 * `.then()` chain continues; per-step `execFile`/`execFileSync` `timeout`
 * options bound any pathological stuck call.
 */
let openQueue: Promise<void> = Promise.resolve();

// FLY-128 per-step timeouts. Bounded so the queue never deadlocks even if
// Terminal.app or tmux server hangs. Cumulative worst case per opener ≤60s,
// typical ≤4s including verify tail. See plan §4.1.
const DEDUP_OSASCRIPT_TIMEOUT_MS = 5_000;
const TMUX_KILL_TIMEOUT_MS = 3_000;
const TMUX_NEW_SESSION_TIMEOUT_MS = 5_000;
const TMUX_SELECT_WINDOW_TIMEOUT_MS = 3_000;
const SELECT_WINDOW_RETRIES = 10;
const SELECT_WINDOW_BACKOFF_MS = 500;
const OPEN_OSASCRIPT_TIMEOUT_MS = 5_000;
const VERIFY_DELAY_MS = 1_500;
const VERIFY_OSASCRIPT_TIMEOUT_MS = 5_000;

/**
 * Promise-style execFile wrapper. Always resolves with `{stdout, stderr}` on
 * success, rejects with the original Error. NOTE (FLY-754): Node's
 * child-process timeout does NOT set `.code === "ETIMEDOUT"` here — the real
 * shape is `{code: null, killed: true, signal: "SIGTERM"}` (process killed by
 * the timeout signal). Use isExecFileTimeout() to classify.
 */
function execFilePromise(
	cmd: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
			if (err) reject(err);
			else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
		});
	});
}

/**
 * FLY-754: classify an execFile rejection as a timeout / signal kill.
 * Node's execFile timeout kills the child with `killSignal` (default SIGTERM)
 * and the callback error carries `{code: null, killed: true, signal: "SIGTERM"}`
 * — NOT `code === "ETIMEDOUT"` (kept in the check for defense in depth).
 * Any signal-killed osascript is treated as AMBIGUOUS: Terminal.app may have
 * partially accepted `do script` before the kill, so callers must NOT assume
 * the tab was never created.
 */
function isExecFileTimeout(err: unknown): boolean {
	const e = err as NodeJS.ErrnoException & {
		killed?: boolean;
		signal?: string | null;
	};
	return e.code === "ETIMEDOUT" || e.killed === true || e.signal != null;
}

/** Sleep without shelling out (Codex R1 non-blocking — FLY-128). */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		t.unref?.();
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Path resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the absolute path to the tmux binary.
 * Returns undefined if tmux is not installed.
 */
function resolveTmuxPath(): string | undefined {
	try {
		return execFileSync("which", ["tmux"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return undefined;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Escaping helpers (defense-in-depth)
// ─────────────────────────────────────────────────────────────────────────────

/** Escape a string for inclusion inside an AppleScript double-quoted literal. */
export function escapeAppleScript(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * POSIX single-quote escape: replace every `'` with `'\''` so the result
 * can safely be wrapped in `'...'` in a shell command.
 */
export function posixEscape(s: string): string {
	return s.replace(/'/g, "'\\''");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API: cancel guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cancel any in-flight openTmuxViewer() for the given executionId. Subsequent
 * openTmuxViewer() calls for the same executionId will skip spawning Terminal.
 *
 * Self-clears after 5 minutes.
 */
export function cancelOpener(executionId: string): void {
	cancelledExecutions.add(executionId);
	setTimeout(
		() => cancelledExecutions.delete(executionId),
		5 * 60 * 1000,
	).unref?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// FLY-650: viewer backend gate (D1=A / Linux portability)
// ─────────────────────────────────────────────────────────────────────────────

export type ViewerBackend = "cmux" | "terminal-app" | "tmux-only" | "none";

/**
 * FLY-650: which terminal viewer backend is active. Mirrors host-config.sh's
 * `viewerBackend` (set as FLYWHEEL_VIEWER_BACKEND by the Bridge wrapper). The env
 * value wins; otherwise the platform default — macOS=`cmux` (today's behavior),
 * anything else (Linux/WSL2)=`tmux-only`.
 *
 * Founder-confirmed (FLY-650, Annie 2026-06-28): Linux runs headless `tmux-only`
 * (attach with `tmux attach`) — an explicit, acknowledged revision of the macOS
 * "never headless" rule for Linux hosts. macOS stays `cmux` (byte-compat).
 */
export function resolveViewerBackend(): ViewerBackend {
	const env = process.env.FLYWHEEL_VIEWER_BACKEND;
	if (
		env === "cmux" ||
		env === "terminal-app" ||
		env === "tmux-only" ||
		env === "none"
	) {
		return env;
	}
	return process.platform === "darwin" ? "cmux" : "tmux-only";
}

/**
 * Whether the active viewer backend uses the macOS Terminal.app/osascript opener.
 * ONLY `terminal-app` does. Centralized so EVERY dispatch path that calls
 * openTmuxViewer is gated here — new call sites cannot bypass it.
 *
 * FLY-754 (intentional behavior change over FLY-650's byte-compat): `cmux` no
 * longer runs the Terminal.app opener. On cmux hosts the viewing surface is
 * cmux-sync's per-window workspaces; the opener's `viewer-<execId>` linked
 * sessions had no consumer there (the Terminal tab consistently failed to
 * materialize) and leaked on every dispatch — 36 zombie sessions observed in
 * production. `tmux-only` / `none` (Linux/WSL2) stay skipped as before.
 */
export function viewerUsesTerminalApp(): boolean {
	return resolveViewerBackend() === "terminal-app";
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API: open viewer
// ─────────────────────────────────────────────────────────────────────────────

export interface TmuxViewerOpts {
	/** Base tmux session, e.g. "runner-flywheel". */
	baseSessionName: string;
	/** Per-runner tmux window id, e.g. "@42". */
	windowId: string;
	/** Per-runner execution id (UUID). Used for linked viewer session name. */
	executionId: string;
	/** engineer / qa / designer (from StateStore.session_role); optional. */
	sessionRole?: string;
	/** Project name for title. */
	projectName: string;
}

/**
 * Open a Terminal.app tab attached to a per-viewer linked tmux session that
 * focuses on the runner's window.
 *
 * Best-effort — failure is non-fatal (user can always `tmux attach` manually).
 *
 * FLY-128: every call enqueues onto a process-local Promise chain so the full
 * opener pipeline (dedup → tmux setup → final do-script → in-queue verify) runs
 * one at a time, preventing Terminal.app Apple Event collisions.
 */
export function openTmuxViewer(opts: TmuxViewerOpts): void {
	// FLY-650/FLY-754: central viewer-backend gate. Only `terminal-app` runs the
	// macOS Terminal.app/osascript opener. On cmux hosts cmux-sync owns viewing
	// (skipping here is what stops `viewer-<execId>` sessions from ever being
	// created — the FLY-754 leak source); on Linux/WSL2 the operator attaches
	// with `tmux attach`. Gating here covers every dispatch call site
	// (run-dispatcher x2, DagDispatcher) at once.
	if (!viewerUsesTerminalApp()) {
		const backend = resolveViewerBackend();
		console.log(
			`[tmux-viewer] viewer backend '${backend}' — skipping Terminal.app opener ` +
				(backend === "cmux"
					? "(viewing handled by cmux-sync workspaces)"
					: `(attach with: tmux attach -t ${opts.baseSessionName})`),
		);
		return;
	}
	const tmuxPath = resolveTmuxPath();
	if (!tmuxPath) {
		console.warn("[tmux-viewer] tmux not found in PATH, skipping viewer");
		return;
	}

	const customTitle = formatViewTitle({
		sessionName: opts.baseSessionName,
		projectName: opts.projectName,
		executionId: opts.executionId,
		windowId: opts.windowId,
		sessionRole: opts.sessionRole,
	});

	// In-process TOCTOU guard (Codex Round 4 #4 — FLY-116)
	if (openingTitles.has(customTitle)) {
		console.log(
			`[tmux-viewer] open already in-flight for ${customTitle}, skip`,
		);
		return;
	}
	openingTitles.add(customTitle);

	// FLY-128: enqueue the full opener pipeline. Per-step timeouts inside
	// doOpen() bound the queue's hold time even under pathological stalls.
	openQueue = openQueue
		.catch(() => {
			/* prior failure must NOT block subsequent runners */
		})
		.then(() => doOpen(opts, customTitle, tmuxPath))
		.catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[tmux-viewer] opener finished with error: ${msg}`);
		})
		.finally(() => {
			// Always release the same-title guard — covers every code path
			// (success, dedup-hit, cancellation, select-window abort, per-step
			// timeout, verify failure).
			openingTitles.delete(customTitle);
		});
}

async function doOpen(
	opts: TmuxViewerOpts,
	customTitle: string,
	tmuxPath: string,
): Promise<void> {
	const safeTitle = escapeAppleScript(customTitle);
	const viewerSession = `viewer-${opts.executionId}`;

	// 1. Dedup osascript with bounded timeout.
	const exists = await runDedup(safeTitle);
	if (exists) {
		console.log(`[tmux-viewer] viewer already open for ${customTitle}, skip`);
		return;
	}

	// 2. Race guard: closeRunnerTerminalView may have cancelled us.
	if (cancelledExecutions.has(opts.executionId)) {
		console.log(
			`[tmux-viewer] opener cancelled for ${opts.executionId}, skip spawn`,
		);
		return;
	}

	// 3. Idempotent linked viewer setup with stderr capture (FLY-128).
	setupViewerSession(tmuxPath, viewerSession, opts.baseSessionName);

	// 4. Bounded retry select-window — uses await delay (no shell-out sleep).
	const windowReady = await selectViewerWindow(
		tmuxPath,
		viewerSession,
		opts.windowId,
	);
	if (!windowReady) {
		console.warn(
			`[tmux-viewer] select-window failed after ${SELECT_WINDOW_RETRIES} attempts for ${viewerSession}:${opts.windowId} — aborting viewer open`,
		);
		killViewerSessionBestEffort(tmuxPath, viewerSession);
		return;
	}

	// 5. Final do-script osascript — opens the Terminal tab and assigns title.
	// Re-check cancellation right before spawning the tab — closeRunnerTerminalView
	// may have fired during the select-window retry window.
	if (cancelledExecutions.has(opts.executionId)) {
		console.log(
			`[tmux-viewer] opener cancelled for ${opts.executionId} pre-open, skip spawn`,
		);
		killViewerSessionBestEffort(tmuxPath, viewerSession);
		return;
	}
	const openOutcome = await runOpen(tmuxPath, viewerSession, safeTitle);

	// FLY-754: a DEFINITE spawn failure (osascript exited non-zero, not
	// signal-killed) means the tab was never created — clean up the linked
	// viewer session created in step 3 or it leaks forever. Ambiguous timeout
	// keeps the verify/log-only path below (the tab may exist).
	if (openOutcome === "failed") {
		killViewerSessionBestEffort(tmuxPath, viewerSession);
		return;
	}

	// 6. In-queue verification (FLY-128 §4.4 — log only, never throws).
	// Awaited so the next opener does not start its dedup until verify settles.
	await delay(VERIFY_DELAY_MS);
	await runVerifyLog(safeTitle, customTitle);
}

/** Dedup osascript — returns true if a tab with this exact title already exists. */
async function runDedup(safeTitle: string): Promise<boolean> {
	const dedupScript = [
		'tell application "Terminal"',
		`  set targetTitle to "${safeTitle}"`,
		"  repeat with w in windows",
		"    repeat with t in tabs of w",
		"      try",
		'        if (custom title of t as text) is targetTitle then return "exists"',
		"      end try",
		"    end repeat",
		"  end repeat",
		'  return "open"',
		"end tell",
	].join("\n");

	try {
		const { stdout } = await execFilePromise(
			"osascript",
			["-e", dedupScript],
			DEDUP_OSASCRIPT_TIMEOUT_MS,
		);
		return stdout.trim() === "exists";
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[tmux-viewer] dedup osascript failed: ${msg}`);
		// Fail open — proceed to spawn rather than block.
		return false;
	}
}

/**
 * Synchronous tmux linked-session setup — kill-session + new-session.
 * Best-effort; select-window validation later will abort safely if either
 * step left the viewer session in an unusable state. Captures stderr so
 * "duplicate session" / "no current target" / etc. is loggable.
 */
function setupViewerSession(
	tmuxPath: string,
	viewerSession: string,
	baseSessionName: string,
): void {
	// Pre-kill any stale viewer session for this exec (rare — same exec id
	// reopened after a crash). Benign if missing.
	try {
		execFileSync(tmuxPath, ["kill-session", "-t", `=${viewerSession}`], {
			encoding: "utf-8",
			stdio: ["ignore", "ignore", "pipe"],
			timeout: TMUX_KILL_TIMEOUT_MS,
		});
	} catch {
		/* benign — viewer session may not exist yet */
	}

	try {
		execFileSync(
			tmuxPath,
			["new-session", "-d", "-s", viewerSession, "-t", `=${baseSessionName}`],
			{
				encoding: "utf-8",
				stdio: ["ignore", "ignore", "pipe"],
				timeout: TMUX_NEW_SESSION_TIMEOUT_MS,
			},
		);
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr ?? "";
		const msg = (err as Error).message;
		// `duplicate session` is benign (same exec re-entrancy after kill race).
		if (!/duplicate session/.test(stderr)) {
			console.log(
				`[tmux-viewer] viewer session create warn (msg=${msg}, stderr=${stderr.trim()})`,
			);
		}
	}
}

/**
 * Bounded select-window retry. Returns true on success, false after exhausting
 * SELECT_WINDOW_RETRIES attempts.
 */
async function selectViewerWindow(
	tmuxPath: string,
	viewerSession: string,
	windowId: string,
): Promise<boolean> {
	let lastStderr = "";
	for (let attempt = 0; attempt < SELECT_WINDOW_RETRIES; attempt++) {
		try {
			execFileSync(
				tmuxPath,
				["select-window", "-t", `${viewerSession}:${windowId}`],
				{
					encoding: "utf-8",
					stdio: ["ignore", "ignore", "pipe"],
					timeout: TMUX_SELECT_WINDOW_TIMEOUT_MS,
				},
			);
			return true;
		} catch (err) {
			lastStderr = (err as { stderr?: string }).stderr ?? "";
			// Single info log on the FIRST retry to mark the slow path without
			// being chatty on every iteration (Codex R1 non-blocking).
			if (attempt === 0) {
				console.log(
					`[tmux-viewer] select-window retrying for ${viewerSession}:${windowId} (stderr=${lastStderr.trim()})`,
				);
			}
			await delay(SELECT_WINDOW_BACKOFF_MS);
		}
	}
	if (lastStderr) {
		console.warn(
			`[tmux-viewer] select-window final stderr: ${lastStderr.trim()}`,
		);
	}
	return false;
}

function killViewerSessionBestEffort(
	tmuxPath: string,
	viewerSession: string,
): void {
	try {
		execFileSync(tmuxPath, ["kill-session", "-t", `=${viewerSession}`], {
			stdio: "ignore",
			timeout: TMUX_KILL_TIMEOUT_MS,
		});
	} catch {
		/* best-effort cleanup */
	}
}

/**
 * Spawn the Terminal tab. Returns the outcome classification (FLY-754):
 *   - "ok"        — osascript succeeded
 *   - "failed"    — osascript DEFINITELY failed (non-zero exit, not
 *                   signal-killed) → the tab was never created; caller must
 *                   clean up the linked viewer session
 *   - "ambiguous" — timeout / signal kill → Terminal.app may have partially
 *                   accepted `do script`; caller must NOT kill the viewer
 *                   session (log-only, same conservative semantics as verify)
 */
async function runOpen(
	tmuxPath: string,
	viewerSession: string,
	safeTitle: string,
): Promise<"ok" | "failed" | "ambiguous"> {
	const safeViewer = posixEscape(viewerSession);
	const shellCmd = `exec ${tmuxPath} attach -t '=${safeViewer}' 2>/dev/null`;
	const safeShellCmd = escapeAppleScript(shellCmd);

	const script = [
		'tell application "Terminal"',
		`  set viewerTab to do script "${safeShellCmd}"`,
		`  set custom title of viewerTab to "${safeTitle}"`,
		"  activate",
		"end tell",
	].join("\n");

	try {
		await execFilePromise(
			"osascript",
			["-e", script],
			OPEN_OSASCRIPT_TIMEOUT_MS,
		);
		return "ok";
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (isExecFileTimeout(err)) {
			console.warn(`[tmux-viewer] open timed out (ambiguous): ${msg}`);
			return "ambiguous";
		}
		console.warn(`[tmux-viewer] open failed: ${msg}`);
		return "failed";
	}
}

/**
 * Log-only verification (FLY-128 §4.4). Re-checks tab existence by exact
 * custom title. Never auto-retries (avoids double-tab risk). Never throws —
 * verification is diagnostic only.
 */
async function runVerifyLog(
	safeTitle: string,
	customTitle: string,
): Promise<void> {
	const verifyScript = [
		'tell application "Terminal"',
		`  set targetTitle to "${safeTitle}"`,
		"  repeat with w in windows",
		"    repeat with t in tabs of w",
		"      try",
		'        if (custom title of t as text) is targetTitle then return "exists"',
		"      end try",
		"    end repeat",
		"  end repeat",
		'  return "missing"',
		"end tell",
	].join("\n");

	try {
		const { stdout } = await execFilePromise(
			"osascript",
			["-e", verifyScript],
			VERIFY_OSASCRIPT_TIMEOUT_MS,
		);
		if (stdout.trim() !== "exists") {
			console.warn(
				`[tmux-viewer] tab not found ${VERIFY_DELAY_MS}ms after spawn — possible Terminal.app drop (title=${customTitle})`,
			);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[tmux-viewer] verify check error (non-fatal): ${msg}`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Back-compat wrapper for legacy callers that only have a session name
// (e.g. older tests). New callers should use openTmuxViewer({...}) above.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legacy API kept for tests/external scripts that only have the bare base
 * session name. Opens a plain Terminal tab attaching to the base session, no
 * custom title, no per-viewer linked session, no dedup. Production runners must
 * use openTmuxViewer({...}).
 */
export function openTmuxViewerLegacy(sessionName: string): void {
	// FLY-650/FLY-754: same viewer-backend gate as openTmuxViewer (only
	// terminal-app opens tabs; cmux is handled by cmux-sync, Linux skips).
	if (!viewerUsesTerminalApp()) {
		console.log(
			`[tmux-viewer] viewer backend '${resolveViewerBackend()}' — skipping ` +
				`legacy Terminal.app opener (attach with: tmux attach -t ${sessionName})`,
		);
		return;
	}
	const tmuxPath = resolveTmuxPath();
	if (!tmuxPath) {
		console.warn("[tmux-viewer] tmux not found in PATH, skipping viewer");
		return;
	}

	const safeName = posixEscape(sessionName);
	const shellCmd = [
		`i=0; while [ $i -lt 120 ] && ! ${tmuxPath} has-session -t '=${safeName}' 2>/dev/null;`,
		`do sleep 1; i=$((i+1)); done;`,
		`exec ${tmuxPath} attach -t '=${safeName}' 2>/dev/null`,
	].join(" ");
	const safeShellCmd = escapeAppleScript(shellCmd);

	const script = [
		'tell application "Terminal"',
		`  do script "${safeShellCmd}"`,
		"  activate",
		"end tell",
	].join("\n");

	execFile("osascript", ["-e", script], (err) => {
		if (err) {
			console.warn(`[tmux-viewer] legacy open failed: ${err.message}`);
		}
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API: close viewer
// ─────────────────────────────────────────────────────────────────────────────

export interface CloseTerminalViewOpts {
	baseSessionName: string;
	projectName: string;
	executionId: string;
	windowId: string;
	sessionRole?: string;
}

export interface CloseTerminalViewResult {
	killedViewerSession: boolean;
	closedTab: boolean;
	error?: string;
}

/**
 * Close the per-viewer linked tmux session AND the macOS Terminal tab opened
 * by openTmuxViewer().
 *
 * 1. tmux kill-session viewer-<executionId>  (causes attach to exit;
 *    safe — only kills the linked viewer session, not the base session.)
 * 2. osascript close tab by exact custom title (fallback — `do script` shell
 *    process exits when attach exits, but the tab stays unless we close it).
 *
 * Best-effort: failure logs warn and returns the partial state. Cancels any
 * in-flight opener for this executionId so a fast race doesn't leak a stale
 * tab created after close.
 */
export async function closeRunnerTerminalView(
	opts: CloseTerminalViewOpts,
): Promise<CloseTerminalViewResult> {
	// Race guard — cancel any in-flight opener for this exec.
	cancelOpener(opts.executionId);

	const tmuxPath = resolveTmuxPath();
	const viewerSession = `viewer-${opts.executionId}`;

	let killedViewerSession = false;
	if (tmuxPath) {
		try {
			execFileSync(tmuxPath, ["kill-session", "-t", `=${viewerSession}`], {
				stdio: "ignore",
				timeout: 5000,
			});
			killedViewerSession = true;
		} catch (err) {
			const msg = (err as Error).message;
			if (!/can't find session|session not found|no server running/.test(msg)) {
				console.warn(`[tmux-viewer] kill viewer-session failed: ${msg}`);
			}
			// benign: viewer session already gone
		}
	}

	const target = formatViewTitle({
		sessionName: opts.baseSessionName,
		projectName: opts.projectName,
		executionId: opts.executionId,
		windowId: opts.windowId,
		sessionRole: opts.sessionRole,
	});
	const safe = escapeAppleScript(target);

	// Terminal.app's `tab` class does not accept the `close` command (only `window`
	// does — verified by qa-fly-116 against PR #167 Round 2). To close a tab, we
	// must close its parent window. To avoid taking down user-owned tabs that
	// may have been merged into the same window, we ONLY close when the parent
	// window has exactly one tab (the viewer). Multi-tab windows are skipped
	// with a warning.
	//
	// `saving no` suppresses Terminal's "process is still running" confirmation
	// dialog (the linked tmux attach is alive at this point and would otherwise
	// block the close).
	const script = [
		'tell application "Terminal"',
		`  set targetTitle to "${safe}"`,
		"  repeat with w in windows",
		"    repeat with t in tabs of w",
		"      try",
		"        if (custom title of t as text) is targetTitle then",
		"          if (count of tabs of w) is 1 then",
		"            close w saving no",
		'            return "closed"',
		"          else",
		'            return "skipped_multi_tab"',
		"          end if",
		"        end if",
		"      end try",
		"    end repeat",
		"  end repeat",
		'  return "not_found"',
		"end tell",
	].join("\n");

	return new Promise((resolve) => {
		execFile("osascript", ["-e", script], (err, stdout) => {
			if (err) {
				// ENOENT = osascript binary not installed (e.g. Linux CI / non-macOS).
				// Treat as benign — we can't close a macOS Terminal tab on Linux,
				// nothing to report as an actionable error.
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					resolve({ killedViewerSession, closedTab: false });
					return;
				}
				console.warn(`[tmux-viewer] close tab failed: ${err.message}`);
				resolve({
					killedViewerSession,
					closedTab: false,
					error: err.message,
				});
				return;
			}
			const out = stdout.trim();
			if (out === "skipped_multi_tab") {
				console.warn(
					`[tmux-viewer] viewer tab found inside a multi-tab window; skipping window close to avoid nuking user tabs (title=${target})`,
				);
			}
			resolve({
				killedViewerSession,
				closedTab: out === "closed",
			});
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Test-only exports (FLY-128) — used by tmux-viewer.concurrent.test.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FLY-128: returns the current opener queue Promise so tests can `await` until
 * all queued openers settle. NOT for production use.
 */
export function _drainTmuxViewerOpenQueueForTest(): Promise<void> {
	return openQueue;
}

/** FLY-128: inspect openingTitles for `finally` cleanup tests. NOT for production use. */
export function _hasOpeningTitleForTest(title: string): boolean {
	return openingTitles.has(title);
}

/**
 * FLY-128: reset module-level state between tests to prevent queue leakage.
 * NOT for production use.
 */
export function _resetTmuxViewerStateForTest(): void {
	openQueue = Promise.resolve();
	openingTitles.clear();
	cancelledExecutions.clear();
}
