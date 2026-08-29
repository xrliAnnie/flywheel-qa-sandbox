import Database from "better-sqlite3";

interface SessionRow {
	id: string;
	status: string;
	ts: string | null;
}

/**
 * Load the canonical completed-issue set from StateStore (~/.flywheel/teamlead.db).
 *
 * Canonical rule (Codex R2#4 / R3#1): an issue is "completed" iff the LATEST non-QA
 * session for that issue_identifier has status === 'completed'. `approved_to_ship` is
 * NOT terminal and is excluded. A newer retry (running/failed) flips an issue back out.
 *
 * Returns an empty set (with a warning) if the DB is missing, so reports still render.
 */
export function loadCompletedIssues(dbPath: string): Set<string> {
	let db: Database.Database;
	try {
		db = new Database(dbPath, { readonly: true, fileMustExist: true });
	} catch {
		console.warn(
			`[token-usage] StateStore not found at ${dbPath}; completed-issue set empty`,
		);
		return new Set();
	}
	try {
		const rows = db
			.prepare(
				`SELECT issue_identifier AS id, status, last_activity_at AS ts
				 FROM sessions
				 WHERE issue_identifier IS NOT NULL
				   AND (session_role IS NULL OR session_role != 'qa')
				 ORDER BY last_activity_at ASC`,
			)
			.all() as SessionRow[];
		const latest = new Map<string, string>();
		for (const r of rows) {
			if (!r.id) continue;
			latest.set(r.id.toUpperCase(), r.status); // ordered asc → last write wins = latest session
		}
		const set = new Set<string>();
		for (const [id, status] of latest) {
			if (status === "completed") set.add(id);
		}
		return set;
	} finally {
		db.close();
	}
}
