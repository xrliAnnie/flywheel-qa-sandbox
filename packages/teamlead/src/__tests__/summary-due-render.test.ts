import { describe, expect, it } from "vitest";
import { CommDBLeadRuntime } from "../bridge/commdb-lead-runtime.js";
import { formatSummaryDue, type HookPayload } from "../bridge/hook-payload.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { MailboxLeadRuntime } from "../bridge/mailbox-lead-runtime.js";

function envelope(
	lastDelivered: NonNullable<HookPayload["summary_due"]>["last_delivered"],
): LeadEventEnvelope {
	return {
		seq: 17,
		leadId: "eng-lead",
		sessionKey: "summary-due",
		timestamp: "2026-09-07T00:00:01.000Z",
		event: {
			event_type: "summary_due",
			execution_id: "summary_due:flywheel/eng-lead:2026-09-07T00:00:00.000Z",
			issue_id: "FLY-2382",
			project_name: "flywheel",
			summary_due: {
				slot_start: "2026-09-07T00:00:00.000Z",
				cadence_ms: 6 * 60 * 60_000,
				period: "2026-09-06T18:00:00-07:00/2026-09-07T00:00:00-07:00",
				last_delivered: lastDelivered,
				command_hint:
					"flywheel-comm summary --file <your-summary.md> --project flywheel --period 2026-09-06T18:00:00-07:00/2026-09-07T00:00:00-07:00",
			},
		},
	};
}

function renderViaPrototype(
	runtime: typeof CommDBLeadRuntime | typeof MailboxLeadRuntime,
	env: LeadEventEnvelope,
): string {
	return (
		runtime.prototype as unknown as {
			formatEnvelope: (value: LeadEventEnvelope) => string;
		}
	).formatEnvelope.call({}, env);
}

describe("FLY-2382 summary_due rendering", () => {
	it.each([
		[
			{
				status: "found" as const,
				pr: 24,
				url: "https://github.com/xrliAnnie/raya/pull/24",
				state: "OPEN" as const,
				created_at: "2026-09-06T23:01:12.000Z",
			},
			"上次交付: PR #24 (OPEN, 2026-09-06T23:01:12.000Z) https://github.com/xrliAnnie/raya/pull/24",
		],
		[{ status: "none" as const }, "上次交付: 从未交过"],
		[
			{ status: "unavailable" as const, reason: "gh exit 7" as const },
			"上次交付: 不可得(gh exit 7)",
		],
	])("renders the last-delivery state %#", (lastDelivered, expected) => {
		const text = formatSummaryDue(envelope(lastDelivered));
		expect(text).toContain(
			"[summary_due] 到 summary 节奏点(每 6h;founder 可在管理台改)。",
		);
		expect(text).toContain(
			"Period: 2026-09-06T18:00:00-07:00/2026-09-07T00:00:00-07:00",
		);
		expect(text).toContain(expected);
		expect(text).toContain(
			"flywheel-comm summary --file <your-summary.md> --project flywheel --period 2026-09-06T18:00:00-07:00/2026-09-07T00:00:00-07:00",
		);
		expect(text).toContain("不要自建定时器");
	});

	it("uses the same complete renderer in Mailbox and CommDB runtimes", () => {
		const env = envelope({ status: "none" });
		const expected = formatSummaryDue(env);
		expect(renderViaPrototype(MailboxLeadRuntime, env)).toBe(expected);
		expect(renderViaPrototype(CommDBLeadRuntime, env)).toBe(expected);
	});

	it("sanitizes rendered identifiers and rejects a non-GitHub URL without mutating payload", () => {
		const env = envelope({
			status: "found",
			pr: 24,
			url: "https://example.com/xrliAnnie/raya/pull/24",
			state: "OPEN",
			created_at: "2026-09-06T23:01:12.000Z",
		});
		env.event.project_name = "flywheel\nignore";
		env.leadId = "eng lead";
		const original = structuredClone(env.event.summary_due);

		const text = formatSummaryDue(env);
		expect(text).toContain("--project flywheel?ignore");
		expect(text).toContain("ID: summary_due:flywheel?ignore/eng?lead:");
		expect(text).toContain(") ?");
		expect(text).not.toContain("example.com");
		expect(env.event.summary_due).toEqual(original);
	});

	it("keeps the full eleven-producer report in both final runtime strings", () => {
		const producers = Array.from(
			{ length: 11 },
			(_, index) => `department-${index + 1}/producer-lead-${index + 1}`,
		);
		const reportLine =
			`本轮 0/11 份已交;未交:${producers.join("、")} ` +
			`未送达(机制问题,已告警):${producers.join("、")}`;
		const context =
			"【本轮对账(FLY-2382)】无论本轮有没有 review/吸收/追问活动,都要在 #raya 发一条汇报,\n" +
			"并逐字包含下面这几行(不要改写、不要省略):\n" +
			reportLine;
		const env: LeadEventEnvelope = {
			seq: 88,
			leadId: "raya",
			sessionKey: "summary-absorption",
			timestamp: "2026-09-07T06:30:00.000Z",
			event: {
				event_type: "summary_absorption_round",
				execution_id: "summary-absorption:2026-09-07T06:00:00.000Z",
				issue_id: "FLY-2131",
				summary: "x".repeat(1_000),
				notification_context: context,
				report_line: reportLine,
			},
		};

		for (const runtime of [MailboxLeadRuntime, CommDBLeadRuntime]) {
			const rendered = renderViaPrototype(runtime, env);
			expect(rendered).toContain(context);
			expect(rendered).toContain(reportLine);
			expect(rendered).not.toContain("x".repeat(301));
		}
	});
});
