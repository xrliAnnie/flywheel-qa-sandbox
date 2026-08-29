import Database from "better-sqlite3";
import {
	type DailyRow,
	type QueryDailyOptions,
	USAGE_SOURCE,
	type UsageStore,
} from "../types.js";

interface DbRow {
	day: string;
	scope: string;
	dim_key: string;
	project: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	fresh_tokens: number;
	cost_micro_usd: number;
	is_completed: number | null;
	sync_status: string;
}

function toDailyRow(r: DbRow): DailyRow {
	return {
		day: r.day,
		scope: r.scope as DailyRow["scope"],
		dimKey: r.dim_key,
		project: r.project,
		inputTokens: r.input_tokens,
		outputTokens: r.output_tokens,
		cacheReadTokens: r.cache_read_tokens,
		cacheWriteTokens: r.cache_write_tokens,
		totalTokens: r.total_tokens,
		freshTokens: r.fresh_tokens,
		costMicroUsd: r.cost_micro_usd,
		isCompleted: r.is_completed === null ? null : r.is_completed === 1,
	};
}

/**
 * Local SQLite fallback store. Used when Supabase is unavailable so the daily job
 * never fails; rows carry `sync_status` so they can be replayed to Supabase later.
 */
export class LocalSqliteUsageStore implements UsageStore {
	private db: Database.Database;

	/** @param filename path to the db file, or ":memory:" for tests. */
	constructor(filename: string) {
		this.db = new Database(filename);
		this.db.pragma("journal_mode = WAL");
		this.migrate();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS token_usage_daily (
				day TEXT NOT NULL,
				scope TEXT NOT NULL,
				dim_key TEXT NOT NULL DEFAULT '',
				project TEXT,
				input_tokens INTEGER NOT NULL DEFAULT 0,
				output_tokens INTEGER NOT NULL DEFAULT 0,
				cache_read_tokens INTEGER NOT NULL DEFAULT 0,
				cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				total_tokens INTEGER NOT NULL DEFAULT 0,
				fresh_tokens INTEGER NOT NULL DEFAULT 0,
				cost_micro_usd INTEGER NOT NULL DEFAULT 0,
				is_completed INTEGER,
				source TEXT NOT NULL DEFAULT 'cc-jsonl',
				sync_status TEXT NOT NULL DEFAULT 'pending',
				updated_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (day, scope, dim_key)
			);
			CREATE INDEX IF NOT EXISTS idx_tud_day ON token_usage_daily(day);
			CREATE INDEX IF NOT EXISTS idx_tud_scope_proj ON token_usage_daily(scope, project);
			-- Tracks days written locally but not yet synced to Supabase. A day is recorded
			-- here even when replaced with ZERO rows, so an empty-day replacement (which must
			-- clear stale remote rows) is still replayed by syncLocalToRemote (Codex R1).
			CREATE TABLE IF NOT EXISTS token_usage_pending_days (day TEXT PRIMARY KEY);
		`);
	}

	async replaceDaily(day: string, rows: DailyRow[]): Promise<void> {
		const del = this.db.prepare(
			"DELETE FROM token_usage_daily WHERE day = ? AND source = ?",
		);
		const ins = this.db.prepare(`
			INSERT INTO token_usage_daily
				(day, scope, dim_key, project, input_tokens, output_tokens, cache_read_tokens,
				 cache_write_tokens, total_tokens, fresh_tokens, cost_micro_usd, is_completed, source, sync_status)
			VALUES (@day, @scope, @dim_key, @project, @input, @output, @cacheRead, @cacheWrite,
				 @total, @fresh, @cost, @isCompleted, @source, 'pending')
		`);
		const markPending = this.db.prepare(
			"INSERT OR REPLACE INTO token_usage_pending_days (day) VALUES (?)",
		);
		const tx = this.db.transaction((batch: DailyRow[]) => {
			del.run(day, USAGE_SOURCE);
			markPending.run(day); // record even for empty batches so the day is replayed
			for (const r of batch) {
				ins.run({
					day: r.day,
					scope: r.scope,
					dim_key: r.dimKey,
					project: r.project,
					input: r.inputTokens,
					output: r.outputTokens,
					cacheRead: r.cacheReadTokens,
					cacheWrite: r.cacheWriteTokens,
					total: r.totalTokens,
					fresh: r.freshTokens,
					cost: r.costMicroUsd,
					isCompleted: r.isCompleted === null ? null : r.isCompleted ? 1 : 0,
					source: USAGE_SOURCE,
				});
			}
		});
		tx(rows); // throws → whole transaction rolls back (delete included)
	}

	async queryDaily(opts: QueryDailyOptions = {}): Promise<DailyRow[]> {
		const where: string[] = [];
		const params: Record<string, unknown> = {};
		if (opts.since) {
			where.push("day >= @since");
			params.since = opts.since;
		}
		if (opts.until) {
			where.push("day <= @until");
			params.until = opts.until;
		}
		if (opts.scope) {
			where.push("scope = @scope");
			params.scope = opts.scope;
		}
		if (opts.project) {
			where.push("project = @project");
			params.project = opts.project;
		}
		const sql = `SELECT * FROM token_usage_daily${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY day, scope, dim_key`;
		const rows = this.db.prepare(sql).all(params) as DbRow[];
		return Promise.resolve(rows.map(toDailyRow));
	}

	/**
	 * Days written locally but not yet synced to Supabase (incl. empty-day replacements).
	 * Sourced from token_usage_pending_days so a zero-row day is still replayed.
	 */
	pendingDays(): string[] {
		const rows = this.db
			.prepare("SELECT day FROM token_usage_pending_days ORDER BY day")
			.all() as { day: string }[];
		return rows.map((r) => r.day);
	}

	markDaySynced(day: string): void {
		const tx = this.db.transaction((d: string) => {
			this.db
				.prepare(
					"UPDATE token_usage_daily SET sync_status = 'synced' WHERE day = ?",
				)
				.run(d);
			this.db
				.prepare("DELETE FROM token_usage_pending_days WHERE day = ?")
				.run(d);
		});
		tx(day);
	}

	close(): void {
		this.db.close();
	}
}
