import { describe, expect, it } from "vitest";
import {
	EventFilter,
	leadEventDeliveryDisposition,
	leadNotificationDecision,
} from "../bridge/EventFilter.js";
import type { HookPayload } from "../bridge/hook-payload.js";

function makePayload(
	overrides: Partial<HookPayload> = {},
): Partial<HookPayload> {
	return {
		execution_id: "exec-1",
		issue_id: "issue-1",
		status: "running",
		...overrides,
	};
}

describe("EventFilter", () => {
	const filter = new EventFilter();

	describe("HIGH priority — needs CEO decision", () => {
		it("session_completed + needs_review → notify_agent (high)", () => {
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "awaiting_review",
					decision_route: "needs_review",
				}),
			);
			expect(result.priority).toBe("high");
		});

		it("session_completed + blocked → notify_agent (high)", () => {
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "blocked",
					decision_route: "blocked",
				}),
			);
			expect(result.priority).toBe("high");
		});

		it("session_failed → notify_agent (high)", () => {
			const result = filter.classify(
				"session_failed",
				makePayload({
					status: "failed",
				}),
			);
			expect(result.priority).toBe("high");
		});
	});

	describe("NORMAL priority — important updates", () => {
		it("session_stuck → notify_agent (high — must Chat notify Annie)", () => {
			const result = filter.classify(
				"session_stuck",
				makePayload({
					status: "running",
					minutes_since_activity: 20,
				}),
			);
			expect(result.priority).toBe("high");
		});

		// FLY-159 (FLY-163: Forum surface removed — only verify chat priority + reason)
		it("gate_timed_out → notify_agent (high) via chat", () => {
			const result = filter.classify(
				"gate_timed_out",
				makePayload({
					status: "running",
					checkpoint: "brainstorm",
					waited_ms: 172_800_000,
					timeout_behavior: "fail-close",
				}),
			);
			expect(result.priority).toBe("high");
			expect(result.reason).toMatch(/gate timed out/);
		});

		it("session_orphaned → notify_agent (normal)", () => {
			const result = filter.classify(
				"session_orphaned",
				makePayload({
					status: "running",
				}),
			);
			expect(result.priority).toBe("normal");
		});

		it("action_executed → notify_agent (normal)", () => {
			const result = filter.classify(
				"action_executed",
				makePayload({
					action: "approve",
				}),
			);
			expect(result.priority).toBe("normal");
		});

		it("cipher_principle_proposed → notify_agent (normal)", () => {
			const result = filter.classify(
				"cipher_principle_proposed",
				makePayload(),
			);
			expect(result.priority).toBe("normal");
		});

		it("session_monitoring_lost → normal (FLY-172, advisory not Annie-emergency)", () => {
			const result = filter.classify(
				"session_monitoring_lost",
				makePayload({ status: "running" }),
			);
			expect(result.priority).toBe("normal");
			expect(result.reason).toContain("monitoring lost");
		});
	});

	describe("Chat-track events — Lead MUST notify Annie in Chat (FLY-47)", () => {
		it("session_started → notify_agent (high)", () => {
			// FLY-163: single chat-only rule replaces the old forum-vs-no-forum split.
			const result = filter.classify("session_started", makePayload());
			expect(result.priority).toBe("high");
			expect(result.reason).toContain("Chat");
		});

		it("session_completed + approved → notify_agent (high) — ship complete", () => {
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "approved",
					decision_route: "approved",
				}),
			);
			expect(result.priority).toBe("high");
			expect(result.reason).toContain("Chat");
		});
	});

	describe("DEFAULT — unmatched events", () => {
		it("unknown event type → notify_agent (normal)", () => {
			const result = filter.classify("some_unknown_event", makePayload());
			expect(result.priority).toBe("normal");
			expect(result.reason).toContain("default");
		});
	});

	describe("Priority ordering", () => {
		it("high rules are not overridden by low rules", () => {
			// session_completed + needs_review should be HIGH, not LOW
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "awaiting_review",
					decision_route: "needs_review",
				}),
			);
			expect(result.priority).toBe("high");
		});

		it("session_completed with status=completed → ship complete (high)", () => {
			// FLY-58: completed status matches the "ship complete" rule
			const result = filter.classify(
				"session_completed",
				makePayload({
					status: "completed",
					decision_route: "some_other_route",
				}),
			);
			expect(result.priority).toBe("high");
		});
	});

	describe("Edge cases", () => {
		it("empty payload session_completed → catch-all (normal)", () => {
			const result = filter.classify("session_completed", {});
			expect(result.priority).toBe("normal");
		});

		it("null-ish fields in payload → no crash", () => {
			const result = filter.classify("session_started", {
				status: undefined,
			});
			expect(result.priority).toBe("high");
		});

		it("result always includes a reason", () => {
			const events = [
				"session_completed",
				"session_failed",
				"session_started",
				"session_stuck",
				"action_executed",
				"unknown",
			];
			for (const e of events) {
				const result = filter.classify(e, makePayload());
				expect(result.reason).toBeTruthy();
			}
		});
	});
});

describe("routine event delivery disposition", () => {
	it("keeps session_started immediate after authoritative session registration", () => {
		expect(
			leadNotificationDecision(
				"session_started",
				{ status: "running" },
				{
					kind: "session_registered",
					proofRef: "session-event:started-1",
				},
			),
		).toEqual({
			disposition: "model",
			reason: "session_started_handoff_required",
			policyVersion: "notification-v1",
			proofRef: "session-event:started-1",
		});
		expect(
			leadNotificationDecision("session_started", { status: "running" }),
		).toMatchObject({ disposition: "model", reason: "proof_missing" });
	});

	it("audits review and PR stages only with authoritative no-action proof", () => {
		for (const stage of ["design_review", "code_review", "pr_created"]) {
			expect(
				leadNotificationDecision(
					"stage_changed",
					{ stage, status: "awaiting_review" },
					{
						kind: "stage_recorded",
						proofRef: `stage:${stage}`,
						actionState: "none",
						reviewOwnerRef: `review-owner:${stage}`,
					},
				),
			).toEqual({
				disposition: "audit_only",
				reason: "routine_stage_owned",
				policyVersion: "notification-v1",
				proofRef: `stage:${stage}`,
			});
		}

		expect(
			leadNotificationDecision(
				"stage_changed",
				{ stage: "design_review", status: "awaiting_review" },
				{
					kind: "stage_recorded",
					proofRef: "stage:design-review",
					actionState: "none",
				},
			),
		).toMatchObject({
			disposition: "model",
			reason: "review_owner_missing",
		});
	});

	it("ignores an inherited decision only when the exact obligation is resolved", () => {
		expect(
			leadNotificationDecision(
				"stage_changed",
				{
					stage: "implement",
					status: "running",
					decision_route: "needs_review",
				},
				{
					kind: "stage_recorded",
					proofRef: "stage:event-1",
					actionState: "resolved",
					actionProofRef: "decision:receipt-1",
				},
			),
		).toEqual({
			disposition: "audit_only",
			reason: "routine_stage_inherited_resolved",
			policyVersion: "notification-v1",
			proofRef: "decision:receipt-1",
		});

		expect(
			leadNotificationDecision(
				"stage_changed",
				{
					stage: "implement",
					status: "running",
					decision_route: "needs_review",
				},
				{
					kind: "stage_recorded",
					proofRef: "stage:event-1",
					actionState: "pending",
				},
			),
		).toMatchObject({ disposition: "model", reason: "action_pending" });
	});

	it("audits only structured routine events from trusted Bridge producers", () => {
		for (const stage of [
			"onboard",
			"brainstorm",
			"research",
			"plan",
			"implement",
			"test",
		]) {
			expect(
				leadEventDeliveryDisposition(
					"stage_changed",
					{ stage, status: "running" },
					true,
				),
			).toBe("audit_only");
			expect(
				leadEventDeliveryDisposition("stage_changed", { stage }, false),
			).toBe("model");
		}
		expect(
			leadEventDeliveryDisposition(
				"session_monitoring_reestablished",
				{},
				true,
			),
		).toBe("audit_only");
		expect(
			leadEventDeliveryDisposition(
				"session_monitoring_reestablished",
				{},
				false,
			),
		).toBe("model");
	});
	it("keeps unknown, actionable, failed, review, ship and founder traffic", () => {
		for (const stage of [
			undefined,
			"unknown",
			"completed",
			"approve",
			"design_review",
			"code_review",
			"ship",
			"pr_created",
		]) {
			expect(
				leadEventDeliveryDisposition("stage_changed", { stage }, true),
			).toBe("model");
		}
		for (const extra of [
			{ status: "failed" },
			{ last_error: "failure" },
			{ decision_route: "needs_review" },
			{ needs_action: true },
			{ checkpoint: "question" },
			{ messages: [{ author: "founder" }] },
		]) {
			expect(
				leadEventDeliveryDisposition(
					"stage_changed",
					{ stage: "test", ...extra },
					true,
				),
			).toBe("model");
		}
		for (const type of [
			"chat",
			"founder_message",
			"unknown",
			"session_failed",
			"review_code",
		]) {
			expect(leadEventDeliveryDisposition(type, { stage: "test" }, true)).toBe(
				"model",
			);
		}
	});
});

describe("FLY-2912 notification v2", () => {
	const binding = {
		projectName: "flywheel",
		leadId: "lead",
		eventId: "notice",
		executionId: "exec",
		issueId: "issue",
	};
	const base = {
		binding,
		proof: {
			sourceRef: "record:notice",
			executionId: "exec",
			action: { state: "none", checkedRefs: ["record:notice"] },
		},
		version: 2,
	};
	const cases = [
		[
			"stage_changed",
			{ stage: "code_review" },
			{
				...base,
				kind: "stage",
				stage: "code_review",
				ownerRef: "runner-review-contract:activation",
			},
		],
		[
			"session_started",
			{},
			{
				...base,
				kind: "startup",
				registrationRef: "session:exec",
				handoff: "initial_notice",
				threadOutcome: "not_required",
			},
		],
		[
			"session_monitoring_reestablished",
			{ status: "ship_parked" },
			{
				...base,
				kind: "monitoring",
				episodeRef: "episode",
				probeRef: "probe",
				alertState: "none",
				legalPark: true,
			},
		],
		[
			"workflow_replacement_eligibility",
			{},
			{
				...base,
				kind: "replacement_notice",
				attemptRef: "attempt",
				scheduleRef: "dispatch",
				nextCheckAt: "2026-09-26T05:00:00Z",
				observedAt: "2026-09-26T04:59:00Z",
				disposition: "replacement_candidate",
			},
		],
	] as const;
	const decide = (
		eventType: string,
		payload: Record<string, unknown>,
		evidence: unknown,
		options = {},
	) =>
		leadNotificationDecision(eventType, payload, evidence as never, {
			binding,
			enabled: true,
			...options,
		});

	it.each(cases)("audits a proven pure %s", (type, payload, evidence) => {
		expect(decide(type, { ...payload }, evidence)).toMatchObject({
			disposition: "audit_only",
			policyVersion: "notification-v2",
			proofRef: "record:notice",
		});
	});
	it.each(cases)(
		"retains every actionable or malformed %s ingress and projection",
		(type, payload, evidence) => {
			for (const mixed of [
				{ question_id: "q" },
				{ question: "Please decide" },
				{ ask: "help" },
				{ prompt: "reply" },
				{ messages: [] },
				{ founder_message: {} },
				{ needs_action: [] },
				{ requires_action: "false" },
				{ error: "failed" },
				{ blocked: true },
				{ failureKind: "goal_blocked" },
				{ checkpoint: "approve_to_ship" },
				{ extension: {} },
				{ summary: "FYI can you decide?" },
				{ notification_context: "all good; please restart" },
			]) {
				expect(
					decide(type, { ...payload, ...mixed }, evidence).disposition,
				).toBe("model");
				expect(
					decide(type, { ...payload }, evidence, {
						projection: { ...payload, ...mixed },
					}).disposition,
				).toBe("model");
			}
		},
	);
	it.each(cases)(
		"restores model delivery for %s when disabled or unbound",
		(type, payload, evidence) => {
			expect(
				decide(type, { ...payload }, evidence, { enabled: false }).disposition,
			).toBe("model");
			expect(
				decide(type, { ...payload }, evidence, {
					binding: { ...binding, executionId: "other" },
				}).disposition,
			).toBe("model");
			expect(
				decide(type, { ...payload, execution_id: "other" }, evidence)
					.disposition,
			).toBe("model");
			expect(
				decide(
					type,
					{ ...payload },
					{
						...evidence,
						proof: { ...base.proof, action: { state: "unknown" } },
					},
				).disposition,
			).toBe("model");
		},
	);
	it("validates producer-bound monitoring details and numeric PR metadata", () => {
		const probe = {
			method: "tmux_pane_probe",
			target: "runner:0",
			result: "alive" as const,
			probed_at: "2026-09-26T04:59:00Z",
		};
		const evidence = { ...cases[2][2], livenessProbe: probe };
		const payload = {
			status: "approved_to_ship",
			liveness_probe: probe,
			minutes_since_activity: 1.5,
			concurrent_reestablished: 2,
		};
		expect(decide(cases[2][0], payload, evidence).disposition).toBe(
			"audit_only",
		);
		expect(
			decide(
				cases[2][0],
				{ ...payload, liveness_probe: { ...probe, target: "other" } },
				evidence,
			).disposition,
		).toBe("model");
		expect(
			decide(
				cases[2][0],
				{ ...payload, liveness_probe: { ...probe, question: "reply" } },
				evidence,
			).disposition,
		).toBe("model");
		expect(
			decide(cases[0][0], { ...cases[0][1], pr_number: 123 }, cases[0][2])
				.disposition,
		).toBe("audit_only");
		expect(
			decide(cases[0][0], { ...cases[0][1], pr_number: "123" }, cases[0][2])
				.disposition,
		).toBe("model");
	});

	it("does not resolve an inherited decision from running or unrelated receipt", () => {
		const [type, payload, evidence] = cases[0];
		const mixed = {
			...payload,
			status: "running",
			decision_route: "needs_review",
		};
		expect(decide(type, mixed, evidence).disposition).toBe("model");
		const resolved = {
			...evidence,
			proof: {
				...base.proof,
				action: {
					state: "resolved",
					resolutionRef: "receipt",
					decisionRoute: "needs_review",
				},
			},
		};
		expect(decide(type, mixed, resolved).disposition).toBe("audit_only");
		expect(
			decide(type, { ...mixed, decision_route: "blocked" }, resolved)
				.disposition,
		).toBe("model");
	});
	it("keeps missing ownership, handoff, open alerts and overdue replacement actionable", () => {
		expect(
			decide(
				cases[0][0],
				{ ...cases[0][1] },
				{ ...cases[0][2], ownerRef: undefined },
			).disposition,
		).toBe("model");
		expect(
			decide(cases[1][0], {}, { ...cases[1][2], handoff: "lead_required" })
				.disposition,
		).toBe("model");
		expect(
			decide(cases[1][0], {}, { ...cases[1][2], threadOutcome: "failed" })
				.disposition,
		).toBe("model");
		expect(
			decide(cases[2][0], {}, { ...cases[2][2], alertState: "open" })
				.disposition,
		).toBe("model");
		expect(
			decide(
				cases[3][0],
				{},
				{ ...cases[3][2], nextCheckAt: "2026-09-26T04:58:00Z" },
			).disposition,
		).toBe("model");
	});
});
