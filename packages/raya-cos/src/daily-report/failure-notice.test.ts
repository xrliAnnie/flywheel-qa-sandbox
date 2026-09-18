import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "../business-round.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "report-notice-"));
	roots.push(root);
	const now = Date.parse("2026-09-16T03:00:00Z"),
		round = new BusinessRound(root, () => now);
	const initial = round.prepare({
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
	function record(result: object) {
		const v = round.resume(initial.operationId);
		return round.record({
			schemaVersion: 2,
			operationId: v.operationId,
			expectedRevision: v.revision,
			tool: "current_turn",
			callId: String(v.revision),
			result,
		});
	}
	return { round, record, initial };
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("daily failure notice", () => {
	it("freezes one notice while preserving the failed stage for independent recovery", () => {
		const f = fixture(),
			failed = f.record({
				action: "failure",
				reason: "GitHub unavailable",
				sourceRef: "tool:read",
			});
		expect(failed.stage).toBe("prepared");
		expect(failed.next).toMatchObject({
			tool: "current_turn",
			arguments: { action: "prepare_failure_notice" },
		});
		const input = failed.next?.arguments.input as Record<string, unknown>;
		expect(input.eventId).toBe(
			`daily-report:2026-09-15:${"0".repeat(40)}:notice:0`,
		);
		const repeated = f.record({
			action: "failure",
			reason: "Still unavailable",
			sourceRef: "tool:read2",
		});
		expect(repeated.next?.arguments.input).toEqual(input);
		expect(
			f.record({
				action: "collect",
				mainCommit: "b".repeat(40),
				sources: [],
				silent: [],
			}).stage,
		).toBe("collecting_complete");
	});
	it("only acknowledges a notice with an exact real announcement receipt", () => {
		const f = fixture(),
			failed = f.record({
				action: "failure",
				reason: "read failed",
				sourceRef: "tool:read",
			});
		const notice = f.round.prepare(failed.next?.arguments.input);
		expect(() =>
			f.record({
				action: "confirm_failure_notice",
				noticeOperationId: notice.operationId,
			}),
		).toThrow(/confirmed/);
		const uncertain = f.round.record({
			schemaVersion: 2,
			operationId: notice.operationId,
			expectedRevision: notice.revision,
			tool: "lead_actions.discord_send",
			callId: "send",
			result: {
				project: "raya",
				leadId: "raya",
				target: "chat",
				eventId: notice.next?.arguments.eventId,
				status: "ambiguous",
			},
		});
		expect(() =>
			f.record({
				action: "confirm_failure_notice",
				noticeOperationId: notice.operationId,
			}),
		).toThrow(/confirmed/);
		f.round.record({
			schemaVersion: 2,
			operationId: notice.operationId,
			expectedRevision: uncertain.revision,
			tool: "lead_actions.discord_send",
			callId: "reconcile",
			result: {
				project: "raya",
				leadId: "raya",
				target: "chat",
				eventId: notice.next?.arguments.eventId,
				status: "sent",
				messageId: "111111111111111111",
				channelId: "222222222222222222",
			},
		});
		expect(
			f.record({
				action: "confirm_failure_notice",
				noticeOperationId: notice.operationId,
			}),
		).toMatchObject({
			stage: "prepared",
			material: {
				failureNotice: { status: "sent", messageId: "111111111111111111" },
			},
		});
	});
});
