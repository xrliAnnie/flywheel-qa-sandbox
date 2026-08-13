import type { IAgentTeamTransport } from "flywheel-agent-team-transport";
import { describe, expect, it } from "vitest";
import { CommDBLeadRuntime } from "../bridge/commdb-lead-runtime.js";
import { formatPatrolTick } from "../bridge/hook-payload.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { MailboxLeadRuntime } from "../bridge/mailbox-lead-runtime.js";

function envelope(
	roster: LeadEventEnvelope["event"]["roster"],
): LeadEventEnvelope {
	return {
		seq: 1,
		eventId: "tick-1",
		event: {
			event_type: "patrol_tick",
			execution_id: "patrol:flywheel:eng-lead",
			issue_id: "",
			project_name: "flywheel",
			roster,
			generated_at: "2026-08-13T12:00:00.000Z",
		},
		sessionKey: "patrol:flywheel:eng-lead",
		leadId: "eng-lead",
		timestamp: "2026-08-13T12:00:00.000Z",
	};
}

describe("FLY-1687 patrol tick rendering", () => {
	it("is exactly alarm + untrusted roster declaration with no Bridge judgment", () => {
		const body = formatPatrolTick(
			envelope([
				{
					identifier: "FLY-1687",
					sessionRole: "implement",
					status: "running",
					executionId8: "12345678",
				},
			]),
		);
		expect(body).toBe(
			"[patrol_tick] 巡检时间到。\n" +
				"按 Bridge 的账,你名下有 1 个未终结 runner(此名册是待核声明,不是结论):\n" +
				"- FLY-1687 [12345678] (implement, running)",
		);
		for (const directive of [
			"check",
			"verify",
			"suggest",
			"inspect",
			"建议",
			"怀疑",
			"该查",
		]) {
			expect(body.toLowerCase()).not.toContain(directive);
		}
	});

	it("fails closed on multiline/control/directive roster fields", () => {
		const body = formatPatrolTick(
			envelope([
				{
					identifier: "FLY-1\n该查这个",
					sessionRole: "verify",
					status: "running",
					executionId8: "12345678",
				},
			]),
		);
		expect(body.split("\n")).toHaveLength(3);
		expect(body).toMatch(
			/- unsafe-[a-f0-9]{8} \[12345678\] \(unsafe-[a-f0-9]{8}, running\)$/,
		);
		for (const directive of [
			"verify",
			"suggest",
			"inspect",
			"建议",
			"怀疑",
			"该查",
		]) {
			expect(body.toLowerCase()).not.toContain(directive);
		}
	});

	it("uses one shared renderer in Mailbox and CommDB runtimes", () => {
		const env = envelope([]);
		const transport = {
			vendorId: () => "test",
			capabilities: () => ({}),
		} as unknown as IAgentTeamTransport;
		const mailbox = new MailboxLeadRuntime({ leadId: "eng-lead", transport });
		const commdb = new CommDBLeadRuntime(":memory:", "eng-lead");
		try {
			expect(mailbox.renderEnvelope(env)).toBe(commdb.renderEnvelope(env));
			expect(mailbox.renderEnvelope(env)).toBe(formatPatrolTick(env));
		} finally {
			void mailbox.shutdown();
			void commdb.shutdown();
		}
	});
});
