import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "../business-round.js";

const roots: string[] = [];
const now = Date.parse("2026-09-16T03:00:00Z"),
	founder = "777777777777777777",
	channel = "222222222222222222",
	message = "111111111111111111";
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "report-reply-"));
	roots.push(root);
	const round = new BusinessRound(root, () => now);
	let v = round.prepare({
		schemaVersion: 2,
		kind: "daily_report",
		sourceRefs: ["wake"],
		wake: {
			scheduleId: "daily-report",
			revision: 1,
			configDigest: "a".repeat(64),
			localDate: "2026-09-15",
			dueAt: "2026-09-16T03:00:00Z",
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
		body: "## 今天各项目发生了什么\n暂无更新。\n## 我的判断\n等待更多证据。",
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
		path: "reports/2026-09-15.md",
		status: "exists",
		document,
		fileSha,
	});
	const attempt = record({ action: "begin_send" });
	record(
		{
			project: "raya",
			leadId: "raya",
			target: "chat",
			eventId: attempt.next?.arguments.eventId,
			status: "sent",
			messageId: message,
			channelId: channel,
		},
		"lead_actions.discord_send",
	);
	return { root, round, document, fileSha };
}
const source = {
	messageId: "888888888888888888",
	channelId: channel,
	authorId: founder,
	body: "明天先核对交付风险。",
	observedAt: now,
	replyTo: { messageId: message, channelId: channel },
};
const prepare = (round: BusinessRound, s: object = source) =>
	round.prepare({
		schemaVersion: 2,
		kind: "report_reply",
		founderUserId: founder,
		source: s,
	});
function record(
	round: BusinessRound,
	v: { operationId: string; revision: number },
	result: object,
) {
	return round.record({
		schemaVersion: 2,
		operationId: v.operationId,
		expectedRevision: v.revision,
		tool: "current_turn",
		callId: String(v.revision),
		result,
	});
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("report discussion association", () => {
	it("binds a real chunk reply, rereads the exact report, and preserves feedback once", () => {
		const { root, round, document, fileSha } = fixture(),
			p = prepare(round);
		expect(p).toMatchObject({
			stage: "awaiting_report_read",
			next: { arguments: { action: "read_report", fileSha } },
		});
		expect(() =>
			record(round, p, {
				action: "verify_report",
				fileSha: "f".repeat(40),
				document,
			}),
		).toThrow();
		const verified = record(round, p, {
			action: "verify_report",
			fileSha,
			document,
		});
		const completed = record(round, verified, {
			action: "interpret",
			note: "她希望明天先核对交付风险。",
		});
		expect(completed).toMatchObject({
			stage: "complete",
			material: {
				note: "她希望明天先核对交付风险。",
				source: { messageId: source.messageId },
			},
		});
		expect(prepare(new BusinessRound(root, () => now))).toEqual(completed);
		expect(() => prepare(round, { ...source, body: "changed" })).toThrow(
			/binding/,
		);
	});
	it("never falls back from a foreign replyTo to a guessed report and rejects a non-founder", () => {
		const { round } = fixture();
		expect(
			prepare(round, {
				...source,
				body: "2026-09-15 的日报",
				replyTo: { messageId: "999999999999999999", channelId: channel },
			}),
		).toMatchObject({ stage: "needs_clarification" });
		expect(() =>
			prepare(round, { ...source, authorId: "666666666666666666" }),
		).toThrow(/founder/);
	});
	it("uses only an unambiguous explicit date when no replyTo exists", () => {
		const { round } = fixture();
		const { replyTo: _reply, ...without } = source;
		expect(
			prepare(round, { ...without, body: "说的是 2026-09-15 的日报。" }),
		).toMatchObject({ stage: "awaiting_report_read" });
		const f = fixture();
		expect(
			prepare(f.round, { ...without, body: "比较 2026-09-14 和 2026-09-15。" }),
		).toMatchObject({ stage: "needs_clarification" });
	});
});
