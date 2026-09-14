import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { expect, it, vi } from "vitest";
import { makeFounderShipApprovalCallback } from "../../bridge/approval-signal/founder-ship-approval-factory.js";
import { makeGateAuthorityView } from "../../bridge/approval-signal/gate-authority-view.js";
import { drainWorkflowSourceEvents } from "../../bridge/founder-approval-projector.js";
import { emitFounderReplyDeliveryForThread } from "../../bridge/founder-reply-deliverer.js";
import { createShipJudgmentReplyObserver } from "../../bridge/ship-judgment-routes.js";
import { InMemoryInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";
import { buildWorkflowRunSnapshotV1 } from "../../workflow-run-snapshot.js";
import { canonicalDigest } from "../contract.js";
import { LearningDelivery } from "../learning-delivery.js";
import { bindingFixture, CHANNEL, HEAD, NOW } from "./binding-fixture.js";

function landSnapshot(): string {
	return JSON.stringify(
		buildWorkflowRunSnapshotV1({
			template: { id: "tpl_eng_heavy_land_v1", revision: 1 },
			manifest: {
				schema_version: 1,
				manifest_variant: "land_v1",
				nodes: [
					{
						id: "design",
						type: "design",
						vendor: "claude",
						model: "claude-fable-5",
					},
					{
						id: "implement",
						type: "implement",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "xhigh",
					},
					{
						id: "qa",
						type: "qa",
						vendor: "claude",
						model: "claude-opus-5",
					},
					{ id: "founder_gate", type: "gate" },
					{ id: "land", type: "land", execution: "engine" },
				],
				edges: [
					{
						id: "design_done",
						from: "design",
						to: "implement",
						condition: "design_done",
					},
					{
						id: "implement_done",
						from: "implement",
						to: "qa",
						condition: "implement_done",
					},
					{
						id: "qa_pass",
						from: "qa",
						to: "founder_gate",
						condition: "qa_pass",
					},
					{
						id: "founder_approved",
						from: "founder_gate",
						to: "land",
						condition: "founder_approved",
					},
				],
				loops: [
					{
						id: "qa_retry",
						from: "qa",
						to: "implement",
						loop_when: "qa_fail",
						exit_when: "qa_pass",
						max_iterations: 3,
						on_limit: "escalate",
					},
					{
						id: "founder_feedback",
						from: "founder_gate",
						to: "implement",
						loop_when: "founder_feedback_kickback",
						exit_when: "founder_approved",
						max_iterations: 3,
						on_limit: "escalate",
					},
				],
				approval_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				terminal_node: { node: "land" },
				ship_claims: ["qa_passed", "founder_approved"],
			},
		}),
	);
}

function publishOpinion(
	store: Awaited<ReturnType<typeof bindingFixture>>["store"],
	decision: "approve" | "reject",
) {
	const now = Date.parse(NOW),
		iso = (offset: number) => new Date(now + offset).toISOString();
	const binding = store.readShipJudgmentBinding("q", CHANNEL)!,
		bindingDigest = canonicalDigest(binding);
	const frozen = store.getShipJudgmentInputs().freeze(
		{
			questionId: "q",
			channelId: CHANNEL,
			bindingDigest,
			targets: [
				{
					repo_identity: "__main__",
					pr_number: 2399,
					head_sha: HEAD,
					diff_base_sha: "b".repeat(40),
				},
			],
			sources: [],
			files: [],
			requirements: [],
			prompt: "fixture",
			model: {
				model: "fixture",
				effort: "high",
				configuration_digest: "c".repeat(64),
			},
		},
		NOW,
	);
	if (frozen.status !== "created") throw new Error(frozen.status);
	const jobs = store.getShipJudgmentJobs(),
		job = jobs.claim(frozen.inputId, "worker", now);
	if (job.status !== "claimed") throw new Error(job.status);
	jobs.markSpawned(job, now);
	jobs.finish(
		job,
		{
			alignment: decision === "approve" ? "fail" : "pass",
			coverage: "pass",
			result: {},
			resultCode: "ok",
			durationMs: 1,
			usage: null,
			costUsd: null,
		},
		now + 1,
	);
	const opinion = store.getShipJudgmentOpinions().offer(
		{
			questionId: "q",
			channelId: CHANNEL,
			bindingDigest,
			inputId: frozen.inputId,
			reason: "evaluated",
			mechanical: {
				verdict: "pass",
				reason: "clean",
				digest: "d".repeat(64),
				checkedAt: iso(2),
				scope: "main",
				checkedRepos: 1,
				openPrCount: 0,
				overlaps: [],
			},
		},
		now + 2,
	);
	if (opinion.status !== "created") throw new Error(opinion.status);
	const delivery = store.getShipJudgmentDelivery(),
		claim = delivery.claim("q", CHANNEL, "sender", now + 2);
	if (claim.status !== "claimed") throw new Error(claim.status);
	const visible = 3;
	delivery.confirm(claim, "123456789012345681", iso(visible), now + visible);
}

// Materialize a new current card while retaining a completed run's unanswered
// clarification in the same original thread. This is fixture setup, not a dispatch.
function openNextCard(
	store: Awaited<ReturnType<typeof bindingFixture>>["store"],
	raw: Awaited<ReturnType<typeof bindingFixture>>["db"],
) {
	raw
		.prepare("UPDATE workflow_run SET status='terminated' WHERE run_id='r'")
		.run();
	store.createWorkflowRun({
		runId: "r-next",
		issueId: "FLY-2399",
		projectName: "flywheel",
		claimsReadEnrolled: true,
		snapshotJson: landSnapshot(),
	});
	raw
		.prepare(
			"UPDATE workflow_run SET engine_owned=1,current_node_id='founder_gate' WHERE run_id='r-next'",
		)
		.run();
	store.upsertWorkflowRunNode({
		runId: "r-next",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "execution-next",
	});
	store.upsertWorkflowRunNode({
		runId: "r-next",
		nodeId: "founder_gate",
		attempt: 1,
		state: "review",
	});
	raw
		.prepare(`INSERT INTO workflow_gate_holder(run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,authority_mode,subject_kind,carrier_binding_state,card_message_id,state,materialization_stage,created_at,updated_at)
 SELECT 'r-next',gate_node_id,1,head_sha,'execution-next','q-next',authority_mode,subject_kind,carrier_binding_state,'123456789012345693','awaiting_review','completed',created_at,updated_at FROM workflow_gate_holder WHERE question_id='q'`)
		.run();
	raw
		.prepare(`INSERT INTO workflow_node_pr_binding(run_id,node_id,attempt,pr_number,head_sha,target_repo_identity,probe_repo_slug,target_repo_path,worktree_binding_generation,receipt_id,bound_at)
 SELECT 'r-next','implement',1,pr_number,head_sha,target_repo_identity,probe_repo_slug,target_repo_path,worktree_binding_generation,'receipt-next',bound_at FROM workflow_node_pr_binding WHERE run_id='r' AND node_id='implement'`)
		.run();
	raw
		.prepare(`INSERT INTO workflow_ship_target_binding(approve_question_id,run_id,target_repo_path,target_repo_identity,probe_repo_slug,frozen_head_sha,worktree_binding_generation)
 SELECT 'q-next','r-next',target_repo_path,target_repo_identity,probe_repo_slug,frozen_head_sha,worktree_binding_generation FROM workflow_ship_target_binding WHERE approve_question_id='q'`)
		.run();
	store.upsertSession({
		execution_id: "execution-next",
		issue_id: "FLY-2399",
		project_name: "flywheel",
		status: "awaiting_review",
	});
	raw
		.prepare(
			"UPDATE sessions SET pr_head_sha=?,review_question_id='q-next' WHERE execution_id='execution-next'",
		)
		.run(HEAD);
}

it.each(["approve", "reject"] as const)(
	"keeps real %s authority immutable when the resulting clarification receives opposite verdict words",
	async (decision) => {
		const { store, db: raw } = await bindingFixture();
		const dir = mkdtempSync(join(tmpdir(), "judgment-authority-"));
		const dbPath = join(dir, "comm.db");
		const comm = new CommDB(dbPath);
		const founder = "123456789012345680",
			thread = "123456789012345679",
			card = "123456789012345678";
		try {
			raw
				.prepare(
					"UPDATE workflow_run SET snapshot=?,engine_owned=1,current_node_id='founder_gate' WHERE run_id='r'",
				)
				.run(landSnapshot());
			store.upsertSession({
				execution_id: "execution",
				issue_id: "FLY-2399",
				project_name: "flywheel",
				status: "awaiting_review",
			});
			raw
				.prepare(
					"UPDATE sessions SET pr_head_sha=?,review_question_id='q' WHERE execution_id='execution'",
				)
				.run(HEAD);
			raw.exec(
				"UPDATE workflow_run_node SET state='review' WHERE node_id='founder_gate'",
			);
			raw
				.prepare(
					"UPDATE sessions SET issue_labels=? WHERE execution_id='execution'",
				)
				.run(JSON.stringify(["Engineering"]));
			publishOpinion(store, decision);
			const authority = makeGateAuthorityView(store);
			expect(authority.resolve("q", "execution")).toMatchObject({
				state: "awaiting_review",
				headSha: HEAD,
			});
			comm.registerSession(
				"execution",
				"runner",
				"flywheel",
				"FLY-2399",
				"test-lead",
			);
			comm.insertQuestion("execution", "test-lead", "ship?", {
				id: "q",
				checkpoint: "approve_to_ship",
			});
			expect(comm.getPendingQuestions("test-lead").map((x) => x.id)).toContain(
				"q",
			);
			expect(Date.now()).toBeGreaterThan(Date.parse(NOW));
			const apply = vi.spyOn(store, "applyWorkflowSourceEvent");
			const project = async () =>
				drainWorkflowSourceEvents({
					projects: ["flywheel"],
					openCommDb: () => new CommDB(dbPath, false),
					store,
				});
			const approve = vi.fn(
				makeFounderShipApprovalCallback({
					store,
					gateAuthorityView: authority,
					discordOwnerUserId: founder,
					onResponseWritten: async () => {
						await project();
					},
				}),
			);
			const observer = createShipJudgmentReplyObserver({
				store,
				projects: [],
				mode: () => "dry_run",
				canonicalFounderId: () => founder,
			});
			const msgId = (
				(BigInt(Date.now() - 1000) - 1420070400000n) <<
				22n
			).toString();
			const cursor = new InMemoryInboundCursorStore();
			cursor.save(
				thread,
				((BigInt(Date.now() - 3600000) - 1420070400000n) << 22n).toString(),
			);
			expect(store.getSession("execution")).toMatchObject({
				pr_head_sha: HEAD,
			});
			const outcome = await emitFounderReplyDeliveryForThread(
				{
					issueId: "FLY-2399",
					projectName: "flywheel",
					threadId: thread,
					botToken: "fixture",
					ownerUserId: founder,
					graceMs: 0,
					commDbPath: dbPath,
					leadId: "test-lead",
				},
				[
					{
						questionId: "q",
						checkpoint: "approve_to_ship",
						executionId: "execution",
						createdAtMs: Date.parse(NOW),
					},
				],
				{
					store,
					cursorStore: cursor,
					commDbLeaseFactory: () => ({ db: comm, release: () => {} }),
					fetchImpl: vi.fn(
						async () =>
							new Response(
								JSON.stringify([
									{
										id: msgId,
										content: decision === "approve" ? "通过" : "打回",
										author: { id: founder, bot: false },
										type: 19,
										message_reference: {
											type: 0,
											message_id: card,
											channel_id: thread,
										},
									},
								]),
								{ status: 200 },
							),
					) as typeof fetch,
					tryFounderShipApproval: approve,
					observeShipJudgmentReply: observer,
					readCurrentBinding: () => ({
						questionId: "q",
						executionId: "execution",
						issueId: "FLY-2399",
						prHeadSha: HEAD,
						threadId: thread,
						gateMessageId: card,
						checkpoint: "approve_to_ship",
						postedAt: NOW,
					}),
				},
			);
			expect(outcome, JSON.stringify(outcome)).toMatchObject({
				result: "advanced",
			});
			expect(approve).toHaveBeenCalledOnce();
			expect(comm.getResponse("q")).toBeDefined();
			const drained = await project();
			expect(
				store.listFounderGateVerdicts({ runId: "r" }),
				JSON.stringify({
					drained,
					errors: apply.mock.results.map((x) => String(x.value)),
				}),
			).toHaveLength(1);
			expect(store.listFounderGateVerdicts({ runId: "r" })[0]).toMatchObject({
				verdict: decision === "approve" ? "approved" : "rework",
				founder_authored: 1,
				question_id: "q",
				head_sha: HEAD,
			});
			const before = store.listFounderGateVerdicts({ runId: "r" });
			const source = comm.listWorkflowSourceEvents()[0]!;
			expect(JSON.parse(before[0]!.author_evidence_json)).toMatchObject({
				kind: "gate_response",
				actor: founder,
				founder_id_at_capture: founder,
				source_event_id: source.source_event_id,
			});
			expect(before[0]!.recorded_at).toBe(source.at);
			await project();
			expect(store.listFounderGateVerdicts({ runId: "r" })).toEqual(before);
			// Only a real founder outcome can create this question. No synthetic B2 rows.
			const observedAt = new Date().toISOString();
			expect(store.getShipJudgmentOutcomes().observeVerdicts(observedAt)).toBe(
				1,
			);
			const clarifications = store.getShipJudgmentClarifications(
				() => "dry_run",
			);
			expect(clarifications.sweep()).toBe(1);
			const root = raw
				.prepare(
					"SELECT clarification_id FROM ship_judgment_clarification WHERE supersedes IS NULL",
				)
				.get() as { clarification_id: string } | undefined;
			expect(root).toBeDefined();
			const learningDelivery = new LearningDelivery(raw, () => "dry_run");
			const postedAt = Date.now();
			const lease = learningDelivery.claim(
				"clarification",
				root!.clarification_id,
				"sender",
				postedAt,
			);
			if (lease.status !== "claimed") throw new Error(lease.status);
			const clarificationMessage = "123456789012345692";
			expect(
				learningDelivery.confirm(
					lease,
					clarificationMessage,
					new Date(postedAt).toISOString(),
					postedAt,
				),
			).toBe(true);
			const explanationId = (
				(BigInt(postedAt) - 1420070400000n) <<
				22n
			).toString();
			const explanation = {
				id: explanationId,
				channel_id: thread,
				content: decision === "approve" ? "打回" : "通过",
				author: { id: founder, bot: false },
				type: 19,
				timestamp: new Date(postedAt).toISOString(),
				edited_timestamp: null,
				message_reference: {
					type: 0,
					message_id: clarificationMessage,
					channel_id: thread,
				},
			};
			const fetchOriginal = vi.fn<typeof fetch>(
				async () => new Response(JSON.stringify(explanation)),
			);
			const learningObserver = createShipJudgmentReplyObserver({
				store,
				mode: () => "dry_run",
				canonicalFounderId: () => founder,
				projects: [
					{
						projectName: "flywheel",
						projectRoot: "/tmp/fixture",
						leads: [
							{
								agentId: "test-lead",
								summaryRole: "engineering",
								chatChannel: CHANNEL,
								match: { labels: ["Engineering"] },
								botToken: "fixture-token",
								botUserId: "123456789012345696",
							},
						],
					},
				],
				fetchImpl: fetchOriginal,
			});
			openNextCard(store, raw);
			comm.registerSession(
				"execution-next",
				"runner",
				"flywheel",
				"FLY-2399",
				"test-lead",
			);
			comm.insertQuestion("execution-next", "test-lead", "ship next?", {
				id: "q-next",
				checkpoint: "approve_to_ship",
			});
			expect(authority.resolve("q-next", "execution-next")).toMatchObject({
				state: "awaiting_review",
				headSha: HEAD,
			});
			const threadContext = {
				issueId: "FLY-2399",
				projectName: "flywheel",
				threadId: thread,
				botToken: "fixture",
				ownerUserId: founder,
				graceMs: 0,
				commDbPath: dbPath,
				leadId: "test-lead",
			};
			const pending = [
				{
					questionId: "q-next",
					checkpoint: "approve_to_ship",
					executionId: "execution-next",
					createdAtMs: Date.parse(NOW),
				},
			];
			const currentDeps = {
				store,
				cursorStore: cursor,
				commDbLeaseFactory: () => ({ db: comm, release: () => {} }),
				tryFounderShipApproval: approve,
				observeShipJudgmentReply: learningObserver,
				readCurrentBinding: () => ({
					questionId: "q-next",
					executionId: "execution-next",
					issueId: "FLY-2399",
					prHeadSha: HEAD,
					threadId: thread,
					gateMessageId: "123456789012345693",
					checkpoint: "approve_to_ship",
					postedAt: NOW,
				}),
			};
			const neutralId = (BigInt(explanationId) + 1n).toString();
			const neutral = {
				...explanation,
				id: neutralId,
				message_reference: {
					type: 0,
					message_id: "123456789012345695",
					channel_id: thread,
				},
			};
			const handoff = vi.fn(async () => true);
			const neutralResult = await emitFounderReplyDeliveryForThread(
				threadContext,
				pending,
				{
					...currentDeps,
					fetchImpl: async () => new Response(JSON.stringify([neutral])),
					deliverAmbiguousToLead: handoff,
				},
			);
			expect(neutralResult, JSON.stringify(neutralResult)).toMatchObject({
				result: "advanced",
			});
			expect(comm.getResponse("q-next")).toBeUndefined();
			expect(
				store.listFounderGateVerdicts({ runId: "r-next" }),
				JSON.stringify(apply.mock.results.map((x) => String(x.value))),
			).toEqual([]);
			expect(
				raw
					.prepare(
						"SELECT count(*) AS n FROM ship_judgment_clarification WHERE supersedes IS NOT NULL",
					)
					.get(),
			).toEqual({ n: 0 });
			expect(fetchOriginal).not.toHaveBeenCalled();
			const nextId = (BigInt(explanationId) + 2n).toString();
			const nextReply = {
				...explanation,
				id: nextId,
				content: decision === "approve" ? "通过" : "打回",
				message_reference: {
					type: 0,
					message_id: "123456789012345693",
					channel_id: thread,
				},
			};
			const nextResult = await emitFounderReplyDeliveryForThread(
				threadContext,
				pending,
				{
					...currentDeps,
					fetchImpl: async () => new Response(JSON.stringify([nextReply])),
				},
			);
			expect(nextResult, JSON.stringify(nextResult)).toMatchObject({
				result: "advanced",
			});
			expect(approve).toHaveBeenCalledTimes(2);
			await project();
			expect(
				store.listFounderGateVerdicts({ runId: "r-next" }),
				JSON.stringify(apply.mock.results.map((x) => String(x.value))),
			).toEqual([
				expect.objectContaining({
					verdict: decision === "approve" ? "approved" : "rework",
					founder_authored: 1,
					question_id: "q-next",
					head_sha: HEAD,
				}),
			]);
			expect(
				raw
					.prepare(
						"SELECT count(*) AS n FROM ship_judgment_clarification WHERE supersedes IS NOT NULL",
					)
					.get(),
			).toEqual({ n: 0 });
			expect(fetchOriginal).not.toHaveBeenCalled();
			// This later reply resolves the old question after the new card decision.
			explanation.id = (BigInt(explanationId) + 3n).toString();
			const allVerdictsBefore = store.listFounderGateVerdicts();
			const nextAuthorityBefore = {
				run: store.getWorkflowRun("r-next"),
				holder: store.getWorkflowGateHolderByQuestionId("q-next"),
				response: comm.getResponse("q-next"),
			};
			const sourcesBefore = comm.listWorkflowSourceEvents();
			const responseBefore = comm.getResponse("q");
			const holderBefore = store.getWorkflowGateHolderByQuestionId("q");
			const runBefore = store.getWorkflowRun("r");
			const explanationOutcome = await emitFounderReplyDeliveryForThread(
				{
					issueId: "FLY-2399",
					projectName: "flywheel",
					threadId: thread,
					botToken: "fixture",
					ownerUserId: founder,
					graceMs: 0,
					commDbPath: dbPath,
					leadId: "test-lead",
				},
				[],
				{
					store,
					cursorStore: cursor,
					commDbLeaseFactory: () => ({ db: comm, release: () => {} }),
					fetchImpl: async () => new Response(JSON.stringify([explanation])),
					tryFounderShipApproval: approve,
					observeShipJudgmentReply: learningObserver,
				},
			);
			expect(
				explanationOutcome,
				JSON.stringify(explanationOutcome),
			).toMatchObject({ result: "advanced" });
			expect(fetchOriginal).toHaveBeenCalledOnce();
			expect(fetchOriginal.mock.calls[0]).toEqual([
				`https://discord.com/api/v10/channels/${thread}/messages/${explanation.id}`,
				expect.objectContaining({
					headers: { Authorization: "Bot fixture-token" },
					redirect: "error",
					signal: expect.any(AbortSignal),
				}),
			]);
			expect(approve).toHaveBeenCalledTimes(2);
			expect(
				raw
					.prepare(
						"SELECT reply_text,resolution,supersedes FROM ship_judgment_clarification WHERE supersedes IS NOT NULL",
					)
					.all(),
			).toEqual([
				{
					reply_text: explanation.content,
					resolution: "explained",
					supersedes: root!.clarification_id,
				},
			]);
			expect(
				raw
					.prepare(
						"SELECT count(*) AS n FROM ship_judgment_delivery WHERE purpose='ack' AND state='pending'",
					)
					.get(),
			).toEqual({ n: 1 });
			await project();
			expect(comm.getResponse("q")).toEqual(responseBefore);
			expect(comm.listWorkflowSourceEvents()).toEqual(sourcesBefore);
			expect(store.listFounderGateVerdicts({ runId: "r" })).toEqual(before);
			expect(store.getWorkflowGateHolderByQuestionId("q")).toEqual(
				holderBefore,
			);
			expect(store.getWorkflowRun("r")).toEqual(runBefore);
			expect(store.listFounderGateVerdicts()).toEqual(allVerdictsBefore);
			expect({
				run: store.getWorkflowRun("r-next"),
				holder: store.getWorkflowGateHolderByQuestionId("q-next"),
				response: comm.getResponse("q-next"),
			}).toEqual(nextAuthorityBefore);
		} finally {
			comm.close();
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
