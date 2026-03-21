/**
 * CipherReader — read-only access to cipher.db for the edge-worker process.
 * Opens the db file on each call (atomic file publish means we always read
 * a consistent snapshot written by CipherWriter).
 */

import { existsSync, readFileSync } from "node:fs";
import initSqlJs from "sql.js";
import { extractDimensions } from "./dimensions.js";
import { generatePatternKeys, getFallbackOrder } from "./pattern-keys.js";
import {
	posteriorMean,
	shouldInjectPattern,
	wilsonLowerBound,
} from "./statistics.js";
import type {
	CipherContext,
	PatternStatistics,
	SnapshotInputDto,
} from "./types.js";

export class CipherReader {
	constructor(private dbPath: string) {}

	/**
	 * Build a prompt context from CIPHER historical patterns.
	 * Returns null if no db, no data, or no relevant patterns.
	 *
	 * Accepts a SnapshotInputDto (pre-decision fields only) rather than
	 * ExecutionContext — CipherReader does not depend on flywheel-core types.
	 */
	async buildPromptContext(
		input: SnapshotInputDto,
	): Promise<CipherContext | null> {
		if (!existsSync(this.dbPath)) return null;

		const SQL = await initSqlJs();
		const buffer = readFileSync(this.dbPath);
		const db = new SQL.Database(buffer);

		try {
			const globalRows = db.exec(
				`SELECT global_approve_rate, prior_strength FROM pattern_summary_cache WHERE id = 'global'`,
			);
			if (globalRows.length === 0 || globalRows[0]!.values.length === 0)
				return null;

			const [globalRate, priorStrength] = globalRows[0]!.values[0]! as [
				number,
				number,
			];

			// Check if any reviews exist
			const totalRows = db.exec(`SELECT COUNT(*) FROM decision_reviews`);
			if ((totalRows[0]?.values[0]?.[0] as number) === 0) return null;

			const dimensions = extractDimensions(input);
			const allKeys = generatePatternKeys(dimensions);
			const fallbackLevels = getFallbackOrder(allKeys);

			const relevantPatterns: PatternStatistics[] = [];
			for (const levelKeys of fallbackLevels) {
				for (const key of levelKeys) {
					const rows = db.exec(
						`SELECT pattern_key, approve_count, reject_count, total_count, maturity_level
						 FROM decision_patterns WHERE pattern_key = ?`,
						[key],
					);
					if (rows.length > 0 && rows[0]!.values.length > 0) {
						const [pk, ac, rc, tc, ml] = rows[0]!.values[0]! as [
							string,
							number,
							number,
							number,
							string,
						];
						const stats: PatternStatistics = {
							patternKey: pk,
							approveCount: ac,
							rejectCount: rc,
							totalCount: tc,
							posteriorMean: posteriorMean(ac, tc, globalRate, priorStrength),
							wilsonLower: wilsonLowerBound(ac, tc),
							maturityLevel: ml as PatternStatistics["maturityLevel"],
						};
						if (shouldInjectPattern(stats, globalRate)) {
							relevantPatterns.push(stats);
						}
					}
				}
				// Stop at first level that yields results (hierarchical fallback)
				if (relevantPatterns.length > 0) break;
			}

			if (relevantPatterns.length === 0) return null;

			const promptText = this.formatPrompt(relevantPatterns, globalRate);
			return { relevantPatterns, globalApproveRate: globalRate, promptText };
		} finally {
			db.close();
		}
	}

	/**
	 * Load active CIPHER principles as HardRule-compatible objects.
	 * Returns an array of { id, description, priority, ruleType } for
	 * registration in HardRuleEngine at priority 50+.
	 */
	async loadActivePrinciples(): Promise<
		Array<{
			id: string;
			description: string;
			priority: number;
			ruleType: "block" | "escalate";
			sourcePattern: string;
		}>
	> {
		if (!existsSync(this.dbPath)) return [];

		const SQL = await initSqlJs();
		const buffer = readFileSync(this.dbPath);
		const db = new SQL.Database(buffer);

		try {
			const rows = db.exec(
				`SELECT id, rule_type, rule_definition, source_pattern
				 FROM cipher_principles
				 WHERE status = 'active'
				 ORDER BY created_at`,
			);
			if (rows.length === 0 || rows[0]!.values.length === 0) return [];

			return rows[0]!.values.map((r, index) => ({
				id: `CIPHER-${(r[0] as string).slice(0, 8)}`,
				ruleType: r[1] as "block" | "escalate",
				description: r[2] as string,
				priority: 50 + index,
				sourcePattern: r[3] as string,
			}));
		} finally {
			db.close();
		}
	}

	private formatPrompt(
		patterns: PatternStatistics[],
		globalRate: number,
	): string {
		const lines = ["## CIPHER Decision Memory (advisory only)"];
		lines.push(`Global approve rate: ${(globalRate * 100).toFixed(0)}%`);
		lines.push("");
		for (const p of patterns) {
			const emoji =
				p.posteriorMean > globalRate + 0.15
					? "HIGH_APPROVE"
					: p.posteriorMean < globalRate - 0.15
						? "LOW_APPROVE"
						: "NEUTRAL";
			const rateStr = (p.posteriorMean * 100).toFixed(0);
			lines.push(
				`[${emoji}] ${p.patternKey}: ${rateStr}% approve (${p.totalCount} samples, ${p.maturityLevel})`,
			);
		}
		lines.push("");
		lines.push(
			"Note: Historical context only. Evaluate the current PR on its own merits.",
		);
		return lines.join("\n");
	}
}
