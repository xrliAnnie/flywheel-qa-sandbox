#!/usr/bin/env node

/**
 * Read-only deployment/rollback audit for FLY-1686 gate-entry authority.
 *
 * Usage:
 *   node scripts/fly1686-gate-entry-audit.mjs --db ~/.flywheel/teamlead.db --mode forward
 *   node scripts/fly1686-gate-entry-audit.mjs --db ~/.flywheel/teamlead.db --mode rollback
 *
 * Exit 2 means at least one active run requires an explicit Lead disposition.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseWorkflowRunSnapshot } from "../packages/teamlead/dist/workflow-run-snapshot.js";
import { workflowApprovalGate } from "../packages/teamlead/dist/workflow-template.js";

function parseArgs(argv) {
	const args = {
		db: resolve(homedir(), ".flywheel", "teamlead.db"),
		mode: "forward",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--db") args.db = resolve(argv[++index] ?? "");
		else if (value === "--mode") args.mode = argv[++index] ?? "";
		else if (value === "--json") args.json = true;
		else throw new Error(`unknown argument: ${value}`);
	}
	if (!new Set(["forward", "rollback"]).has(args.mode)) {
		throw new Error("--mode must be forward or rollback");
	}
	if (!existsSync(args.db)) throw new Error(`database not found: ${args.db}`);
	args.db = realpathSync(args.db);
	return args;
}

function all(db, sql, ...params) {
	return db.prepare(sql).all(...params);
}

function one(db, sql, ...params) {
	return db.prepare(sql).get(...params);
}

function currentBindings(db, runId) {
	return all(
		db,
		`WITH latest AS (
		   SELECT run_id, node_id, MAX(attempt) AS attempt
		     FROM workflow_run_node WHERE run_id = ?
		    GROUP BY run_id, node_id
		 )
		 SELECT b.* FROM workflow_node_pr_binding b
		 JOIN latest l ON l.run_id = b.run_id AND l.node_id = b.node_id
		              AND l.attempt = b.attempt
		 ORDER BY b.node_id`,
		runId,
	);
}

function gateTopology(snapshot) {
	const gateNodeId = workflowApprovalGate(snapshot.manifest).node;
	const predecessorNodeIds = [
		...new Set(
			snapshot.manifest.edges
				.filter((edge) => edge.to === gateNodeId)
				.map((edge) => edge.from),
		),
	];
	return { gateNodeId, predecessorNodeIds };
}

function forwardDisposition(db, run, topology, bindings) {
	const owners = new Set(bindings.map((binding) => binding.node_id));
	const gateOwned = topology.predecessorNodeIds.some((nodeId) =>
		owners.has(nodeId),
	);
	const holder = one(
		db,
		`SELECT question_id, state, carrier_binding_state
		   FROM workflow_gate_holder
		  WHERE run_id = ? AND gate_node_id = ? AND state != 'superseded'
		  ORDER BY attempt DESC LIMIT 1`,
		run.run_id,
		topology.gateNodeId,
	);
	const manifest = one(
		db,
		"SELECT current_revision, sealed_at FROM workflow_pr_manifest WHERE run_id = ?",
		run.run_id,
	);
	const currentIsPredecessor = topology.predecessorNodeIds.includes(
		run.current_node_id,
	);
	if (run.current_node_id === topology.gateNodeId && !gateOwned) {
		return {
			classification: "already_in_gate_legacy_binding",
			requiresDisposition: true,
			recommendation:
				"drain or explicitly align the active holder before deploy",
			holder,
		};
	}
	if (currentIsPredecessor && manifest?.sealed_at && !gateOwned) {
		return {
			classification: "stale_sealed_before_gate",
			requiresDisposition: true,
			recommendation:
				"reopen/align the sealed manifest under Lead authority before verdict retry",
			holder,
		};
	}
	return {
		classification: gateOwned
			? "gate_entry_authority_current"
			: currentIsPredecessor
				? "unconsumed_before_gate"
				: "active_outside_gate_window",
		requiresDisposition: false,
		recommendation: "none",
		holder,
	};
}

function rollbackDisposition(db, run, topology, bindings) {
	const retired = one(
		db,
		"SELECT event_uid FROM workflow_run_event WHERE run_id = ? AND kind = 'pr_binding_retired' LIMIT 1",
		run.run_id,
	);
	const receiptTarget = one(
		db,
		`SELECT approve_question_id FROM workflow_ship_target_binding
		  WHERE run_id = ? AND superseded_at IS NULL
		    AND worktree_binding_generation LIKE 'receipt-v1:%' LIMIT 1`,
		run.run_id,
	);
	const unboundFence = one(
		db,
		`SELECT h.question_id FROM workflow_gate_holder h
		  WHERE h.run_id = ? AND h.authority_mode = 'runner_ship'
		    AND h.carrier_binding_state = 'unbound' AND h.state != 'superseded'
		    AND EXISTS (
		      SELECT 1 FROM workflow_run_event e
		       WHERE e.run_id = h.run_id AND e.kind = 'gate_entry_mirror_fence'
		    ) LIMIT 1`,
		run.run_id,
	);
	const currentIsPredecessor = topology.predecessorNodeIds.includes(
		run.current_node_id,
	);
	const completionWithoutBinding =
		currentIsPredecessor &&
		bindings.length === 0 &&
		one(
			db,
			`SELECT 1 AS present FROM sessions
			  WHERE execution_id IN (
			    SELECT execution_id FROM workflow_run_node
			     WHERE run_id = ? AND state = 'done'
			  ) AND pr_number IS NOT NULL LIMIT 1`,
			run.run_id,
		);
	const reasons = [
		completionWithoutBinding && "completion_without_legacy_binding",
		retired && "retired_legacy_binding",
		receiptTarget && "receipt_v1_ship_target",
		unboundFence && "unbound_runner_ship_mirror_fence",
	].filter(Boolean);
	return {
		classification: reasons.length ? reasons.join(",") : "rollback_compatible",
		requiresDisposition: reasons.length > 0,
		recommendation: reasons.length
			? "drain this run on the FLY-1686 runtime or apply an explicit Lead disposition before rollback"
			: "none",
	};
}

const args = parseArgs(process.argv.slice(2));
const db = new DatabaseSync(args.db, { readOnly: true });
try {
	const runs = all(
		db,
		`SELECT run_id, project_name, issue_id, current_node_id, snapshot
		   FROM workflow_run
		  WHERE status = 'active' AND engine_owned = 1 AND snapshot IS NOT NULL
		  ORDER BY project_name, issue_id, run_id`,
	);
	const rows = runs.map((run) => {
		let topology;
		try {
			topology = gateTopology(parseWorkflowRunSnapshot(run.snapshot));
		} catch (error) {
			return {
				runId: run.run_id,
				project: run.project_name,
				issue: run.issue_id,
				classification: "snapshot_invalid",
				requiresDisposition: true,
				recommendation: String(error),
			};
		}
		const bindings = currentBindings(db, run.run_id);
		return {
			runId: run.run_id,
			project: run.project_name,
			issue: run.issue_id,
			currentNodeId: run.current_node_id,
			gateNodeId: topology.gateNodeId,
			gatePredecessors: topology.predecessorNodeIds,
			bindingOwners: bindings.map((binding) => ({
				nodeId: binding.node_id,
				head: binding.head_sha,
				prNumber: binding.pr_number,
				receiptId: binding.receipt_id,
			})),
			...(args.mode === "forward"
				? forwardDisposition(db, run, topology, bindings)
				: rollbackDisposition(db, run, topology, bindings)),
		};
	});
	const result = {
		schemaVersion: 1,
		mode: args.mode,
		database: args.db,
		scanned: rows.length,
		requiresDisposition: rows.filter((row) => row.requiresDisposition).length,
		rows,
	};
	if (args.json) console.log(JSON.stringify(result, null, 2));
	else {
		console.log(
			`FLY-1686 ${args.mode} audit: scanned=${result.scanned} requiresDisposition=${result.requiresDisposition}`,
		);
		console.table(
			rows.map((row) => ({
				issue: row.issue,
				run: row.runId,
				current: row.currentNodeId ?? "",
				classification: row.classification,
				disposition: row.requiresDisposition ? "REQUIRED" : "none",
			})),
		);
	}
	if (result.requiresDisposition > 0) process.exitCode = 2;
} finally {
	db.close();
}
