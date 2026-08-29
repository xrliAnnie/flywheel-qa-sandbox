import type { DailyRow } from "../types.js";

export interface LeadEntry {
	name: string;
	tokens: number;
	cost: number;
}
export interface IssueEntry {
	id: string;
	tokens: number;
	cost: number;
}
export interface ProjectEntry {
	name: string;
	/** Project total = own runner+main + its owned leads (1:1, no double-count). */
	tokens: number;
	cost: number;
	runnerMainTokens: number;
	leads: LeadEntry[];
	/** Completed issues active on the report day (per-day usage). */
	issues: IssueEntry[];
	inprogCount: number;
	inprogTokens: number;
	/** True for display-only projects not yet registered in projects.json (shown 0). */
	unregistered?: boolean;
}
export interface TrendPoint {
	day: string;
	tokens: number;
	/** Estimated cost (micro-USD) for that day. */
	cost: number;
}
export interface WindowAgg {
	label: string;
	days: number;
	avgTokens: number;
	avgCost: number;
	byModel: Record<string, number>;
}
export interface ReportModel {
	reportDay: string;
	timezone: string;
	total: {
		tokens: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
	projects: ProjectEntry[];
	leadsAll: LeadEntry[];
	models: { name: string; tokens: number; cost: number }[];
	trendTotal: TrendPoint[];
	trendByProject: { project: string; points: TrendPoint[] }[];
	comparison?: { before: WindowAgg; after: WindowAgg };
	storeMode?: "supabase" | "local";
	warning?: string;
}

export interface BuildReportOptions {
	reportDay: string;
	timezone: string;
	/** Render-time completion check (StateStore: latest non-QA lifecycle status === 'completed'). */
	isCompleted: (issueId: string) => boolean;
	/** Trend window lower bound (YYYY-MM-DD). Defaults to reportDay. */
	trendSince?: string;
	topProjects?: number;
	/**
	 * Canonical list of known project names (e.g. from the fleet `projects.json`).
	 * Any that have no usage on the report day are still listed (with 0) so the
	 * report shows every project, not only the ones that happened to run.
	 */
	knownProjects?: string[];
	/**
	 * Subset of `knownProjects` that are display-only (recognized but not yet
	 * registered in projects.json). Padded 0-entries for these are flagged
	 * `unregistered` so the report can tag them "(未立项)".
	 */
	displayOnlyProjects?: string[];
	before?: { since: string; until: string; label: string };
	after?: { since: string; until: string; label: string };
	storeMode?: "supabase" | "local";
	warning?: string;
}

const TREND_TOP_DEFAULT = 5;

/** Assemble the daily report view model from stored daily rows. Pure + testable. */
export function buildReportModel(
	rows: DailyRow[],
	opts: BuildReportOptions,
): ReportModel {
	const day = opts.reportDay;
	const dayRows = rows.filter((r) => r.day === day);
	const totalRow = dayRows.find((r) => r.scope === "total");

	const projScope = dayRows.filter((r) => r.scope === "project");
	const leadScope = dayRows.filter((r) => r.scope === "lead");
	const issueScope = dayRows.filter((r) => r.scope === "issue");
	const modelScope = dayRows.filter((r) => r.scope === "model");

	const projectNames = new Set<string>();
	for (const r of projScope) projectNames.add(r.dimKey);
	for (const r of leadScope) if (r.project) projectNames.add(r.project);
	for (const r of issueScope) if (r.project) projectNames.add(r.project);

	const projects: ProjectEntry[] = [];
	for (const name of projectNames) {
		const own = projScope.find((r) => r.dimKey === name);
		const runnerMain = own?.totalTokens ?? 0;
		const leadRows = leadScope.filter((r) => r.project === name);
		const leads: LeadEntry[] = leadRows
			.map((r) => ({
				name: r.dimKey,
				tokens: r.totalTokens,
				cost: r.costMicroUsd,
			}))
			.sort((a, b) => b.tokens - a.tokens);
		const leadTokens = leadRows.reduce((s, r) => s + r.totalTokens, 0);
		const leadCost = leadRows.reduce((s, r) => s + r.costMicroUsd, 0);

		const projIssues = issueScope.filter((r) => r.project === name);
		const issues: IssueEntry[] = projIssues
			.filter((r) => opts.isCompleted(r.dimKey))
			.map((r) => ({
				id: r.dimKey,
				tokens: r.totalTokens,
				cost: r.costMicroUsd,
			}))
			.sort((a, b) => b.tokens - a.tokens);
		const inprog = projIssues.filter((r) => !opts.isCompleted(r.dimKey));

		projects.push({
			name,
			tokens: runnerMain + leadTokens,
			cost: (own?.costMicroUsd ?? 0) + leadCost,
			runnerMainTokens: runnerMain,
			leads,
			issues,
			inprogCount: inprog.length,
			inprogTokens: inprog.reduce((s, r) => s + r.totalTokens, 0),
		});
	}
	projects.sort((a, b) => b.tokens - a.tokens);

	// Pad with known projects that had NO usage on the report day (show 0), so the
	// report always lists every known project, not just the ones that happened to run.
	if (opts.knownProjects?.length) {
		const present = new Set(projects.map((p) => p.name));
		const displayOnly = new Set(opts.displayOnlyProjects ?? []);
		for (const name of opts.knownProjects) {
			if (present.has(name)) continue;
			projects.push({
				name,
				tokens: 0,
				cost: 0,
				runnerMainTokens: 0,
				leads: [],
				issues: [],
				inprogCount: 0,
				inprogTokens: 0,
				unregistered: displayOnly.has(name),
			});
		}
	}

	const leadsAll: LeadEntry[] = leadScope
		.map((r) => ({
			name: r.dimKey,
			tokens: r.totalTokens,
			cost: r.costMicroUsd,
		}))
		.sort((a, b) => b.tokens - a.tokens);

	const models = modelScope
		.map((r) => ({
			name: r.dimKey,
			tokens: r.totalTokens,
			cost: r.costMicroUsd,
		}))
		.sort((a, b) => b.tokens - a.tokens);

	// trends
	const since = opts.trendSince ?? day;
	const inWindow = (d: string) => d >= since && d <= day;
	const totalByDay = new Map<string, number>();
	const totalCostByDay = new Map<string, number>();
	for (const r of rows) {
		if (r.scope === "total" && inWindow(r.day)) {
			totalByDay.set(r.day, r.totalTokens);
			totalCostByDay.set(r.day, r.costMicroUsd);
		}
	}
	const trendDays = [...totalByDay.keys()].sort();
	const trendTotal: TrendPoint[] = trendDays.map((d) => ({
		day: d,
		tokens: totalByDay.get(d) ?? 0,
		cost: totalCostByDay.get(d) ?? 0,
	}));

	// per-project trend = project-scope + its lead rows, per day (tokens + cost)
	const topN = opts.topProjects ?? TREND_TOP_DEFAULT;
	const topProjectNames = projects
		.filter((p) => p.tokens > 0)
		.slice(0, topN)
		.map((p) => p.name);
	const projDay = new Map<string, Map<string, { tok: number; cost: number }>>(); // project -> day -> {tok,cost}
	const bump = (proj: string, d: string, tok: number, cost: number) => {
		let m = projDay.get(proj);
		if (!m) {
			m = new Map();
			projDay.set(proj, m);
		}
		const cur = m.get(d) ?? { tok: 0, cost: 0 };
		cur.tok += tok;
		cur.cost += cost;
		m.set(d, cur);
	};
	for (const r of rows) {
		if (!inWindow(r.day)) continue;
		if (r.scope === "project")
			bump(r.dimKey, r.day, r.totalTokens, r.costMicroUsd);
		else if (r.scope === "lead" && r.project)
			bump(r.project, r.day, r.totalTokens, r.costMicroUsd);
	}
	const trendByProject = topProjectNames.map((proj) => ({
		project: proj,
		points: trendDays.map((d) => ({
			day: d,
			tokens: projDay.get(proj)?.get(d)?.tok ?? 0,
			cost: projDay.get(proj)?.get(d)?.cost ?? 0,
		})),
	}));

	const model: ReportModel = {
		reportDay: day,
		timezone: opts.timezone,
		total: {
			tokens: totalRow?.totalTokens ?? 0,
			input: totalRow?.inputTokens ?? 0,
			output: totalRow?.outputTokens ?? 0,
			cacheRead: totalRow?.cacheReadTokens ?? 0,
			cacheWrite: totalRow?.cacheWriteTokens ?? 0,
			cost: totalRow?.costMicroUsd ?? 0,
		},
		projects,
		leadsAll,
		models,
		trendTotal,
		trendByProject,
		storeMode: opts.storeMode,
		warning: opts.warning,
	};

	if (opts.before && opts.after) {
		model.comparison = {
			before: windowAgg(
				rows,
				opts.before.since,
				opts.before.until,
				opts.before.label,
			),
			after: windowAgg(
				rows,
				opts.after.since,
				opts.after.until,
				opts.after.label,
			),
		};
	}
	return model;
}

/** Average daily tokens/cost + by-model totals over an inclusive day window. */
export function windowAgg(
	rows: DailyRow[],
	since: string,
	until: string,
	label: string,
): WindowAgg {
	const totalDays = new Set<string>();
	let tok = 0;
	let cost = 0;
	const byModel: Record<string, number> = {};
	for (const r of rows) {
		if (r.day < since || r.day > until) continue;
		if (r.scope === "total") {
			totalDays.add(r.day);
			tok += r.totalTokens;
			cost += r.costMicroUsd;
		} else if (r.scope === "model") {
			byModel[r.dimKey] = (byModel[r.dimKey] ?? 0) + r.totalTokens;
		}
	}
	const n = Math.max(totalDays.size, 1);
	return {
		label,
		days: totalDays.size,
		avgTokens: tok / n,
		avgCost: cost / n,
		byModel,
	};
}
