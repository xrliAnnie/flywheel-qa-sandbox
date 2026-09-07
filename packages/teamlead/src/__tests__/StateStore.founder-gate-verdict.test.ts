import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { canonicalSubmissionDigest } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

function rawDatabase(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

const RUN_ID = "run-fly2396";
const QUESTION_ID = "question-fly2396";
const HEAD = "a".repeat(40);

async function createBoundFounderGate(
	options: {
		holderHead?: string;
		missingPr?: boolean;
		duplicatePr?: boolean;
		shipHead?: string;
		shipRunId?: string | null;
		shipRepoIdentity?: string;
		shipRepoSlug?: string;
		bindingRepoSlug?: string;
	} = {},
): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: RUN_ID,
		issueId: "FLY-2396",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertWorkflowRunNode({
		runId: RUN_ID,
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "implement-fly2396",
		endedAt: "2026-09-06T18:00:00.000Z",
	});
	if (options.shipRunId && options.shipRunId !== RUN_ID) {
		store.createWorkflowRun({
			runId: options.shipRunId,
			issueId: "FLY-2396-OTHER",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
	}
	if (options.duplicatePr) {
		store.upsertWorkflowRunNode({
			runId: RUN_ID,
			nodeId: "qa",
			attempt: 1,
			state: "done",
			executionId: "qa-fly2396",
			endedAt: "2026-09-06T18:00:00.000Z",
		});
	}
	const raw = rawDatabase(store);
	raw
		.prepare(
			`INSERT INTO workflow_gate_holder
			  (run_id, gate_node_id, attempt, head_sha, source_execution_id,
			   question_id, authority_mode, subject_kind, carrier_binding_state,
			   card_message_id, state, materialization_stage, created_at, updated_at)
			 VALUES (?, 'founder_gate', 1, ?, 'implement-fly2396', ?, 'land',
			         'git_head', 'bound', 'card-fly2396', 'awaiting_review',
			         'completed', '2026-09-06T18:01:00.000Z',
			         '2026-09-06T18:02:00.000Z')`,
		)
		.run(RUN_ID, options.holderHead ?? HEAD, QUESTION_ID);
	raw
		.prepare(
			`INSERT INTO workflow_ship_target_binding
			  (approve_question_id, run_id, target_repo_path, target_repo_identity,
			   probe_repo_slug, frozen_head_sha, worktree_binding_generation)
			 VALUES (?, ?, '/repo', ?, ?, ?, 'generation-1')`,
		)
		.run(
			QUESTION_ID,
			options.shipRunId === undefined ? RUN_ID : options.shipRunId,
			options.shipRepoIdentity ?? "__main__",
			options.shipRepoSlug ?? "xrliAnnie/flywheel",
			options.shipHead ?? HEAD,
		);
	if (!options.missingPr) {
		raw
			.prepare(
				`INSERT INTO workflow_node_pr_binding
				  (run_id, node_id, attempt, pr_number, head_sha,
				   target_repo_identity, probe_repo_slug, target_repo_path,
				   worktree_binding_generation, receipt_id, bound_at)
				 VALUES (?, 'implement', 1, 1063, ?, '__main__', ?, '/repo',
				         'generation-1', 'receipt-fly2396', '2026-09-06T18:00:00.000Z')`,
			)
			.run(RUN_ID, HEAD, options.bindingRepoSlug ?? "xrliAnnie/flywheel");
		if (options.duplicatePr) {
			raw
				.prepare(
					`INSERT INTO workflow_node_pr_binding
					  (run_id, node_id, attempt, pr_number, head_sha,
					   target_repo_identity, probe_repo_slug, target_repo_path,
					   worktree_binding_generation, receipt_id, bound_at)
					 VALUES (?, 'qa', 1, 1064, ?, '__main__', ?, '/repo',
					         'generation-2', 'receipt-fly2396-duplicate',
					         '2026-09-06T18:00:00.000Z')`,
				)
				.run(RUN_ID, HEAD, options.bindingRepoSlug ?? "xrliAnnie/flywheel");
		}
	}
	// Make the next claim's PK intentionally differ from its server_seq (G25).
	raw
		.prepare(
			`INSERT INTO workflow_claims
			  (id, server_seq, issue_id, workflow_run_id, node_id, decision_kind,
			   attempt, predicate, issuer_kind, subject_kind, subject_digest,
			   permanent, authority_id)
			 VALUES (40, 900, 'FLY-2396', ?, NULL, 'fixture', NULL, 'qa_exempt',
			         'bridge_policy', 'git_head', ?, 1, 'fixture')`,
		)
		.run(RUN_ID, "b".repeat(40));
	return store;
}

function applyFounderApproval(
	store: StateStore,
	overrides: Record<string, unknown> = {},
) {
	const payload = {
		schema_version: 1,
		run_id: RUN_ID,
		issue_id: "FLY-2396",
		question_id: QUESTION_ID,
		response: { approved: true },
		actor: "founder-user",
		founder_id_at_capture: "founder-user",
		approved_head: HEAD,
		classification: "founder_direct_signal",
		authority_id: QUESTION_ID,
		...overrides,
	};
	return store.applyWorkflowSourceEvent({
		project: "flywheel",
		sourceEventId: "founder-approval:fly2396",
		kind: "founder_approval",
		payloadJson: JSON.stringify(payload),
		payloadDigest: canonicalSubmissionDigest(payload),
		schemaVersion: 1,
		at: "2026-09-06T18:03:00.000Z",
	});
}

describe("FLY-2396 founder gate verdict ledger", () => {
	it("installs the immutable exact-head schema and migration receipt atomically", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const raw = rawDatabase(store);
			const columns = raw
				.prepare("PRAGMA table_info(workflow_founder_gate_verdict)")
				.all() as Array<{ name: string }>;
			expect(columns.map(({ name }) => name)).toEqual([
				"verdict_id",
				"source_event_id",
				"run_id",
				"gate_node_id",
				"attempt",
				"verdict",
				"question_id",
				"repo_identity",
				"repo_slug",
				"pr_number",
				"head_sha",
				"rework_request_id",
				"claim_id",
				"founder_authored",
				"author_evidence_json",
				"row_digest",
				"recorded_at",
			]);
			const objects = raw
				.prepare(
					`SELECT type, name FROM sqlite_master
					  WHERE name LIKE 'workflow_founder_gate_verdict%'
					  ORDER BY type, name`,
				)
				.all();
			expect(objects).toEqual(
				expect.arrayContaining([
					{
						type: "index",
						name: "workflow_founder_gate_verdict_run",
					},
					{
						type: "trigger",
						name: "workflow_founder_gate_verdict_no_delete",
					},
					{
						type: "trigger",
						name: "workflow_founder_gate_verdict_no_update",
					},
				]),
			);
			expect(
				raw
					.prepare(
						`SELECT applied_at FROM state_store_migration
						  WHERE migration_id = 'fly-2396-founder-gate-verdict-v1'`,
					)
					.get(),
			).toMatchObject({
				applied_at: expect.stringMatching(
					/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
				),
			});
			expect(store.listFounderGateVerdicts()).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("reopens with the same schema objects and one unchanged migration receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2396-migration-"));
		const path = join(root, "teamlead.db");
		try {
			const first = await StateStore.create(path);
			const rawFirst = rawDatabase(first);
			const snapshot = rawFirst
				.prepare(
					`SELECT type, name, sql FROM sqlite_master
					  WHERE name LIKE 'workflow_founder_gate_verdict%'
					  ORDER BY type, name`,
				)
				.all();
			const receipt = rawFirst
				.prepare(
					"SELECT * FROM state_store_migration WHERE migration_id = 'fly-2396-founder-gate-verdict-v1'",
				)
				.get();
			first.close();

			const reopened = await StateStore.create(path);
			try {
				const rawReopened = rawDatabase(reopened);
				expect(
					rawReopened
						.prepare(
							`SELECT type, name, sql FROM sqlite_master
							  WHERE name LIKE 'workflow_founder_gate_verdict%'
							  ORDER BY type, name`,
						)
						.all(),
				).toEqual(snapshot);
				expect(
					rawReopened
						.prepare(
							"SELECT * FROM state_store_migration WHERE migration_id = 'fly-2396-founder-gate-verdict-v1'",
						)
						.all(),
				).toEqual([receipt]);
			} finally {
				reopened.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("records an approval against the exact repo, PR and holder head", async () => {
		const store = await createBoundFounderGate();
		try {
			const result = applyFounderApproval(store);
			expect(result).toMatchObject({
				kind: "founder_claim",
				status: "applied",
			});
			if (result.kind !== "founder_claim") throw new Error("claim missing");
			const rows = store.listFounderGateVerdicts({ runId: RUN_ID });
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				source_event_id: "founder-approval:fly2396",
				gate_node_id: "founder_gate",
				attempt: 1,
				verdict: "approved",
				question_id: QUESTION_ID,
				repo_identity: "__main__",
				repo_slug: "xrliAnnie/flywheel",
				pr_number: 1063,
				head_sha: HEAD,
				rework_request_id: null,
				claim_id: result.claimId,
				founder_authored: 1,
				recorded_at: "2026-09-06T18:03:00.000Z",
			});
			expect(result.claimId).not.toBe(901);
			expect(JSON.parse(rows[0]!.author_evidence_json)).toEqual({
				kind: "gate_response",
				actor: "founder-user",
				founder_id_at_capture: "founder-user",
				source_event_id: "founder-approval:fly2396",
			});
			expect(rows[0]!.row_digest).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			store.close();
		}
	});

	it("matches the GitHub repo slug case-insensitively", async () => {
		const store = await createBoundFounderGate({
			shipRepoSlug: "XRLIANNIE/FLYWHEEL",
			bindingRepoSlug: "xrliannie/flywheel",
		});
		try {
			expect(applyFounderApproval(store)).toMatchObject({
				kind: "founder_claim",
				status: "applied",
			});
			expect(store.listFounderGateVerdicts()).toMatchObject([
				{
					repo_slug: "XRLIANNIE/FLYWHEEL",
					pr_number: 1063,
					head_sha: HEAD,
				},
			]);
		} finally {
			store.close();
		}
	});

	it("keeps founder authority separate from authorship", async () => {
		const store = await createBoundFounderGate();
		try {
			applyFounderApproval(store, { actor: "bridge-founder-consent" });
			expect(store.listFounderGateVerdicts()).toMatchObject([
				{
					verdict: "approved",
					founder_authored: 0,
				},
			]);
		} finally {
			store.close();
		}
	});

	it("marks a v1 payload without captured founder identity as legacy evidence", async () => {
		const store = await createBoundFounderGate();
		try {
			applyFounderApproval(store, { founder_id_at_capture: undefined });
			const row = store.listFounderGateVerdicts()[0]!;
			expect(row.founder_authored).toBe(0);
			expect(JSON.parse(row.author_evidence_json)).toEqual({
				kind: "gate_response_legacy_payload",
				actor: "founder-user",
				source_event_id: "founder-approval:fly2396",
			});
		} finally {
			store.close();
		}
	});

	it("rejects update and delete attempts against an existing verdict", async () => {
		const store = await createBoundFounderGate();
		try {
			applyFounderApproval(store);
			const raw = rawDatabase(store);
			expect(() =>
				raw
					.prepare(
						"UPDATE workflow_founder_gate_verdict SET founder_authored = 0",
					)
					.run(),
			).toThrow("workflow_founder_gate_verdict is immutable");
			expect(() =>
				raw.prepare("DELETE FROM workflow_founder_gate_verdict").run(),
			).toThrow("workflow_founder_gate_verdict is immutable");
			expect(store.listFounderGateVerdicts()).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it.each([
		["missing PR", { missingPr: true }, "pr_missing"],
		["non-git holder head", { holderHead: "z".repeat(40) }, "subject"],
		["head mismatch", { shipHead: "c".repeat(40) }, "head_mismatch"],
		["ambiguous PR", { duplicatePr: true }, "pr_ambiguous"],
		["repo mismatch", { bindingRepoSlug: "xrliAnnie/other" }, "repo_mismatch"],
		["ship run missing", { shipRunId: null }, "ship_target_run_mismatch"],
		[
			"ship run mismatch",
			{ shipRunId: "run-other" },
			"ship_target_run_mismatch",
		],
		["repo identity empty", { shipRepoIdentity: "" }, "repo_identity_missing"],
		["repo slug empty", { shipRepoSlug: "" }, "repo_missing"],
	] as const)(
		"rolls back claim and verdict when the binding has %s",
		async (_case, fixture, reason) => {
			const store = await createBoundFounderGate(fixture);
			try {
				const approvedHead =
					"holderHead" in fixture ? fixture.holderHead : undefined;
				expect(() =>
					applyFounderApproval(
						store,
						approvedHead ? { approved_head: approvedHead } : {},
					),
				).toThrow(
					reason === "subject"
						? "founder decision source payload invalid: subject"
						: `founder decision source payload invalid: verdict unbound (${reason})`,
				);
				expect(store.listFounderGateVerdicts()).toEqual([]);
				expect(
					rawDatabase(store)
						.prepare(
							"SELECT COUNT(*) AS count FROM workflow_claims WHERE authority_id = ?",
						)
						.get(QUESTION_ID),
				).toEqual({ count: 0 });
			} finally {
				store.close();
			}
		},
	);
});
