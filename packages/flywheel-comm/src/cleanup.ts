import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommDB } from "./db.js";
import type { Session } from "./types.js";

export interface CleanupOptions {
	/** CommDB file paths. If omitted, globs ~/.flywheel/comm/STAR/comm.db */
	dbPaths?: string[];
	/** Cleanup timeout in minutes. Default: 30 */
	timeoutMinutes?: number;
	/** Dry-run mode — log but don't kill */
	dryRun?: boolean;
	/** Log function */
	log?: (msg: string) => void;
}

export interface CleanupResult {
	/** Number of tmux windows killed */
	cleaned: number;
	/** Number of sessions skipped (not timed out, attached, or gone) */
	skipped: number;
	/** Non-fatal warnings (e.g. legacy DB without sessions table) */
	warnings: string[];
	/** Real errors (tmux/SQLite failures) */
	errors: string[];
}

/**
 * Clean up stale tmux windows from completed/timed-out runner sessions.
 *
 * Scans CommDB for sessions in terminal state (completed/timeout) whose
 * ended_at exceeds the timeout threshold. For each, checks if the tmux
 * session still exists and has no attached clients before killing the window.
 */
export function cleanupStaleSessions(opts?: CleanupOptions): CleanupResult {
	const timeoutMinutes = opts?.timeoutMinutes ?? 30;
	const dryRun = opts?.dryRun ?? false;
	const log = opts?.log ?? (() => {});

	const result: CleanupResult = {
		cleaned: 0,
		skipped: 0,
		warnings: [],
		errors: [],
	};

	// 1. Check if tmux server is running
	if (!isTmuxServerRunning()) {
		return result;
	}

	// 2. Determine DB paths
	const dbPaths = opts?.dbPaths ?? discoverCommDbs();

	// 3. Process each CommDB
	for (const dbPath of dbPaths) {
		if (!existsSync(dbPath)) {
			continue; // Expected empty state — no warning/error
		}

		let db: CommDB | undefined;
		try {
			db = CommDB.openReadonly(dbPath);
			const sessions = db.listSessions(undefined, [
				"completed",
				"timeout",
			]);

			for (const session of sessions) {
				processSession(session, timeoutMinutes, dryRun, log, result);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("no such table")) {
				result.warnings.push(`legacy DB (no sessions table): ${dbPath}`);
			} else {
				result.errors.push(`${dbPath}: ${msg}`);
			}
		} finally {
			db?.close();
		}
	}

	return result;
}

/** Discover all CommDB files under ~/.flywheel/comm/{project}/comm.db */
function discoverCommDbs(): string[] {
	const commDir = join(homedir(), ".flywheel", "comm");
	if (!existsSync(commDir)) return [];
	try {
		return readdirSync(commDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => join(commDir, d.name, "comm.db"))
			.filter((p) => existsSync(p));
	} catch {
		return [];
	}
}

function isTmuxServerRunning(): boolean {
	try {
		execFileSync("tmux", ["list-sessions"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function processSession(
	session: Session,
	timeoutMinutes: number,
	dryRun: boolean,
	log: (msg: string) => void,
	result: CleanupResult,
): void {
	// Skip sessions without ended_at
	if (!session.ended_at) {
		return;
	}

	// Check if session has exceeded the timeout
	const endedAtMs = Date.parse(session.ended_at + "Z");
	const elapsed = Date.now() - endedAtMs;
	if (elapsed < timeoutMinutes * 60_000) {
		result.skipped++;
		return;
	}

	const tmuxWindow = session.tmux_window;
	// tmux_window format: "sessionName:@windowId" (production) or bare "@id" (legacy test data)
	const colonIdx = tmuxWindow.indexOf(":");
	const sessionName = colonIdx >= 0 ? tmuxWindow.slice(0, colonIdx) : tmuxWindow;

	try {
		// Check if tmux session still exists
		try {
			execFileSync("tmux", ["has-session", "-t", `=${sessionName}`], {
				stdio: "pipe",
			});
		} catch {
			// Session doesn't exist — already cleaned up
			result.skipped++;
			return;
		}

		// Check if anyone is attached
		const clients = execFileSync(
			"tmux",
			[
				"list-clients",
				"-t",
				`=${sessionName}`,
				"-F",
				"#{client_session}",
			],
			{ encoding: "utf-8", stdio: "pipe" },
		).trim();

		if (clients.length > 0) {
			result.skipped++;
			return;
		}

		// Dry-run: log and skip
		if (dryRun) {
			log(
				`[dry-run] Would kill tmux window: ${tmuxWindow} (session: ${session.execution_id})`,
			);
			result.skipped++;
			return;
		}

		// Kill the tmux window
		execFileSync("tmux", ["kill-window", "-t", tmuxWindow], {
			stdio: "pipe",
		});
		log(`Killed stale tmux window: ${tmuxWindow} (session: ${session.execution_id})`);
		result.cleaned++;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// TOCTOU: session/window may have been cleaned between has-session and kill-window
		if (msg.includes("session") || msg.includes("window")) {
			result.skipped++;
		} else {
			result.errors.push(`Failed to clean ${tmuxWindow}: ${msg}`);
		}
	}
}
