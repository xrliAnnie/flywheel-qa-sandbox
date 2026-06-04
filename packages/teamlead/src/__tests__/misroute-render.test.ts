/**
 * FLY-208 A2: runner_misrouted_report rendering parity (mailbox/commdb).
 *
 * Same parity-by-construction rationale as the FLY-195 stuck-escalation
 * renderer: the bug class is drift between the event payload and the text
 * the Lead actually reads. One shared renderer, asserted identical across
 * both Lead runtimes, for both the per-message and the aggregate-backlog
 * shapes.
 */

import { describe, expect, it, vi } from "vitest";
import { CommDBLeadRuntime } from "../bridge/commdb-lead-runtime.js";
import {
	formatMisroutedReport,
	type HookPayload,
} from "../bridge/hook-payload.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { MailboxLeadRuntime } from "../bridge/mailbox-lead-runtime.js";

function perMessageEvent(): HookPayload {
	return {
		event_type: "runner_misrouted_report",
		execution_id: "runner-433d4078",
		issue_id: "unknown",
		project_name: "sub",
		status: "misrouted_report",
		from_agent: "runner-433d4078",
		misroute_from: "runner-433d4078",
		misrouted_at: "2026-06-04T06:18:36.368Z",
		summary: "Annie R1 意见已落地并 push 到 PR #16(commit 45721d0)",
		misroute_hint:
			"Reply to the Runner via `flywheel-comm send` (NOT SendMessage).",
	};
}

function aggregateEvent(): HookPayload {
	return {
		event_type: "runner_misrouted_report",
		execution_id: "misroute-backlog",
		issue_id: "unknown",
		project_name: "geoforge3d",
		status: "misrouted_backlog",
		summary: "184 misrouted runner report(s) from [runner-a, runner-b] ...",
		misroute_count: 184,
		misroute_archive_path:
			"/Users/x/.flywheel/state/misroute-archive/product-lead/misroute_agg_abcd1234abcd1234.jsonl",
		misroute_hint:
			"Reply to the Runner via `flywheel-comm send` (NOT SendMessage).",
	};
}

function envelope(event: HookPayload): LeadEventEnvelope {
	return {
		seq: 7,
		event,
		sessionKey: event.execution_id,
		leadId: "sub-lead",
		timestamp: "2026-06-04T07:00:00.000Z",
	};
}

function mockTransport() {
	const writes: Array<{ payload: { content: string } }> = [];
	const transport = {
		vendorId: () => "claude-code",
		capabilities: () => ({
			wakeMode: "builtin-receiver",
			preflightIsHardGate: true,
			preservesMetadata: true,
			maxPayloadBytes: 1_000_000,
			requiresStableAgentIdentity: true,
		}),
		getInboxPath: () => "/dummy/inbox.json",
		getStateDir: () => "/dummy/state",
		write: vi.fn(async (w: { payload: { content: string } }) => {
			writes.push(w);
			return {
				flywheelId: "test-id",
				idempotent: false,
				wroteAt: 1_700_000_000_000,
				finalized: true,
			};
		}),
		verifyLastWrite: vi.fn(async () => {}),
		readUnread: vi.fn(async () => []),
		ack: vi.fn(async () => {}),
		dedupeKey: (m: { id: string }) => m.id,
		createReceiver: () => null,
		buildRunnerSpawnConfig: () => ({ args: [], env: {} }),
		buildLeadSpawnConfig: () => ({ args: [], env: {} }),
		preflight: vi.fn(async () => ({ ok: true, availabilitySignals: [] })),
	} as never;
	return { writes, transport };
}

function renderViaCommDbPrototype(env: LeadEventEnvelope): string {
	// The runner_misrouted_report branch returns before touching `this`, so no
	// real CommDB needs to be opened (same trick as the FLY-195 parity test).
	return (
		CommDBLeadRuntime.prototype as unknown as {
			formatEnvelope: (e: LeadEventEnvelope) => string;
		}
	).formatEnvelope.call({}, env);
}

describe("runner_misrouted_report rendering (FLY-208 A2)", () => {
	it("per-message shape: original text + black-hole explanation + hint", () => {
		const text = formatMisroutedReport(envelope(perMessageEvent()));
		expect(text).toContain("runner_misrouted_report");
		expect(text).toContain("MISROUTED REPORT from runner-433d4078");
		expect(text).toContain("2026-06-04T06:18:36.368Z");
		expect(text).toContain("black-hole");
		expect(text).toContain("Annie R1 意见已落地并 push 到 PR #16");
		expect(text).toContain("flywheel-comm send");
	});

	it("aggregate shape: count + archive path + not-replayed warning", () => {
		const text = formatMisroutedReport(envelope(aggregateEvent()));
		expect(text).toContain("MISROUTED BACKLOG: 184");
		expect(text).toContain("misroute_agg_abcd1234abcd1234.jsonl");
		expect(text).toContain("do NOT assume any of them was handled");
	});

	it("MailboxLeadRuntime.deliver renders via the shared formatter", async () => {
		const { transport, writes } = mockTransport();
		const runtime = new MailboxLeadRuntime({
			leadId: "sub-lead",
			transport,
		});
		const env = envelope(perMessageEvent());
		const result = await runtime.deliver(env);
		expect(result.delivered).toBe(true);
		expect(writes[0]?.payload.content).toBe(formatMisroutedReport(env));
	});

	it("CommDBLeadRuntime formats identically (shared renderer parity)", () => {
		const env = envelope(perMessageEvent());
		expect(renderViaCommDbPrototype(env)).toBe(formatMisroutedReport(env));
		const agg = envelope(aggregateEvent());
		expect(renderViaCommDbPrototype(agg)).toBe(formatMisroutedReport(agg));
	});
});
