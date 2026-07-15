/**
 * FLY-245 D2 / Codex code-review R1 HIGH-3 — durable launch claim keyed by
 * execution id.
 *
 * The in-memory `inflight` map in RunDispatcher dedups only WITHIN one Bridge
 * process. After a Bridge crash, a gateway retry replays the SAME pre-bound
 * successor execId; with an empty inflight map the dispatcher would call
 * `Blueprint.run()` AGAIN — removing/recreating the issue worktree and opening a
 * SECOND `tmux new-window` — so one request could start TWO real Runners.
 *
 * This store is the DURABLE, cross-restart find-or-create key:
 *   - `claim(execId)` is an atomic INSERT-OR-IGNORE: the FIRST caller gets
 *     `"claimed"`, every later caller (including after a restart) gets
 *     `"exists"`;
 *   - once the launch reaches a live tmux window, `recordWindow(execId, window)`
 *     persists it, so a replay can probe liveness: a LIVE window means a Runner
 *     is already running → the dispatcher returns the existing execution and
 *     never starts a second; a dead/absent window means the prior attempt never
 *     reached a live Runner → re-driving the SAME execId is safe (FLY-99
 *     pre-create cleanup converges the worktree/branch).
 *
 * Only the gateway pre-bound retry path uses this (legacy self-UUID retries are
 * byte-unchanged). better-sqlite3, same dependency policy as the other stores.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface LaunchClaim {
	execution_id: string;
	tmux_window: string | null;
	claimed_at: number;
}

export class LaunchClaimStore {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(
			`CREATE TABLE IF NOT EXISTS launch_claims (
				execution_id TEXT PRIMARY KEY,
				tmux_window  TEXT,
				claimed_at   INTEGER NOT NULL
			)`,
		);
	}

	/**
	 * Atomically claim a launch for `execId`. Returns `"claimed"` iff THIS call
	 * inserted the row (it is the first/owning attempt); `"exists"` if a prior
	 * attempt — in this process or a previous one before a crash — already
	 * claimed it. The INSERT OR IGNORE + `changes` check is the serialization
	 * point: two concurrent claims can never both win.
	 */
	claim(execId: string, nowMs: number): "claimed" | "exists" {
		const info = this.db
			.prepare(
				"INSERT OR IGNORE INTO launch_claims (execution_id, tmux_window, claimed_at) VALUES (?, NULL, ?)",
			)
			.run(execId, nowMs);
		return info.changes === 1 ? "claimed" : "exists";
	}

	/**
	 * Persist the live tmux window for a claimed launch. THROWS if the write did
	 * not update exactly one row (Codex R3 HIGH-3): the caller (the adapter, right
	 * after `tmux new-window`) treats a failed/zero-row bind as fatal — it kills
	 * the just-opened window and aborts the launch rather than leaving a live but
	 * UNTRACKED Runner that a replay would re-drive into a second one.
	 */
	recordWindow(execId: string, tmuxWindow: string): void {
		const info = this.db
			.prepare(
				"UPDATE launch_claims SET tmux_window = ? WHERE execution_id = ?",
			)
			.run(tmuxWindow, execId);
		if (info.changes !== 1) {
			throw new Error(
				`launch-claim recordWindow updated ${info.changes} rows for ${execId} (expected 1) — claim row missing`,
			);
		}
	}

	getClaim(execId: string): LaunchClaim | undefined {
		return this.db
			.prepare("SELECT * FROM launch_claims WHERE execution_id = ?")
			.get(execId) as LaunchClaim | undefined;
	}

	close(): void {
		this.db.close();
	}
}
