/**
 * FLY-1018: ship_approval_request rendering — shared formatter + both
 * concrete runtimes (plan §2.8 render contract, Codex R2-1 + R3-3).
 *
 * The generic formatter would drop pr_url / requester / requester_context;
 * missing EITHER runtime's first-class branch degrades that surface back to
 * the generic renderer and the founder-facing request loses its PR URL. So
 * both runtimes must render via the SHARED formatShipApprovalRequest
 * (parity-by-construction — FLY-195 lesson).
 */

import { describe, expect, it, vi } from "vitest";
import { CommDBLeadRuntime } from "../bridge/commdb-lead-runtime.js";
import {
	formatShipApprovalRequest,
	type HookPayload,
} from "../bridge/hook-payload.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { MailboxLeadRuntime } from "../bridge/mailbox-lead-runtime.js";

function shipEvent(overrides: Partial<HookPayload> = {}): HookPayload {
	return {
		event_type: "ship_approval_request",
		execution_id: "",
		issue_id: "",
		project_name: "geoforge3d",
		summary: "printer firmware fix ready",
		pr_url: "https://github.com/org/repo/pull/42",
		requester: "gemini-agent",
		requester_context: "Annie asked in the voice huddle",
		...overrides,
	};
}

function envelope(event: HookPayload): LeadEventEnvelope {
	return {
		seq: 7,
		event,
		sessionKey: "",
		leadId: "flywheel-eng-lead",
		timestamp: "2026-07-08T00:00:00.000Z",
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

describe("ship_approval_request rendering (FLY-1018)", () => {
	it("renders PR URL, requester, context and the 'nothing merged' note verbatim", () => {
		const text = formatShipApprovalRequest(envelope(shipEvent()));
		expect(text).toContain(
			"[ship-approval-request] requester=gemini-agent PR https://github.com/org/repo/pull/42 — printer firmware fix ready(Annie asked in the voice huddle). Nothing merged; founder approval + owning runner verified ship flow still required.",
		);
		expect(text).toContain("Project: geoforge3d");
		expect(text).toContain("carries no ship authority");
	});

	it("omits the context parenthetical when requester_context is absent", () => {
		const text = formatShipApprovalRequest(
			envelope(shipEvent({ requester_context: undefined })),
		);
		expect(text).toContain(
			"PR https://github.com/org/repo/pull/42 — printer firmware fix ready. Nothing merged;",
		);
	});

	it("MailboxLeadRuntime.deliver renders via the shared formatter", async () => {
		const { transport, writes } = mockTransport();
		const runtime = new MailboxLeadRuntime({
			leadId: "flywheel-eng-lead",
			transport,
		});
		const env = envelope(shipEvent());
		const result = await runtime.deliver(env);
		expect(result.delivered).toBe(true);
		expect(writes[0]?.payload.content).toBe(formatShipApprovalRequest(env));
	});

	it("CommDBLeadRuntime formats identically (shared renderer parity)", () => {
		const env = envelope(shipEvent());
		const rendered = (
			CommDBLeadRuntime.prototype as unknown as {
				formatEnvelope: (e: LeadEventEnvelope) => string;
			}
		).formatEnvelope.call({}, env);
		expect(rendered).toBe(formatShipApprovalRequest(env));
	});
});
