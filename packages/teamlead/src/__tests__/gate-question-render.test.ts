/**
 * FLY-208 6a: gate_question rendering — shared formatter + JSON-shape
 * guidance for approve_to_ship.
 *
 * Production incident: the gate notification told the Lead
 * `respond ... "your reply"` with no mention that ONLY the JSON
 * `{"approved": true}` approves — the Lead's plain-text "APPROVE — ..." was
 * silently recorded as feedback (founder-consent wiring), forcing a ratify
 * retry loop. The formatter is shared (extracted BEFORE the copy change,
 * Codex design R2 #5) so the guidance cannot drift between runtimes.
 */

import { describe, expect, it, vi } from "vitest";
import { CommDBLeadRuntime } from "../bridge/commdb-lead-runtime.js";
import {
	formatGateQuestion,
	type HookPayload,
} from "../bridge/hook-payload.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { MailboxLeadRuntime } from "../bridge/mailbox-lead-runtime.js";

function gateEvent(checkpoint: string): HookPayload {
	return {
		event_type: "gate_question",
		execution_id: "exec-433d4078",
		issue_id: "issue-1",
		issue_identifier: "LEARN-12",
		project_name: "sub",
		status: "gate_pending",
		summary: "Approve to ship LEARN-12: about to merge PR #16",
		question_id: "q-e60b91b9",
		from_agent: "exec-433d4078",
		comm_db_path: "/tmp/comm.db",
		checkpoint,
	};
}

function envelope(event: HookPayload): LeadEventEnvelope {
	return {
		seq: 9,
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

describe("gate_question rendering (FLY-208 6a)", () => {
	it("approve_to_ship: reply command shows the required JSON shape + APPROVAL SHAPE guidance", () => {
		const text = formatGateQuestion(envelope(gateEvent("approve_to_ship")));
		expect(text).toContain(
			`respond --db /tmp/comm.db --bridge-url $BRIDGE_URL --lead <your_id> q-e60b91b9 '{"approved": true}'`,
		);
		expect(text).toContain("APPROVAL SHAPE");
		expect(text).toContain("recorded as FEEDBACK, not approval");
		// The misleading generic placeholder is GONE for approve
		expect(text).not.toContain('"your reply"');
	});

	it("non-approve checkpoints keep the legacy direct command (no --bridge-url, no shape banner)", () => {
		const text = formatGateQuestion(envelope(gateEvent("brainstorm")));
		expect(text).toContain('q-e60b91b9 "your reply"');
		expect(text).not.toContain("--bridge-url");
		expect(text).not.toContain("APPROVAL SHAPE");
		expect(text).toContain("[BRAINSTORM]");
	});

	it("MailboxLeadRuntime.deliver renders via the shared formatter", async () => {
		const { transport, writes } = mockTransport();
		const runtime = new MailboxLeadRuntime({ leadId: "sub-lead", transport });
		const env = envelope(gateEvent("approve_to_ship"));
		const result = await runtime.deliver(env);
		expect(result.delivered).toBe(true);
		expect(writes[0]?.payload.content).toBe(formatGateQuestion(env));
	});

	it("CommDBLeadRuntime formats identically (shared renderer parity)", () => {
		for (const cp of ["approve_to_ship", "brainstorm"]) {
			const env = envelope(gateEvent(cp));
			const rendered = (
				CommDBLeadRuntime.prototype as unknown as {
					formatEnvelope: (e: LeadEventEnvelope) => string;
				}
			).formatEnvelope.call({}, env);
			expect(rendered).toBe(formatGateQuestion(env));
		}
	});
});
