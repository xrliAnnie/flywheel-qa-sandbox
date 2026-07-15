import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const HEAD = "a".repeat(40);

async function freshStore(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1244",
		projectName: "flywheel",
		claimsReadEnrolled: false,
	});
	return store;
}

function founderEvent() {
	const payload = {
		schema_version: 1,
		run_id: "run-1",
		issue_id: "FLY-1244",
		question_id: "question-1",
		response: { approved: true },
		actor: "bridge",
		approved_head: HEAD,
		classification: "dashboard_founder_action",
		authority_id: "question-1",
	};
	return {
		project: "flywheel",
		sourceEventId: "founder-approval:question-1",
		kind: "founder_approval" as const,
		payloadJson: canonicalJsonString(payload),
		payloadDigest: canonicalSubmissionDigest(payload),
		schemaVersion: 1,
	};
}

describe("StateStore.applyWorkflowSourceEvent", () => {
	it("applies founder receipt and claim in one idempotent transaction", async () => {
		const store = await freshStore();
		const first = store.applyWorkflowSourceEvent(founderEvent());
		expect(first).toMatchObject({
			kind: "founder_claim",
			status: "applied",
			claimId: expect.any(Number),
		});

		const replay = store.applyWorkflowSourceEvent(founderEvent());
		expect(replay).toEqual({
			kind: "founder_claim",
			status: "replayed",
			claimId: first.kind === "founder_claim" ? first.claimId : -1,
		});
		expect(store.countWorkflowClaims("run-1")).toBe(1);
		expect(
			store.resolveWorkflowDecisionClaim({
				runId: "run-1",
				decisionKind: "founder_decision",
				subjectKind: "git_head",
				subjectDigest: HEAD,
			}),
		).toMatchObject({ valid: true });
	});

	it("rejects a same-id payload mismatch without writing another claim", async () => {
		const store = await freshStore();
		store.applyWorkflowSourceEvent(founderEvent());
		expect(() =>
			store.applyWorkflowSourceEvent({
				...founderEvent(),
				payloadDigest: "0".repeat(64),
			}),
		).toThrow(/digest|mismatch|poison/i);
		expect(store.countWorkflowClaims("run-1")).toBe(1);
	});

	it("rejects a source project that does not own the frozen workflow run", async () => {
		const store = await freshStore();
		expect(() =>
			store.applyWorkflowSourceEvent({
				...founderEvent(),
				project: "other-project",
			}),
		).toThrow(/source payload invalid/i);
		expect(store.countWorkflowClaims("run-1")).toBe(0);
	});

	it("records project-level TURN disposition without inventing a run event", async () => {
		const store = await freshStore();
		const payload = {
			schema_version: 1,
			issue_id: "FLY-1244",
			old_holder: null,
			new_holder: "exec-design",
			from_role: null,
			to_role: "design",
			resulting_epoch: 1,
			target_run_id: null,
		};
		const result = store.applyWorkflowSourceEvent({
			project: "flywheel",
			sourceEventId: "turn:1",
			kind: "turn_grant",
			payloadJson: canonicalJsonString(payload),
			payloadDigest: canonicalSubmissionDigest(payload),
			schemaVersion: 1,
		});
		expect(result).toEqual({
			kind: "turn_project_history",
			status: "applied",
		});
		expect(store.listWorkflowRunEvents("run-1")).toHaveLength(0);
	});

	it("dead-letters poison terminally and idempotently", async () => {
		const store = await freshStore();
		store.recordWorkflowSourceDeadletter({
			project: "flywheel",
			sourceEventId: "bad:1",
			reason: "malformed_payload",
		});
		store.recordWorkflowSourceDeadletter({
			project: "flywheel",
			sourceEventId: "bad:1",
			reason: "malformed_payload",
		});
		expect(
			store.getWorkflowSourceDeadletter("flywheel", "bad:1"),
		).toMatchObject({ reason: "malformed_payload" });
	});
});
