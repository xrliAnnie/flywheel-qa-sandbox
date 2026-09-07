import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const script = join(repoRoot, "scripts/fly-2395-ship-relevance-retro.mjs");
const requireFromTeamlead = createRequire(
	join(repoRoot, "packages/teamlead/package.json"),
);
const Database = requireFromTeamlead("better-sqlite3");
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildFixture(path) {
	const db = new Database(path);
	db.exec(`
		CREATE TABLE workflow_run_node (
			run_id TEXT NOT NULL,
			execution_id TEXT
		);
		CREATE TABLE ship_relevant_diff_snapshot (
			execution_id TEXT NOT NULL,
			pr_head_sha TEXT NOT NULL,
			repo TEXT NOT NULL,
			pr_number INTEGER NOT NULL,
			base_ref TEXT NOT NULL,
			base_oid TEXT NOT NULL,
			classifier_version INTEGER NOT NULL,
			ship_relevant INTEGER NOT NULL,
			file_count INTEGER NOT NULL,
			computed_at TEXT NOT NULL
		);
		CREATE TABLE codex_review_record (
			execution_id TEXT NOT NULL,
			target_repo_identity TEXT NOT NULL,
			target_pr_head_sha TEXT NOT NULL
		);
	`);
	const node = db.prepare(
		"INSERT INTO workflow_run_node(run_id, execution_id) VALUES (?, ?)",
	);
	const snapshot = db.prepare(`
		INSERT INTO ship_relevant_diff_snapshot(
			execution_id, pr_head_sha, repo, pr_number, base_ref, base_oid,
			classifier_version, ship_relevant, file_count, computed_at
		) VALUES (?, ?, 'owner/main', ?, 'main', ?, 1, ?, ?, ?)
	`);
	const addSnapshot = ({
		runId,
		executionId,
		headSha,
		prNumber,
		shipRelevant,
		fileCount,
		computedAt,
	}) => {
		node.run(runId, executionId);
		snapshot.run(
			executionId,
			headSha,
			prNumber,
			"d".repeat(40),
			shipRelevant,
			fileCount,
			computedAt,
		);
	};
	addSnapshot({
		runId: "run-doc-single",
		executionId: "exec-doc-single",
		headSha: HEAD_A,
		prNumber: 11,
		shipRelevant: 0,
		fileCount: 2,
		computedAt: "2025-01-01T00:00:00.000Z",
	});
	addSnapshot({
		runId: "run-doc-multi",
		executionId: "exec-a",
		headSha: HEAD_A,
		prNumber: 12,
		shipRelevant: 1,
		fileCount: 5,
		computedAt: "2025-01-02T00:00:00.000Z",
	});
	addSnapshot({
		runId: "run-doc-multi",
		executionId: "exec-b",
		headSha: HEAD_B,
		prNumber: 12,
		shipRelevant: 0,
		fileCount: 3,
		computedAt: "2025-02-02T00:00:00.000Z",
	});
	addSnapshot({
		runId: "run-doc-nested",
		executionId: "exec-doc-nested",
		headSha: HEAD_B,
		prNumber: 13,
		shipRelevant: 0,
		fileCount: 4,
		computedAt: "2025-01-03T00:00:00.000Z",
	});
	addSnapshot({
		runId: "run-code",
		executionId: "exec-code",
		headSha: HEAD_C,
		prNumber: 14,
		shipRelevant: 1,
		fileCount: 1,
		computedAt: "2025-01-04T00:00:00.000Z",
	});
	db.prepare(
		`INSERT INTO codex_review_record
		 (execution_id, target_repo_identity, target_pr_head_sha)
		 VALUES (?, 'owner/nested', ?)`,
	).run("exec-doc-nested", HEAD_C);
	db.close();
}

test("counterfactual replay flips nested docs runs and preserves the negative cohort", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2395-retro-"));
	try {
		const dbPath = join(root, "teamlead-copy.db");
		buildFixture(dbPath);
		const before = sha256(dbPath);
		const output = execFileSync(process.execPath, [script, "--db", dbPath], {
			cwd: repoRoot,
			encoding: "utf8",
		});

		assert.match(
			output,
			/mode=counterfactual db=.*teamlead-copy\.db copied_at=/,
		);
		assert.match(
			output,
			/cohort_total=4 docs_only_baseline=3 with_nested_review=1/,
		);
		assert.match(
			output,
			/spec_sql: cohort_total=4 docs_only_runs=2 docs_only_with_nested=1 code_runs=2 code_with_nested=0/,
		);
		assert.match(
			output,
			/positive: 1\/1 flipped to non-docs-only \(unknown:nested_review_uncovered\)/,
		);
		assert.match(output, /negative: 2\/2 remain docs_only/);
		assert.match(
			output,
			/production_control: 4\/4 unknown:primary_snapshot_missing/,
		);
		assert.match(
			output,
			/run=run-doc-multi .*"primaryExecutionId":"exec-b".*"snapshotVersion":1/,
		);
		assert.equal(
			sha256(dbPath),
			before,
			"the read-only replay mutated its input",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
