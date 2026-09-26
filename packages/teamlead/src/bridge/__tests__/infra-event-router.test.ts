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
} from "../../LeadAlertNotifier.js";
import {
	type BoundIssueThread,
	classifyInfraEvent,
	createInfraAlertSink,
	ISSUE_PROGRESS_KINDS,
	TICKET_KINDS,
} from "../infra-event-router.js";

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
			expect(["ticket", "issue_thread", "notify"]).toContain(route);
			expect(route).not.toBe("issue_thread"); // unbound never goes to a thread
		}
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
		const resolve = vi.fn(overrides?.resolve ?? (() => null));
		const deliver = vi.fn(
			overrides?.deliver ??
				(async (): Promise<AlertResult> => ({ sent: true })),
		);
		const sink = createInfraAlertSink({
			rawSink,
			routingEnabled: overrides?.routingEnabled ?? (() => true),
			resolveBoundIssueThread: resolve,
			deliverToIssueThread: deliver,
			logger: () => {},
		});
		return { sink, rawSink, resolve, deliver };
	}

	it("routing DISABLED (env unset) → pure passthrough; resolver never consulted", async () => {
		const { sink, rawSink, resolve, deliver } = makeDeps({
			routingEnabled: () => false,
		});
		const p = payload("three_stage_stuck");
		const result = await sink.alert(p);
		expect(rawSink.alert).toHaveBeenCalledExactlyOnceWith(p);
		expect(resolve).not.toHaveBeenCalled();
		expect(deliver).not.toHaveBeenCalled();
		expect(result).toEqual({ sent: true });
	});

	it("ticket kind → rawSink even when a thread is bound", async () => {
		const { sink, rawSink, deliver } = makeDeps({ resolve: () => THREAD });
		await sink.alert(payload("rate_limit"));
		expect(rawSink.alert).toHaveBeenCalledTimes(1);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("issue-progress kind + bound thread → issue-thread leg, NOT rawSink", async () => {
		const { sink, rawSink, deliver } = makeDeps({ resolve: () => THREAD });
		const p = payload("three_stage_stuck");
		await sink.alert(p);
		expect(deliver).toHaveBeenCalledExactlyOnceWith(p, THREAD);
		expect(rawSink.alert).not.toHaveBeenCalled();
	});

	it("issue-progress kind, NO bound thread → fail-safe rawSink (queue)", async () => {
		const { sink, rawSink, deliver } = makeDeps({ resolve: () => null });
		await sink.alert(payload("founder_milestone_undelivered"));
		expect(rawSink.alert).toHaveBeenCalledTimes(1);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("resolver THROWS → fail-safe rawSink (an alert is never lost on a resolver bug)", async () => {
		const { sink, rawSink } = makeDeps({
			resolve: () => {
				throw new Error("boom");
			},
		});
		const result = await sink.alert(payload("three_stage_stuck"));
		expect(rawSink.alert).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ sent: true });
	});

	it("issue-thread deliverer THROWS → fail-safe rawSink (never silent)", async () => {
		const { sink, rawSink } = makeDeps({
			resolve: () => THREAD,
			deliver: async () => {
				throw new Error("discord down");
			},
		});
		const result = await sink.alert(payload("three_stage_stuck"));
		expect(rawSink.alert).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ sent: true });
	});

	it("routing enabled for a ticket kind never resolves a thread (no wasted lookups)", async () => {
		const { sink, resolve } = makeDeps();
		await sink.alert(payload("usage_limit"));
		expect(resolve).not.toHaveBeenCalled();
	});
});
