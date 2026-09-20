import { describe, expect, it } from "vitest";
import {
	compareShipJudgmentApprovalTargets,
	parseShipJudgmentApprovalEnvelope,
	SHIP_JUDGMENT_APPROVAL_ACTOR,
	SHIP_JUDGMENT_APPROVAL_DECISION_SOURCE,
	shipJudgmentApprovalSourceEventId,
} from "../ship-judgment-approval-contract.js";

const uuid = (digit: string) =>
	`${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

function envelope() {
	return {
		schema_version: 1,
		policy: "three-point-auto-v1",
		judgment_policy: "ship-judgment-v1",
		project_name: "flywheel",
		run_id: "run-1",
		issue_id: "FLY-2737",
		question_id: "question-1",
		gate_node_id: "founder_gate",
		attempt: 1,
		source_execution_id: "execution-1",
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
			{
				repo_identity: "owner/secondary",
				repo_slug: "owner/secondary",
				pr_number: 19,
				head_sha: "b".repeat(40),
			},
		],
		manifest: { revision: 2, digest: "c".repeat(64) },
		judgment: {
			opinion_id: uuid("1"),
			input_id: uuid("2"),
			evaluation_id: uuid("3"),
			semantic_digest: "d".repeat(64),
			model_snapshot_digest: "e".repeat(64),
			evidence_policy: "ship-judgment-evidence-v2",
			evidence_digest: "f".repeat(64),
			mechanical_digest: "0".repeat(64),
			mechanical_checked_at: "2026-09-18T16:30:00.000Z",
			presentation_digest: "1".repeat(64),
			delivered_message_id: "123456789012345681",
		},
		control: {
			event_id: uuid("4"),
			opening_event_id: uuid("5"),
			flag_revision: 3,
		},
		policy_provenance: {
			id: uuid("6"),
			original_message_digest: "2".repeat(64),
		},
		decision_at: "2026-09-18T16:30:01.000Z",
		response: { approved: true },
		actor: SHIP_JUDGMENT_APPROVAL_ACTOR,
		decision_source: SHIP_JUDGMENT_APPROVAL_DECISION_SOURCE,
	};
}

describe("ship judgment approval contract", () => {
	it("sorts mixed-case repository targets with the contract's code-unit order", () => {
		const targets = [
			{
				repo_identity: "xrliAnnie/flywheel",
				repo_slug: "xrliAnnie/flywheel",
				pr_number: 1264,
				head_sha: "b".repeat(40),
			},
			{
				repo_identity: "xrliAnnie/GeoForge3D",
				repo_slug: "xrliAnnie/GeoForge3D",
				pr_number: 42,
				head_sha: "a".repeat(40),
			},
		];
		targets.sort(compareShipJudgmentApprovalTargets);
		expect(targets.map((target) => target.repo_identity)).toEqual([
			"xrliAnnie/GeoForge3D",
			"xrliAnnie/flywheel",
		]);
	});

	it("accepts a complete sorted multi-target three-point envelope", () => {
		const value = envelope();
		expect(parseShipJudgmentApprovalEnvelope(value)).toEqual(value);
		expect(shipJudgmentApprovalSourceEventId(value.question_id)).toBe(
			"ship-judgment-auto:question-1",
		);
	});

	it.each([
		[
			"old actor",
			(value: ReturnType<typeof envelope>) => {
				value.actor = "bridge-auto-narrow-gate" as never;
			},
		],
		[
			"missing evidence",
			(value: ReturnType<typeof envelope>) =>
				delete (value.judgment as Partial<typeof value.judgment>)
					.evidence_digest,
		],
		[
			"primary absent",
			(value: ReturnType<typeof envelope>) => value.targets.shift(),
		],
		[
			"duplicate target",
			(value: ReturnType<typeof envelope>) =>
				value.targets.push({ ...value.targets[0]! }),
		],
		[
			"unsorted targets",
			(value: ReturnType<typeof envelope>) => value.targets.reverse(),
		],
		[
			"forged approval",
			(value: ReturnType<typeof envelope>) => {
				value.response.approved = false as true;
			},
		],
	])("rejects %s", (_name, mutate) => {
		const value = envelope();
		mutate(value);
		expect(() => parseShipJudgmentApprovalEnvelope(value)).toThrow(
			/ship_judgment_approval_invalid/,
		);
	});
});
