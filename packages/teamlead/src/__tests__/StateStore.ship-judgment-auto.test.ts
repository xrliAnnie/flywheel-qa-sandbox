import {
	AUTO_NARROW_ACTOR,
	AUTO_NARROW_DECISION_SOURCE,
} from "flywheel-comm/auto-narrow-contract";
import {
	SHIP_JUDGMENT_APPROVAL_ACTOR,
	SHIP_JUDGMENT_APPROVAL_DECISION_SOURCE,
} from "flywheel-comm/ship-judgment-approval-contract";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainWorkflowSourceEvents } from "../bridge/founder-approval-projector.js";
import { StateStore } from "../StateStore.js";

const PROVENANCE_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_DIGEST = "2".repeat(64);

function envelope() {
	return {
		schema_version: 1,
		policy: "three-point-auto-v1",
		judgment_policy: "ship-judgment-v1",
		project_name: "flywheel",
		run_id: "run-2737",
		issue_id: "FLY-2737",
		question_id: "question-1",
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

describe("StateStore ship judgment auto approval intent", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => store.close());

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
		store.recordShipJudgmentPolicyProvenance(provenanceInput());
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

	it("keeps a source-written machine approval in flight after an earlier rejection", () => {
		store.recordShipJudgmentPolicyProvenance(provenanceInput());
		store.prepareShipJudgmentAutoApproval(envelope());
		store.recordShipJudgmentAutoApprovalDisposition({
			sourceEventId: "ship-judgment-auto:question-1",
			disposition: "rejected",
			reason: "mode_check_pending",
			at: "2026-09-18T16:30:02.000Z",
		});
		expect(store.hasRejectedShipJudgmentMachineApproval("question-1")).toBe(
			true,
		);
		store.recordShipJudgmentAutoApprovalDisposition({
			sourceEventId: "ship-judgment-auto:question-1",
			disposition: "source_written",
			reason: "written",
			at: "2026-09-18T16:30:03.000Z",
		});
		expect(store.hasRejectedShipJudgmentMachineApproval("question-1")).toBe(
			false,
		);
		store.recordShipJudgmentAutoApprovalDisposition({
			sourceEventId: "ship-judgment-auto:question-1",
			disposition: "rejected",
			reason: "gate_changed",
			at: "2026-09-18T16:30:03.000Z",
		});
		expect(store.hasRejectedShipJudgmentMachineApproval("question-1")).toBe(
			true,
		);
	});
});

it("deadletters an unapplied legacy approval source and advances the cursor", async () => {
	const store = await StateStore.create(":memory:");
	const payload = {
		schema_version: 1,
		actor: AUTO_NARROW_ACTOR,
		decision_source: AUTO_NARROW_DECISION_SOURCE,
	};
	const payloadJson = JSON.stringify(payload);
	try {
		await expect(
			drainWorkflowSourceEvents({
				projects: ["flywheel"],
				openCommDb: () => ({
					listWorkflowSourceEventsAfter: (cursor) =>
						cursor < 1
							? [
									{
										row_id: 1,
										project: "flywheel",
										source_event_id: "auto-narrow:legacy-question",
										kind: "founder_approval" as const,
										payload: payloadJson,
										payload_digest: canonicalSubmissionDigest(payload),
										schema_version: 1,
										at: "2026-09-18T16:30:00.000Z",
									},
								]
							: [],
				}),
				store,
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
				alertFallback: async () => ({ accepted: true }),
			}),
		).resolves.toMatchObject({ deadlettered: 1, applied: 0 });
		expect(store.getWorkflowSourceCursor("flywheel")).toBe(1);
		expect(
			store.getWorkflowSourceDeadletter(
				"flywheel",
				"auto-narrow:legacy-question",
			),
		).toBeTruthy();
	} finally {
		store.close();
	}
});
