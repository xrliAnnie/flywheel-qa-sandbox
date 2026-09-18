import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "../business-round.js";

const roots: string[] = [];
function fixture(existingRoot?: string, reportDate = "2026-09-15") {
	const root = existingRoot ?? mkdtempSync(join(tmpdir(), "report-send-"));
	roots.push(root);
	let now = Date.parse("2026-09-16T03:00:00Z");
	const round = new BusinessRound(root, () => now);
	let v = round.prepare({
		schemaVersion: 2,
		kind: "daily_report",
		sourceRefs: ["wake"],
		wake: {
			scheduleId: "daily-report",
			revision: 1,
			configDigest: "a".repeat(64),
			localDate: reportDate,
			dueAt:
				reportDate === "2026-09-15"
					? "2026-09-16T03:00:00Z"
					: "2026-09-15T03:00:00Z",
			timezone: "America/Los_Angeles",
		},
	});
	const record = (result: object, tool = "current_turn") => {
		v = round.record({
			schemaVersion: 2,
			operationId: v.operationId,
			expectedRevision: v.revision,
			tool,
			callId: String(v.revision),
			result,
		});
		return v;
	};
	record({
		action: "collect",
		mainCommit: "b".repeat(40),
		sources: [],
		silent: [],
	});
	record({
		action: "generate",
		body: `## 今天各项目发生了什么\n${"x ".repeat(4000)}\n## 我的判断\n继续观察。`,
		sourceRefs: [],
	});
	const document = String(v.material?.document),
		fileSha = createHash("sha1")
			.update(`blob ${Buffer.byteLength(document)}\0`)
			.update(document)
			.digest("hex");
	record({
		action: "probe",
		repo: "xrliAnnie/raya",
		ref: "main",
		path: `reports/${reportDate}.md`,
		status: "exists",
		document,
		fileSha,
	});
	return {
		root,
		round,
		record,
		view: () => v,
		advance: (ms: number) => {
			now += ms;
		},
	};
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("durable report chunk delivery", () => {
	it("reserves before sending and resumes unknown outcomes without issuing another send", () => {
		const f = fixture(),
			attempt = f.record({ action: "begin_send" });
		expect(attempt.next?.tool).toBe("lead_actions.discord_send");
		expect(f.round.resume(attempt.operationId)).toMatchObject({
			next: null,
			needsReconciliation: true,
		});
		const eventId = attempt.next?.arguments.eventId;
		f.record(
			{
				project: "raya",
				leadId: "raya",
				target: "chat",
				eventId,
				status: "ambiguous",
			},
			"lead_actions.discord_send",
		);
		expect(f.view()).toMatchObject({ next: null, needsReconciliation: true });
		const done = f.record(
			{
				project: "raya",
				leadId: "raya",
				target: "chat",
				eventId,
				status: "sent",
				messageId: "111111111111111111",
				channelId: "222222222222222222",
			},
			"lead_actions.discord_send",
		);
		expect(done.stage).toBe("posting");
		expect(done.material?.messageIds).toMatchObject({
			"0": "111111111111111111",
		});
	});
	it("enforces four attempts in sixty seconds and respects platform retryAfterMs", () => {
		const f = fixture();
		for (let i = 0; i < 4; i++) {
			const attempt = f.record({ action: "begin_send" });
			f.record(
				{
					project: "raya",
					leadId: "raya",
					target: "chat",
					eventId: attempt.next?.arguments.eventId,
					status: "sent",
					messageId: String(111111111111111110n + BigInt(i)),
					channelId: "222222222222222222",
				},
				"lead_actions.discord_send",
			);
		}
		expect(f.record({ action: "begin_send" })).toMatchObject({
			next: null,
			nextAttemptAt: expect.any(Number),
		});
		f.advance(60000);
		const attempt = f.record({ action: "begin_send" });
		const limited = f.record(
			{
				project: "raya",
				leadId: "raya",
				target: "chat",
				eventId: attempt.next?.arguments.eventId,
				status: "rate_limited",
				retryAfterMs: 5000,
			},
			"lead_actions.discord_send",
		);
		expect(limited).toMatchObject({
			next: null,
			nextAttemptAt: expect.any(Number),
		});
		expect(f.record({ action: "begin_send" }).next).toBeNull();
		f.advance(5000);
		expect(f.record({ action: "begin_send" }).next?.arguments.eventId).toBe(
			attempt.next?.arguments.eventId,
		);
	});
	it("does not mark posted until every chunk has a bound sent receipt", () => {
		const f = fixture();
		const chunks = (f.view().material?.context as { chunks: unknown[] }).chunks;
		for (let i = 0; i < chunks.length; i++) {
			if (i % 4 === 0) f.advance(60000);
			const attempt = f.record({ action: "begin_send" });
			expect(() =>
				f.record(
					{
						project: "raya",
						leadId: "raya",
						target: "chat",
						eventId: "foreign",
						status: "sent",
						messageId: "111111111111111111",
						channelId: "222222222222222222",
					},
					"lead_actions.discord_send",
				),
			).toThrow();
			f.record(
				{
					project: "raya",
					leadId: "raya",
					target: "chat",
					eventId: attempt.next?.arguments.eventId,
					status: "sent",
					messageId: String(333333333333333330n + BigInt(i)),
					channelId: "222222222222222222",
				},
				"lead_actions.discord_send",
			);
		}
		expect(f.view()).toMatchObject({
			stage: "posted",
			next: null,
			needsReconciliation: false,
		});
	});
});

it("shares the reservation budget across catch-up dates and keeps internal budget out of status", () => {
	const f = fixture();
	for (let i = 0; i < 4; i++) {
		const attempt = f.record({ action: "begin_send" });
		f.record(
			{
				project: "raya",
				leadId: "raya",
				target: "chat",
				eventId: attempt.next?.arguments.eventId,
				status: "sent",
				messageId: String(444444444444444440n + BigInt(i)),
				channelId: "222222222222222222",
			},
			"lead_actions.discord_send",
		);
	}
	const older = fixture(f.root, "2026-09-14");
	expect(older.record({ action: "begin_send" })).toMatchObject({
		next: null,
		nextAttemptAt: expect.any(Number),
	});
	expect(
		older.round.status().operations.map((op) => op.operationId),
	).not.toContain("daily-report:send-budget");
});
