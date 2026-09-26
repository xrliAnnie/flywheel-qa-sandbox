import { createClient } from "@supabase/supabase-js";
import {
	type DailyRow,
	type QueryDailyOptions,
	USAGE_SOURCE,
	type UsageStore,
} from "../types.js";

/** Minimal structural type for the Supabase bits we use (keeps tests mockable). */
export interface SupabaseLike {
	rpc(
		fn: string,
		args: Record<string, unknown>,
	): PromiseLike<{ error: { message: string } | null }>;
	from(table: string): any;
}

function toJsonRow(r: DailyRow): Record<string, unknown> {
	return {
		scope: r.scope,
		dim_key: r.dimKey,
		project: r.project,
		input_tokens: r.inputTokens,
		output_tokens: r.outputTokens,
		cache_read_tokens: r.cacheReadTokens,
		cache_write_tokens: r.cacheWriteTokens,
		total_tokens: r.totalTokens,
		fresh_tokens: r.freshTokens,
		cost_micro_usd: r.costMicroUsd,
		is_completed: r.isCompleted,
	};
}

function fromDbRow(r: any): DailyRow {
	return {
		day: r.day,
		scope: r.scope,
		dimKey: r.dim_key ?? "",
		project: r.project ?? null,
		inputTokens: Number(r.input_tokens ?? 0),
		outputTokens: Number(r.output_tokens ?? 0),
		cacheReadTokens: Number(r.cache_read_tokens ?? 0),
		cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
		totalTokens: Number(r.total_tokens ?? 0),
		freshTokens: Number(r.fresh_tokens ?? 0),
		costMicroUsd: Number(r.cost_micro_usd ?? 0),
		isCompleted:
			r.is_completed === null || r.is_completed === undefined
				? null
				: Boolean(r.is_completed),
	};
}

/**
 * Primary store: Supabase Postgres. DDL (table/RLS/RPC) lives in
 * supabase/migrations/20260628_token_usage_daily.sql and is applied out-of-band;
 * this runtime only does DML and assumes the table + RPC exist.
 */
export class SupabaseUsageStore implements UsageStore {
	constructor(private client: SupabaseLike) {}

	/** Build from SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env, or null if absent. */
	static fromEnv(
		env: NodeJS.ProcessEnv = process.env,
	): SupabaseUsageStore | null {
		const url = env.SUPABASE_URL;
		const key = env.SUPABASE_SERVICE_ROLE_KEY;
		if (!url || !key) return null;
		return new SupabaseUsageStore(createClient(url, key));
	}

	async replaceDaily(day: string, rows: DailyRow[]): Promise<void> {
		// Atomic server-side delete-then-insert via the migration's Postgres function.
		const { error } = await this.client.rpc("replace_token_usage_daily", {
			p_day: day,
			p_source: USAGE_SOURCE,
			p_rows: rows.map(toJsonRow),
		});
		if (error)
			throw new Error(`supabase replaceDaily(${day}): ${error.message}`);
	}

	async queryDaily(opts: QueryDailyOptions = {}): Promise<DailyRow[]> {
		let q = this.client.from("token_usage_daily").select("*");
		if (opts.since) q = q.gte("day", opts.since);
		if (opts.until) q = q.lte("day", opts.until);
		if (opts.scope) q = q.eq("scope", opts.scope);
		if (opts.project) q = q.eq("project", opts.project);
		q = q.order("day");
		const { data, error } = await q;
		if (error) throw new Error(`supabase queryDaily: ${error.message}`);
		return ((data ?? []) as any[]).map(fromDbRow);
	}
}
