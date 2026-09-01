/**
 * FLY-927 Task 1.1: infra-event Router — pure classification + the routed
 * InfraAlertSink wrapper. D1 (brainstorm gate): route by RESPONDER —
 * infra process-health kinds are bot-fixable → ticket queue; issue-progress
 * kinds belong in the issue's own [FLY-XX] thread when one is bound;
 * anything unresolvable fail-safes to the ticket queue (never silently drop).
 */
import { describe, expect, it, vi } from "vitest";
import {
	ALERT_EVENT_TYPES,
	type AlertEventType,
	type AlertPayload,
	type AlertResult,
	INFORMATIONAL_KINDS,
} from "../../LeadAlertNotifier.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { buildInfraAlertRouting } from "../infra-alert-wiring.js";
import {
	type BoundIssueThread,
	classifyInfraEvent,
	createInfraAlertSink,
	ISSUE_PROGRESS_KINDS,
	TICKET_KINDS,
} from "../infra-event-router.js";
import { createReviewAlertEmitter } from "../review-governance-effects.js";

const THREAD: BoundIssueThread = {
	threadId: "t-1",
	channelId: "c-1",
	issueId: "issue-uuid",
	issueIdentifier: "FLY-1",
	executionId: "exec-1",
};

function payload(eventType: AlertEventType): AlertPayload {
	return {
		leadId: "flywheel-eng-lead",
		projectName: "flywheel",
		eventId: `e-${eventType}`,
		eventType,
		title: "t",
		body: "b",
		severity: "warning",
	};
}

describe("classifyInfraEvent (FLY-927 D1 matrix)", () => {
	it("routes FLY-1364 actionable incidents to tickets", () => {
		expect(TICKET_KINDS.has("cmux_cleanup")).toBe(true);
		expect(TICKET_KINDS.has("cmux_watcher_stalled")).toBe(true);
		expect(TICKET_KINDS.has("tmux_rescue_hold")).toBe(true);
		expect(TICKET_KINDS.has("ship_attempt_failed")).toBe(true);
	});

	it.each([
		"flag_scan_failed",
		"flag_scan_handoff",
		"flag_scan_no_clock",
	] as const)(
		"routes ordinary informational kind %s to Claw mailbox",
		(kind) => {
			expect(INFORMATIONAL_KINDS.has(kind)).toBe(true);
			expect(TICKET_KINDS.has(kind)).toBe(false);
			expect(ISSUE_PROGRESS_KINDS.has(kind)).toBe(false);
			expect(
				classifyInfraEvent({ eventType: kind, boundIssueThread: THREAD }),
			).toBe("ticket");
		},
	);

	it("every TICKET_KIND routes to ticket, with or without a bound thread", () => {
		for (const kind of TICKET_KINDS) {
			expect(
				classifyInfraEvent({ eventType: kind, boundIssueThread: THREAD }),
			).toBe("ticket");
			expect(
				classifyInfraEvent({ eventType: kind, boundIssueThread: null }),
			).toBe("ticket");
		}
	});

	it("every ISSUE_PROGRESS_KIND routes to issue_thread when bound", () => {
		for (const kind of ISSUE_PROGRESS_KINDS) {
			expect(
				classifyInfraEvent({ eventType: kind, boundIssueThread: THREAD }),
			).toBe("issue_thread");
		}
	});

	it("routes production review failures through session resolution, with wrong keys failing safe to ticket", async () => {
		const store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-uuid",
			issue_identifier: "FLY-1",
			issue_title: "Review recovery",
			issue_labels: JSON.stringify(["Flywheel"]),
			project_name: "flywheel",
			status: "running",
		});
		store.upsertChatThread("t-1", "c-1", "issue-uuid");
		const projects = [
			{
				projectName: "flywheel",
				projectRoot: "/tmp/fw",
				leads: [
					{
						agentId: "flywheel-eng-lead",
						chatChannel: "c-1",
						alertChannel: "alerts",
						match: { labels: ["Flywheel"] },
						botToken: "token",
					},
				],
			},
		] as unknown as ProjectEntry[];
		const rawSink = { alert: vi.fn(async () => ({ sent: true })) };
		const ticketSink = { alert: vi.fn(async () => ({ queued: true })) };
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			json: async () => ({ id: "message-1" }),
			text: async () => "",
		}));
		const sink = buildInfraAlertRouting({
			store,
			projects,
			rawSink,
			ticketSink,
			routingEnabled: () => true,
			ticketsEnabled: () => false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger: () => {},
		});
		const emitReviewAlert = createReviewAlertEmitter({
			store,
			projects,
			alert: (alert) => sink.alert(alert),
		});

		expect(ISSUE_PROGRESS_KINDS.has("review_job_failed")).toBe(true);
		await emitReviewAlert({
			kind: "review_job_failed",
			eventId: "review-failed:req-1:1",
			issueId: "FLY-1",
			executionId: "exec-1",
			requestId: "req-1",
			message: "Review req-1 failed; the gate remains closed.",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain(
			"/channels/t-1/messages",
		);
		expect(ticketSink.alert).not.toHaveBeenCalled();

		fetchImpl.mockClear();
		await sink.alert({
			...payload("review_job_failed"),
			sessionKey: "flywheel:FLY-1",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(ticketSink.alert).toHaveBeenCalledTimes(1);
		store.close();
	});

	it("ISSUE_PROGRESS_KINDS fail-safe to ticket when NO thread is bound", () => {
		for (const kind of ISSUE_PROGRESS_KINDS) {
			expect(
				classifyInfraEvent({ eventType: kind, boundIssueThread: null }),
			).toBe("ticket");
		}
	});

	it("the two kind sets are disjoint and cover the WHOLE AlertEventType union", () => {
		for (const kind of TICKET_KINDS) {
			expect(ISSUE_PROGRESS_KINDS.has(kind)).toBe(false);
		}
		// Every union member classifies deterministically (never throws, never a
		// silent drop): members in neither set default to "ticket".
		for (const kind of ALERT_EVENT_TYPES) {
			const route = classifyInfraEvent({
				eventType: kind,
				boundIssueThread: null,
			});
			expect(["ticket", "issue_thread"]).toContain(route);
			expect(route).not.toBe("issue_thread"); // unbound never goes to a thread
		}
	});

	it("routes restart-storm holds to the actionable ticket lane", () => {
		expect(TICKET_KINDS).toContain("restart_storm_hold");
		expect(
			classifyInfraEvent({
				eventType: "restart_storm_hold",
				boundIssueThread: THREAD,
			}),
		).toBe("ticket");
	});

	it("union members outside both sets fail-safe to ticket", () => {
		const uncovered = ALERT_EVENT_TYPES.filter(
			(k) => !TICKET_KINDS.has(k) && !ISSUE_PROGRESS_KINDS.has(k),
		);
		for (const kind of uncovered) {
			expect(
				classifyInfraEvent({ eventType: kind, boundIssueThread: THREAD }),
			).toBe("ticket");
		}
	});
});

describe("createInfraAlertSink (routing wrapper)", () => {
	function makeDeps(overrides?: {
		founderUserId?: string | null;
		routingEnabled?: () => boolean;
		resolve?: (p: AlertPayload) => BoundIssueThread | null;
		deliver?: (p: AlertPayload, t: BoundIssueThread) => Promise<AlertResult>;
	}) {
		const rawSink = {
			alert: vi.fn(
				async (_p: AlertPayload): Promise<AlertResult> => ({
					sent: true,
				}),
			),
		};
		const ticketSink = {
			alert: vi.fn(
				async (_p: AlertPayload): Promise<AlertResult> => ({
					queued: true,
				}),
			),
		};
		const resolve = vi.fn(overrides?.resolve ?? (() => null));
		const deliver = vi.fn(
			overrides?.deliver ??
				(async (): Promise<AlertResult> => ({ sent: true })),
		);
		const sink = createInfraAlertSink({
			rawSink,
			ticketSink,
			founderUserId:
				overrides?.founderUserId === null
					? undefined
					: (overrides?.founderUserId ?? "123456789012345678"),
			routingEnabled: overrides?.routingEnabled ?? (() => true),
			resolveBoundIssueThread: resolve,
			deliverToIssueThread: deliver,
			logger: () => {},
		});
		return { sink, rawSink, ticketSink, resolve, deliver };
	}

	it("routing DISABLED (env unset) → pure passthrough; resolver never consulted", async () => {
		const { sink, rawSink, ticketSink, resolve, deliver } = makeDeps({
			routingEnabled: () => false,
		});
		const p = payload("three_stage_stuck");
		const result = await sink.alert(p);
		expect(rawSink.alert).toHaveBeenCalledExactlyOnceWith(p);
		expect(ticketSink.alert).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
		expect(deliver).not.toHaveBeenCalled();
		expect(result).toEqual({ sent: true });
	});

	it("ordinary ticket kind → Claw mailbox even when a thread is bound", async () => {
		const { sink, rawSink, ticketSink, deliver } = makeDeps({
			resolve: () => THREAD,
		});
		const p = payload("rate_limit");
		await sink.alert(p);
		expect(ticketSink.alert).toHaveBeenCalledExactlyOnceWith(p);
		expect(rawSink.alert).not.toHaveBeenCalled();
		expect(deliver).not.toHaveBeenCalled();
	});

	it("workflow escalation → Hub with the existing founder mention", async () => {
		const { sink, rawSink, ticketSink } = makeDeps();
		const p = payload("workflow_engine_escalation");
		await sink.alert(p);
		expect(rawSink.alert).toHaveBeenCalledExactlyOnceWith({
			...p,
			mentionUserId: "123456789012345678",
		});
		expect(ticketSink.alert).not.toHaveBeenCalled();
	});

	it("an unrecovered cmux watcher → Hub with the founder mention", async () => {
		const { sink, rawSink, ticketSink } = makeDeps();
		const p = payload("cmux_watcher_unrecovered");
		await sink.alert(p);
		expect(rawSink.alert).toHaveBeenCalledExactlyOnceWith({
			...p,
			mentionUserId: "123456789012345678",
		});
		expect(ticketSink.alert).not.toHaveBeenCalled();
	});

	it("an explicit mention remains an escalation and reaches the Hub unchanged", async () => {
		const { sink, rawSink, ticketSink } = makeDeps();
		const p = {
			...payload("deploy_failed"),
			mentionUserId: "222222222222222222",
		};
		await sink.alert(p);
		expect(rawSink.alert).toHaveBeenCalledExactlyOnceWith(p);
		expect(ticketSink.alert).not.toHaveBeenCalled();
	});

	it("an invalid explicit mention stays in the Claw mailbox", async () => {
		const { sink, rawSink, ticketSink } = makeDeps();
		const p = { ...payload("deploy_failed"), mentionUserId: "not-a-snowflake" };
		await sink.alert(p);
		expect(ticketSink.alert).toHaveBeenCalledExactlyOnceWith(p);
		expect(rawSink.alert).not.toHaveBeenCalled();
	});

	it("workflow escalation replaces an invalid explicit mention with the canonical founder", async () => {
		const { sink, rawSink, ticketSink } = makeDeps();
		const p = {
			...payload("workflow_engine_escalation"),
			mentionUserId: "not-a-snowflake",
		};
		await sink.alert(p);
		expect(rawSink.alert).toHaveBeenCalledExactlyOnceWith({
			...p,
			mentionUserId: "123456789012345678",
		});
		expect(ticketSink.alert).not.toHaveBeenCalled();
	});

	it("workflow escalation without a valid founder stays durable in the Claw mailbox", async () => {
		const { sink, rawSink, ticketSink } = makeDeps({
			founderUserId: "not-a-snowflake",
		});
		const p = payload("workflow_engine_escalation");
		await sink.alert(p);
		expect(ticketSink.alert).toHaveBeenCalledExactlyOnceWith(p);
		expect(rawSink.alert).not.toHaveBeenCalled();
	});

	it("workflow dead-exec issue alerts use the bound issue thread", async () => {
		const { sink, rawSink, resolve, deliver } = makeDeps({
			resolve: () => THREAD,
		});
		const p = payload("workflow_engine_issue_alert");
		await sink.alert(p);
		expect(resolve).toHaveBeenCalledExactlyOnceWith(p);
		expect(deliver).toHaveBeenCalledExactlyOnceWith(p, THREAD);
		expect(rawSink.alert).not.toHaveBeenCalled();
	});

	it("issue-progress kind + bound thread → issue-thread leg, NOT rawSink", async () => {
		const { sink, rawSink, deliver } = makeDeps({ resolve: () => THREAD });
		const p = payload("three_stage_stuck");
		await sink.alert(p);
		expect(deliver).toHaveBeenCalledExactlyOnceWith(p, THREAD);
		expect(rawSink.alert).not.toHaveBeenCalled();
	});

	it("issue-progress kind, NO bound thread → fail-safe Claw mailbox", async () => {
		const { sink, rawSink, ticketSink, deliver } = makeDeps({
			resolve: () => null,
		});
		const p = payload("founder_gate_delivery_failed");
		await sink.alert(p);
		expect(ticketSink.alert).toHaveBeenCalledExactlyOnceWith(p);
		expect(rawSink.alert).not.toHaveBeenCalled();
		expect(deliver).not.toHaveBeenCalled();
	});

	it("resolver THROWS → fail-safe Claw mailbox", async () => {
		const { sink, rawSink, ticketSink } = makeDeps({
			resolve: () => {
				throw new Error("boom");
			},
		});
		const result = await sink.alert(payload("three_stage_stuck"));
		expect(ticketSink.alert).toHaveBeenCalledTimes(1);
		expect(rawSink.alert).not.toHaveBeenCalled();
		expect(result).toEqual({ queued: true });
	});

	it("issue-thread deliverer THROWS → fail-safe Claw mailbox", async () => {
		const { sink, rawSink, ticketSink } = makeDeps({
			resolve: () => THREAD,
			deliver: async () => {
				throw new Error("discord down");
			},
		});
		const result = await sink.alert(payload("three_stage_stuck"));
		expect(ticketSink.alert).toHaveBeenCalledTimes(1);
		expect(rawSink.alert).not.toHaveBeenCalled();
		expect(result).toEqual({ queued: true });
	});

	it("routing enabled for a ticket kind never resolves a thread (no wasted lookups)", async () => {
		const { sink, resolve } = makeDeps();
		await sink.alert(payload("usage_limit"));
		expect(resolve).not.toHaveBeenCalled();
	});
});
