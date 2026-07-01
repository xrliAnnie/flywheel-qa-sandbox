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
			const since = str(flags, "since") ?? shiftDay(today, -1);
			const until = str(flags, "until") ?? today;
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

		// report / daily → generate
		const reportDay =
			str(flags, "date") ?? (cmd === "daily" ? shiftDay(today, -1) : today);
		const trendSince = str(flags, "trend-since") ?? shiftDay(reportDay, -27);
		const before = parseWindow(str(flags, "before"), "改动前");
		const after = parseWindow(str(flags, "after"), "改动后");
		// Canonical project list (projects.json) + display-only names (Polaris etc)
		// so every project shows, even at 0.
		const registered = loadKnownProjects(str(flags, "projects-json"));
		const displayOnlyProjects = [...DISPLAY_ONLY_PROJECTS];
		const knownProjects = [...registered, ...displayOnlyProjects];

		const gen = await generateReport({
			store: resolved.store,
			reportDay,
			timeZone: tz,
			trendSince,
			completedDbPath,
			before,
			after,
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
