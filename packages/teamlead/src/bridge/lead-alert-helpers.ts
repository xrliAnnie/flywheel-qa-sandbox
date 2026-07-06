/**
 * FLY-83: helpers that glue the Bridge-side watchdog/notifier to the
 * shell-owned alert infrastructure.
 *
 * - `createClaimsReader`: reads `~/.flywheel/alerts/claims.db` (written by
 *   `scripts/lead-alert.sh`) and returns the set of eventIds claimed in the
 *   last hour. Cross-process dedup lives here: if shell already claimed an
 *   eventId, Bridge skips the Discord POST.
 * - `createClaimsClaimer` (Fix 2): atomically claims an eventId by running
 *   `BEGIN IMMEDIATE + INSERT OR IGNORE + SELECT changes()` inside a single
 *   sqlite3 transaction against the SAME `claims.db` that
 *   `scripts/lead-alert.sh` writes. Returns true iff the row was inserted
 *   by this caller — race-safe across Bridge and shell processes.
 * - `createBlockedMarkerReader`: lists marker files under
 *   `~/.flywheel/blocked/`. Presence means claude-lead.sh supervisor has
 *   paused this Lead; watchdog goes Silent until Annie clears the marker.
 * - `defaultLeadPaneCapture`: `tmux capture-pane` against a resolved
 *   `@windowId` for LeadWatchdog's external observation loop.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ClaimsClaimer, ClaimsReader } from "../LeadAlertNotifier.js";
import type { CaptureFn } from "../LeadWatchdog.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CLAIMS_DB =
	process.env.FLYWHEEL_CLAIMS_DB ??
	join(homedir(), ".flywheel", "alerts", "claims.db");
const DEFAULT_BLOCKED_DIR =
	process.env.FLYWHEEL_BLOCKED_DIR ?? join(homedir(), ".flywheel", "blocked");
const DEFAULT_TMUX_SESSION = process.env.FLYWHEEL_TMUX_SESSION ?? "flywheel";

const CLAIMS_LOOKBACK_SECONDS = 3600;

/**
 * FLY-529: resolve the optional alert filesystem dir overrides from env, for
 * the QA Testing Room's alert mirror. The test Bridge sets these to slot-local
 * paths so its `LeadAlertNotifier` writes the alert queue / dead-letter under
 * `${SLOT_DIR}/` instead of the shared production `~/.flywheel/alert-queue|
 * alert-deadletter` — otherwise the live production Bridge's drainer picks up
 * test alerts and posts them (cross-pickup).
 *
 * Byte-compat contract: an UNSET (or whitespace-only) env yields `undefined`
 * for that field, so `LeadAlertNotifier`'s constructor keeps its existing
 * `?? join(homedir(), ".flywheel", ...)` default. With neither env set the
 * returned object is `{}` and production behavior is byte-identical.
 *
 * The claims.db path is NOT handled here — it is already env-overridable via
 * `FLYWHEEL_CLAIMS_DB` (see `DEFAULT_CLAIMS_DB` above), and the test Bridge sets
 * that directly.
 */
export function resolveAlertDirsFromEnv(
	env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { queueDir?: string; deadLetterDir?: string } {
	const out: { queueDir?: string; deadLetterDir?: string } = {};
	const queueDir = env.FLYWHEEL_ALERT_QUEUE_DIR?.trim();
	const deadLetterDir = env.FLYWHEEL_ALERT_DEADLETTER_DIR?.trim();
	if (queueDir) out.queueDir = queueDir;
	if (deadLetterDir) out.deadLetterDir = deadLetterDir;
	return out;
}

/**
 * Returns a ClaimsReader that reads eventIds claimed in the last hour from
 * `claims.db`. Missing DB / missing table → empty Set (caller treats as not
 * claimed and proceeds with Bridge-side dedup via StateStore).
 */
export function createClaimsReader(
	dbPath: string = DEFAULT_CLAIMS_DB,
): ClaimsReader {
	return async () => {
		const set = new Set<string>();
		try {
			const { stdout } = await execFileAsync(
				"sqlite3",
				[
					dbPath,
					`SELECT event_id FROM alert_claims WHERE claimed_at > strftime('%s','now') - ${CLAIMS_LOOKBACK_SECONDS};`,
				],
				{ encoding: "utf-8", timeout: 3000 },
			);
			for (const line of stdout.split("\n")) {
				const trimmed = line.trim();
				if (trimmed) set.add(trimmed);
			}
		} catch {
			// File not yet created, table missing, or sqlite3 unavailable.
			// Fall through — empty Set preserves availability over strict dedup.
		}
		return set;
	};
}

/**
 * Returns a ClaimsClaimer that atomically claims an `eventId` against the
 * shell-shared `claims.db`. Implementation matches `scripts/lead-alert.sh`
 * exactly:
 *
 *   BEGIN IMMEDIATE;
 *   INSERT OR IGNORE INTO alert_claims VALUES (?, ?, ?, strftime('%s','now'));
 *   SELECT changes();
 *   COMMIT;
 *
 * The `SELECT changes()` is read inside the SAME sqlite3 invocation so it
 * reflects the just-completed INSERT. On `1` we won the race; on `0` someone
 * else already claimed (could be another Bridge process or the shell path).
 * On any error (sqlite missing, DB locked beyond timeout, malformed args)
 * we return `null` so the caller can fall back to availability-over-strict
 * — preferring a duplicate alert to a silent failure.
 */
export function createClaimsClaimer(
	dbPath: string = DEFAULT_CLAIMS_DB,
): ClaimsClaimer {
	return async (eventId, leadId, kind) => {
		try {
			await mkdir(dirname(dbPath), { recursive: true });
		} catch {
			// Directory creation failure is non-fatal; sqlite3 will fail too and
			// we'll fall through to null below.
		}
		// SQL-injection-safe: bind eventId / leadId / kind as parameters via
		// `-cmd` would not return rows; instead we route through stdin so we
		// can include `BEGIN IMMEDIATE`, `INSERT OR IGNORE`, and `SELECT
		// changes()` in one transaction. Parameters are quoted with sqlite3's
		// `quote()` to escape single quotes safely.
		const sql = `
.timeout 5000
CREATE TABLE IF NOT EXISTS alert_claims (
  event_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
BEGIN IMMEDIATE;
INSERT OR IGNORE INTO alert_claims VALUES (
  ${sqlString(eventId)}, ${sqlString(leadId)}, ${sqlString(kind)}, strftime('%s','now')
);
SELECT changes();
COMMIT;
`;
		try {
			const stdout = await sqliteRunWithStdin(dbPath, sql, 5000);
			// Last non-empty line is `SELECT changes()` output: "1" if we won
			// the INSERT, "0" if the row already existed.
			const lines = stdout
				.split("\n")
				.map((s) => s.trim())
				.filter((s) => s);
			const last = lines[lines.length - 1];
			return last === "1";
		} catch {
			return null;
		}
	};
}

/**
 * Run a sqlite3 invocation with `sql` piped to stdin, returning stdout. We
 * use `spawn` instead of `execFileAsync` because Node's `execFile` doesn't
 * forward an `input` string into the child's stdin. A timer enforces the
 * timeout: SIGKILL on overrun, surfaces an Error so the caller can fall
 * through to "claim infra broken → null".
 */
function sqliteRunWithStdin(
	dbPath: string,
	sql: string,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("sqlite3", [dbPath], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`sqlite3 timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`sqlite3 exit ${code}: ${stderr.trim()}`));
			}
		});
		child.stdin.end(sql);
	});
}

/**
 * Single-quote escaping for sqlite3 string literals. Doubles any embedded
 * single quotes, then wraps the value in single quotes. Used in place of
 * parameter binding because we issue `BEGIN/INSERT/SELECT/COMMIT` over
 * stdin (single transaction).
 */
function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Returns a reader that enumerates marker files (e.g.
 * `cos-lead.login_expired.flag`) for the given leadId. The returned strings
 * are the *kind* portion (`login_expired`), matching AlertEventType names
 * written by `claude-lead.sh`.
 */
export function createBlockedMarkerReader(
	dirPath: string = DEFAULT_BLOCKED_DIR,
): (leadId: string) => Promise<string[]> {
	return async (leadId) => {
		try {
			const entries = await readdir(dirPath);
			const prefix = `${leadId}.`;
			const suffix = ".flag";
			const kinds: string[] = [];
			for (const entry of entries) {
				if (entry.startsWith(prefix) && entry.endsWith(suffix)) {
					kinds.push(entry.slice(prefix.length, entry.length - suffix.length));
				}
			}
			return kinds;
		} catch {
			return [];
		}
	};
}

/**
 * Default capture function for LeadWatchdog: shell-free `tmux capture-pane`
 * keyed by a resolved `@window_id` (from `LeadWindowLocator`). Window IDs
 * are globally unique in tmux, so the session prefix is omitted; if a user
 * overrides the session via env, it's preserved for callers that want
 * name-based targeting.
 */
export function defaultLeadPaneCapture(
	session: string = DEFAULT_TMUX_SESSION,
): CaptureFn {
	return async (windowId, lines) => {
		const target = windowId.startsWith("@")
			? windowId
			: `${session}:${windowId}`;
		const { stdout } = await execFileAsync(
			"tmux",
			["capture-pane", "-t", target, "-p", "-S", `-${lines}`],
			{ encoding: "utf-8", timeout: 5000 },
		);
		return stdout;
	};
}
