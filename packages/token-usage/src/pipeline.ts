import { aggregateDaily } from "./aggregator.js";
import { loadCompletedIssues } from "./completion.js";
import type { ModelRate } from "./pricing.js";
import { buildReportModel, type ReportModel } from "./report/build-report.js";
import { renderReportHtml } from "./report/render-html.js";
import { renderReportText } from "./report/render-text.js";
import { DEFAULT_TIMEZONE, dayFromTimestamp, scanLogs } from "./scanner.js";
import type { DailyRow, UsageStore } from "./types.js";

/** Inclusive list of YYYY-MM-DD days from `since` to `until`. */
export function dateRange(since: string, until: string): string[] {
	const out: string[] = [];
	const d = new Date(`${since}T00:00:00Z`);
	const end = new Date(`${until}T00:00:00Z`);
	while (d <= end) {
		out.push(d.toISOString().slice(0, 10));
		d.setUTCDate(d.getUTCDate() + 1);
	}
	return out;
}

/** "Today" in the report timezone. */
export function todayInTz(tz: string = DEFAULT_TIMEZONE): string {
	return dayFromTimestamp(new Date().toISOString(), tz);
}

export interface AggregateOptions {
	baseDir: string;
	store: UsageStore;
	timeZone?: string;
	since: string;
	until: string;
	homeDir?: string;
	leadProjectMap?: Record<string, string>;
	/** Per-model pricing override (from `loadPricingConfig()`); defaults to the built-in table. */
	rates?: Record<string, ModelRate>;
	/** Config-overridden model ids, pinned against date-effective pricing (see ratesForDay). */
	pinnedModels?: ReadonlySet<string>;
	/**
	 * Optional secondary store written when a `store.replaceDaily` throws mid-run
	 * (e.g. Supabase passes the initial probe but the RPC fails later). Ensures a
	 * day never lands in neither store (Codex R1). Usually a LocalSqliteUsageStore.
	 * `markDaySynced` is called when a day later writes to the PRIMARY successfully,
	 * so a recovered day's stale fallback rows are no longer overlaid (Codex R3).
	 */
	localFallback?: UsageStore & { markDaySynced?: (day: string) => void };
}

/**
 * Scan logs for [since, until], aggregate, and persist each day via replaceDaily.
 * Every day in the window is replaced (even empty) so stale rows are cleared.
 */
export async function aggregateAndPersist(
	opts: AggregateOptions,
): Promise<{ days: string[]; fallbackDays: string[] }> {
	const records = await scanLogs(opts.baseDir, {
		timeZone: opts.timeZone,
		since: opts.since,
		until: opts.until,
		homeDir: opts.homeDir,
	});
	const rows = aggregateDaily(records, {
		leadProjectMap: opts.leadProjectMap,
		rates: opts.rates,
		pinnedModels: opts.pinnedModels,
	});
	const byDay = new Map<string, DailyRow[]>();
	for (const r of rows) {
		const list = byDay.get(r.day) ?? [];
		list.push(r);
		byDay.set(r.day, list);
	}
	const days = dateRange(opts.since, opts.until);
	const fallbackDays: string[] = [];
	for (const day of days) {
		const dayRows = byDay.get(day) ?? [];
		try {
			await opts.store.replaceDaily(day, dayRows);
			// Primary now has the truth for this day → drop any stale fallback-pending
			// marker for it so a recovered day isn't overlaid from the local fallback (Codex R3).
			opts.localFallback?.markDaySynced?.(day);
		} catch (err) {
			if (!opts.localFallback) throw err;
			// Primary write failed mid-run → persist to local fallback so the day is
			// never lost (replayable later via syncLocalToRemote).
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				`[token-usage] primary store failed for ${day} (${msg}); wrote local fallback`,
			);
			await opts.localFallback.replaceDaily(day, dayRows);
			fallbackDays.push(day);
		}
	}
	return { days, fallbackDays };
}

export interface GenerateOptions {
	store: UsageStore;
	reportDay: string;
	timeZone?: string;
	trendSince?: string;
	completedDbPath: string;
	before?: { since: string; until: string; label: string };
	after?: { since: string; until: string; label: string };
	storeMode?: "supabase" | "local";
	warning?: string;
	/** Canonical known project names (from projects.json) — listed even with 0 usage. */
	knownProjects?: string[];
	/** Subset of knownProjects that are display-only (not registered) → tagged 未立项. */
	displayOnlyProjects?: string[];
	/**
	 * Local fallback store (when primary=Supabase). Any of its still-unsynced days that
	 * fall in the report window override the primary's rows for those days, so a day that
	 * failed to write to Supabase isn't rendered as missing/stale (Codex R2). A warning
	 * names the merged days.
	 */
	localFallback?: {
		queryDaily: UsageStore["queryDaily"];
		pendingDays(): string[];
	};
}

export interface GeneratedReport {
	model: ReportModel;
	html: string;
	text: string;
	json: string;
}

/** Build the report model from the store + StateStore completion, and render all formats. */
export async function generateReport(
	opts: GenerateOptions,
): Promise<GeneratedReport> {
	const tz = opts.timeZone ?? DEFAULT_TIMEZONE;
	const lowerBounds = [
		opts.reportDay,
		opts.trendSince,
		opts.before?.since,
		opts.after?.since,
	].filter((x): x is string => Boolean(x));
	const since = lowerBounds.reduce((a, b) => (a < b ? a : b), opts.reportDay);
	let rows = await opts.store.queryDaily({ since, until: opts.reportDay });
	let warning = opts.warning;

	// Merge in any unsynced local-fallback days that fall in the window, so a day that
	// failed to reach Supabase is not rendered as missing/stale (Codex R2).
	if (opts.localFallback) {
		const pend = opts.localFallback
			.pendingDays()
			.filter((d) => d >= since && d <= opts.reportDay);
		if (pend.length > 0) {
			const pendSet = new Set(pend);
			const localRows = await opts.localFallback.queryDaily({
				since,
				until: opts.reportDay,
			});
			rows = rows
				.filter((r) => !pendSet.has(r.day))
				.concat(localRows.filter((r) => pendSet.has(r.day)));
			const note = `本地 fallback 未同步天数已并入报告（Supabase 暂缺）: ${pend.join(", ")}`;
			warning = warning ? `${warning}; ${note}` : note;
		}
	}

	const completed = loadCompletedIssues(opts.completedDbPath);
	const model = buildReportModel(rows, {
		reportDay: opts.reportDay,
		timezone: tz,
		isCompleted: (id) => completed.has(id.toUpperCase()),
		trendSince: opts.trendSince,
		before: opts.before,
		after: opts.after,
		storeMode: opts.storeMode,
		warning,
		knownProjects: opts.knownProjects,
		displayOnlyProjects: opts.displayOnlyProjects,
	});
	return {
		model,
		html: renderReportHtml(model),
		text: renderReportText(model),
		json: JSON.stringify(model, null, 2),
	};
}
