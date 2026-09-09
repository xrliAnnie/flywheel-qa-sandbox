import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { canonicalSubmissionDigest } from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { SHIP_RELEVANT_CLASSIFIER_VERSION } from "../bridge/ship-relevant-diff.js";
import { StateStore } from "../StateStore.js";

const HEAD = "a".repeat(40);
const OBSERVED_AT = "2026-09-08T12:00:30.000Z";
const DECLARATION_ID = "11111111-1111-4111-8111-111111111111";

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function seedBoundVerdict(store: StateStore): void {
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-2398",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	const db = rawDb(store);
	db.prepare(
		`INSERT INTO workflow_gate_holder
		  (run_id, gate_node_id, attempt, head_sha, source_execution_id,
		   question_id, authority_mode, subject_kind, carrier_binding_state,
		   card_message_id, state, materialization_stage, created_at, updated_at)
		 VALUES ('run-1', 'founder_gate', 1, ?, 'implement-1', 'question-1',
		         'land', 'git_head', 'bound', 'card-1', 'awaiting_review',
		         'completed', ?, ?)`,
	).run(HEAD, OBSERVED_AT, OBSERVED_AT);
	db.prepare(
		`INSERT INTO workflow_claims
		  (id, server_seq, issue_id, workflow_run_id, node_id, decision_kind,
		   attempt, predicate, issuer_kind, subject_kind, subject_digest,
		   permanent, authority_id)
		 VALUES (41, 901, 'FLY-2398', 'run-1', NULL, 'founder_decision', NULL,
		         'founder_approved', 'founder_challenge', 'git_head', ?, 1,
		         'question-1')`,
	).run(HEAD);
	db.prepare(
		`INSERT INTO workflow_founder_gate_verdict
		  (verdict_id, source_event_id, run_id, gate_node_id, attempt, verdict,
		   question_id, repo_identity, repo_slug, pr_number, head_sha,
		   rework_request_id, claim_id, founder_authored, author_evidence_json,
		   row_digest, recorded_at)
		 VALUES ('verdict-1', 'founder-approval:1', 'run-1', 'founder_gate', 1,
		         'approved', 'question-1', '__main__', 'xrliAnnie/flywheel',
		         1063, ?, NULL, 41, 1, '{"kind":"founder"}', ?, ?)`,
	).run(HEAD, "b".repeat(64), OBSERVED_AT);
}

function insertObservation(store: StateStore): void {
	insertObservationWith(store);
}

function insertObservationWith(
	store: StateStore,
	overrides: Record<string, unknown> = {},
): void {
	const row = {
		verdict_id: "verdict-1",
		run_id: "run-1",
		question_id: "question-1",
		gate_execution_id: "implement-1",
		repo_identity: "__main__",
		pr_number: 1063,
		head_sha: HEAD,
		observed_at: OBSERVED_AT,
		machine_class: "docs_only",
		machine_reason: null,
		machine_file_count: 2,
		machine_candidate_count: 1,
		machine_declared_projected_count: 0,
		machine_primary_snapshot_age_ms: 30_000,
		machine_declared_max_snapshot_age_ms: null,
		machine_basis_json:
			'{"schemaVersion":1,"prs":[],"nestedReviews":{"entries":[]}}',
		s2_ran_status: "unsatisfied",
		s2_ran_reason: "no_ledger_row",
		s2_record_status: "unsatisfied",
		s2_record_reason: "no_ledger_row",
		s2_verdict: "unsatisfied",
		s2_basis_record_id: null,
		s2_row_count: 0,
		s2_other_head_row_count: 0,
		shadow_version: 1,
		...overrides,
	};
	rawDb(store)
		.prepare(
			`INSERT INTO auto_merge_shadow_observation
			  (verdict_id, run_id, question_id, gate_execution_id, repo_identity,
			   pr_number, head_sha, observed_at, machine_class, machine_reason,
			   machine_file_count, machine_candidate_count,
			   machine_declared_projected_count, machine_primary_snapshot_age_ms,
			   machine_declared_max_snapshot_age_ms, machine_basis_json,
			   s2_ran_status, s2_ran_reason, s2_record_status, s2_record_reason,
			   s2_verdict, s2_basis_record_id, s2_row_count,
			   s2_other_head_row_count, shadow_version)
			 VALUES (@verdict_id, @run_id, @question_id, @gate_execution_id,
			         @repo_identity, @pr_number, @head_sha, @observed_at,
			         @machine_class, @machine_reason, @machine_file_count,
			         @machine_candidate_count, @machine_declared_projected_count,
			         @machine_primary_snapshot_age_ms,
			         @machine_declared_max_snapshot_age_ms, @machine_basis_json,
			         @s2_ran_status, @s2_ran_reason, @s2_record_status,
			         @s2_record_reason, @s2_verdict, @s2_basis_record_id,
			         @s2_row_count, @s2_other_head_row_count, @shadow_version)`,
		)
		.run(row);
}

function insertDeclarationDirect(
	store: StateStore,
	overrides: Record<string, unknown> = {},
): void {
	rawDb(store)
		.prepare(
			`INSERT INTO auto_merge_shadow_declaration
			  (declaration_id, question_id, run_id, declared_class, declared_by,
			   discord_channel_id, discord_message_id, discord_author_user_id,
			   message_ts, declaration_seq, declared_at)
			 VALUES (@declaration_id, @question_id, @run_id, @declared_class,
			         @declared_by, @discord_channel_id, @discord_message_id,
			         @discord_author_user_id, @message_ts, @declaration_seq,
			         @declared_at)`,
		)
		.run({
			declaration_id: DECLARATION_ID,
			question_id: "question-1",
			run_id: "run-1",
			declared_class: "pure_docs",
			declared_by: "flywheel-eng-lead",
			discord_channel_id: "12345678901234567",
			discord_message_id: "22345678901234567",
			discord_author_user_id: "32345678901234567",
			message_ts: OBSERVED_AT,
			declaration_seq: 1,
			declared_at: OBSERVED_AT,
			...overrides,
		});
}

async function createApprovalGate(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-approval",
		issueId: "FLY-2398",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertWorkflowRunNode({
		runId: "run-approval",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "implement-approval",
		endedAt: "2026-09-08T12:00:00.000Z",
	});
	store.upsertSession({
		execution_id: "implement-approval",
		issue_id: "FLY-2398",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "implement",
		session_role: "main",
		chat_thread_role: "main",
	});
	const db = rawDb(store);
	db.prepare(
		`INSERT INTO workflow_gate_holder
		  (run_id, gate_node_id, attempt, head_sha, source_execution_id,
		   question_id, authority_mode, subject_kind, carrier_binding_state,
		   card_message_id, state, materialization_stage, created_at, updated_at)
		 VALUES ('run-approval', 'founder_gate', 1, ?, 'implement-approval',
		         'question-approval', 'land', 'git_head', 'bound', 'card-approval',
		         'awaiting_review', 'completed', '2026-09-08T12:00:00.000Z',
		         '2026-09-08T12:00:00.000Z')`,
	).run(HEAD);
	db.prepare(
		`INSERT INTO workflow_ship_target_binding
		  (approve_question_id, run_id, target_repo_path, target_repo_identity,
		   probe_repo_slug, frozen_head_sha, worktree_binding_generation)
		 VALUES ('question-approval', 'run-approval', '/repo', '__main__',
		         'xrliAnnie/flywheel', ?, 'generation-1')`,
	).run(HEAD);
	db.prepare(
		`INSERT INTO workflow_node_pr_binding
		  (run_id, node_id, attempt, pr_number, head_sha, target_repo_identity,
		   probe_repo_slug, target_repo_path, worktree_binding_generation,
		   receipt_id, bound_at)
		 VALUES ('run-approval', 'implement', 1, 1063, ?, '__main__',
		         'xrliAnnie/flywheel', '/repo', 'generation-1', 'receipt-1',
		         '2026-09-08T12:00:00.000Z')`,
	).run(HEAD);
	store.putShipRelevantPrSnapshot({
		execution_id: "implement-approval",
		repo_slug: "xrliAnnie/flywheel",
		pr_number: 1063,
		pr_head_sha: HEAD,
		role: "primary",
		base_ref: "main",
		base_oid: "c".repeat(40),
		classifier_version: SHIP_RELEVANT_CLASSIFIER_VERSION,
		ship_relevant: 0,
		file_count: 2,
		sample_paths: ["README.md"],
		commit_shas: [HEAD],
		computed_at: "2026-09-08T12:00:00.000Z",
	});
	return store;
}

function applyApproval(store: StateStore) {
	const payload = {
		schema_version: 1,
		run_id: "run-approval",
		issue_id: "FLY-2398",
		question_id: "question-approval",
		response: { approved: true },
		actor: "founder-user",
		founder_id_at_capture: "founder-user",
		approved_head: HEAD,
		classification: "founder_direct_signal",
		authority_id: "question-approval",
	};
	return store.applyWorkflowSourceEvent({
		project: "flywheel",
		sourceEventId: "founder-approval:shadow-1",
		kind: "founder_approval",
		payloadJson: JSON.stringify(payload),
		payloadDigest: canonicalSubmissionDigest(payload),
		schemaVersion: 1,
		at: OBSERVED_AT,
	});
}

function insertStrengthTwoRow(
	store: StateStore,
	input: { recordId: string; headSha: string; recordedAt: string },
): void {
	rawDb(store)
		.prepare(
			`INSERT INTO strength_two_evidence_record
			  (record_id, run_id, recorder_credential_id, recorder_activation_id,
			   recorder_execution_id, recorder_node_id, recorder_attempt,
			   target_repo_identity, head_sha, site_kind, site_slot,
			   site_bridge_port, site_checked_at, lane, driver_exit_code,
			   ran_status, ran_reason, record_url, record_url_kind,
			   record_checked_at, probe_detail, rerun_spec, rerun_worktree_path,
			   rerun_argv, rerun_command, record_status, record_reason, verdict,
			   recorded_at)
			 VALUES (?, 'run-approval', 1, 'activation-qa', 'qa-1', 'qa', 1,
			         '__main__', ?, 'slot_529', 1, 19872, ?, 'manual_test_deploy',
			         NULL, 'unsatisfied', 'lane_unproven',
			         'https://example.test/evidence', 'hosted_report', ?, '{}',
			         '{"schemaVersion":1,"lane":"manual_test_deploy","deploy":{"generalized":false}}',
			         '/repo', '[]', 'echo rerun', 'unsatisfied', 'url_unreachable',
			         'unsatisfied', ?)`,
		)
		.run(
			input.recordId,
			input.headSha,
			input.recordedAt,
			input.recordedAt,
			input.recordedAt,
		);
}

describe("StateStore auto-merge shadow ledger", () => {
	it("installs both append-only ledgers and one migration receipt", async () => {
		const store = await StateStore.create(":memory:");
		const db = rawDb(store);

		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'auto_merge_shadow_%' ORDER BY name",
				)
				.all(),
		).toEqual([
			{ name: "auto_merge_shadow_declaration" },
			{ name: "auto_merge_shadow_observation" },
		]);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'auto_merge_shadow_%_no_%' ORDER BY name",
				)
				.all(),
		).toEqual([
			{ name: "auto_merge_shadow_declaration_no_delete" },
			{ name: "auto_merge_shadow_declaration_no_update" },
			{ name: "auto_merge_shadow_observation_no_delete" },
			{ name: "auto_merge_shadow_observation_no_update" },
		]);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM state_store_migration WHERE migration_id = 'fly-2398-shadow-observation-v1'",
				)
				.get(),
		).toEqual({ count: 1 });

		store.close();
	});

	it("reopens with unchanged schema objects and one receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2398-shadow-migration-"));
		const path = join(root, "teamlead.db");
		try {
			const first = await StateStore.create(path);
			const schema = rawDb(first)
				.prepare(
					`SELECT type, name, sql FROM sqlite_master
					  WHERE name LIKE 'auto_merge_shadow_%' ORDER BY type, name`,
				)
				.all();
			const receipt = rawDb(first)
				.prepare(
					"SELECT * FROM state_store_migration WHERE migration_id = 'fly-2398-shadow-observation-v1'",
				)
				.get();
			first.close();

			const reopened = await StateStore.create(path);
			expect(
				rawDb(reopened)
					.prepare(
						`SELECT type, name, sql FROM sqlite_master
						  WHERE name LIKE 'auto_merge_shadow_%' ORDER BY type, name`,
					)
					.all(),
			).toEqual(schema);
			expect(
				rawDb(reopened)
					.prepare(
						"SELECT * FROM state_store_migration WHERE migration_id = 'fly-2398-shadow-observation-v1'",
					)
					.all(),
			).toEqual([receipt]);
			reopened.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lists a complete immutable observation row", async () => {
		const store = await StateStore.create(":memory:");
		seedBoundVerdict(store);
		insertObservation(store);

		expect(store.listAutoMergeShadowObservations()).toEqual([
			expect.objectContaining({
				verdict_id: "verdict-1",
				run_id: "run-1",
				question_id: "question-1",
				machine_class: "docs_only",
				machine_reason: null,
				machine_file_count: 2,
				s2_ran_reason: "no_ledger_row",
				s2_record_reason: "no_ledger_row",
				shadow_version: 1,
			}),
		]);
		expect(() =>
			rawDb(store)
				.prepare(
					"UPDATE auto_merge_shadow_observation SET machine_file_count = 3 WHERE verdict_id = 'verdict-1'",
				)
				.run(),
		).toThrow(/auto_merge_shadow_observation is immutable/);
		expect(() =>
			rawDb(store)
				.prepare(
					"DELETE FROM auto_merge_shadow_observation WHERE verdict_id = 'verdict-1'",
				)
				.run(),
		).toThrow(/auto_merge_shadow_observation is immutable/);

		store.close();
	});

	it.each([
		["empty run", { run_id: "" }],
		["empty question", { question_id: "" }],
		["empty execution", { gate_execution_id: "" }],
		["empty repo identity", { repo_identity: "" }],
		["non-positive PR", { pr_number: 0 }],
		["non-canonical head", { head_sha: "A".repeat(40) }],
		["machine class", { machine_class: "maybe" }],
		["machine reason", { machine_class: "unknown", machine_reason: "maybe" }],
		["negative file count", { machine_file_count: -1 }],
		["negative candidate count", { machine_candidate_count: -1 }],
		["negative projected count", { machine_declared_projected_count: -1 }],
		["invalid basis JSON", { machine_basis_json: "{" }],
		[
			"oversized basis JSON",
			{ machine_basis_json: JSON.stringify("x".repeat(16_384)) },
		],
		["ran status", { s2_ran_status: "maybe" }],
		["empty ran reason", { s2_ran_reason: "" }],
		["record status", { s2_record_status: "maybe" }],
		["long record reason", { s2_record_reason: "x".repeat(65) }],
		["strength-two verdict", { s2_verdict: "maybe" }],
		["negative exact-head rows", { s2_row_count: -1 }],
		["negative other-head rows", { s2_other_head_row_count: -1 }],
		["shadow version", { shadow_version: 2 }],
		["docs-only reason", { machine_reason: "scope_unresolved" }],
		["docs-only file count", { machine_file_count: null }],
		["inconsistent strength-two halves", { s2_verdict: "satisfied" }],
		["zero-row reason", { s2_ran_reason: "lane_unproven" }],
		["zero-row basis", { s2_basis_record_id: "record-without-row" }],
		["nonzero row without basis", { s2_row_count: 1 }],
	] as const)(
		"rejects direct observation SQL with %s",
		async (_case, overrides) => {
			const store = await StateStore.create(":memory:");
			seedBoundVerdict(store);
			expect(() => insertObservationWith(store, overrides)).toThrow();
			expect(store.listAutoMergeShadowObservations()).toEqual([]);
			store.close();
		},
	);

	it.each([
		["non-canonical UUID", { declaration_id: "NOT-A-UUID" }],
		["empty question", { question_id: "" }],
		["empty run", { run_id: "" }],
		["declared class", { declared_class: "maybe" }],
		["empty declarer", { declared_by: "" }],
		["long declarer", { declared_by: "x".repeat(65) }],
		["invalid declarer character", { declared_by: "lead!" }],
		["empty channel", { discord_channel_id: "" }],
		["long channel", { discord_channel_id: "1".repeat(33) }],
		["non-digit channel", { discord_channel_id: "123x" }],
		["empty message", { discord_message_id: "" }],
		["long message", { discord_message_id: "1".repeat(33) }],
		["non-digit message", { discord_message_id: "123x" }],
		["empty author", { discord_author_user_id: "" }],
		["long author", { discord_author_user_id: "1".repeat(33) }],
		["non-digit author", { discord_author_user_id: "123x" }],
		["non-positive sequence", { declaration_seq: 0 }],
	] as const)(
		"rejects direct declaration SQL with %s",
		async (_case, overrides) => {
			const store = await StateStore.create(":memory:");
			seedBoundVerdict(store);
			expect(() => insertDeclarationDirect(store, overrides)).toThrow();
			expect(store.listAutoMergeShadowDeclarations("question-1")).toEqual([]);
			store.close();
		},
	);

	it("appends declarations with monotonic per-question sequence and canonical replay", async () => {
		const store = await StateStore.create(":memory:");
		seedBoundVerdict(store);
		const firstInput = {
			declarationId: DECLARATION_ID,
			questionId: "question-1",
			runId: "run-1",
			declaredClass: "pure_docs" as const,
			declaredBy: "flywheel-eng-lead",
			discordChannelId: "12345678901234567",
			discordMessageId: "22345678901234567",
			discordAuthorUserId: "32345678901234567",
			messageTs: "2026-09-08T12:00:10.000Z",
			declaredAt: "2026-09-08T12:01:00.000Z",
		};

		expect(store.recordAutoMergeShadowDeclaration(firstInput)).toMatchObject({
			ok: true,
			status: "created",
			row: { declaration_seq: 1 },
		});
		expect(
			store.recordAutoMergeShadowDeclaration({
				...firstInput,
				declaredAt: "2026-09-08T12:02:00.000Z",
			}),
		).toMatchObject({ ok: true, status: "replayed" });
		expect(
			store.recordAutoMergeShadowDeclaration({
				...firstInput,
				declaredClass: "other_code",
			}),
		).toEqual({ ok: false, reason: "declaration_conflict" });
		expect(
			store.recordAutoMergeShadowDeclaration({
				...firstInput,
				declarationId: "22222222-2222-4222-8222-222222222222",
				declaredClass: "config_only",
				discordMessageId: "42345678901234567",
			}),
		).toMatchObject({
			ok: true,
			status: "created",
			row: { declaration_seq: 2 },
		});
		expect(store.listAutoMergeShadowDeclarations("question-1")).toHaveLength(2);
		expect(() =>
			rawDb(store)
				.prepare(
					"UPDATE auto_merge_shadow_declaration SET declared_class = 'other_code' WHERE declaration_id = ?",
				)
				.run(DECLARATION_ID),
		).toThrow(/auto_merge_shadow_declaration is immutable/);
		expect(() =>
			rawDb(store)
				.prepare(
					"DELETE FROM auto_merge_shadow_declaration WHERE declaration_id = ?",
				)
				.run(DECLARATION_ID),
		).toThrow(/auto_merge_shadow_declaration is immutable/);

		store.close();
	});

	it("rejects a Discord message already used by a different declaration", async () => {
		const store = await StateStore.create(":memory:");
		seedBoundVerdict(store);
		const input = {
			declarationId: DECLARATION_ID,
			questionId: "question-1",
			runId: "run-1",
			declaredClass: "pure_docs" as const,
			declaredBy: "flywheel-eng-lead",
			discordChannelId: "12345678901234567",
			discordMessageId: "22345678901234567",
			discordAuthorUserId: "32345678901234567",
			messageTs: "2026-09-08T12:00:10.000Z",
			declaredAt: "2026-09-08T12:01:00.000Z",
		};
		expect(store.recordAutoMergeShadowDeclaration(input)).toMatchObject({
			ok: true,
		});
		expect(
			store.recordAutoMergeShadowDeclaration({
				...input,
				declarationId: "22222222-2222-4222-8222-222222222222",
			}),
		).toEqual({ ok: false, reason: "message_already_used" });

		store.close();
	});

	it("rejects an invalid declared_by value before SQLite", async () => {
		const store = await StateStore.create(":memory:");
		seedBoundVerdict(store);

		expect(
			store.recordAutoMergeShadowDeclaration({
				declarationId: DECLARATION_ID,
				questionId: "question-1",
				runId: "run-1",
				declaredClass: "pure_docs",
				declaredBy: "bad!actor",
				discordChannelId: "12345678901234567",
				discordMessageId: "22345678901234567",
				discordAuthorUserId: "32345678901234567",
				messageTs: "2026-09-08T12:00:10.000Z",
				declaredAt: "2026-09-08T12:01:00.000Z",
			}),
		).toEqual({ ok: false, reason: "invalid_declaration" });

		store.close();
	});

	it("freezes machine and strength-two facts in the founder verdict transaction", async () => {
		const store = await createApprovalGate();

		expect(applyApproval(store)).toMatchObject({
			kind: "founder_claim",
			status: "applied",
		});
		expect(store.listAutoMergeShadowObservations()).toEqual([
			expect.objectContaining({
				run_id: "run-approval",
				question_id: "question-approval",
				gate_execution_id: "implement-approval",
				repo_identity: "__main__",
				pr_number: 1063,
				head_sha: HEAD,
				observed_at: OBSERVED_AT,
				machine_class: "docs_only",
				machine_file_count: 2,
				s2_ran_reason: "no_ledger_row",
				s2_record_reason: "no_ledger_row",
				s2_row_count: 0,
				s2_other_head_row_count: 0,
			}),
		]);
		expect(applyApproval(store)).toMatchObject({
			kind: "founder_claim",
			status: "replayed",
		});
		expect(store.listAutoMergeShadowObservations()).toHaveLength(1);

		store.close();
	});

	it("keeps the founder verdict when observation insertion fails", async () => {
		const store = await createApprovalGate();
		rawDb(store).exec(`
			CREATE TRIGGER fail_shadow_observation
			BEFORE INSERT ON auto_merge_shadow_observation
			BEGIN SELECT RAISE(ABORT, 'fixture shadow failure'); END;
		`);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(applyApproval(store)).toMatchObject({
			kind: "founder_claim",
			status: "applied",
		});
		expect(store.listFounderGateVerdicts()).toHaveLength(1);
		expect(store.listAutoMergeShadowObservations()).toEqual([]);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]?.[0]).toMatch(
			/^\[auto-merge-shadow\] observation skipped for fgv:/,
		);

		warn.mockRestore();
		store.close();
	});

	it("distinguishes another-head strength-two evidence from no ledger row", async () => {
		const store = await createApprovalGate();
		insertStrengthTwoRow(store, {
			recordId: "33333333-3333-4333-8333-333333333333",
			headSha: "d".repeat(40),
			recordedAt: "2026-09-08T12:00:20.000Z",
		});

		expect(applyApproval(store)).toMatchObject({ status: "applied" });
		expect(store.listAutoMergeShadowObservations()).toMatchObject([
			{
				s2_ran_reason: "no_ledger_row",
				s2_record_reason: "no_ledger_row",
				s2_row_count: 0,
				s2_other_head_row_count: 1,
			},
		]);

		store.close();
	});

	it("freezes the exact-head strength-two basis row", async () => {
		const store = await createApprovalGate();
		const recordId = "44444444-4444-4444-8444-444444444444";
		insertStrengthTwoRow(store, {
			recordId,
			headSha: HEAD,
			recordedAt: "2026-09-08T12:00:20.000Z",
		});

		expect(applyApproval(store)).toMatchObject({ status: "applied" });
		expect(store.listAutoMergeShadowObservations()).toMatchObject([
			{
				s2_basis_record_id: recordId,
				s2_row_count: 1,
				s2_other_head_row_count: 0,
			},
		]);

		store.close();
	});
});
