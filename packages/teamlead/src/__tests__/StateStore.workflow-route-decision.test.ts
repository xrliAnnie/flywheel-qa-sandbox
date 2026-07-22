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

	it("atomically deduplicates rejected decisions and reminder outbox rows", async () => {
		const store = await StateStore.create(":memory:");
		const input = {
			project: "flywheel",
			issueId: "FLY-1407",
			errorCode: "INVALID_TASK_CATEGORY",
			payload: { taskCategory: "coding" },
			recipientLeadId: "flywheel-eng-lead",
			owningDept: "engineering",
			selectedBy: "flywheel-eng-lead",
		};
		expect(store.insertRejectedRouteDecisionWithReminder(input)).toMatchObject({
			inserted: true,
		});
		expect(store.insertRejectedRouteDecisionWithReminder(input)).toMatchObject({
			inserted: false,
		});
		expect(store.listWorkflowRouteDecisions()).toHaveLength(1);
		expect(store.listWorkflowRouteReminderOutbox()).toHaveLength(1);
		expect(store.listWorkflowRouteReminderOutbox()[0]).toMatchObject({
			status: "pending",
			attempts: 0,
			recipient_lead_id: "flywheel-eng-lead",
		});
		store.close();
	});

	it("deduplicates a successful fallback per decision, not forever per issue", async () => {
		const store = await StateStore.create(":memory:");
		for (const executionId of ["fallback-1", "fallback-2"]) {
			store.claimWorkflowRouteDecision({
				project: "flywheel",
				issueId: "FLY-1407",
				executionId,
				route: "generic_fallback",
				routeDigest: `digest-${executionId}`,
				categorySource: "default_fallback",
			});
			const first = store.insertWorkflowRouteDecisionReminder({
				executionId,
				code: "WORK_KIND_DEFAULT_FALLBACK",
				payload: { taskCategory: null, fallback: "generic" },
				recipientLeadId: "flywheel-eng-lead",
			});
			expect(first.inserted).toBe(true);
			expect(
				store.insertWorkflowRouteDecisionReminder({
					executionId,
					code: "WORK_KIND_DEFAULT_FALLBACK",
					payload: { taskCategory: null, fallback: "generic" },
					recipientLeadId: "flywheel-eng-lead",
				}).inserted,
			).toBe(false);
		}
		expect(store.listWorkflowRouteReminderOutbox()).toHaveLength(2);
		store.close();
	});

	it("redrives reminder delivery with per-attempt event ids until accepted", async () => {
		const store = await StateStore.create(":memory:");
		const inserted = store.insertRejectedRouteDecisionWithReminder({
			project: "flywheel",
			issueId: "FLY-1407",
			errorCode: "INVALID_TIER",
			payload: { tier: "medium" },
			recipientLeadId: "flywheel-eng-lead",
		});
		const first = store.claimWorkflowRouteReminder({
			owner: "bridge-a",
			now: "2026-07-21T00:00:00.000Z",
			leaseExpiresAt: "2026-07-21T00:01:00.000Z",
		});
		expect(first).toMatchObject({
			dedupKey: inserted.dedupKey,
			attempt: 1,
			eventId: `${inserted.dedupKey}#1`,
		});
		// Simulate POST success followed by a process crash before accepted is
		// persisted: the expired lease redrives with a visibly new attempt id.
		const second = store.claimWorkflowRouteReminder({
			owner: "bridge-b",
			now: "2026-07-21T00:02:00.000Z",
			leaseExpiresAt: "2026-07-21T00:03:00.000Z",
		});
		expect(second).toMatchObject({
			attempt: 2,
			eventId: `${inserted.dedupKey}#2`,
		});
		expect(
			store.completeWorkflowRouteReminder({
				dedupKey: inserted.dedupKey,
				owner: "bridge-b",
				attempt: 2,
				outcome: "accepted",
				now: "2026-07-21T00:02:10.000Z",
			}),
		).toBe(true);
		expect(store.listWorkflowRouteReminderOutbox()[0]).toMatchObject({
			status: "accepted",
			attempts: 2,
		});
		expect(
			store.claimWorkflowRouteReminder({
				owner: "bridge-c",
				now: "2026-07-21T00:04:00.000Z",
				leaseExpiresAt: "2026-07-21T00:05:00.000Z",
			}),
		).toBeUndefined();
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
