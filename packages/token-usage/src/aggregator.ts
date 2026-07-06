import { resolveLeadProject } from "./lead-project.js";
import {
	costMicroUsd,
	MODEL_RATES,
	type ModelRate,
	ratesForDay,
} from "./pricing.js";
import type { DailyRow, Scope, UsageRecord } from "./types.js";

interface Acc {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	project: string | null;
}

function emptyAcc(project: string | null): Acc {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, project };
}

function add(a: Acc, r: UsageRecord, cost: number): void {
	a.input += r.inputTokens;
	a.output += r.outputTokens;
	a.cacheRead += r.cacheReadTokens;
	a.cacheWrite += r.cacheWriteTokens;
	a.cost += cost;
}

function toRow(day: string, scope: Scope, dimKey: string, a: Acc): DailyRow {
	const total = a.input + a.output + a.cacheRead + a.cacheWrite;
	const fresh = a.input + a.output + a.cacheWrite;
	return {
		day,
		scope,
		dimKey,
		project: a.project,
		inputTokens: a.input,
		outputTokens: a.output,
		cacheReadTokens: a.cacheRead,
		cacheWriteTokens: a.cacheWrite,
		totalTokens: total,
		freshTokens: fresh,
		costMicroUsd: a.cost,
		isCompleted: null,
	};
}

export interface AggregateOptions {
	leadProjectMap?: Record<string, string>;
	/**
	 * Per-model pricing table for cost estimation. Defaults to the built-in
	 * `MODEL_RATES`; pass a `loadPricingConfig()` result to apply a configured
	 * override. Cost is computed here (per record, by model) and stored in each
	 * `DailyRow.costMicroUsd`, so a rate change only affects newly aggregated days.
	 */
	rates?: Record<string, ModelRate>;
	/**
	 * Models explicitly overridden via config (from `loadPricingConfigWithMeta`).
	 * These are pinned against date-effective pricing rules — see `ratesForDay`.
	 */
	pinnedModels?: ReadonlySet<string>;
}

/**
 * Aggregate deduplicated UsageRecords into flat daily scope rows for storage.
 *
 * Scopes are stored SEPARATELY (single-source aggregates):
 *  - total   : whole-fleet per day
 *  - project : runner + main per project (Leads are NOT folded here — render folds them)
 *  - lead    : per lead, attributed to its owning project (1:1)
 *  - issue   : per issue (ALL issues; completion is applied at render time), with project
 *  - model   : per model
 * Sandbox / other-bucket records contribute to `total` only (so the grand total reconciles)
 * but are not attributed to a product project.
 */
export function aggregateDaily(
	records: UsageRecord[],
	opts: AggregateOptions = {},
): DailyRow[] {
	// day -> scope -> key -> Acc
	const days = new Map<
		string,
		{
			total: Acc;
			project: Map<string, Acc>;
			lead: Map<string, Acc>;
			issue: Map<string, Acc>;
			model: Map<string, Acc>;
		}
	>();

	const dayOf = (d: string) => {
		let g = days.get(d);
		if (!g) {
			g = {
				total: emptyAcc(null),
				project: new Map(),
				lead: new Map(),
				issue: new Map(),
				model: new Map(),
			};
			days.set(d, g);
		}
		return g;
	};
	const bucket = (m: Map<string, Acc>, key: string, project: string | null) => {
		let a = m.get(key);
		if (!a) {
			a = emptyAcc(project);
			m.set(key, a);
		}
		return a;
	};

	const rates = opts.rates ?? MODEL_RATES;
	for (const r of records) {
		// Price by the rate effective ON the record's day (date-aware, e.g. Sonnet 5);
		// config-pinned models keep their configured rate for every day.
		const cost = costMicroUsd(
			r.model,
			r,
			ratesForDay(r.day, rates, opts.pinnedModels),
		);
		const g = dayOf(r.day);
		add(g.total, r, cost);
		if (r.model && r.model !== "<synthetic>" && r.model !== "?") {
			add(bucket(g.model, r.model, null), r, cost);
		}
		if ((r.kind === "runner" || r.kind === "main") && r.project) {
			add(bucket(g.project, r.project, r.project), r, cost);
			if (r.kind === "runner" && r.issue) {
				add(bucket(g.issue, r.issue, r.project), r, cost);
			}
		} else if (r.kind === "lead" && r.leadWho) {
			const proj = resolveLeadProject(r.leadWho, opts.leadProjectMap);
			add(bucket(g.lead, r.leadWho, proj), r, cost);
		} else if (r.kind === "sandbox") {
			// Surface (not hide) sandbox/test-slot usage as its own bucket so the
			// report can show excluded totals + validate attribution coverage (Codex R1).
			add(bucket(g.project, "(sandbox)", "(sandbox)"), r, cost);
		} else {
			// kind === "other": non-Dev / unknown cwds — bucketed, never silently dropped.
			add(bucket(g.project, "(unattributed)", "(unattributed)"), r, cost);
		}
	}

	const rows: DailyRow[] = [];
	for (const [day, g] of days) {
		rows.push(toRow(day, "total", "", g.total));
		for (const [k, a] of g.project) rows.push(toRow(day, "project", k, a));
		for (const [k, a] of g.lead) rows.push(toRow(day, "lead", k, a));
		for (const [k, a] of g.issue) rows.push(toRow(day, "issue", k, a));
		for (const [k, a] of g.model) rows.push(toRow(day, "model", k, a));
	}
	return rows;
}
