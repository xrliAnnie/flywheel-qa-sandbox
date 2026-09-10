import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { AutoNarrowSourceEnvelopeV1 } from "flywheel-comm/auto-narrow-contract";
import { CommDB } from "flywheel-comm/db";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { computeAutoNarrowMetrics } from "../auto-narrow/opinion.js";
import { reconcileAutoNarrowOpinionDeliveries } from "../bridge/auto-narrow-opinion-delivery.js";
import { SHIP_RELEVANT_CLASSIFIER_VERSION } from "../bridge/ship-relevant-diff.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const HEAD = "a".repeat(40);
const OPEN_AT = "2026-09-09T03:00:00.000Z";
const DECISION_AT = "2026-09-09T03:01:00.000Z";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function snapshot(): string {
	return JSON.stringify(
		buildWorkflowRunSnapshotV2({
			template: { id: "tpl_auto_narrow_test", revision: 1 },
			canonicalRoot: REPO_ROOT,
			manifest: {
				schema_version: 2,
				nodes: [
					{
						id: "craft",
						type: "generic",
						role: "general",
						vendor: "claude",
						model: "claude-opus-5",
						effort: "xhigh",
					},
					{ id: "founder_gate", type: "gate" },
					{ id: "land", type: "land", execution: "engine" },
				],
				edges: [
					{
						id: "crafted",
						from: "craft",
						to: "founder_gate",
						condition: "node_done",
					},
					{
						id: "approved",
						from: "founder_gate",
						to: "land",
						condition: "founder_approved",
					},
				],
				loops: [],
				approval_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				terminal_node: { node: "land" },
				ship_claims: ["founder_approved"],
			},
		}),
	);
}

function bindPr(store: StateStore): void {
	rawDb(store)
		.prepare(
			`INSERT INTO workflow_node_pr_binding
			  (run_id, node_id, attempt, pr_number, head_sha, target_repo_identity,
			   probe_repo_slug, target_repo_path, worktree_binding_generation,
			   receipt_id, bound_at)
			 VALUES ('run-auto', 'craft', 1, 1453, ?, '__main__',
			         'xrliAnnie/flywheel', '/tmp/flywheel', 'generation-1',
			         'receipt-auto', '2026-09-09T02:58:00.000Z')`,
		)
		.run(HEAD);
}

function insertStrengthTwo(store: StateStore): void {
	rawDb(store)
		.prepare(
			`INSERT INTO strength_two_evidence_record
			  (record_id, run_id, recorder_credential_id, recorder_activation_id,
			   recorder_execution_id, recorder_node_id, recorder_attempt,
			   target_repo_identity, head_sha, site_kind, site_slot,
			   site_bridge_port, site_http_status, site_health_ok,
			   site_shutting_down, site_build_mode, site_build_sha,
			   site_artifact_build_sha, site_checked_at, lane, driver_exit_code,
			   ran_status, ran_reason, record_url, record_url_kind,
			   record_http_status, record_digest, record_bytes, record_checked_at,
			   probe_detail, rerun_spec, rerun_worktree_path, rerun_argv,
			   rerun_command, local_copy_path, record_status, record_reason,
			   verdict, recorded_at)
			 VALUES ('44444444-4444-4444-8444-444444444444', 'run-auto', 1,
			         'activation-qa', 'qa-auto', 'qa', 1, '__main__', ?, 'slot_529',
			         1, 19872, 200, 1, 0, 'built', ?, ?,
			         '2026-09-09T02:59:00.000Z', 'generalized_e2e_stub', 0,
			         'satisfied', 'ok', 'https://example.test/evidence',
			         'hosted_report', 200, ?, 128, '2026-09-09T02:59:00.000Z',
			         '{}', '{"schemaVersion":1,"lane":"generalized_e2e_stub"}',
			         '/tmp/flywheel', '[]', 'echo rerun', NULL, 'satisfied', 'ok',
			         'satisfied', '2026-09-09T02:59:00.000Z')`,
		)
		.run(HEAD, HEAD, HEAD, "b".repeat(64));
}

async function fixture(
	path = ":memory:",
	omitStrengthTwo = false,
): Promise<{
	store: StateStore;
	questionId: string;
}> {
	const store = await StateStore.create(path);
	store.createWorkflowRun({
		runId: "run-auto",
		issueId: "FLY-2453",
		projectName: "flywheel",
		snapshotJson: snapshot(),
		claimsReadEnrolled: true,
	});
	rawDb(store)
		.prepare(
			"UPDATE workflow_run SET engine_owned = 1, gate_carrier_epoch = 1, current_node_id = 'craft' WHERE run_id = 'run-auto'",
		)
		.run();
	store.upsertWorkflowRunNode({
		runId: "run-auto",
		nodeId: "craft",
		attempt: 1,
		state: "running",
		executionId: "implement-auto",
	});
	bindPr(store);
	const transition = store.commitWorkflowTransitionTx({
		nodeReuseEnabled: false,
		runId: "run-auto",
		nodeId: "craft",
		attempt: 1,
		executionId: "implement-auto",
		outcome: "node_done",
		subjectDigest: HEAD,
		now: "2026-09-09T02:58:30.000Z",
	});
	if (!transition.ok) throw new Error(transition.reason);
	const holder = store.getCurrentWorkflowGateHolder("run-auto", "founder_gate");
	if (!holder) throw new Error("missing holder");
	for (const [stage, cardMessageId] of [
		["question_written"],
		["session_bound"],
		["card_posted", "1517000000000000042"],
		["card_bound", "1517000000000000042"],
		["completed", "1517000000000000042"],
	] as const) {
		expect(
			store.advanceWorkflowGateHolderMaterialization({
				questionId: holder.question_id,
				stage,
				...(cardMessageId ? { cardMessageId } : {}),
				now: "2026-09-09T02:58:40.000Z",
			}),
		).toMatchObject({ ok: true });
	}
	store.putShipRelevantPrSnapshot({
		execution_id: "implement-auto",
		repo_slug: "xrliAnnie/flywheel",
		pr_number: 1453,
		pr_head_sha: HEAD,
		role: "primary",
		base_ref: "main",
		base_oid: "c".repeat(40),
		classifier_version: SHIP_RELEVANT_CLASSIFIER_VERSION,
		ship_relevant: 0,
		file_count: 2,
		sample_paths: ["README.md"],
		commit_shas: [HEAD],
		computed_at: "2026-09-09T03:00:30.000Z",
	});
	expect(
		store.recordAutoMergeShadowDeclaration({
			declarationId: "33333333-3333-4333-8333-333333333333",
			questionId: holder.question_id,
			runId: "run-auto",
			declaredClass: "pure_docs",
			declaredBy: "flywheel-eng-lead",
			discordChannelId: "1516209714097291335",
			discordMessageId: "1517000000000000030",
			discordAuthorUserId: "1138241636057481306",
			messageTs: "2026-09-09T02:59:10.000Z",
			declaredAt: "2026-09-09T02:59:10.000Z",
		}),
	).toMatchObject({ ok: true });
	if (!omitStrengthTwo) insertStrengthTwo(store);
	expect(
		store.applyAutoNarrowControlChange({
			eventId: "11111111-1111-4111-8111-111111111111",
			projectName: "flywheel",
			mode: "auto",
			expectedChangeSeq: 0,
			founderMessageId: "1517000000000000001",
			founderChannelId: "1516209714097291335",
			founderAuthorId: "1138241636057481306",
			messageCreatedAt: "2026-09-09T02:59:30.000Z",
			messageDigest: "d".repeat(64),
			commandText: "现在放开",
			executedBy: "flywheel-eng-lead",
			reason: "founder 1517000000000000001",
			now: Date.parse(OPEN_AT),
		}),
	).toMatchObject({ ok: true });
	return { store, questionId: holder.question_id };
}

function insertFounderRework(
	store: StateStore,
	questionId: string,
	recordedAt = "2026-09-09T03:00:45.000Z",
): void {
	rawDb(store)
		.prepare(
			`INSERT INTO workflow_rework_request
			 (request_id, run_id, source_event_id, authority, source_node_id,
			  source_attempt, base_revision, authority_context_json,
			  authority_context_digest, founder_feedback_verbatim, requested_at)
			 VALUES ('rework:older-card', 'run-auto', 'founder-feedback:older-card',
			         'founder', 'founder_gate', 1, ?, '{}', ?, 'stop this head', ?)`,
		)
		.run(HEAD, "b".repeat(64), recordedAt);
	rawDb(store)
		.prepare(
			`INSERT INTO workflow_founder_gate_verdict
			 (verdict_id, source_event_id, run_id, gate_node_id, attempt, verdict,
			  question_id, repo_identity, repo_slug, pr_number, head_sha,
			  rework_request_id, claim_id, founder_authored, author_evidence_json,
			  row_digest, recorded_at)
			 VALUES ('founder-rework-verdict', 'founder-feedback:older-card',
			         'run-auto', 'founder_gate', 1, 'rework', ?,
			         '__main__', 'xrliAnnie/flywheel', 1453, ?,
			         'rework:older-card', NULL, 1, '{"kind":"gate_response"}', ?, ?)`,
		)
		.run(questionId, HEAD, "c".repeat(64), recordedAt);
}

describe("StateStore auto narrow approval", () => {
	it("rotates the pending candidate page after the prior tick cursor", async () => {
		const { store, questionId } = await fixture();
		store.createWorkflowRun({
			runId: "run-rotate",
			issueId: "FLY-2453-ROTATE",
			projectName: "flywheel",
			snapshotJson: snapshot(),
			claimsReadEnrolled: true,
		});
		const secondQuestionId = `workflow-gate:${"f".repeat(64)}`;
		rawDb(store)
			.prepare(
				`INSERT INTO workflow_gate_holder
				  (run_id, gate_node_id, attempt, head_sha, source_execution_id,
				   question_id, card_message_id, state, materialization_stage,
				   created_at, updated_at, authority_mode, subject_kind)
				 VALUES ('run-rotate', 'founder_gate', 1, ?, 'exec-rotate', ?,
				         '1517000000000000043', 'awaiting_review', 'completed',
				         '2026-09-09T02:58:40.000Z', '2026-09-09T02:58:40.000Z',
				         'land', 'git_head')`,
			)
			.run("b".repeat(40), secondQuestionId);
		const firstPage = store.listPendingAutoNarrowCandidates(20);
		expect(firstPage).toHaveLength(2);
		expect(firstPage).toContain(questionId);
		expect(firstPage).toContain(secondQuestionId);
		expect(store.listPendingAutoNarrowCandidates(20, firstPage[0])[0]).toBe(
			firstPage[1],
		);
		expect(store.listPendingAutoNarrowCandidates(20, firstPage[1])[0]).toBe(
			firstPage[0],
		);
		store.close();
	});

	it("uses the tick-shared metric snapshot when refreshing each opinion", async () => {
		const { store, questionId } = await fixture();
		const metrics = {
			sampleN: 7,
			agreeN: 6,
			precisionA: 5,
			precisionB: 6,
			confidenceLower: 0.42,
			sampleStartAt: "2026-09-01T03:00:00.000Z",
			sampleEndAt: "2026-09-08T03:00:00.000Z",
			lastEligibleHumanAt: "2026-09-08T03:00:00.000Z",
		};
		expect(
			store.refreshAutoNarrowOpinion({
				questionId,
				issueThreadId: "1517000000000000050",
				mode: "auto",
				controlAppliedAt: OPEN_AT,
				at: DECISION_AT,
				metrics,
			}),
		).toMatchObject({ status: "created", snapshot: metrics });
		store.close();
	});

	it("records one durable opinion intent and refreshes it after declaration drift", async () => {
		const { store, questionId } = await fixture();
		expect(
			store.refreshAutoNarrowOpinion({
				questionId,
				issueThreadId: "1517000000000000050",
				mode: "auto",
				controlAppliedAt: OPEN_AT,
				at: DECISION_AT,
			}),
		).toMatchObject({ status: "created", snapshot: { ordinal: 1 } });
		expect(
			store.refreshAutoNarrowOpinion({
				questionId,
				issueThreadId: "1517000000000000050",
				mode: "auto",
				controlAppliedAt: OPEN_AT,
				at: DECISION_AT,
			}),
		).toMatchObject({ status: "unchanged" });
		expect(
			store.recordAutoMergeShadowDeclaration({
				declarationId: "55555555-5555-4555-8555-555555555555",
				questionId,
				runId: "run-auto",
				declaredClass: "config_only",
				declaredBy: "flywheel-eng-lead",
				discordChannelId: "1516209714097291335",
				discordMessageId: "1517000000000000040",
				discordAuthorUserId: "1138241636057481306",
				messageTs: "2026-09-09T03:01:05.000Z",
				declaredAt: "2026-09-09T03:01:05.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.refreshAutoNarrowOpinion({
				questionId,
				issueThreadId: "1517000000000000050",
				mode: "auto",
				controlAppliedAt: OPEN_AT,
				at: "2026-09-09T03:01:06.000Z",
			}),
		).toMatchObject({
			status: "created",
			snapshot: { ordinal: 2, gate2: 0, eligible: 0 },
		});
		expect(store.listAutoNarrowOpinionSnapshots(questionId)).toHaveLength(2);
		expect(store.getAutoNarrowOpinionDelivery(questionId)).toMatchObject({
			state: "pending",
			desiredOpinionId: expect.stringContaining(":2"),
			postedOpinionId: null,
		});
		store.close();
	});

	it("posts one opinion, patches it after drift, and swaps the bot reaction", async () => {
		const { store, questionId } = await fixture();
		store.refreshAutoNarrowOpinion({
			questionId,
			issueThreadId: "1517000000000000050",
			mode: "auto",
			controlAppliedAt: OPEN_AT,
			at: DECISION_AT,
		});
		const posted: string[] = [];
		const edited: string[] = [];
		const reactions: string[] = [];
		await reconcileAutoNarrowOpinionDeliveries({
			store,
			mode: "auto",
			now: () => "2026-09-09T03:01:01.000Z",
			post: async ({ content }) => {
				posted.push(content);
				return { kind: "posted", messageId: "1517000000000000060" };
			},
			edit: async ({ content }) => {
				edited.push(content);
				return { ok: true };
			},
			scan: async () => ({ kind: "none", frontier: "frontier-1" }),
			setReaction: async ({ reaction }) => {
				reactions.push(reaction);
				return true;
			},
			markCard: async () => true,
		});
		expect(posted).toHaveLength(1);
		expect(edited).toHaveLength(0);
		expect(reactions).toEqual(["eligible"]);
		expect(store.getAutoNarrowOpinionDelivery(questionId)).toMatchObject({
			state: "delivered",
			followupMessageId: "1517000000000000060",
			reactionApplied: "eligible",
		});

		store.recordAutoMergeShadowDeclaration({
			declarationId: "55555555-5555-4555-8555-555555555555",
			questionId,
			runId: "run-auto",
			declaredClass: "config_only",
			declaredBy: "flywheel-eng-lead",
			discordChannelId: "1516209714097291335",
			discordMessageId: "1517000000000000040",
			discordAuthorUserId: "1138241636057481306",
			messageTs: "2026-09-09T03:01:05.000Z",
			declaredAt: "2026-09-09T03:01:05.000Z",
		});
		store.refreshAutoNarrowOpinion({
			questionId,
			issueThreadId: "1517000000000000050",
			mode: "auto",
			controlAppliedAt: OPEN_AT,
			at: "2026-09-09T03:01:06.000Z",
		});
		await reconcileAutoNarrowOpinionDeliveries({
			store,
			mode: "auto",
			now: () => "2026-09-09T03:01:07.000Z",
			post: async ({ content }) => {
				posted.push(content);
				return { kind: "posted", messageId: "1517000000000000061" };
			},
			edit: async ({ content }) => {
				edited.push(content);
				return { ok: true };
			},
			scan: async () => ({ kind: "none", frontier: "frontier-1" }),
			setReaction: async ({ reaction }) => {
				reactions.push(reaction);
				return true;
			},
			markCard: async () => true,
		});
		expect(posted).toHaveLength(1);
		expect(edited).toHaveLength(1);
		expect(reactions).toEqual(["eligible", "ineligible"]);
		expect(store.getAutoNarrowOpinionDelivery(questionId)).toMatchObject({
			state: "delivered",
			followupMessageId: "1517000000000000060",
			reactionApplied: "ineligible",
		});
		store.close();
	});

	it("in off mode finishes a pending automatic label without editing opinions or reactions", async () => {
		const edit = vi.fn(async () => ({ ok: true }));
		const post = vi.fn(async () => ({
			kind: "posted" as const,
			messageId: "1517000000000000061",
		}));
		const setReaction = vi.fn(async () => true);
		const bind = vi.fn(() => true);
		const finish = vi.fn(() => true);
		const store = {
			listAutoNarrowOpinionDeliveryWork: () => [
				{
					delivery: {
						questionId: "question-off-label",
						issueThreadId: "1517000000000000050",
						cardMessageId: "1517000000000000042",
						desiredOpinionId: "question-off-label:1",
						postedOpinionId: "question-off-label:1",
						followupMessageId: "1517000000000000060",
						generation: 0,
						attempt: 1,
						state: "pending" as const,
						correlationMarker: "auto-narrow-opinion:off-label",
						postingAt: null,
						firstZeroScanAt: null,
						scanFrontier: null,
						nextAttemptAt: null,
						lastErrorCode: null,
						reactionApplied: "eligible" as const,
						automaticLabelPending: 1 as const,
					},
					opinion: {
						opinionId: "question-off-label:1",
						questionId: "question-off-label",
						runId: "run-off-label",
						projectName: "flywheel",
						headSha: HEAD,
						cardMessageId: "1517000000000000042",
						ordinal: 1,
						capturedAt: DECISION_AT,
						gate1: 1 as const,
						gate2: 1 as const,
						gate3: 1 as const,
						eligible: 1 as const,
						declarationId: "33333333-3333-4333-8333-333333333333",
						machineReason: null,
						s2BasisRecordId: "44444444-4444-4444-8444-444444444444",
						reasonCode: "eligible" as const,
						policyVersion: 1 as const,
						sampleN: 0,
						agreeN: 0,
						precisionA: 0,
						precisionB: 0,
						confidenceLower: null,
						sampleStartAt: null,
						sampleEndAt: null,
						lastEligibleHumanAt: null,
					},
					openingAt: OPEN_AT,
				},
			],
			beginAutoNarrowOpinionDelivery: () => ({
				questionId: "question-off-label",
				issueThreadId: "1517000000000000050",
				cardMessageId: "1517000000000000042",
				desiredOpinionId: "question-off-label:1",
				postedOpinionId: "question-off-label:1",
				followupMessageId: "1517000000000000060",
				generation: 1,
				attempt: 2,
				state: "posting" as const,
				correlationMarker: "auto-narrow-opinion:off-label",
				postingAt: DECISION_AT,
				firstZeroScanAt: null,
				scanFrontier: null,
				nextAttemptAt: null,
				lastErrorCode: null,
				reactionApplied: "eligible" as const,
				automaticLabelPending: 1 as const,
			}),
			bindAutoNarrowOpinionMessage: bind,
			markAutoNarrowOpinionReaction: vi.fn(() => true),
			markAutoNarrowAutomaticLabelDelivered: vi.fn(() => true),
			finishAutoNarrowOpinionDelivery: finish,
			deferAutoNarrowOpinionDelivery: vi.fn(() => true),
			recordAutoNarrowOpinionRecovery: vi.fn(() => "waiting" as const),
		};
		const result = await reconcileAutoNarrowOpinionDeliveries({
			store: store as unknown as StateStore,
			mode: "off",
			post,
			edit,
			scan: async () => ({ kind: "none", frontier: null }),
			setReaction,
			markCard: async () => true,
		});
		expect(result.delivered).toBe(1);
		expect(post).not.toHaveBeenCalled();
		expect(edit).not.toHaveBeenCalled();
		expect(setReaction).not.toHaveBeenCalled();
		expect(bind).not.toHaveBeenCalled();
		expect(finish).toHaveBeenCalledOnce();
	});

	it("persists an opinion with zero approvals among 21 eligible human samples", async () => {
		const { store, questionId } = await fixture();
		try {
			const metrics = computeAutoNarrowMetrics(
				Array.from({ length: 21 }, () => ({
					decidedAt: DECISION_AT,
					predicted: true,
					actual: false,
				})),
			);
			expect(
				store.refreshAutoNarrowOpinion({
					questionId,
					issueThreadId: "1517000000000000050",
					mode: "auto",
					at: DECISION_AT,
					metrics,
				}),
			).toMatchObject({
				status: "created",
				snapshot: { confidenceLower: 0, precisionB: 21 },
			});
		} finally {
			store.close();
		}
	});

	it("keeps one opinion when approval projects while its POST is in flight", async () => {
		const { store, questionId } = await fixture();
		try {
			store.refreshAutoNarrowOpinion({
				questionId,
				issueThreadId: "1517000000000000050",
				mode: "auto",
				at: DECISION_AT,
			});
			let envelope: AutoNarrowSourceEnvelopeV1 | undefined;
			expect(
				store.commitAutoNarrowSourceIfEligible({
					questionId,
					at: DECISION_AT,
					writeSource: ({ envelope: frozen }) => {
						envelope = frozen;
						return { written: true, replayed: false };
					},
				}),
			).toMatchObject({ status: "written" });
			const post = vi.fn(async () => {
				if (post.mock.calls.length === 1) {
					expect(store.getAutoNarrowOpinionDelivery(questionId)?.state).toBe(
						"posting",
					);
					expect(
						store.applyWorkflowSourceEvent({
							project: "flywheel",
							sourceEventId: `auto-narrow:${questionId}`,
							kind: "founder_approval",
							payloadJson: canonicalJsonString(envelope!),
							payloadDigest: canonicalSubmissionDigest(envelope!),
							schemaVersion: 1,
							at: "2026-09-09T03:01:01.000Z",
						}),
					).toMatchObject({ status: "applied" });
				}
				return { kind: "posted" as const, messageId: "1517000000000000060" };
			});
			const markCard = vi.fn(async () => true);
			const deps = {
				store,
				mode: "auto" as const,
				now: () => "2026-09-09T03:01:02.000Z",
				post,
				edit: async () => ({ ok: true }),
				scan: async () => ({
					kind: "found" as const,
					messageId: "1517000000000000060",
					frontier: "frontier-1",
				}),
				setReaction: async () => true,
				markCard,
			};
			await reconcileAutoNarrowOpinionDeliveries(deps);
			await reconcileAutoNarrowOpinionDeliveries(deps);
			await reconcileAutoNarrowOpinionDeliveries(deps);
			expect(post).toHaveBeenCalledOnce();
			expect(store.getAutoNarrowOpinionDelivery(questionId)).toMatchObject({
				state: "delivered",
				followupMessageId: "1517000000000000060",
			});
			expect(markCard).toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("resets the retry budget after successful opinion refresh deliveries", async () => {
		const { store, questionId } = await fixture();
		let now = DECISION_AT;
		const refresh = (sampleN: number) =>
			store.refreshAutoNarrowOpinion({
				questionId,
				issueThreadId: "1517000000000000050",
				mode: "auto",
				at: now,
				metrics: {
					...store.getAutoNarrowOpinionMetrics(now),
					sampleN,
					agreeN: sampleN,
					sampleStartAt: sampleN ? DECISION_AT : null,
					sampleEndAt: sampleN ? now : null,
				},
			});
		const edit = vi.fn(async () => ({ ok: true }));
		const deps = {
			store,
			mode: "auto" as const,
			now: () => now,
			post: vi.fn(async () => ({
				kind: "posted" as const,
				messageId: "1517000000000000060",
			})),
			edit,
			scan: vi.fn(async () => ({
				kind: "none" as const,
				frontier: "frontier-1",
			})),
			setReaction: async () => true,
			markCard: async () => true,
		};
		for (let cycle = 0; cycle < 8; cycle += 1) {
			refresh(cycle);
			expect((await reconcileAutoNarrowOpinionDeliveries(deps)).delivered).toBe(
				1,
			);
			now = new Date(Date.parse(now) + 1000).toISOString();
		}
		expect(deps.post).toHaveBeenCalledOnce();
		expect(edit).toHaveBeenCalledTimes(7);
		expect(store.getAutoNarrowOpinionDelivery(questionId)).toMatchObject({
			state: "delivered",
			attempt: 0,
		});
		refresh(8);
		edit.mockResolvedValueOnce({ ok: false });
		expect((await reconcileAutoNarrowOpinionDeliveries(deps)).deferred).toBe(1);
		const deferred = store.getAutoNarrowOpinionDelivery(questionId)!;
		expect(deferred).toMatchObject({ state: "pending", attempt: 1 });
		expect(store.listAutoNarrowOpinionDeliveryWork(20, now)).toEqual([]);
		now = deferred.nextAttemptAt!;
		expect(store.listAutoNarrowOpinionDeliveryWork(20, now)).toHaveLength(1);
		expect((await reconcileAutoNarrowOpinionDeliveries(deps)).delivered).toBe(
			1,
		);
		expect(store.getAutoNarrowOpinionDelivery(questionId)).toMatchObject({
			state: "delivered",
			attempt: 0,
		});
		store.close();
	});

	it("backs off persistent opinion failures and retires them after bounded attempts", async () => {
		const { store, questionId } = await fixture();
		store.refreshAutoNarrowOpinion({
			questionId,
			issueThreadId: "1517000000000000050",
			mode: "auto",
			controlAppliedAt: OPEN_AT,
			at: DECISION_AT,
		});
		let now = DECISION_AT;
		for (let expectedAttempt = 1; expectedAttempt <= 8; expectedAttempt += 1) {
			expect(store.listAutoNarrowOpinionDeliveryWork(20, now)).toHaveLength(1);
			const claimed = store.beginAutoNarrowOpinionDelivery(questionId, now);
			expect(claimed).toMatchObject({
				attempt: expectedAttempt,
				state: "posting",
			});
			expect(
				store.deferAutoNarrowOpinionDelivery({
					questionId,
					generation: claimed!.generation,
					state: "pending",
					errorCode: "reaction_failed",
					now,
				}),
			).toBe(true);
			const deferred = store.getAutoNarrowOpinionDelivery(questionId)!;
			if (expectedAttempt === 8) {
				expect(deferred).toMatchObject({
					state: "gone",
					nextAttemptAt: null,
					lastErrorCode: "reaction_failed",
				});
				expect(store.listAutoNarrowOpinionDeliveryWork(20, now)).toEqual([]);
				continue;
			}
			expect(deferred.state).toBe("pending");
			expect(deferred.nextAttemptAt).not.toBeNull();
			expect(Date.parse(deferred.nextAttemptAt!)).toBeGreaterThan(
				Date.parse(now),
			);
			expect(store.listAutoNarrowOpinionDeliveryWork(20, now)).toEqual([]);
			now = deferred.nextAttemptAt!;
		}
		store.close();
	});

	it.each(["uncertain", "posting"] as const)(
		"preserves %s recovery across metric-only opinion refreshes",
		async (state) => {
			const { store, questionId } = await fixture();
			let now = DECISION_AT;
			const refresh = (sampleN: number) =>
				store.refreshAutoNarrowOpinion({
					questionId,
					issueThreadId: "1517000000000000050",
					mode: "auto",
					at: now,
					metrics: {
						...store.getAutoNarrowOpinionMetrics(now),
						sampleN,
						agreeN: sampleN,
						sampleStartAt: DECISION_AT,
						sampleEndAt: now,
					},
				});
			refresh(7);
			const claimed = store.beginAutoNarrowOpinionDelivery(questionId, now)!;
			if (state === "uncertain") {
				expect(
					store.deferAutoNarrowOpinionDelivery({
						questionId,
						generation: claimed.generation,
						state,
						errorCode: "post_uncertain",
						now,
					}),
				).toBe(true);
			}
			const before = store.getAutoNarrowOpinionDelivery(questionId)!;
			refresh(8);
			const after = store.getAutoNarrowOpinionDelivery(questionId)!;
			expect(after.desiredOpinionId).not.toBe(before.desiredOpinionId);
			expect(after).toEqual({
				...before,
				desiredOpinionId: after.desiredOpinionId,
			});
			const post = vi.fn(async () => ({
				kind: "posted" as const,
				messageId: "1517000000000000060",
			}));
			const scan = vi.fn(async () => ({
				kind: "none" as const,
				frontier: "frontier-1",
			}));
			const deps = {
				store,
				mode: "auto" as const,
				now: () => now,
				post,
				scan,
				edit: async () => ({ ok: true }),
				setReaction: async () => true,
				markCard: async () => true,
			};
			now = before.nextAttemptAt ?? now;
			await reconcileAutoNarrowOpinionDeliveries(deps);
			expect(scan).toHaveBeenCalledOnce();
			expect(post).not.toHaveBeenCalled();
			const firstScan = store.getAutoNarrowOpinionDelivery(questionId)!;
			expect(firstScan).toMatchObject({
				state: "uncertain",
				firstZeroScanAt: now,
				scanFrontier: "frontier-1",
			});
			refresh(9);
			const refreshed = store.getAutoNarrowOpinionDelivery(questionId)!;
			expect(refreshed).toEqual({
				...firstScan,
				desiredOpinionId: refreshed.desiredOpinionId,
			});
			await reconcileAutoNarrowOpinionDeliveries(deps);
			expect(scan).toHaveBeenCalledOnce();
			expect(post).not.toHaveBeenCalled();
			now = firstScan.nextAttemptAt!;
			expect(
				Date.parse(now) - Date.parse(firstScan.firstZeroScanAt!),
			).toBeGreaterThanOrEqual(30000);
			await reconcileAutoNarrowOpinionDeliveries(deps);
			expect(scan).toHaveBeenCalledTimes(2);
			expect(post).not.toHaveBeenCalled();
			expect(store.getAutoNarrowOpinionDelivery(questionId)?.state).toBe(
				"pending",
			);
			await reconcileAutoNarrowOpinionDeliveries(deps);
			await reconcileAutoNarrowOpinionDeliveries(deps);
			expect(post).toHaveBeenCalledOnce();
			expect(store.getAutoNarrowOpinionDelivery(questionId)).toMatchObject({
				state: "delivered",
				attempt: 0,
			});
			store.close();
		},
	);

	it("paces uncertain delivery recovery scans before allowing a repost", async () => {
		const { store, questionId } = await fixture();
		store.refreshAutoNarrowOpinion({
			questionId,
			issueThreadId: "1517000000000000050",
			mode: "auto",
			controlAppliedAt: OPEN_AT,
			at: DECISION_AT,
		});
		const claimed = store.beginAutoNarrowOpinionDelivery(
			questionId,
			DECISION_AT,
		)!;
		expect(
			store.deferAutoNarrowOpinionDelivery({
				questionId,
				generation: claimed.generation,
				state: "uncertain",
				errorCode: "post_uncertain",
				now: DECISION_AT,
			}),
		).toBe(true);
		const firstDue =
			store.getAutoNarrowOpinionDelivery(questionId)!.nextAttemptAt!;
		expect(Date.parse(firstDue)).toBeGreaterThan(Date.parse(DECISION_AT));
		expect(store.listAutoNarrowOpinionDeliveryWork(20, DECISION_AT)).toEqual(
			[],
		);
		expect(
			store.recordAutoNarrowOpinionRecovery({
				questionId,
				kind: "none",
				now: firstDue,
				frontier: "frontier-1",
			}),
		).toBe("waiting");
		const afterFirstScan = store.getAutoNarrowOpinionDelivery(questionId)!;
		expect(afterFirstScan).toMatchObject({
			state: "uncertain",
			firstZeroScanAt: firstDue,
		});
		expect(Date.parse(afterFirstScan.nextAttemptAt!)).toBeGreaterThan(
			Date.parse(firstDue),
		);
		expect(store.listAutoNarrowOpinionDeliveryWork(20, firstDue)).toEqual([]);
		expect(
			store.recordAutoNarrowOpinionRecovery({
				questionId,
				kind: "none",
				now: afterFirstScan.nextAttemptAt!,
				frontier: "frontier-1",
			}),
		).toBe("retry");
		expect(store.getAutoNarrowOpinionDelivery(questionId)).toMatchObject({
			state: "pending",
			nextAttemptAt: null,
		});
		store.close();
	});

	it("bounds Discord opinion writes with an abort signal", async () => {
		const { store, questionId } = await fixture();
		store.refreshAutoNarrowOpinion({
			questionId,
			issueThreadId: "1517000000000000050",
			mode: "auto",
			controlAppliedAt: OPEN_AT,
			at: DECISION_AT,
		});
		const post = vi.fn(async (input: { signal?: AbortSignal }) => {
			expect(input.signal).toBeInstanceOf(AbortSignal);
			expect(input.signal?.aborted).toBe(false);
			return { kind: "failed" as const };
		});
		await reconcileAutoNarrowOpinionDeliveries({
			store,
			mode: "auto",
			now: () => DECISION_AT,
			post,
			edit: async () => ({ ok: true }),
			scan: async () => ({ kind: "none", frontier: null }),
			setReaction: async () => true,
			markCard: async () => true,
		});
		expect(post).toHaveBeenCalledOnce();
		store.close();
	});

	it("freezes the three gates, survives a later stop, and atomically activates land", async () => {
		const { store, questionId } = await fixture();
		let envelope: AutoNarrowSourceEnvelopeV1 | undefined;
		rawDb(store).pragma("busy_timeout = 777");
		expect(
			store.evaluateAutoNarrowCandidate(questionId, DECISION_AT),
		).toMatchObject({
			observation: {
				machine_class: "docs_only",
				machine_reason: null,
			},
			eligibility: {
				eligible: true,
				gate1: true,
				gate2: true,
				gate3: true,
			},
		});
		expect(
			store.commitAutoNarrowSourceIfEligible({
				questionId,
				at: DECISION_AT,
				writeSource: ({ envelope: frozen }) => {
					expect(rawDb(store).pragma("busy_timeout", { simple: true })).toBe(0);
					envelope = frozen;
					return { written: true, replayed: false };
				},
			}),
		).toMatchObject({ status: "written" });
		expect(rawDb(store).pragma("busy_timeout", { simple: true })).toBe(777);
		expect(envelope).toBeDefined();

		expect(
			store.applyAutoNarrowControlChange({
				eventId: "22222222-2222-4222-8222-222222222222",
				projectName: "flywheel",
				mode: "dry_run",
				expectedChangeSeq: 1,
				founderMessageId: "1517000000000000002",
				founderChannelId: "1516209714097291335",
				founderAuthorId: "1138241636057481306",
				messageCreatedAt: "2026-09-09T03:01:01.000Z",
				messageDigest: "e".repeat(64),
				commandText: "现在停止",
				executedBy: "flywheel-eng-lead",
				reason: "founder 1517000000000000002",
				now: Date.parse("2026-09-09T03:01:02.000Z"),
			}),
		).toMatchObject({ ok: true });
		expect(
			store.commitAutoNarrowSourceIfEligible({
				questionId,
				at: "2026-09-09T03:01:03.000Z",
				writeSource: () => ({ written: true, replayed: false }),
			}),
		).toEqual({ status: "not_auto" });

		const payloadJson = canonicalJsonString(envelope!);
		const source = {
			project: "flywheel",
			sourceEventId: `auto-narrow:${questionId}`,
			kind: "founder_approval" as const,
			payloadJson,
			payloadDigest: canonicalSubmissionDigest(envelope!),
			schemaVersion: 1,
			at: "2026-09-09T03:01:04.000Z",
		};
		expect(store.applyWorkflowSourceEvent(source)).toMatchObject({
			kind: "founder_claim",
			status: "applied",
		});
		expect(store.getWorkflowRun("run-auto")).toMatchObject({
			status: "active",
			current_node_id: "land",
		});
		expect(
			store.getCurrentWorkflowGateHolder("run-auto", "founder_gate"),
		).toMatchObject({ state: "approved" });
		expect(store.applyWorkflowSourceEvent(source)).toMatchObject({
			kind: "founder_claim",
			status: "replayed",
		});
		expect(
			rawDb(store)
				.prepare(
					`SELECT decision_source, control_event_id, opening_event_id,
					        declaration_id, s2_basis_record_id
					   FROM auto_narrow_decision_audit`,
				)
				.all(),
		).toEqual([
			{
				decision_source: "auto_narrow_gate",
				control_event_id: "11111111-1111-4111-8111-111111111111",
				opening_event_id: "11111111-1111-4111-8111-111111111111",
				declaration_id: "33333333-3333-4333-8333-333333333333",
				s2_basis_record_id: "44444444-4444-4444-8444-444444444444",
			},
		]);
		expect(store.listAutoMergeShadowObservations()).toHaveLength(1);
		expect(store.listFounderGateVerdicts()).toMatchObject([
			{ founder_authored: 0, verdict: "approved" },
		]);
		store.close();
	});

	it("fails fast on a StateStore writer lock, restores timeout, and retries after release", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2453-state-lock-"));
		const statePath = join(root, "teamlead.db");
		let store: StateStore | undefined;
		let locker: Database.Database | undefined;
		try {
			({ store } = await fixture(statePath));
			const holder = store.getCurrentWorkflowGateHolder(
				"run-auto",
				"founder_gate",
			);
			if (!holder) throw new Error("missing holder");
			rawDb(store).pragma("busy_timeout = 777");
			locker = new Database(statePath);
			locker.pragma("busy_timeout = 0");
			locker.exec("BEGIN IMMEDIATE");
			const writeSource = vi.fn(() => ({ written: true, replayed: false }));
			const started = Date.now();
			expect(() =>
				store!.commitAutoNarrowSourceIfEligible({
					questionId: holder.question_id,
					at: DECISION_AT,
					writeSource,
				}),
			).toThrow(/busy|locked/i);
			expect(Date.now() - started).toBeLessThan(250);
			expect(writeSource).not.toHaveBeenCalled();
			expect(rawDb(store).pragma("busy_timeout", { simple: true })).toBe(777);
			locker.exec("ROLLBACK");
			locker.close();
			locker = undefined;
			expect(
				store.commitAutoNarrowSourceIfEligible({
					questionId: holder.question_id,
					at: DECISION_AT,
					writeSource,
				}),
			).toMatchObject({ status: "written" });
		} finally {
			if (locker) {
				try {
					locker.exec("ROLLBACK");
				} catch {}
				locker.close();
			}
			store?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("529 isolated two-database path approves, projects, activates land, and delivers fake Discord effects", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2453-529-"));
		const statePath = join(root, "teamlead.db");
		const commPath = join(root, "comm.db");
		let store: StateStore | undefined;
		let comm: CommDB | undefined;
		try {
			({ store } = await fixture(statePath));
			const holder = store.getCurrentWorkflowGateHolder(
				"run-auto",
				"founder_gate",
			);
			if (!holder) throw new Error("missing 529 holder");
			const questionId = holder.question_id;
			comm = new CommDB(commPath);
			comm.insertQuestion("implement-auto", "flywheel-eng-lead", "ship?", {
				id: questionId,
				checkpoint: "approve_to_ship",
			});

			store.refreshAutoNarrowOpinion({
				questionId,
				issueThreadId: "1517000000000000050",
				mode: "auto",
				controlAppliedAt: OPEN_AT,
				at: DECISION_AT,
			});
			const posts: string[] = [];
			const reactions: string[] = [];
			const banners: string[] = [];
			await reconcileAutoNarrowOpinionDeliveries({
				store,
				mode: "auto",
				now: () => DECISION_AT,
				post: async ({ content }) => {
					posts.push(content);
					return { kind: "posted", messageId: "1517000000000000060" };
				},
				edit: async () => ({ ok: true }),
				scan: async () => ({ kind: "none", frontier: "529-frontier" }),
				setReaction: async ({ reaction }) => {
					reactions.push(reaction);
					return true;
				},
				markCard: async ({ banner }) => {
					banners.push(banner);
					return true;
				},
			});

			expect(
				store.commitAutoNarrowSourceIfEligible({
					questionId,
					at: DECISION_AT,
					writeSource: ({
						expectedOwner,
						projectedThroughSourceRowId,
						envelope,
					}) =>
						comm!.insertAutoNarrowApprovalWithSource({
							project: "flywheel",
							expectedOwner,
							projectedThroughSourceRowId,
							envelope,
						}),
				}),
			).toMatchObject({ status: "written" });
			expect(comm.getResponse(questionId)).toMatchObject({
				from_agent: "bridge-auto-narrow-gate",
			});
			const source = comm.listWorkflowSourceEvents()[0];
			if (!source) throw new Error("missing 529 source");
			expect(
				store.applyWorkflowSourceEvent({
					project: source.project,
					sourceEventId: source.source_event_id,
					kind: source.kind,
					payloadJson: source.payload,
					payloadDigest: source.payload_digest,
					schemaVersion: source.schema_version,
					at: source.at,
				}),
			).toMatchObject({ kind: "founder_claim", status: "applied" });
			expect(store.getWorkflowRun("run-auto")).toMatchObject({
				current_node_id: "land",
			});

			await reconcileAutoNarrowOpinionDeliveries({
				store,
				mode: "auto",
				now: () => "2026-09-09T03:01:01.000Z",
				post: async () => ({
					kind: "posted",
					messageId: "1517000000000000061",
				}),
				edit: async () => ({ ok: true }),
				scan: async () => ({ kind: "none", frontier: "529-frontier" }),
				setReaction: async ({ reaction }) => {
					reactions.push(reaction);
					return true;
				},
				markCard: async ({ banner }) => {
					banners.push(banner);
					return true;
				},
			});

			expect(posts).toHaveLength(1);
			expect(posts[0]).toContain(
				"闸① 机器判纯文档 ✓ · 闸② Lead代理声明 pure_docs ✓ · 闸③ 强度二证据 ✓",
			);
			expect(reactions).toContain("eligible");
			expect(banners).toEqual([
				`窄口自动批（开关由 founder 于 ${OPEN_AT} 打开）`,
			]);
			expect(
				rawDb(store)
					.prepare(
						`SELECT a.decision_source, c.founder_message_id,
						        (SELECT COUNT(*) FROM workflow_founder_gate_verdict) AS verdicts,
						        (SELECT COUNT(*) FROM auto_merge_shadow_observation) AS observations,
						        (SELECT COUNT(*) FROM auto_merge_shadow_declaration) AS declarations,
						        (SELECT COUNT(*) FROM strength_two_evidence_record) AS strength_two
						   FROM auto_narrow_decision_audit a
						   JOIN auto_narrow_control_event c ON c.event_id = a.control_event_id`,
					)
					.get(),
			).toEqual({
				decision_source: "auto_narrow_gate",
				founder_message_id: "1517000000000000001",
				verdicts: 1,
				observations: 1,
				declarations: 1,
				strength_two: 1,
			});
			console.log(
				`FLY-2453 529 receipt state_db=${statePath} comm_db=${commPath} fake_founder=1138241636057481306 fake_discord=1517000000000000050 source=1 audit=1 verdict=1 observation=1 declaration=1 strength_two=1 opinion=1 reaction=eligible land=activated`,
			);
		} finally {
			comm?.close();
			store?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("excludes founder samples whose four shadow lines are incomplete", async () => {
		const { store, questionId } = await fixture();
		store.refreshAutoNarrowOpinion({
			questionId,
			issueThreadId: "1517000000000000050",
			mode: "auto",
			controlAppliedAt: OPEN_AT,
			at: "2026-09-09T03:00:30.000Z",
		});
		insertFounderRework(store, questionId);
		expect(
			store.refreshAutoNarrowOpinion({
				questionId,
				issueThreadId: "1517000000000000050",
				mode: "auto",
				controlAppliedAt: OPEN_AT,
				at: DECISION_AT,
			}),
		).toMatchObject({
			status: "created",
			snapshot: { sampleN: 0, agreeN: 0, precisionA: 0, precisionB: 0 },
		});
		store.close();
	});

	it("keeps the rolling opinion cohort project-local", async () => {
		const { store, questionId } = await fixture();
		store.refreshAutoNarrowOpinion({
			questionId,
			issueThreadId: "1517000000000000050",
			mode: "auto",
			controlAppliedAt: OPEN_AT,
			at: "2026-09-09T03:00:30.000Z",
		});
		const evaluation = store.evaluateAutoNarrowCandidate(
			questionId,
			"2026-09-09T03:00:45.000Z",
		);
		if (!evaluation) throw new Error("missing candidate evaluation");
		insertFounderRework(store, questionId);
		const internals = store as unknown as {
			insertAutoMergeShadowObservationTx(row: unknown): void;
			autoNarrowMetricSamplesTx(
				projectName: string,
				at: string,
			): Array<{ questionId: string }>;
		};
		internals.insertAutoMergeShadowObservationTx({
			...evaluation.observation,
			verdict_id: "founder-rework-verdict",
			observed_at: "2026-09-09T03:00:45.000Z",
		});
		rawDb(store)
			.prepare(
				"UPDATE workflow_run SET project_name = 'other-project' WHERE run_id = 'run-auto'",
			)
			.run();
		expect(
			internals.autoNarrowMetricSamplesTx("flywheel", DECISION_AT),
		).toEqual([]);
		store.close();
	});

	it("never auto-approves a repo/head the founder has sent back", async () => {
		const { store, questionId } = await fixture();
		insertFounderRework(store, questionId);
		expect(
			store.evaluateAutoNarrowCandidate(questionId, DECISION_AT),
		).toMatchObject({
			hasFounderRework: true,
			eligibility: { eligible: false, reasonCode: "negative_guard" },
		});
		const writeSource = vi.fn(() => ({ written: true, replayed: false }));
		expect(
			store.commitAutoNarrowSourceIfEligible({
				questionId,
				at: DECISION_AT,
				writeSource,
			}),
		).toEqual({ status: "ineligible" });
		expect(writeSource).not.toHaveBeenCalled();
		store.close();
	});

	it("rolls back the claim, verdict, audit, and holder when strict observation insertion fails", async () => {
		const { store, questionId } = await fixture();
		let envelope: AutoNarrowSourceEnvelopeV1 | undefined;
		store.commitAutoNarrowSourceIfEligible({
			questionId,
			at: DECISION_AT,
			writeSource: ({ envelope: frozen }) => {
				envelope = frozen;
				return { written: true, replayed: false };
			},
		});
		rawDb(store).exec(`CREATE TRIGGER fail_auto_observation
			BEFORE INSERT ON auto_merge_shadow_observation
			BEGIN SELECT RAISE(ABORT, 'fixture strict observation failure'); END;`);
		const payloadJson = canonicalJsonString(envelope!);
		expect(() =>
			store.applyWorkflowSourceEvent({
				project: "flywheel",
				sourceEventId: `auto-narrow:${questionId}`,
				kind: "founder_approval",
				payloadJson,
				payloadDigest: canonicalSubmissionDigest(envelope!),
				schemaVersion: 1,
			}),
		).toThrow(/strict observation failure/);
		expect(store.countWorkflowClaims("run-auto")).toBe(0);
		expect(store.listFounderGateVerdicts()).toEqual([]);
		expect(store.listAutoMergeShadowObservations()).toEqual([]);
		expect(
			rawDb(store).prepare("SELECT * FROM auto_narrow_decision_audit").all(),
		).toEqual([]);
		expect(
			store.getCurrentWorkflowGateHolder("run-auto", "founder_gate"),
		).toMatchObject({ state: "awaiting_review" });
		store.close();
	});
});

// Preserve QA attempt 1 writer-level mutation controls in CI.
describe("QA writer-level three-gate negatives", () => {
	function assertNoAutoApproval(store: StateStore, questionId: string): void {
		let sawWrite = false;
		const result = store.commitAutoNarrowSourceIfEligible({
			questionId,
			at: DECISION_AT,
			writeSource: () => {
				sawWrite = true;
				return { written: true, replayed: false };
			},
		});
		expect(sawWrite).toBe(false);
		expect(result).toEqual({ status: "ineligible" });
		expect(
			rawDb(store).prepare("SELECT * FROM auto_narrow_decision_audit").all(),
		).toEqual([]);
		expect(store.listAutoMergeShadowObservations()).toHaveLength(0);
		expect(store.listFounderGateVerdicts()).toHaveLength(0);
		expect(
			store.getCurrentWorkflowGateHolder("run-auto", "founder_gate"),
		).toMatchObject({ state: "awaiting_review" });
		expect(store.getWorkflowRun("run-auto")).toMatchObject({
			current_node_id: "founder_gate",
		});
	}

	it("positive control: all three gates pass and the writer freezes a source", async () => {
		const { store, questionId } = await fixture();
		let sawWrite = false;
		expect(
			store.commitAutoNarrowSourceIfEligible({
				questionId,
				at: DECISION_AT,
				writeSource: () => {
					sawWrite = true;
					return { written: true, replayed: false };
				},
			}),
		).toMatchObject({ status: "written" });
		expect(sawWrite).toBe(true);
		store.close();
	});

	it("gate1 negative: machine class ship_relevant blocks the writer", async () => {
		const { store, questionId } = await fixture();
		store.putShipRelevantPrSnapshot({
			execution_id: "implement-auto",
			repo_slug: "xrliAnnie/flywheel",
			pr_number: 1453,
			pr_head_sha: HEAD,
			role: "primary",
			base_ref: "main",
			base_oid: "c".repeat(40),
			classifier_version: SHIP_RELEVANT_CLASSIFIER_VERSION,
			ship_relevant: 1,
			file_count: 2,
			sample_paths: ["packages/teamlead/src/StateStore.ts"],
			commit_shas: [HEAD],
			computed_at: "2026-09-09T03:00:31.000Z",
		});
		assertNoAutoApproval(store, questionId);
		expect(
			store.evaluateAutoNarrowCandidate(questionId, DECISION_AT),
		).toMatchObject({
			eligibility: { gate1: false, gate2: true, gate3: true },
		});
		store.close();
	});

	it("gate2 negative: latest Lead declaration config_only blocks the writer", async () => {
		const { store, questionId } = await fixture();
		expect(
			store.recordAutoMergeShadowDeclaration({
				declarationId: "33333333-3333-4333-8333-333333333334",
				questionId,
				runId: "run-auto",
				declaredClass: "config_only",
				declaredBy: "flywheel-eng-lead",
				discordChannelId: "1516209714097291335",
				discordMessageId: "1517000000000000031",
				discordAuthorUserId: "1138241636057481306",
				messageTs: "2026-09-09T02:59:20.000Z",
				declaredAt: "2026-09-09T02:59:20.000Z",
			}),
		).toMatchObject({ ok: true });
		assertNoAutoApproval(store, questionId);
		expect(
			store.evaluateAutoNarrowCandidate(questionId, DECISION_AT),
		).toMatchObject({
			eligibility: { gate1: true, gate2: false, gate3: true },
		});
		store.close();
	});

	it("gate3 negative: strength-two evidence absent blocks the writer", async () => {
		const { store, questionId } = await fixture(":memory:", true);
		assertNoAutoApproval(store, questionId);
		expect(
			store.evaluateAutoNarrowCandidate(questionId, DECISION_AT),
		).toMatchObject({
			eligibility: { gate1: true, gate2: true, gate3: false },
		});
		store.close();
	});
});
