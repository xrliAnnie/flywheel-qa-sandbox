/**
 * FLY-929 B1+B2 — receipt write (P-expect gated) + the expectation watchdog.
 *
 * Deadline semantics: the 00:30 job publishes YESTERDAY's report, so past the
 * 01:00 local deadline the receipt must carry date === yesterday-in-report-tz.
 * The tz boundary cases pin the UTC-vs-LA cross-day behavior both ways.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	expectedReportDate,
	localDate,
	localHour,
	notifyDigestExpectTick,
} from "../notify-digest-expect.js";
import {
	readNotifyReceipts,
	writeTokenReportReceipt,
} from "../notify-receipts.js";

const LA = "America/Los_Angeles";
const EXPECT_ON = { FLYWHEEL_NOTIFY_DIGEST_EXPECT: "1" };

let dir: string;
let receiptsPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly929-receipts-"));
	receiptsPath = join(dir, "notify-receipts.json");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("tz helpers", () => {
	it("localDate/localHour translate a UTC instant into the report tz", () => {
		// 2026-07-07T08:30Z = 2026-07-07 01:30 PDT (UTC-7)
		const now = new Date("2026-07-07T08:30:00Z");
		expect(localDate(now, LA)).toBe("2026-07-07");
		expect(localHour(now, LA)).toBe(1);
	});

	it("UTC-vs-LA cross-day boundary: late-UTC is still the previous LA day", () => {
		// 2026-07-08T06:59Z = 2026-07-07 23:59 PDT — LA has NOT crossed the day
		const now = new Date("2026-07-08T06:59:00Z");
		expect(localDate(now, LA)).toBe("2026-07-07");
		expect(expectedReportDate(now, LA)).toBe("2026-07-06");
	});

	it("after the LA midnight the expected date advances", () => {
		// 2026-07-08T07:01Z = 2026-07-08 00:01 PDT
		const now = new Date("2026-07-08T07:01:00Z");
		expect(localDate(now, LA)).toBe("2026-07-08");
		expect(expectedReportDate(now, LA)).toBe("2026-07-07");
	});
});

// FLY-1243: the P-expect gate (FLYWHEEL_NOTIFY_DIGEST_EXPECT) is retired —
// writeTokenReportReceipt always writes. The "P-expect unset → ZERO
// filesystem side effects" off-path sentinel is deleted (no such off-path
// exists anymore); describe block renamed accordingly.
describe("writeTokenReportReceipt", () => {
	it("P-expect on → atomic receipt with date/ts/messageId", () => {
		const now = new Date("2026-07-07T07:31:00Z");
		writeTokenReportReceipt(
			{ date: "2026-07-06", messageId: "m1" },
			{ env: EXPECT_ON, path: receiptsPath, now: () => now },
		);
		const receipts = readNotifyReceipts(receiptsPath);
		expect(receipts.token_report).toEqual({
			date: "2026-07-06",
			ts: now.toISOString(),
			messageId: "m1",
		});
		// no stray temp file left behind
		expect(readFileSync(receiptsPath, "utf-8")).toContain("token_report");
	});

	it("write failure is logged, never thrown", () => {
		const log = vi.fn();
		// Put a regular FILE where the receipt's parent directory should be —
		// mkdir -p must fail, and the writer must swallow + log.
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		writeFileSync(join(dir, "blocker"), "not a directory", "utf-8");
		writeTokenReportReceipt(
			{ date: "2026-07-06" },
			{ env: EXPECT_ON, path: join(dir, "blocker", "x.json"), log },
		);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("receipt write failed"),
		);
	});

	it("corrupt receipts file reads as empty (treated as no receipt)", () => {
		writeTokenReportReceipt(
			{ date: "2026-07-06" },
			{ env: EXPECT_ON, path: receiptsPath },
		);
		// clobber with garbage
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		writeFileSync(receiptsPath, "not-json{{{", "utf-8");
		expect(readNotifyReceipts(receiptsPath)).toEqual({});
	});
});

describe("notifyDigestExpectTick", () => {
	// 2026-07-07 02:00 PDT — past the 01:00 deadline; expected report = 07-06.
	const PAST_DEADLINE = new Date("2026-07-07T09:00:00Z");

	function tick(
		overrides: Partial<Parameters<typeof notifyDigestExpectTick>[0]> = {},
	) {
		const alert = vi.fn().mockResolvedValue({ sent: true });
		return {
			alert,
			run: () =>
				notifyDigestExpectTick({
					now: PAST_DEADLINE,
					tz: LA,
					receiptsPath,
					alert,
					env: EXPECT_ON,
					...overrides,
				}),
		};
	}

	// FLY-1243: the P-expect gate is retired — notifyDigestExpectTick no
	// longer has an "inactive" outcome (that union member was removed); the
	// off-path sentinel is deleted.

	it("before the 01:00 local deadline → quiet", async () => {
		// 2026-07-07 00:30 PDT
		const { alert, run } = tick({ now: new Date("2026-07-07T07:30:00Z") });
		expect(await run()).toBe("before-deadline");
		expect(alert).not.toHaveBeenCalled();
	});

	it("receipt present with the expected date → quiet", async () => {
		writeTokenReportReceipt(
			{ date: "2026-07-06", messageId: "m1" },
			{ env: EXPECT_ON, path: receiptsPath },
		);
		const { alert, run } = tick();
		expect(await run()).toBe("receipt-ok");
		expect(alert).not.toHaveBeenCalled();
	});

	it("no receipt past the deadline → ONE alert with the date-keyed eventId + identity contract", async () => {
		const { alert, run } = tick();
		expect(await run()).toBe("alerted");
		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				leadId: "codex-infra-bot-lead",
				projectName: "flywheel",
				eventType: "notify_digest_failed",
				eventId: "notify_digest_failed:2026-07-06",
				severity: "warning",
			}),
		);
	});

	it("stale receipt (an older date) → alert", async () => {
		writeTokenReportReceipt(
			{ date: "2026-07-05" },
			{ env: EXPECT_ON, path: receiptsPath },
		);
		const { alert, run } = tick();
		expect(await run()).toBe("alerted");
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("repeated ticks produce the SAME eventId (claims-table dedup makes them one alert)", async () => {
		const t1 = tick();
		await t1.run();
		const t2 = tick();
		await t2.run();
		const id1 = t1.alert.mock.calls[0]?.[0]?.eventId;
		const id2 = t2.alert.mock.calls[0]?.[0]?.eventId;
		expect(id1).toBe("notify_digest_failed:2026-07-06");
		expect(id2).toBe(id1);
	});

	it("corrupt receipts file counts as no receipt → alert (fail-loud over silent)", async () => {
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		writeFileSync(receiptsPath, "%%%garbage", "utf-8");
		const { alert, run } = tick();
		expect(await run()).toBe("alerted");
		expect(alert).toHaveBeenCalledTimes(1);
	});
});
