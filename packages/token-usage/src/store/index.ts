import type { UsageStore } from "../types.js";
import { LocalSqliteUsageStore } from "./local-sqlite-store.js";
import { SupabaseUsageStore } from "./supabase-store.js";

export { LocalSqliteUsageStore } from "./local-sqlite-store.js";
export { type SupabaseLike, SupabaseUsageStore } from "./supabase-store.js";

export type StoreMode = "supabase" | "local";

export interface ResolvedStore {
	store: UsageStore;
	mode: StoreMode;
	/** Human-facing note when running degraded (local-only). */
	warning?: string;
}

export interface ResolveStoreOptions {
	/** Path for the local SQLite fallback (e.g. ~/.flywheel/token-usage.db). */
	localPath: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the active store: Supabase when creds are present AND reachable, else the
 * local SQLite fallback (so the daily job never hard-fails). A loud warning is
 * surfaced when running local-only so reports never silently omit days.
 */
export async function resolveUsageStore(
	opts: ResolveStoreOptions,
): Promise<ResolvedStore> {
	const supa = SupabaseUsageStore.fromEnv(opts.env);
	if (supa) {
		try {
			// cheap reachability probe (empty range)
			await supa.queryDaily({ since: "9999-12-31", until: "9999-12-31" });
			return { store: supa, mode: "supabase" };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				store: new LocalSqliteUsageStore(opts.localPath),
				mode: "local",
				warning: `Supabase unreachable (${msg}); using local-only store at ${opts.localPath}`,
			};
		}
	}
	return {
		store: new LocalSqliteUsageStore(opts.localPath),
		mode: "local",
		warning: `Supabase creds absent (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY); using local-only store at ${opts.localPath}`,
	};
}

/**
 * Replay locally-buffered days to a remote store, then mark them synced.
 * Returns the list of days successfully synced.
 */
export async function syncLocalToRemote(
	local: LocalSqliteUsageStore,
	remote: UsageStore,
): Promise<string[]> {
	const synced: string[] = [];
	for (const day of local.pendingDays()) {
		const rows = await local.queryDaily({ since: day, until: day });
		await remote.replaceDaily(day, rows);
		local.markDaySynced(day);
		synced.push(day);
	}
	return synced;
}
