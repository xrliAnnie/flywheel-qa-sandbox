import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const baseDecision = {
	project: "flywheel",
	issueId: "FLY-1407",
	idempotencyKey: "route-key",
	route: "workflow_v2" as const,
	routeDigest: "digest-a",
	taskCategory: "research" as const,
	categorySource: "task_category" as const,
	selectedBy: "flywheel-eng-lead",
	selectionReason: "binding:research",
	owningDept: "engineering",
	suggestedCategory: "code" as const,
	labelDocumentationIntent: false,
};

describe("StateStore workflow route decisions", () => {
	it("claims immutable decisions with inserted, resume, launched, and conflict outcomes", async () => {
		const store = await StateStore.create(":memory:");
		expect(store.claimWorkflowRouteDecision(baseDecision)).toMatchObject({
			status: "inserted",
			decision: { status: "decided", route_digest: "digest-a" },
		});
		expect(store.claimWorkflowRouteDecision(baseDecision)).toMatchObject({
			status: "resume_decided",
		});
		expect(
			store.claimWorkflowRouteDecision({
				...baseDecision,
				routeDigest: "digest-b",
			}),
		).toMatchObject({ status: "conflict" });

		const legacy = {
			...baseDecision,
			idempotencyKey: undefined,
			executionId: "legacy-exec",
			route: "bypass_override" as const,
			routeDigest: "legacy-digest",
			taskCategory: undefined,
			categorySource: undefined,
			override: "no-three-stage" as const,
		};
		expect(store.claimWorkflowRouteDecision(legacy)).toMatchObject({
			status: "inserted",
		});
		expect(
			store.markWorkflowRouteDecisionLaunched({ executionId: "legacy-exec" }),
		).toBe(false);
		expect(
			store.claimLegacyWorkflowEntry({
				issueId: "FLY-1407",
				projectName: "flywheel",
				executionId: "legacy-exec",
				role: "main",
			}),
		).toEqual({ ok: true });
		store.upsertSession({
			execution_id: "legacy-exec",
			issue_id: "FLY-1407",
			project_name: "flywheel",
			status: "running",
		});
		expect(
			store.markWorkflowRouteDecisionLaunched({ executionId: "legacy-exec" }),
		).toBe(true);
		expect(store.claimWorkflowRouteDecision(legacy)).toMatchObject({
			status: "already_launched",
			decision: { status: "launched" },
		});
		store.close();
	});

	it("atomically deduplicates rejected decisions", async () => {
		const store = await StateStore.create(":memory:");
		const input = {
			project: "flywheel",
			issueId: "FLY-1407",
			errorCode: "INVALID_TASK_CATEGORY",
			payload: { taskCategory: "coding" },
			owningDept: "engineering",
			selectedBy: "flywheel-eng-lead",
		};
		expect(store.insertRejectedRouteDecision(input)).toMatchObject({
			inserted: true,
		});
		expect(store.insertRejectedRouteDecision(input)).toMatchObject({
			inserted: false,
		});
		expect(store.listWorkflowRouteDecisions()).toHaveLength(1);
		store.close();
	});

	it("summarizes only launched task-category decisions against audit suggestions", async () => {
		const store = await StateStore.create(":memory:");
		for (const [executionId, category, source, suggested] of [
			["match", "code", "task_category", "code"],
			["mismatch", "research", "task_category", "code"],
			["override", undefined, "template_override", "code"],
		] as const) {
			store.claimWorkflowRouteDecision({
				...baseDecision,
				idempotencyKey: undefined,
				executionId,
				route: "legacy",
				routeDigest: `digest-${executionId}`,
				taskCategory: category,
				categorySource: source,
				suggestedCategory: suggested,
			});
			store.claimLegacyWorkflowEntry({
				issueId: `FLY-${executionId}`,
				projectName: "flywheel",
				executionId,
				role: "main",
			});
			store.upsertSession({
				execution_id: executionId,
				issue_id: `FLY-${executionId}`,
				project_name: "flywheel",
				status: "running",
			});
			expect(store.markWorkflowRouteDecisionLaunched({ executionId })).toBe(
				true,
			);
		}
		expect(store.summarizeCategorySuggestionAlignment("flywheel")).toEqual([
			{
				project: "flywheel",
				owningDept: "engineering",
				total: 2,
				matches: 1,
				ratio: 0.5,
			},
		]);
		store.close();
	});
});
