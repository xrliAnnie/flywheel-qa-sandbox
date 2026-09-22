import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	SHIP_JUDGMENT_APPROVAL_ACTOR,
	SHIP_JUDGMENT_APPROVAL_DECISION_SOURCE,
} from "flywheel-comm/ship-judgment-approval-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainWorkflowSourceEvents } from "../../bridge/founder-approval-projector.js";
import { StateStore } from "../../StateStore.js";
import { canonicalDigest } from "../contract.js";
import { bindingFixture, CHANNEL, HEAD } from "./binding-fixture.js";
import { evidenceFixture } from "./evidence-fixture.js";

const PROVENANCE_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_DIGEST = "2".repeat(64);

function envelope(questionId = "question-1") {
	return {
		schema_version: 1,
		policy: "three-point-auto-v1",
		judgment_policy: "ship-judgment-v1",
		project_name: "flywheel",
		run_id: "run-2737",
		issue_id: "FLY-2737",
		question_id: questionId,
		gate_node_id: "founder_gate",
		attempt: 1,
		source_execution_id: "implement-2737",
		card: {
			message_id: "123456789012345678",
			thread_id: "123456789012345679",
			channel_id: "123456789012345680",
		},
		primary: {
			repo_identity: "__main__",
			repo_slug: "owner/repo",
			pr_number: 2737,
			head_sha: "a".repeat(40),
		},
		targets: [
			{
				repo_identity: "__main__",
				repo_slug: "owner/repo",
				pr_number: 2737,
				head_sha: "a".repeat(40),
			},
		],
		manifest: { revision: 1, digest: "b".repeat(64) },
		judgment: {
			opinion_id: "opinion-1",
			input_id: "input-1",
			evaluation_id: "evaluation-1",
			semantic_digest: "c".repeat(64),
			model_snapshot_digest: "d".repeat(64),
			evidence_policy: "ship-judgment-evidence-v2",
			evidence_digest: "e".repeat(64),
			mechanical_digest: "f".repeat(64),
			mechanical_checked_at: "2026-09-18T16:30:00.000Z",
			presentation_digest: "1".repeat(64),
			delivered_message_id: "123456789012345681",
		},
		control: {
			event_id: "11111111-1111-4111-8111-111111111111",
			opening_event_id: "22222222-2222-4222-8222-222222222222",
			flag_revision: 3,
		},
		policy_provenance: {
			id: PROVENANCE_ID,
			original_message_digest: POLICY_DIGEST,
		},
		decision_at: "2026-09-18T16:30:01.000Z",
		response: { approved: true as const },
		actor: SHIP_JUDGMENT_APPROVAL_ACTOR,
		decision_source: SHIP_JUDGMENT_APPROVAL_DECISION_SOURCE,
	};
}

describe("StateStore ship judgment auto approval intent", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	function provenance() {
		return store.recordShipJudgmentPolicyProvenance({
			provenanceId: PROVENANCE_ID,
			channelId: "1516209714097291335",
			threadId: "1550442575066955787",
			messageId: "1550543841961050283",
			authorId: "1138241636057481306",
			messageCreatedAt: "2026-09-18T16:27:39.635Z",
			originalMessageDigest: POLICY_DIGEST,
			verifiedAt: "2026-09-18T16:29:00.000Z",
			verificationReceiptId: "trusted-discord-fetch-1",
		});
	}

	it("requires verified exact founder policy provenance", () => {
		expect(() => store.prepareShipJudgmentAutoApproval(envelope())).toThrow(
			/provenance unavailable/,
		);
		expect(() =>
			store.recordShipJudgmentPolicyProvenance({
				...provenanceInput(),
				messageId: "1550543841961050284",
			}),
		).toThrow(/provenance invalid/);
	});

	it("stores immutable byte-identical intent and replays it", () => {
		provenance();
		const first = store.prepareShipJudgmentAutoApproval(envelope());
		expect(first).toMatchObject({
			status: "created",
			row: { sourceEventId: "ship-judgment-auto:question-1" },
		});
		expect(store.prepareShipJudgmentAutoApproval(envelope())).toMatchObject({
			status: "existing",
			row: { envelopeHash: first.row.envelopeHash },
		});
		const changed = envelope();
		changed.decision_at = "2026-09-18T16:30:02.000Z";
		expect(() => store.prepareShipJudgmentAutoApproval(changed)).toThrow(
			/replay conflict/,
		);
	});
});

describe("StateStore three-point auto writer", () => {
	it("writes only a current delivered v2 all-pass judgment", async () => {
		const { store, db } = await bindingFixture();
		const root = mkdtempSync(join(tmpdir(), "fly2737-auto-integration-"));
		const commPath = join(root, "comm.db");
		const comm = new CommDB(commPath);
		const at = "2026-09-18T16:30:00.000Z";
		try {
			comm.registerSession(
				"execution",
				"runner",
				"flywheel",
				"FLY-2399",
				"lead",
			);
			comm.insertQuestion("execution", "lead", "ship?", {
				id: "q",
				checkpoint: "approve_to_ship",
			});
			store.upsertWorkflowRunNode({
				runId: "r",
				nodeId: "design",
				attempt: 1,
				state: "completed",
				executionId: "design-exec",
			});
			store.insertCodexReviewJob({
				requestId: "design-r1",
				executionId: "design-exec",
				issueId: "FLY-2399",
				projectName: "flywheel",
				reviewType: "design",
				questionId: "design-question",
				targetPath: "engineering/doc/plan.md",
				targetRepoIdentity: "__main__",
				authorFamily: "codex",
				designPlanProof: {
					planPath: "engineering/doc/plan.md",
					reviewedCommitSha: "9".repeat(40),
					expectedBlobSha: "c".repeat(40),
					capturedAt: at,
				},
			});
			store.completeCodexReviewJob("design-r1", "APPROVED", "[]");
			const proof = store.getDesignReviewProofForReviewJob("design-r1")!;
			store.validateDesignReviewApprovalProof({
				proofId: proof.proof_id,
				validationReceiptId: "validation-1",
				reviewedCommitSha: "9".repeat(40),
				expectedBlobSha: "c".repeat(40),
				validatedAt: at,
			});
			store.sealDesignReviewApprovalProof({
				proofId: proof.proof_id,
				verdictReceiptId: "verdict-1",
				approvedAt: at,
			});
			const control = store.applyAutoNarrowControlChange({
				eventId: "11111111-1111-4111-8111-111111111111",
				projectName: "flywheel",
				mode: "auto",
				expectedChangeSeq: 0,
				founderMessageId: "1550545000000000000",
				founderChannelId: "1516209714097291335",
				founderAuthorId: "1138241636057481306",
				messageCreatedAt: at,
				messageDigest: "7".repeat(64),
				commandText: "现在放开",
				executedBy: "flywheel-eng-lead",
				reason: "founder 1550545000000000000",
				now: Date.parse(at) + 1,
			});
			expect(control).toMatchObject({ ok: true });
			store.recordShipJudgmentPolicyProvenance(provenanceInput());
			const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
			const frozen = store.getShipJudgmentInputs().freeze(
				{
					questionId: "q",
					channelId: CHANNEL,
					bindingDigest: canonicalDigest(binding),
					targets: [
						{
							repo_identity: "__main__",
							pr_number: 2399,
							head_sha: HEAD,
							diff_base_sha: "b".repeat(40),
						},
					],
					sources: [
						{
							source_id: "plan-1",
							kind: "plan",
							revision: "c".repeat(40),
							text: "approved plan",
						},
						{
							source_id: "qa-1",
							kind: "qa",
							revision: "report-1",
							text: "use case passed",
						},
						{
							source_id: "diff-1",
							kind: "diff",
							revision: "d".repeat(64),
							text: "+ fix",
						},
					],
					files: [{ repo_identity: "__main__", path: "src/fix.ts" }],
					requirements: [],
					prompt: "fixture",
					model: {
						model: "fixture",
						effort: "high",
						configuration_digest: "8".repeat(64),
					},
				},
				at,
			);
			if (frozen.status !== "created") throw new Error(frozen.status);
			const jobs = store.getShipJudgmentJobs();
			const job = jobs.claim(frozen.inputId, "worker", Date.parse(at));
			if (job.status !== "claimed") throw new Error(job.status);
			jobs.markSpawned(job, Date.parse(at));
			jobs.finish(
				job,
				{
					alignment: "pass",
					coverage: "pass",
					result: {},
					resultCode: "evaluated",
					durationMs: 1,
					usage: null,
					costUsd: null,
				},
				Date.parse(at) + 1,
			);
			const opinionCandidate = {
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				inputId: frozen.inputId,
				reason: "evaluated",
				mechanical: {
					verdict: "pass",
					reason: "mechanical_checks_clear",
					digest: "e".repeat(64),
					checkedAt: at,
					scope: "main",
					checkedRepos: 1,
					openPrCount: 0,
					overlaps: [],
				},
				evidence: evidenceFixture(binding, at),
			};
			const opinions = store.getShipJudgmentOpinions();
			const offered = opinions.offer(
				opinionCandidate,
				Date.parse(at) + 2,
				"auto",
			);
			if (offered.status !== "created") throw new Error(offered.status);
			const delivery = store.getShipJudgmentDelivery();
			const claim = delivery.claim("q", CHANNEL, "sender", Date.parse(at) + 2);
			if (claim.status !== "claimed") throw new Error(claim.status);
			expect(
				delivery.confirm(
					claim,
					"123456789012345681",
					"2026-09-18T16:30:00.003Z",
					Date.parse(at) + 3,
				),
			).toBe(true);
			const blockedBeforeModeCheck = vi.fn();
			expect(
				store.commitShipJudgmentSourceIfEligible({
					questionId: "q",
					at: "2026-09-18T16:30:03.500Z",
					writeSource: blockedBeforeModeCheck,
				}),
			).toEqual({ status: "ineligible" });
			expect(blockedBeforeModeCheck).not.toHaveBeenCalled();
			expect(
				store.getShipJudgmentAutoApproval("ship-judgment-auto:q"),
			).toBeUndefined();
			expect(
				store.reconcileShipJudgmentModeCheck("2026-09-18T16:30:04.000Z"),
			).toMatchObject({
				status: "passed",
				questionId: "q",
				opinionId: offered.opinionId,
				reason: "three_point_opinion_visible",
			});
			db.prepare(`INSERT INTO ship_judgment_legacy_retirement
				(question_id,retirement_policy,thread_id,card_message_id,legacy_marker,
				 legacy_state,status,observed_at)
				VALUES ('q','three-point-retirement-v1',?,?,'auto-narrow-opinion:q',
				 'pending','pending',?)`).run(
				binding.threadId,
				binding.cardMessageId,
				at,
			);
			const blockedBeforeRetirement = vi.fn();
			expect(
				store.commitShipJudgmentSourceIfEligible({
					questionId: "q",
					at: "2026-09-18T16:30:04.500Z",
					writeSource: blockedBeforeRetirement,
				}),
			).toEqual({ status: "ineligible" });
			expect(blockedBeforeRetirement).not.toHaveBeenCalled();
			expect(
				store.getShipJudgmentAutoApproval("ship-judgment-auto:q"),
			).toBeUndefined();
			db.prepare(`UPDATE ship_judgment_legacy_retirement
				SET status='retired',retired_at=? WHERE question_id='q'`).run(
				"2026-09-18T16:30:05.000Z",
			);
			const staleWrite = vi.fn();
			expect(
				store.commitShipJudgmentSourceIfEligible({
					questionId: "q",
					at: "2026-09-18T16:31:10.000Z",
					writeSource: staleWrite,
				}),
			).toEqual({ status: "ineligible" });
			expect(staleWrite).not.toHaveBeenCalled();
			expect(
				store.getShipJudgmentAutoApproval("ship-judgment-auto:q"),
			).toBeUndefined();
			const refreshedAt = "2026-09-18T16:31:20.000Z";
			expect(
				opinions.offer(
					{
						...opinionCandidate,
						mechanical: {
							...opinionCandidate.mechanical,
							checkedAt: refreshedAt,
						},
					},
					Date.parse(refreshedAt) + 1,
					"auto",
				),
			).toEqual({ status: "unchanged" });
			const writeSource = vi.fn((input) =>
				comm.insertShipJudgmentApprovalWithSource({
					project: "flywheel",
					...input,
				}),
			);
			const interruptedWrite = vi.fn((input) => {
				comm.insertShipJudgmentApprovalWithSource({
					project: "flywheel",
					...input,
				});
				throw new Error("simulated state commit interruption");
			});
			expect(() =>
				store.commitShipJudgmentSourceIfEligible({
					questionId: "q",
					at: "2026-09-18T16:31:21.000Z",
					writeSource: interruptedWrite,
				}),
			).toThrow(/simulated state commit interruption/);
			expect(
				store.getShipJudgmentAutoApproval("ship-judgment-auto:q"),
			).toBeTruthy();
			const committed = store.commitShipJudgmentSourceIfEligible({
				questionId: "q",
				at: "2026-09-18T16:31:22.000Z",
				writeSource,
			});
			expect(committed).toMatchObject({
				status: "replayed",
				envelope: {
					actor: SHIP_JUDGMENT_APPROVAL_ACTOR,
					decision_source: SHIP_JUDGMENT_APPROVAL_DECISION_SOURCE,
					targets: [{ repo_identity: "__main__", head_sha: HEAD }],
				},
			});
			expect(writeSource).toHaveBeenCalledTimes(1);
			expect(comm.getResponse("q")).toMatchObject({
				from_agent: SHIP_JUDGMENT_APPROVAL_ACTOR,
			});
			const source = comm.listWorkflowSourceEventsAfter(0, 1)[0]!;
			expect(() =>
				store.applyWorkflowSourceEvent({
					project: source.project,
					sourceEventId: source.source_event_id,
					kind: source.kind,
					payloadJson: source.payload,
					payloadDigest: source.payload_digest,
					schemaVersion: source.schema_version,
					sourceRowId: source.row_id,
					at: source.at,
					projectedAt: "2026-09-18T16:32:30.000Z",
				}),
			).toThrow(/mechanical_stale/);
			expect(store.hasAppliedShipJudgmentMachineApproval("q", HEAD)).toBe(
				false,
			);
			expect(
				await drainWorkflowSourceEvents({
					projects: ["flywheel"],
					openCommDb: () => new CommDB(commPath, false),
					store,
					now: () => "2026-09-18T16:31:30.000Z",
				}),
			).toMatchObject({ applied: 1, deadlettered: 0 });
			expect(store.hasAppliedShipJudgmentMachineApproval("q", HEAD)).toBe(true);
			expect(
				store.hasAppliedShipJudgmentMachineApproval("q", "f".repeat(40)),
			).toBe(false);
			expect(
				db
					.prepare(
						"SELECT disposition FROM ship_judgment_auto_approval_disposition WHERE source_event_id='ship-judgment-auto:q' ORDER BY rowid",
					)
					.all(),
			).toEqual([
				{ disposition: "prepared" },
				{ disposition: "source_written" },
				{ disposition: "applied" },
			]);
			db.prepare(
				"UPDATE ship_judgment_delivery SET dirty_since=? WHERE question_id='q'",
			).run(at);
			expect(
				store.commitShipJudgmentSourceIfEligible({
					questionId: "q",
					at: "2026-09-18T16:31:23.000Z",
					writeSource,
				}),
			).toEqual({ status: "ineligible" });
		} finally {
			comm.close();
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function provenanceInput() {
	return {
		provenanceId: PROVENANCE_ID,
		channelId: "1516209714097291335",
		threadId: "1550442575066955787",
		messageId: "1550543841961050283",
		authorId: "1138241636057481306",
		messageCreatedAt: "2026-09-18T16:27:39.635Z",
		originalMessageDigest: POLICY_DIGEST,
		verifiedAt: "2026-09-18T16:29:00.000Z",
		verificationReceiptId: "trusted-discord-fetch-1",
	};
}
