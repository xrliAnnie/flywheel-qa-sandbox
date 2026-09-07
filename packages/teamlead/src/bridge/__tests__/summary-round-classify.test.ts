import type {
	MailboxSettlement,
	MailboxState,
} from "flywheel-comm/mailbox-queue";
import { summaryDeliveryBranch } from "flywheel-comm/summary-contract";
import { describe, expect, it } from "vitest";
import type { SummaryPull } from "../summary-delivery-ledger.js";
import {
	classifyRound,
	type SummaryDueRoundRow,
} from "../summary-round-classify.js";

const PERIOD = "2026-09-07T00:00:00-07:00/2026-09-07T06:00:00-07:00";
const due = (leadId: string, projectName = "flywheel"): SummaryDueRoundRow => ({
	projectName,
	leadId,
	period: PERIOD,
});
const key = (row: SummaryDueRoundRow) => `${row.projectName}/${row.leadId}`;
const evidence = {
	deadReason: null,
	lastError: null,
	createdAt: "2026-09-07T00:00:01.000Z",
	deliveredAt: null,
	notifiedAt: null,
};
const live = (
	state: MailboxState,
	deliveredAt: string | null = null,
): MailboxSettlement => ({
	kind: "live",
	state,
	settledAt:
		state === "ACKED" || state === "DEAD" ? "2026-09-07T00:01:00.000Z" : null,
	...evidence,
	deliveredAt,
});
const pull = (row: SummaryDueRoundRow): SummaryPull => ({
	number: 24,
	url: "https://github.com/xrliAnnie/raya/pull/24",
	state: "OPEN",
	project: row.projectName,
	lead: row.leadId,
	headRefName: summaryDeliveryBranch({
		project: row.projectName,
		author: row.leadId,
		period: row.period,
	}),
	createdAt: Date.parse("2026-09-07T00:02:00.000Z"),
});

describe("FLY-2382 summary round classification", () => {
	it("counts only the exact due-period branch while keeping inbox delivery orthogonal", () => {
		const exact = due("eng-lead");
		const wrongPeriod = due("product-lead");
		const wrongPull = {
			...pull(wrongPeriod),
			headRefName: summaryDeliveryBranch({
				project: wrongPeriod.projectName,
				author: wrongPeriod.leadId,
				period: "2026-09-06/2026-09-06",
			}),
		};
		const result = classifyRound(
			[exact, wrongPeriod],
			{ status: "ok", pulls: [pull(exact), wrongPull] },
			new Map([
				[key(exact), live("DEAD")],
				[key(wrongPeriod), live("ACKED")],
			]),
		);

		expect(result).toMatchObject({
			round_ledger: "ok",
			producer_count: 2,
			delivered_count: 1,
			absent: ["product-lead"],
			undelivered: ["eng-lead"],
			report_line:
				"本轮 1/2 份已交;未交:product-lead 未送达(机制问题,已告警):eng-lead",
		});
		expect(result.producers[0]).toMatchObject({
			delivered: true,
			due_delivery: "undelivered",
			delivered_pr: { number: 24 },
		});
	});

	it("does not count a closed exact-branch PR as delivered", () => {
		const row = due("eng-lead");
		const result = classifyRound(
			[row],
			{ status: "ok", pulls: [{ ...pull(row), state: "CLOSED" }] },
			new Map([[key(row), live("ACKED")]]),
		);

		expect(result).toMatchObject({
			delivered_count: 0,
			absent: ["eng-lead"],
			undelivered: [],
			report_line: "本轮 0/1 份已交;未交:eng-lead",
		});
		expect(result.producers[0]).toMatchObject({
			delivered: false,
			due_delivery: "delivered",
		});
		expect(result.producers[0]).not.toHaveProperty("delivered_pr");
	});

	it.each([
		["absent identity", { kind: "absent_identity" } as const, "undelivered"],
		["torn identity", { kind: "torn_identity" } as const, "undelivered"],
		["queued", live("QUEUED"), "undelivered"],
		["leased before delivery", live("LEASED"), "undelivered"],
		[
			"leased after delivery",
			live("LEASED", "2026-09-07T00:00:05.000Z"),
			"delivered",
		],
		["acked", live("ACKED"), "delivered"],
		["dead", live("DEAD"), "undelivered"],
		[
			"archived queued",
			{
				kind: "archived_nonterminal",
				state: "QUEUED",
				settledAt: null,
				...evidence,
			} as const,
			"undelivered",
		],
		[
			"archived delivered lease",
			{
				kind: "archived_nonterminal",
				state: "LEASED",
				settledAt: null,
				...evidence,
				deliveredAt: "2026-09-07T00:00:05.000Z",
			} as const,
			"delivered",
		],
		[
			"archived ack",
			{
				kind: "archived_terminal",
				state: "ACKED",
				settledAt: "2026-09-07T00:01:00.000Z",
				...evidence,
			} as const,
			"delivered",
		],
		[
			"archived dead",
			{
				kind: "archived_terminal",
				state: "DEAD",
				settledAt: "2026-09-07T00:01:00.000Z",
				...evidence,
			} as const,
			"undelivered",
		],
		["inspection error", "unknown" as const, "unknown"],
	] as const)("maps %s to %s", (_name, settlement, expected) => {
		const row = due("eng-lead");
		const result = classifyRound(
			[row],
			{ status: "ok", pulls: [] },
			new Map([[key(row), settlement]]),
		);
		expect(result.producers[0]?.due_delivery).toBe(expected);
	});

	it("never calls an unavailable ledger silence and still exposes delivery failure", () => {
		const row = due("eng-lead");
		const result = classifyRound(
			[row],
			{ status: "unavailable", reason: "gh exit 7" },
			new Map([[key(row), live("DEAD")]]),
		);

		expect(result).toMatchObject({
			round_ledger: "unavailable",
			absent: [],
			undelivered: ["eng-lead"],
			delivery_unknown: [],
		});
		expect(result).not.toHaveProperty("producer_count");
		expect(result).not.toHaveProperty("delivered_count");
		expect(result.report_line).toBe(
			"本轮交付状态不可得(gh exit 7),只报吸收不报缺席。 未送达(机制问题,已告警):eng-lead",
		);
	});

	it("renders complete and unexplained-difference branches without listing absent producers", () => {
		const row = due("eng-lead");
		expect(
			classifyRound(
				[row],
				{ status: "ok", pulls: [pull(row)] },
				new Map([[key(row), live("ACKED")]]),
			).report_line,
		).toBe("本轮 1/1 份已交。");
		expect(
			classifyRound(
				[row],
				{ status: "ok", pulls: [] },
				new Map([[key(row), "unknown"]]),
			).report_line,
		).toBe(
			"本轮 0/1 份已交;无人「未交」——差额见下。 送达状态不可得(不计未交):eng-lead",
		);
	});

	it("qualifies duplicate Lead names and strips controls from report text", () => {
		const rows = [
			due("same\nlead", "project a"),
			due("same\nlead", "project b"),
		];
		const result = classifyRound(
			rows,
			{ status: "ok", pulls: [] },
			new Map(rows.map((row) => [key(row), live("ACKED")])),
		);

		expect(result.absent).toEqual([
			"project a/same\nlead",
			"project b/same\nlead",
		]);
		expect(result.report_line).toContain(
			"未交:project?a/same?lead、project?b/same?lead",
		);
		expect(
			[...result.report_line].some((character) => {
				const code = character.codePointAt(0) ?? 0;
				return code < 32 || code === 127;
			}),
		).toBe(false);
	});
});
