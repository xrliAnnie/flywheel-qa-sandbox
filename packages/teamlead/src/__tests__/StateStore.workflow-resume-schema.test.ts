import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	StateStore,
	WORKFLOW_RESUME_REASON_CODES,
	WORKFLOW_RESUME_ROLLOUT_STATES,
	WORKFLOW_RUN_NODE_STATES,
	type WorkflowResumeFailureReason,
} from "../StateStore.js";

const SHA = "a".repeat(40);

let root: string;
let db: Database.Database;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "fly1707-resume-schema-"));
	const store = await StateStore.create(join(root, "state.db"));
	store.close();
	db = new Database(join(root, "state.db"));
	db.pragma("foreign_keys = ON");
});

afterEach(() => {
	db.close();
	rmSync(root, { recursive: true, force: true });
});

function insertAttachment(
	attachmentId: string,
	opts: { carrier?: "git_checkpoint" | "state_only_checkpoint" } = {},
): void {
	const carrier = opts.carrier ?? "git_checkpoint";
	db.prepare(
		`INSERT INTO workflow_resume_attachment (
			attachment_id, run_id, target_node_id, target_attempt, transition_uid,
			receipt_kind, receipt_digest, carrier_kind, anchor_ref, anchor_commit,
			repo_identity, snapshot_digest, resolved_node_digest,
			rework_authority_digest, envelope_json, created_at
		) VALUES (?, 'run-1', 'implement', 2, ?, 'edge_traversed', 'receipt-digest',
			?, ?, ?, ?, 'snapshot-digest', 'node-digest', 'none', '{}', ?)`,
	).run(
		attachmentId,
		`transition:${attachmentId}`,
		carrier,
		carrier === "git_checkpoint"
			? `refs/flywheel/checkpoints/run-1/${attachmentId}`
			: null,
		carrier === "git_checkpoint" ? SHA : null,
		carrier === "git_checkpoint" ? "repo-identity" : null,
		"2026-08-15T00:00:00.000Z",
	);
}

describe("FLY-1707 workflow resume schema", () => {
	it("creates exactly the S1 resume tables, lifecycle index, and immutable-ledger triggers", () => {
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workflow_resume_%' ORDER BY name",
			)
			.all()
			.map((row) => (row as { name: string }).name);
		expect(tables).toEqual([
			"workflow_resume_admission",
			"workflow_resume_attachment",
			"workflow_resume_attachment_state",
			"workflow_resume_probe",
			"workflow_resume_response",
		]);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_resume_probe_opportunity'",
				)
				.get(),
		).toBeDefined();
		const triggers = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workflow_resume_%' ORDER BY name",
			)
			.all()
			.map((row) => (row as { name: string }).name);
		expect(triggers).toEqual([
			"workflow_resume_admission_no_delete",
			"workflow_resume_admission_no_update",
			"workflow_resume_attachment_no_delete",
			"workflow_resume_attachment_no_update",
			"workflow_resume_response_no_delete",
			"workflow_resume_response_no_update",
		]);
	});

	it("enforces attachment carrier shape, immutable identity, and absorbing invalid-state shape", () => {
		insertAttachment("att-git");
		insertAttachment("att-state", { carrier: "state_only_checkpoint" });
		expect(() =>
			db
				.prepare(
					"UPDATE workflow_resume_attachment SET receipt_digest = 'changed' WHERE attachment_id = 'att-git'",
				)
				.run(),
		).toThrow(/append-only/i);
		expect(() =>
			db
				.prepare(
					`INSERT INTO workflow_resume_attachment (
						attachment_id, run_id, target_node_id, target_attempt, transition_uid,
						receipt_kind, receipt_digest, carrier_kind, anchor_ref, anchor_commit,
						repo_identity, snapshot_digest, resolved_node_digest, envelope_json, created_at
					) VALUES ('bad-state', 'run-1', 'qa', 1, 'bad-state', 'edge_traversed',
						'd', 'state_only_checkpoint', 'must-be-null', NULL, NULL, 's', 'n', '{}', 'now')`,
				)
				.run(),
		).toThrow(/constraint/i);

		db.prepare(
			`INSERT INTO workflow_resume_attachment_state
			 (attachment_id, state, updated_at) VALUES ('att-git', 'intent', 'now')`,
		).run();
		expect(() =>
			db
				.prepare(
					`INSERT INTO workflow_resume_attachment_state
					 (attachment_id, state, invalid_reason, updated_at)
					 VALUES ('att-state', 'invalid', NULL, 'now')`,
				)
				.run(),
		).toThrow(/constraint/i);
		expect(() =>
			db
				.prepare(
					"UPDATE workflow_resume_attachment_state SET invalid_reason = 'anchor_unreachable' WHERE attachment_id = 'att-git'",
				)
				.run(),
		).toThrow(/constraint/i);
	});

	it("enforces the admission action union, frozen-body byte cap, response immutability, and probe opportunity key", () => {
		insertAttachment("source", { carrier: "state_only_checkpoint" });
		insertAttachment("result");
		const insertAdmission = db.prepare(
			`INSERT INTO workflow_resume_admission (
				admission_key, admission_digest, run_id, action_kind,
				source_attachment_id, result_attachment_id, target_node_id,
				target_attempt, new_attempt, new_execution_id, redrive_generation,
				frozen_s3_body, verdict, created_at
			) VALUES (?, 'digest', 'run-1', ?, 'source', ?, 'implement', 2, ?, ?, ?, ?, 'proposed', 'now')`,
		);
		insertAdmission.run(
			"redispatch-ok",
			"redispatch_execution",
			"result",
			3,
			"exec-2",
			null,
			"frozen body",
		);
		expect(() =>
			insertAdmission.run(
				"redispatch-no-body",
				"redispatch_execution",
				"result",
				3,
				"exec-3",
				null,
				null,
			),
		).toThrow(/constraint/i);
		expect(() =>
			insertAdmission.run(
				"redispatch-too-large",
				"redispatch_execution",
				"result",
				3,
				"exec-4",
				null,
				"é".repeat(131_073),
			),
		).toThrow(/constraint/i);
		insertAdmission.run(
			"state-only-ok",
			"reconcile_state_only",
			null,
			null,
			null,
			1,
			null,
		);
		expect(() =>
			insertAdmission.run(
				"state-only-with-body",
				"reconcile_state_only",
				null,
				null,
				null,
				2,
				"not allowed",
			),
		).toThrow(/constraint/i);

		db.prepare(
			"INSERT INTO workflow_resume_response VALUES ('redispatch-ok', '{\"ok\":true}', 'now')",
		).run();
		expect(() =>
			db
				.prepare(
					"UPDATE workflow_resume_response SET response_json = '{}' WHERE admission_key = 'redispatch-ok'",
				)
				.run(),
		).toThrow(/append-only/i);

		const insertProbe = db.prepare(
			`INSERT INTO workflow_resume_probe
			 (run_id, probe_kind, opportunity_key, verdict, created_at)
			 VALUES ('run-1', ?, 'source:ready', 'proposed', 'now')`,
		);
		insertProbe.run("shadow");
		expect(() => insertProbe.run("shadow")).toThrow(/unique/i);
		insertProbe.run("admission");
	});

	it("enforces collection lease shape, one open episode, and run-scoped immutable aliases", () => {
		db.prepare(
			`INSERT INTO workflow_run_collect_receipt
			 (receipt_key, run_id, state, target_list_json, updated_at)
			 VALUES ('episode:run-1:0', 'run-1', 'frozen', '[]', 'now')`,
		).run();
		expect(() =>
			db
				.prepare(
					`INSERT INTO workflow_run_collect_receipt
					 (receipt_key, run_id, state, owner_id, target_list_json, updated_at)
					 VALUES ('bad-lease', 'run-2', 'collecting', 'owner', '[]', 'now')`,
				)
				.run(),
		).toThrow(/constraint/i);
		expect(() =>
			db
				.prepare(
					`INSERT INTO workflow_run_collect_receipt
					 (receipt_key, run_id, state, target_list_json, updated_at)
					 VALUES ('episode:run-1:1', 'run-1', 'frozen', '[]', 'now')`,
				)
				.run(),
		).toThrow(/unique/i);

		db.prepare(
			`INSERT INTO workflow_run_collect_alias
			 (run_id, client_request_id, receipt_key, request_digest, created_at)
			 VALUES ('run-1', 'client-1', 'episode:run-1:0', 'digest', 'now')`,
		).run();
		expect(() =>
			db
				.prepare(
					"UPDATE workflow_run_collect_alias SET request_digest = 'changed' WHERE run_id = 'run-1'",
				)
				.run(),
		).toThrow(/append-only/i);
		expect(() =>
			db
				.prepare(
					`INSERT INTO workflow_run_collect_alias
					 (run_id, client_request_id, receipt_key, request_digest, created_at)
					 VALUES ('run-2', 'client-1', 'episode:run-1:0', 'digest', 'now')`,
				)
				.run(),
		).toThrow(/foreign key/i);
	});

	it("enforces the operator close intent mode and stage", () => {
		db.prepare(
			`INSERT INTO workflow_operator_close_intent
			 (execution_id, mode, reason, stage, created_at, updated_at)
			 VALUES ('exec-1', 'done', 'finished', 'prepared', 'now', 'now')`,
		).run();
		expect(() =>
			db
				.prepare(
					`INSERT INTO workflow_operator_close_intent
					 (execution_id, mode, reason, stage, created_at, updated_at)
					 VALUES ('exec-2', 'invalid', 'finished', 'prepared', 'now', 'now')`,
				)
				.run(),
		).toThrow(/constraint/i);
		expect(() =>
			db
				.prepare(
					"UPDATE workflow_operator_close_intent SET stage = 'invalid' WHERE execution_id = 'exec-1'",
				)
				.run(),
		).toThrow(/constraint/i);
	});
});

describe("FLY-1707 compile-time resume contract", () => {
	it("keeps the canonical short-code, rollout, and superseded-node unions explicit", () => {
		const parameterized: WorkflowResumeFailureReason = "envelope_changed:issue";
		expect(parameterized.length).toBeLessThanOrEqual(64);
		expect(WORKFLOW_RESUME_REASON_CODES).toEqual([
			"target_moved",
			"receipt_missing",
			"receipt_digest_mismatch",
			"attachment_frontier_divergence",
			"attachment_missing",
			"anchor_pending",
			"anchor_unreachable",
			"envelope_changed",
			"envelope_unavailable",
			"snapshot_mismatch",
			"runtime_mismatch",
			"authority_context_mismatch",
			"carrier_unknown",
			"carrier_action_mismatch",
			"input_fallback",
			"frozen_input_too_large",
			"writer_not_fenced",
			"writer_liveness_unknown",
			"external_drift",
			"quarantine_overflow",
			"run_not_active",
			"rewind_not_supported",
			"resume_disabled",
		]);
		expect(WORKFLOW_RESUME_ROLLOUT_STATES).toEqual([
			"legacy_passthrough",
			"enforced_attachment_missing",
			"enforced_resume",
		]);
		expect(WORKFLOW_RUN_NODE_STATES).toContain("superseded");
	});
});
