import { describe, expect, it } from "vitest";
import {
	AUTO_NARROW_ACTOR,
	AUTO_NARROW_CONTROL_MODES,
	AUTO_NARROW_DECISION_SOURCE,
	AUTO_NARROW_FLAG_NAME,
	AUTO_NARROW_MODES,
	AUTO_NARROW_OPINION_WINDOW,
	AUTO_NARROW_POLICY_VERSION,
	AUTO_NARROW_PRECISION_MINIMUM,
	AUTO_NARROW_PRECISION_TARGET,
	autoNarrowVerdictId,
	parseAutoNarrowSourceEnvelope,
} from "../auto-narrow-contract.js";

const HEAD = "a".repeat(40);
const UUIDS = {
	control: "11111111-1111-4111-8111-111111111111",
	opening: "22222222-2222-4222-8222-222222222222",
	declaration: "33333333-3333-4333-8333-333333333333",
	strengthTwo: "44444444-4444-4444-8444-444444444444",
} as const;

function envelope(): Record<string, unknown> {
	return {
		schema_version: 1,
		policy_version: 1,
		run_id: "run-2453",
		issue_id: "FLY-2453",
		question_id: "question-2453",
		gate_node_id: "founder_gate",
		attempt: 1,
		source_execution_id: "implement-2453",
		repo_identity: "__main__",
		repo_slug: "xrliAnnie/flywheel",
		pr_number: 1140,
		head_sha: HEAD,
		response: { approved: true },
		actor: AUTO_NARROW_ACTOR,
		decision_source: AUTO_NARROW_DECISION_SOURCE,
		control: {
			event_id: UUIDS.control,
			opening_event_id: UUIDS.opening,
			flag_revision: 2,
			opening_at: "2026-09-09T03:00:00.000Z",
			founder_message_id: "1517000000000000001",
		},
		declaration: {
			declaration_id: UUIDS.declaration,
			declaration_seq: 3,
		},
		strength_two: { basis_record_id: UUIDS.strengthTwo },
		observation: {
			verdict_id: autoNarrowVerdictId("question-2453"),
			run_id: "run-2453",
			question_id: "question-2453",
			gate_execution_id: "implement-2453",
			repo_identity: "__main__",
			pr_number: 1140,
			head_sha: HEAD,
			observed_at: "2026-09-09T03:01:00.000Z",
			machine_class: "docs_only",
			machine_reason: null,
			machine_file_count: 2,
			machine_candidate_count: 1,
			machine_declared_projected_count: 0,
			machine_primary_snapshot_age_ms: 1000,
			machine_declared_max_snapshot_age_ms: null,
			machine_basis_json:
				'{"schemaVersion":1,"prs":[],"nestedReviews":{"entries":[]}}',
			s2_ran_status: "satisfied",
			s2_ran_reason: "ok",
			s2_record_status: "satisfied",
			s2_record_reason: "ok",
			s2_verdict: "satisfied",
			s2_basis_record_id: UUIDS.strengthTwo,
			s2_row_count: 1,
			s2_other_head_row_count: 0,
			shadow_version: 1,
		},
		decision_at: "2026-09-09T03:01:00.000Z",
	};
}

describe("auto narrow shared contract", () => {
	it("pins the protected flag, source identity, modes, and display-only metric", () => {
		expect(AUTO_NARROW_FLAG_NAME).toBe("auto_merge_narrow_gate");
		expect(AUTO_NARROW_MODES).toEqual(["off", "dry_run", "auto"]);
		expect(AUTO_NARROW_CONTROL_MODES).toEqual(["dry_run", "auto"]);
		expect(AUTO_NARROW_ACTOR).toBe("bridge-auto-narrow-gate");
		expect(AUTO_NARROW_DECISION_SOURCE).toBe("auto_narrow_gate");
		expect(AUTO_NARROW_POLICY_VERSION).toBe(1);
		expect(AUTO_NARROW_OPINION_WINDOW).toBe(200);
		expect(AUTO_NARROW_PRECISION_TARGET).toBe(0.98);
		expect(AUTO_NARROW_PRECISION_MINIMUM).toBe(5);
	});

	it("accepts one exact, fully bound approval envelope", () => {
		expect(parseAutoNarrowSourceEnvelope(envelope())).toEqual(envelope());
	});

	it.each([
		[
			"unknown top-level key",
			(value: any) => {
				value.extra = true;
			},
		],
		[
			"untrusted actor",
			(value: any) => {
				value.actor = "founder-user";
			},
		],
		[
			"non approval",
			(value: any) => {
				value.response.approved = false;
			},
		],
		[
			"head mismatch",
			(value: any) => {
				value.observation.head_sha = "b".repeat(40);
			},
		],
		[
			"question mismatch",
			(value: any) => {
				value.observation.question_id = "other";
			},
		],
		[
			"derived verdict mismatch",
			(value: any) => {
				value.observation.verdict_id = `fgv:${"b".repeat(64)}`;
			},
		],
		[
			"declaration mismatch",
			(value: any) => {
				value.declaration.declaration_seq = 0;
			},
		],
		[
			"strength two mismatch",
			(value: any) => {
				value.observation.s2_basis_record_id = null;
			},
		],
		[
			"one failed gate",
			(value: any) => {
				value.observation.machine_class = "ship_relevant";
			},
		],
	] as const)("rejects %s", (_label, mutate) => {
		const value = envelope();
		mutate(value);
		expect(() => parseAutoNarrowSourceEnvelope(value)).toThrow(
			/auto_narrow_source_invalid/,
		);
	});
});
