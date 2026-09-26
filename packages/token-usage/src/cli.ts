#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DISPLAY_ONLY_PROJECTS,
	loadKnownProjects,
	loadLeadProjectMap,
} from "./lead-project.js";
import { aggregateAndPersist, generateReport, todayInTz } from "./pipeline.js";
import { loadPricingConfigWithMeta } from "./pricing.js";
import { DEFAULT_TIMEZONE } from "./scanner.js";
import { LocalSqliteUsageStore, resolveUsageStore } from "./store/index.js";

interface Flags {
	[k: string]: string | boolean;
}

function parseFlags(argv: string[]): { cmd: string; flags: Flags } {
	const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "daily";
	const flags: Flags = {};
	const start = argv[0] && !argv[0].startsWith("--") ? 1 : 0;
	for (let i = start; i < argv.length; i++) {
		const a = argv[i];
		if (!a || !a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			flags[key] = next;
			i++;
		} else {
			flags[key] = true;
		}
	}
	return { cmd, flags };
}

function str(f: Flags, k: string): string | undefined {
	const v = f[k];
	return typeof v === "string" ? v : undefined;
}

/** Shift a YYYY-MM-DD day by `delta` days (UTC arithmetic on the civil date). */
function shiftDay(day: string, delta: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + delta);
	return d.toISOString().slice(0, 10);
}

export interface CmpWindow {
	since: string;
	until: string;
	label: string;
}
export interface Comparison {
	before: CmpWindow;
	after: CmpWindow;
}

/**
 * Strict YYYY-MM-DD parse. Rejects values JS `Date` would silently normalize
 * (e.g. `2026-02-31` → `2026-03-03`). Returns the canonical iso string or null.
 */
export function parseIsoDayStrict(s: string | undefined): string | null {
	if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
	const d = new Date(`${s}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString().slice(0, 10) === s ? s : null;
}

/** Parse a bounded positive-integer flag/env; warn + fall back to `def` when invalid. */
function boundedInt(
	raw: string | undefined,
	def: number,
	min: number,
	max: number,
	name: string,
): number {
	if (raw === undefined) return def;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min || n > max) {
		console.warn(
			`[token-usage] invalid ${name} "${raw}" — using ${def} (allowed ${min}..${max})`,
		);
		return def;
	}
	return n;
}

/**
 * Derive the before/after comparison windows for the report hero.
 * Precedence: explicit --before/--after > --rollout-date (flag > env) > week-over-week.
 * The week-over-week default is applied only when `defaultWeekOverWeek` is set (daily mode);
 * ad-hoc `report` gets a comparison only when flags/env request one.
 */
export function deriveComparison(
	reportDay: string,
	flags: Flags,
	env: Record<string, string | undefined>,
	opts: { defaultWeekOverWeek: boolean },
): Comparison | undefined {
	// 1. explicit windows win outright (both required to render a comparison).
	const explicitBefore = parseWindow(str(flags, "before"), "改动前");
	const explicitAfter = parseWindow(str(flags, "after"), "改动后");
	if (explicitBefore && explicitAfter) {
		return { before: explicitBefore, after: explicitAfter };
	}

	// 2. rollout anchor (ponytail-style fixed before/after). Flag overrides env.
	const rolloutRaw = str(flags, "rollout-date") ?? env.TOKEN_USAGE_ROLLOUT_DATE;
	if (rolloutRaw !== undefined) {
		const d = parseIsoDayStrict(rolloutRaw);
		if (!d) {
			console.warn(
				`[token-usage] invalid rollout date "${rolloutRaw}" — using week-over-week`,
			);
		} else if (d > reportDay) {
			console.warn(
				`[token-usage] rollout date ${d} is after report day ${reportDay} — using week-over-week`,
			);
		} else {
			const n = boundedInt(
				str(flags, "window") ?? env.TOKEN_USAGE_WINDOW_DAYS,
				7,
				1,
				90,
				"--window",
			);
			return {
				before: {
					since: shiftDay(d, -n),
					until: shiftDay(d, -1),
					label: "改动前",
				},
				after: { since: d, until: reportDay, label: "改动后" },
			};
		}
	}

	// 3. rolling week-over-week (daily default only).
	if (opts.defaultWeekOverWeek) {
		return {
			before: {
				since: shiftDay(reportDay, -13),
				until: shiftDay(reportDay, -7),
				label: "前一周",
			},
			after: {
				since: shiftDay(reportDay, -6),
				until: reportDay,
				label: "本周",
			},
		};
	}
	return undefined;
}

/**
 * Derive the daily aggregate window. The lower bound must reach every day the report
 * will render (Codex R1 HIGH-2): the backfill floor anchored on the *report day* plus
 * the comparison before/after starts — so a fallback store self-heals with no missing
 * comparison day. `until` is today so today's partial data is pre-aggregated.
 */
export function deriveAggregateWindow(
	today: string,
	reportDay: string,
	comparison: Comparison | undefined,
	flags: Flags,
	env: Record<string, string | undefined>,
): { since: string; until: string } {
	const backfillDays = boundedInt(
		str(flags, "backfill-days") ?? env.TOKEN_USAGE_BACKFILL_DAYS,
		14,
		1,
		90,
		"--backfill-days",
	);
	const candidates = [shiftDay(reportDay, -(backfillDays - 1))];
	if (comparison?.before.since) candidates.push(comparison.before.since);
	if (comparison?.after.since) candidates.push(comparison.after.since);
	const since = candidates.reduce((a, b) => (a < b ? a : b));
	return { since, until: today };
}

export interface ReportParams {
	reportDay: string;
	trendSince: string;
	comparison: Comparison | undefined;
	aggregateSince: string;
	aggregateUntil: string;
}

/** Resolve all report + aggregate parameters from the CLI flags (pure + testable). */
export function resolveReportParams(
	cmd: string,
	flags: Flags,
	env: Record<string, string | undefined>,
	today: string,
): ReportParams {
	// FLY-929 B1: `report-day` shares the daily semantics — it exists so the
	// shell pipeline can ask THIS CLI (the date authority, tz-aware) for the
	// expected report day instead of recomputing dates in bash.
	const reportDay =
		str(flags, "date") ??
		(cmd === "daily" || cmd === "report-day" ? shiftDay(today, -1) : today);
	const trendSince = str(flags, "trend-since") ?? shiftDay(reportDay, -27);
	const comparison = deriveComparison(reportDay, flags, env, {
		defaultWeekOverWeek: cmd === "daily",
	});
	const aggWin = deriveAggregateWindow(
		today,
		reportDay,
		comparison,
		flags,
		env,
	);
	return {
		reportDay,
		trendSince,
		comparison,
		aggregateSince: str(flags, "since") ?? aggWin.since,
		aggregateUntil: str(flags, "until") ?? aggWin.until,
	};
}

export async function main(
	argv: string[] = process.argv.slice(2),
): Promise<number> {
	const { cmd, flags } = parseFlags(argv);
	const tz =
		str(flags, "tz") ?? process.env.TOKEN_USAGE_TIMEZONE ?? DEFAULT_TIMEZONE;
	const home = os.homedir();
	const baseDir =
		str(flags, "base-dir") ?? path.join(home, ".claude", "projects");
	const localPath =
		str(flags, "db") ?? path.join(home, ".flywheel", "token-usage.db");
	const completedDbPath =
		str(flags, "completed-db") ?? path.join(home, ".flywheel", "teamlead.db");
	const today = todayInTz(tz);
	// Resolve report day, trend/comparison windows, and the rolling aggregate window
	// once, up front — the aggregate step must cover every day the report renders.
	const params = resolveReportParams(cmd, flags, process.env, today);

	// FLY-929 B1: `report-day` prints the resolved report day (daily semantics:
	// yesterday in the report tz, `--date` override honored) and exits — no
	// store access. token-usage-daily.sh feeds this to
	// `publish-report --expected-date` so the Bridge receipt carries the
	// CLI-authoritative date (Codex design R1#5: the Bridge never recomputes).
	if (cmd === "report-day") {
		process.stdout.write(`${params.reportDay}\n`);
		return 0;
	}

	const resolved = await resolveUsageStore({ localPath });
	if (resolved.warning) console.error(`[token-usage] ${resolved.warning}`);

	// When the primary is Supabase, keep a local store ready so a mid-run write
	// failure still lands the day somewhere (replayable via `sync`).
	const localFallback =
		resolved.mode === "supabase"
			? new LocalSqliteUsageStore(localPath)
			: undefined;

	try {
		if (cmd === "aggregate" || cmd === "daily") {
			// Rolling window (default 14 days, anchored on the report day + covering the
			// comparison windows) so the local fallback self-heals a full trend instead of
			// collapsing to today+yesterday. replaceDaily is idempotent per day; re-scanning
			// historical days re-aggregates from the same append-only CC logs (pricing uses
			// current rates — see FLY-713: rate changes only affect newly-aggregated days).
			const since = params.aggregateSince;
			const until = params.aggregateUntil;
			// Derive the lead→project map from the authoritative fleet config.
			const leadProjectMap = loadLeadProjectMap(str(flags, "projects-json"));
			// Load the (optionally configured) pricing table once; warnings → stderr.
			// `overrides` pins config-set models against date-effective rules.
			const { rates, overrides } = loadPricingConfigWithMeta({
				file: str(flags, "pricing-file"),
			});
			const { days, fallbackDays } = await aggregateAndPersist({
				baseDir,
				store: resolved.store,
				timeZone: tz,
				since,
				until,
				localFallback,
				leadProjectMap,
				rates,
				pinnedModels: overrides,
			});
			console.error(
				`[token-usage] aggregated + persisted ${days.length} day(s): ${days.join(", ")} (store=${resolved.mode})` +
					(fallbackDays.length
						? ` — ${fallbackDays.length} day(s) went to local fallback: ${fallbackDays.join(", ")}`
						: ""),
			);
		}

		if (cmd === "aggregate") return 0;

		// report / daily → generate (params resolved up front, incl. the before/after
		// comparison hero: week-over-week by default in daily mode, or a configurable
		// --rollout-date / TOKEN_USAGE_ROLLOUT_DATE anchor).
		// Canonical project list (projects.json) + display-only names (Polaris etc)
		// so every project shows, even at 0.
		const registered = loadKnownProjects(str(flags, "projects-json"));
		const displayOnlyProjects = [...DISPLAY_ONLY_PROJECTS];
		const knownProjects = [...registered, ...displayOnlyProjects];

		const gen = await generateReport({
			store: resolved.store,
			reportDay: params.reportDay,
			timeZone: tz,
			trendSince: params.trendSince,
			completedDbPath,
			before: params.comparison?.before,
			after: params.comparison?.after,
			storeMode: resolved.mode,
			warning: resolved.warning,
			localFallback,
			knownProjects,
			displayOnlyProjects,
		});

		const out = str(flags, "out");
		if (out) {
			writeFileSync(out, gen.html, "utf8");
			console.error(
				`[token-usage] wrote HTML report → ${out} (${Buffer.byteLength(gen.html, "utf8")} bytes)`,
			);
		}
		if (flags.json) {
			process.stdout.write(`${gen.json}\n`);
		} else if (!out) {
			process.stdout.write(`${gen.text}\n`);
		}
		return 0;
	} finally {
		resolved.store.close?.();
		localFallback?.close();
	}
}

/** Parse "YYYY-MM-DD..YYYY-MM-DD" into a labeled window. */
function parseWindow(
	spec: string | undefined,
	label: string,
): { since: string; until: string; label: string } | undefined {
	if (!spec) return undefined;
	const [since, until] = spec.split("..");
	if (!since || !until) return undefined;
	return { since, until, label };
}

// Auto-run only when invoked directly as the bin (not when imported as a library,
// e.g. by `flywheel-comm token-report`).
const invokedDirectly =
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(
				"[token-usage] fatal:",
				err instanceof Error ? err.message : err,
			);
			process.exit(1);
		});
}
