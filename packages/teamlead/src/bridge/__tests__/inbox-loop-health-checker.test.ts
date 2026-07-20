import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxLoopHealthChecker } from "../inbox-loop-health-checker.js";

let dir: string;
let queue: LeadInboxQueue;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inbox-health-"));
	queue = new LeadInboxQueue(join(dir, "comm.db"));
});

afterEach(() => {
	queue.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("InboxLoopHealthChecker", () => {
	it("alerts for the failed Lead when a sibling Lead is healthy", async () => {
		queue.recordTickStarted("lead-healthy", "2026-07-19T00:09:00.000Z");
		queue.recordTickSuccess("lead-healthy", "2026-07-19T00:09:00.000Z");
		queue.recordTickStarted("lead-failed", "2026-07-19T00:00:00.000Z");
		const alert = vi.fn(async () => undefined);
		const checker = new InboxLoopHealthChecker({
			targets: [
				{ projectName: "same-project", leadId: "lead-healthy", queue },
				{ projectName: "same-project", leadId: "lead-failed", queue },
			],
			alert,
			startedAtMs: Date.parse("2026-07-19T00:00:00.000Z"),
			stallMs: 10 * 60_000,
			startupGraceMs: 5 * 60_000,
			now: () => Date.parse("2026-07-19T00:11:00.000Z"),
		});

		await checker.check();
		await checker.check();

		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				leadId: "lead-failed",
				projectName: "same-project",
				eventType: "inbox_loop_stalled",
			}),
		);
		expect(String(alert.mock.calls[0]?.[0].body)).toContain(
			"lead_id=lead-failed",
		);
	});

	it("includes overdue and P0 counts in the same latched alert", async () => {
		queue.recordTickSuccess("lead-x", "2026-07-19T00:10:30.000Z");
		queue.enqueue({
			id: "p0-overdue",
			toLead: "lead-x",
			source: "gate",
			type: "question",
			msgClass: "model",
			priority: 0,
			content: "ship gate",
			deadlineAt: "2026-07-19T00:10:59.000Z",
		});
		queue.enqueue({
			id: "p2-overdue",
			toLead: "lead-x",
			source: "report",
			type: "report",
			msgClass: "model",
			priority: 2,
			content: "report",
			deadlineAt: "2026-07-19T00:10:58.000Z",
		});
		const alert = vi.fn(async () => undefined);
		const checker = new InboxLoopHealthChecker({
			targets: [{ projectName: "project", leadId: "lead-x", queue }],
			alert,
			startedAtMs: Date.parse("2026-07-19T00:00:00.000Z"),
			stallMs: 10 * 60_000,
			startupGraceMs: 5 * 60_000,
			now: () => Date.parse("2026-07-19T00:11:00.000Z"),
		});

		await checker.check();
		await checker.check();

		expect(alert).toHaveBeenCalledTimes(1);
		const payload = alert.mock.calls[0]?.[0];
		expect(payload?.body).toContain("overdue=2");
		expect(payload?.body).toContain("p0_overdue=1");
		expect(payload?.severity).toBe("severe");
	});
});
