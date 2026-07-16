import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { loadBundledWorkflowSeeds } from "../workflow-template.js";

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

	it("projects a run-attributed TURN into the owning engine run atomically", async () => {
		const store = await StateStore.create(":memory:");
		const seed = loadBundledWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		store.importWorkflowTemplateSeed(seed);
		store.materializeWorkflowRun({
			runId: "engine-run",
			issueId: "FLY-1307",
			projectName: "flywheel",
			taskCategory: "code",
			templateId: seed.templateId,
			claimsReadEnrolled: false,
			actor: "lead",
			startReservation: {
				idempotencyKey: "start-engine",
				selectionDigest: "selection",
				nodeId: "design",
				attempt: 1,
				executionId: "engine-design",
				createdAt: "2026-07-16T00:00:00.000Z",
			},
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "engine-run",
				nodeId: "design",
				executionId: "engine-design",
				attempt: 1,
				now: "2026-07-16T00:01:00.000Z",
				expiresAt: "2026-07-16T01:01:00.000Z",
				absoluteDeadlineAt: "2026-07-17T00:01:00.000Z",
				env: { FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
			}),
		).toMatchObject({ ok: true });
		const payload = {
			schema_version: 1,
			issue_id: "FLY-1307",
			old_holder: null,
			new_holder: "engine-design",
			from_role: null,
			to_role: "design",
			resulting_epoch: 1,
			target_run_id: "engine-run",
		};
		const result = store.applyWorkflowSourceEvent({
			project: "flywheel",
			sourceEventId: "turn:engine:design",
			kind: "turn_grant",
			payloadJson: canonicalJsonString(payload),
			payloadDigest: canonicalSubmissionDigest(payload),
			schemaVersion: 1,
		});

		expect(result).toEqual({ kind: "turn_run_event", status: "applied" });
		expect(
			store
				.listWorkflowRunEvents("engine-run")
				.find((event) => event.kind === "turn_granted"),
		).toEqual(
			expect.objectContaining({
				event_uid: "source_turn:flywheel:turn:engine:design",
				kind: "turn_granted",
				execution_id: "engine-design",
			}),
		);
		expect(
			store.applyWorkflowSourceEvent({
				project: "flywheel",
				sourceEventId: "turn:engine:design",
				kind: "turn_grant",
				payloadJson: canonicalJsonString(payload),
				payloadDigest: canonicalSubmissionDigest(payload),
				schemaVersion: 1,
			}),
		).toEqual({ kind: "turn_run_event", status: "replayed" });
		const forged = { ...payload, new_holder: "forged-execution" };
		expect(() =>
			store.applyWorkflowSourceEvent({
				project: "flywheel",
				sourceEventId: "turn:engine:forged",
				kind: "turn_grant",
				payloadJson: canonicalJsonString(forged),
				payloadDigest: canonicalSubmissionDigest(forged),
				schemaVersion: 1,
			}),
		).toThrow(/source payload invalid/i);
		expect(
			store
				.listWorkflowRunEvents("engine-run")
				.filter((event) => event.kind === "turn_granted"),
		).toHaveLength(1);
		store.close();
	});

	it("atomically terminalizes a product v2 run only when founder source completes all ship claims", async () => {
		const store = await StateStore.create(":memory:");
		const root = mkdtempSync(join(tmpdir(), "fly1307-product-source-"));
		mkdirSync(join(root, "agents"));
		writeFileSync(
			join(root, "agents", "generic-executor.md"),
			"Execute the pinned node.\n",
		);
		const seed = loadBundledWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_product_v1",
		)!;
		const flags = {
			FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
		};
		store.importWorkflowTemplateSeed(seed, flags);
		store.materializeWorkflowRun({
			runId: "product-run",
			issueId: "FLY-1307",
			projectName: "flywheel",
			taskCategory: "product",
			templateId: seed.templateId,
			claimsReadEnrolled: false,
			actor: "lead",
			canonicalRoot: root,
			env: flags,
			startReservation: {
				idempotencyKey: "product-start",
				selectionDigest: "selection",
				nodeId: "research",
				attempt: 1,
				executionId: "product-research",
				createdAt: "2026-07-16T00:00:00.000Z",
			},
		});
		store.upsertWorkflowRunNode({
			runId: "product-run",
			nodeId: "research",
			attempt: 1,
			state: "running",
			executionId: "product-research",
		});
		expect(
			store.commitWorkflowTransitionTx({
				runId: "product-run",
				nodeId: "research",
				attempt: 1,
				executionId: "product-research",
				outcome: "node_done",
				successorExecutionId: "product-produce",
			}).ok,
		).toBe(true);
		expect(
			store.commitWorkflowTransitionTx({
				runId: "product-run",
				nodeId: "produce",
				attempt: 1,
				executionId: "product-produce",
				outcome: "node_done",
				successorExecutionId: "product-review",
			}).ok,
		).toBe(true);
		const review = store.admitGeneralizedWorkflowExecution({
			runId: "product-run",
			nodeId: "review",
			executionId: "product-review",
			attempt: 1,
			now: "2026-07-16T00:10:00.000Z",
			expiresAt: "2027-07-16T00:10:00.000Z",
			absoluteDeadlineAt: "2027-07-17T00:10:00.000Z",
			env: flags,
		});
		if (!review.ok || !review.submissionCredential) {
			throw new Error("review admission failed");
		}
		expect(
			store.submitWorkflowDecisionByCredential({
				credential: review.submissionCredential,
				clientRequestId: "review-pass",
				predicate: "design_review_approved",
				subjectDigest: HEAD,
				issuerVendor: "claude",
				issuerModel: "sonnet",
				subjectProducerExecutionId: "product-produce",
				subjectProducerVendor: "codex",
				claimExpiresAt: "2027-07-16T00:10:00.000Z",
				now: "2026-07-16T00:11:00.000Z",
			}).ok,
		).toBe(true);
		expect(store.getWorkflowRun("product-run")?.status).toBe("active");
		const payload = {
			schema_version: 1,
			run_id: "product-run",
			issue_id: "FLY-1307",
			question_id: "product-founder",
			response: { approved: true },
			actor: "bridge",
			approved_head: HEAD,
			classification: "dashboard_founder_action",
			authority_id: "product-founder",
		};
		store.applyWorkflowSourceEvent({
			project: "flywheel",
			sourceEventId: "founder-approval:product-founder",
			kind: "founder_approval",
			payloadJson: canonicalJsonString(payload),
			payloadDigest: canonicalSubmissionDigest(payload),
			schemaVersion: 1,
		});

		expect(store.getWorkflowRun("product-run")?.status).toBe("completed");
		expect(
			store
				.listWorkflowRunEvents("product-run")
				.filter((event) => event.kind === "run_completed"),
		).toHaveLength(1);
		store.close();
		rmSync(root, { recursive: true, force: true });
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
