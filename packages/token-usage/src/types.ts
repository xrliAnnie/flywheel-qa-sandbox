/**
 * FLY-614 token-usage shared types.
 *
 * The whole pipeline is built around CC jsonl logs as the source of truth:
 * scan → classify (by cwd) → aggregate (daily × scope) → persist → render.
 */

/** Aggregation dimension for a stored daily row. */
export type Scope = "total" | "project" | "lead" | "issue" | "model";

/** What a CC session's working directory represents. */
export type EntityKind = "runner" | "main" | "lead" | "sandbox" | "other";

/** Result of classifying a CC log line's `cwd`. */
export interface Classification {
	kind: EntityKind;
	/** Product project (lowercase), e.g. "flywheel". null for lead/sandbox/other. */
	project: string | null;
	/** Issue identifier (uppercase), e.g. "FLY-614". Only for kind="runner" with an issue suffix. */
	issue: string | null;
	/** Runner role suffix, e.g. "qa". null when not present. */
	role: string | null;
	/** Display / grouping key: lead name, issue id, "(main)", or a non-Dev bucket label. */
	who: string;
}

/** One deduplicated assistant turn extracted from a CC jsonl log. */
export interface UsageRecord {
	requestId: string;
	cwd: string;
	gitBranch: string | null;
	model: string;
	/** Local report date (YYYY-MM-DD) derived from the UTC timestamp via TOKEN_USAGE_TIMEZONE. */
	day: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	kind: EntityKind;
	project: string | null;
	issue: string | null;
	leadWho: string | null;
}

/** One persisted daily aggregate row (mirrors the token_usage_daily table). */
export interface DailyRow {
	day: string;
	scope: Scope;
	/** "" for scope="total"; otherwise project/lead/issue/model name. */
	dimKey: string;
	/** Attribution project for lead/issue rows (enables nesting + per-project trend). */
	project: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** input + output + cacheRead + cacheWrite. */
	totalTokens: number;
	/** input + output + cacheWrite (cache-read excluded). */
	freshTokens: number;
	/** Relative "weight" only — NOT a real bill (subscription). Integer micro-USD. */
	costMicroUsd: number;
	/** Only meaningful for scope="issue"; render-time StateStore join is the source of truth. */
	isCompleted: boolean | null;
}

export interface QueryDailyOptions {
	/** Inclusive lower bound (YYYY-MM-DD). */
	since?: string;
	/** Inclusive upper bound (YYYY-MM-DD). */
	until?: string;
	scope?: Scope;
	project?: string;
}

/**
 * Persistence abstraction (data-access layer). Implemented by SupabaseUsageStore
 * (primary) and LocalSqliteUsageStore (fallback). Swapping storage = swap the impl.
 */
export interface UsageStore {
	/** Atomically replace ALL managed rows for a day (delete-then-insert in one transaction). */
	replaceDaily(day: string, rows: DailyRow[]): Promise<void>;
	/** Query stored daily rows by date range / scope / project. */
	queryDaily(opts?: QueryDailyOptions): Promise<DailyRow[]>;
	/** Optional resource cleanup (e.g. close the local DB handle). */
	close?(): void;
}

/** Single source tag in v1 (audit metadata; not part of the primary key). */
export const USAGE_SOURCE = "cc-jsonl";
