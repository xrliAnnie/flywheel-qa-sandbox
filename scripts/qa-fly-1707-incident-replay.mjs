#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		db: { type: "string" },
		repo: { type: "string" },
		json: { type: "boolean", default: false },
	},
});
if (!values.db || !values.repo) throw new Error("db_and_repo_required");

const requestedDb = resolve(values.db);
const canonicalProductionDb = resolve(homedir(), ".flywheel/teamlead.db");
if (requestedDb === canonicalProductionDb) {
	throw new Error("production_db_refused");
}
const dbPath = realpathSync(requestedDb);
if (
	existsSync(canonicalProductionDb) &&
	dbPath === realpathSync(canonicalProductionDb)
) {
	throw new Error("production_db_refused");
}
const repoPath = realpathSync(resolve(values.repo));

function gitAcceptsLineage(reviewedHead, materializedHead) {
	try {
		execFileSync(
			"git",
			["-C", repoPath, "cat-file", "-e", `${materializedHead}^{commit}`],
			{ stdio: "ignore" },
		);
		execFileSync(
			"git",
			[
				"-C",
				repoPath,
				"merge-base",
				"--is-ancestor",
				reviewedHead,
				materializedHead,
			],
			{ stdio: "ignore" },
		);
		return true;
	} catch {
		return false;
	}
}

const legacyDesignNodeId = "design"; // FLY-2121-history: these pinned August runs predate the node-id cutover.
const cases = [
	{ issueId: "FLY-1645", targetNodeId: "qa", targetAttempt: 1 },
	{ issueId: "FLY-1680", targetNodeId: "implement", targetAttempt: 2 },
	{ issueId: "FLY-1614", targetNodeId: "implement", targetAttempt: 2 },
	{ issueId: "FLY-1686", targetNodeId: "implement", targetAttempt: 2 },
];
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = [];
try {
	for (const expected of cases) {
		const run = db
			.prepare(
				`SELECT run_id, current_node_id
				   FROM workflow_run
				  WHERE issue_id = ? AND template_id = 'tpl_code'
				    AND current_node_id = ? AND created_at >= '2026-08-11'
				  ORDER BY created_at
				  LIMIT 1`,
			)
			.get(expected.issueId, expected.targetNodeId);
		if (!run) throw new Error(`historical_run_missing:${expected.issueId}`);
		const target = db
			.prepare(
				`SELECT attempt, state
				   FROM workflow_run_node
				  WHERE run_id = ? AND node_id = ?
				  ORDER BY attempt DESC
				  LIMIT 1`,
			)
			.get(run.run_id, expected.targetNodeId);
		if (Number(target?.attempt) !== expected.targetAttempt) {
			throw new Error(`historical_target_mismatch:${expected.issueId}`);
		}
		const designAttempts = Number(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM workflow_run_node WHERE run_id = ? AND node_id = ?",
				)
				.get(run.run_id, legacyDesignNodeId).count,
		);
		const binding = db
			.prepare(
				`SELECT binding.head_sha, node.execution_id
				   FROM workflow_node_pr_binding binding
				   JOIN workflow_run_node node
				     ON node.run_id = binding.run_id
				    AND node.node_id = binding.node_id
				    AND node.attempt = binding.attempt
				  WHERE binding.run_id = ? AND binding.node_id = 'implement'
				  ORDER BY binding.attempt DESC
				  LIMIT 1`,
			)
			.get(run.run_id);
		if (!binding)
			throw new Error(`historical_binding_missing:${expected.issueId}`);
		const review = db
			.prepare(
				`SELECT target_pr_head_sha
				   FROM codex_review_record
				  WHERE execution_id = ? AND status = 'approved'
				  ORDER BY approved_at DESC
				  LIMIT 1`,
			)
			.get(binding.execution_id);
		if (!review)
			throw new Error(`historical_review_missing:${expected.issueId}`);
		if (!gitAcceptsLineage(review.target_pr_head_sha, binding.head_sha)) {
			throw new Error(`historical_lineage_refused:${expected.issueId}`);
		}
		rows.push({
			issueId: expected.issueId,
			runId: run.run_id,
			targetNodeId: expected.targetNodeId,
			targetAttempt: expected.targetAttempt,
			targetState: target.state,
			designAttempts,
			newDesignAttempts: 0,
			attachmentAuthority: {
				nodeId: "implement",
				executionId: binding.execution_id,
				materializedHead: binding.head_sha,
				reviewedHead: review.target_pr_head_sha,
			},
			lineage:
				review.target_pr_head_sha === binding.head_sha ? "exact" : "forward",
		});
	}
} finally {
	db.close();
}

const fly1614 = rows.find((row) => row.issueId === "FLY-1614");
const originalHead = fly1614.attachmentAuthority.materializedHead;
const mutatedHead = `${originalHead[0] === "0" ? "1" : "0"}${originalHead.slice(1)}`;
const result = {
	source: dbPath,
	mode: "read_only_credential_reconstruction",
	qualified: rows.length,
	rows,
	fly1614MutatedHeadRefused: !gitAcceptsLineage(
		fly1614.attachmentAuthority.reviewedHead,
		mutatedHead,
	),
	caveat:
		"8-11 历史 run 依赖凭据重建才能重放；4.1 小时是可避免墙钟上限，不代表当时机制已经运行。",
};
if (!result.fly1614MutatedHeadRefused) {
	throw new Error("fly1614_mutated_head_was_accepted");
}
process.stdout.write(`${JSON.stringify(result, null, values.json ? 0 : 2)}\n`);
