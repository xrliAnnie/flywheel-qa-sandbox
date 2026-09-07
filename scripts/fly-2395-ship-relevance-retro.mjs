#!/usr/bin/env node

import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const requireFromTeamlead = createRequire(
	join(repoRoot, "packages/teamlead/package.json"),
);
const Database = requireFromTeamlead("better-sqlite3");

function parseArgs(argv) {
	if (argv.length !== 2 || argv[0] !== "--db" || !argv[1]) {
		throw new Error(
			"usage: node scripts/fly-2395-ship-relevance-retro.mjs --db <readonly-copy>",
		);
	}
	return { dbPath: realpathSync(argv[1]) };
}

function requireTables(db, names) {
	const present = new Set(
		db
			.prepare(
				"SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
			)
			.all()
			.map((row) => String(row.name)),
	);
	for (const name of names) {
		if (!present.has(name)) throw new Error(`required_table_missing:${name}`);
	}
}

function historicalRowsByRun(db) {
	const snapshots = db
		.prepare(`
			WITH runexec AS (
				SELECT DISTINCT run_id, execution_id
				  FROM workflow_run_node
				 WHERE execution_id IS NOT NULL
			)
			SELECT re.run_id, s.execution_id, s.pr_head_sha, s.repo, s.pr_number,
			       s.base_ref, s.base_oid, s.classifier_version, s.ship_relevant,
			       s.file_count, s.computed_at
			  FROM runexec re
			  JOIN ship_relevant_diff_snapshot s
			    ON s.execution_id = re.execution_id
			 WHERE s.classifier_version = 1
			 ORDER BY re.run_id, s.computed_at, s.execution_id
		`)
		.all();
	const nestedReviews = db
		.prepare(`
			WITH runexec AS (
				SELECT DISTINCT run_id, execution_id
				  FROM workflow_run_node
				 WHERE execution_id IS NOT NULL
			)
			SELECT DISTINCT re.run_id,
			       lower(c.target_repo_identity) AS repo_identity,
			       lower(c.target_pr_head_sha) AS head_sha
			  FROM runexec re
			  JOIN codex_review_record c
			    ON c.execution_id = re.execution_id
			 WHERE lower(c.target_repo_identity) <> '__main__'
			 ORDER BY re.run_id, repo_identity, head_sha
		`)
		.all();
	const runs = new Map();
	for (const row of snapshots) {
		const runId = String(row.run_id);
		const entry = runs.get(runId) ?? {
			primarySnapshots: [],
			nestedReviews: [],
		};
		entry.primarySnapshots.push({
			execution_id: String(row.execution_id),
			pr_head_sha: String(row.pr_head_sha),
			repo: String(row.repo),
			pr_number: Number(row.pr_number),
			base_ref: String(row.base_ref),
			base_oid: String(row.base_oid),
			classifier_version: Number(row.classifier_version),
			ship_relevant: Number(row.ship_relevant),
			file_count: Number(row.file_count),
			computed_at: String(row.computed_at),
		});
		runs.set(runId, entry);
	}
	for (const row of nestedReviews) {
		const entry = runs.get(String(row.run_id));
		if (!entry) continue;
		entry.nestedReviews.push({
			repoIdentity: String(row.repo_identity),
			headSha: String(row.head_sha),
		});
	}
	return runs;
}

function reproduceSpecSql(db) {
	const row = db
		.prepare(`
			WITH runexec AS (
				SELECT DISTINCT run_id, execution_id
				  FROM workflow_run_node
				 WHERE execution_id IS NOT NULL
			),
			runship AS (
				SELECT re.run_id, max(s.ship_relevant) AS max_sr
				  FROM runexec re
				  JOIN ship_relevant_diff_snapshot s
				    ON s.execution_id = re.execution_id
				 WHERE s.classifier_version = 1
				 GROUP BY re.run_id
			),
			nested AS (
				SELECT DISTINCT re.run_id
				  FROM runexec re
				  JOIN codex_review_record c
				    ON c.execution_id = re.execution_id
				 WHERE c.target_repo_identity <> '__main__'
			)
			SELECT
			  (SELECT count(*) FROM runship) AS cohort_total,
			  (SELECT count(*) FROM runship WHERE max_sr = 0) AS docs_only_runs,
			  (SELECT count(*) FROM runship rs JOIN nested n ON n.run_id = rs.run_id
			    WHERE rs.max_sr = 0) AS docs_only_with_nested,
			  (SELECT count(*) FROM runship WHERE max_sr = 1) AS code_runs,
			  (SELECT count(*) FROM runship rs JOIN nested n ON n.run_id = rs.run_id
			    WHERE rs.max_sr = 1) AS code_with_nested
		`)
		.get();
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => [key, Number(value)]),
	);
}

function emptyProductionStore() {
	return {
		resolveWorkflowRunForExecution: () => ({ kind: "none" }),
		resolveWorkflowNodePrBindingForSession: () => ({ kind: "none" }),
		projectCurrentShipRelevantCandidates: () => [],
		listNestedCodexReviewHeadsForRun: () => [],
		listNestedCodexReviewHeadsForExecution: () => [],
		getShipRelevantPrSnapshot: () => undefined,
		resolvePrimaryShipRelevantPrSnapshot: () => ({ kind: "none" }),
	};
}

async function main() {
	const { dbPath } = parseArgs(process.argv.slice(2));
	const adapterPath = join(
		repoRoot,
		"packages/teamlead/dist/bridge/run-ship-relevance.js",
	);
	if (!existsSync(adapterPath)) {
		throw new Error(
			"teamlead_dist_missing: run pnpm --filter flywheel-teamlead build first",
		);
	}
	const { resolveRunShipRelevance, resolveRunShipRelevanceCounterfactual } =
		await import(pathToFileURL(adapterPath).href);
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		db.pragma("query_only = ON");
		requireTables(db, [
			"workflow_run_node",
			"ship_relevant_diff_snapshot",
			"codex_review_record",
		]);
		const runs = historicalRowsByRun(db);
		const specSql = reproduceSpecSql(db);
		const results = [];
		let productionUnknown = 0;
		for (const [runId, facts] of [...runs.entries()].sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			const result = resolveRunShipRelevanceCounterfactual(facts);
			const basisSnapshot = facts.primarySnapshots.find(
				(snapshot) =>
					snapshot.execution_id === result.basis?.primaryExecutionId,
			);
			const production = basisSnapshot
				? resolveRunShipRelevance(emptyProductionStore(), {
						execution_id: basisSnapshot.execution_id,
						pr_number: basisSnapshot.pr_number,
						pr_head_sha: basisSnapshot.pr_head_sha,
					})
				: { verdict: "unknown", reason: "primary_snapshot_missing" };
			if (
				production.verdict === "unknown" &&
				production.reason === "primary_snapshot_missing"
			) {
				productionUnknown += 1;
			}
			results.push({
				runId,
				baselineDocsOnly: basisSnapshot?.ship_relevant === 0,
				hasNestedReview: facts.nestedReviews.length > 0,
				result,
				production,
			});
		}

		const docsOnly = results.filter((result) => result.baselineDocsOnly);
		const positive = docsOnly.filter((result) => result.hasNestedReview);
		const positiveFlipped = positive.filter(
			(result) =>
				result.result.verdict === "unknown" &&
				result.result.reason === "nested_review_uncovered",
		).length;
		const negative = docsOnly.filter((result) => !result.hasNestedReview);
		const negativePreserved = negative.filter(
			(result) => result.result.verdict === "docs_only",
		).length;

		console.log(
			`mode=counterfactual db=${dbPath} copied_at=${statSync(dbPath).mtime.toISOString()}`,
		);
		console.log(
			`cohort_total=${results.length} docs_only_baseline=${docsOnly.length} with_nested_review=${positive.length}`,
		);
		console.log(
			`spec_sql: cohort_total=${specSql.cohort_total} docs_only_runs=${specSql.docs_only_runs} docs_only_with_nested=${specSql.docs_only_with_nested} code_runs=${specSql.code_runs} code_with_nested=${specSql.code_with_nested}`,
		);
		for (const row of results) {
			console.log(
				`run=${row.runId} baseline=${row.baselineDocsOnly ? "docs_only" : "ship_relevant"} nested_review=${row.hasNestedReview ? "yes" : "no"} verdict=${row.result.verdict}${"reason" in row.result ? `:${row.result.reason}` : ""} basis=${JSON.stringify(row.result.basis)} production=${row.production.verdict}${"reason" in row.production ? `:${row.production.reason}` : ""}`,
			);
		}
		console.log(
			`positive: ${positiveFlipped}/${positive.length} flipped to non-docs-only (unknown:nested_review_uncovered)`,
		);
		console.log(
			`negative: ${negativePreserved}/${negative.length} remain docs_only`,
		);
		console.log(
			`production_control: ${productionUnknown}/${results.length} unknown:primary_snapshot_missing`,
		);
		if (
			positiveFlipped !== positive.length ||
			negativePreserved !== negative.length ||
			productionUnknown !== results.length
		) {
			process.exitCode = 1;
		}
	} finally {
		db.close();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
