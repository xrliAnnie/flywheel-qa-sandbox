/**
 * FLY-929 QA (three-stage QA phase) — date-contract hardening for B1↔B2.
 *
 * The implement-phase suite (notify-digest-expect.test.ts) already pins the
 * happy path and the UTC-vs-LA cross-day boundary, and does a real
 * write→tick round-trip in America/Los_Angeles. This QA file adds the edge
 * cases that the LA-only suite does not exercise but that the Codex design
 * R1#5 date contract depends on:
 *
 *   1. The EXACT 01:00 local deadline (inclusive) — the pivot between
 *      "before-deadline" and a real judgement.
 *   2. A non-US, non-DST report timezone (Asia/Shanghai, UTC+8) — a real
 *      writeTokenReportReceipt → notifyDigestExpectTick round-trip so the
 *      date the writer records and the date the tick expects are proven to
 *      align under a different offset, not just LA.
 *   3. DST transition days in LA (spring-forward + fall-back) — proving the
 *      UTC-arithmetic civil-date shift stays correct across an offset change.
 *   4. Year/month rollover in the civil-date shift.
 *
 * Every assertion uses the REAL exported production functions (no mocks of the
 * unit under test) and injects `now`/`tz`/`env` — zero production code touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	expectedReportDate,
	localHour,
	notifyDigestExpectTick,
} from "../notify-digest-expect.js";
import { writeTokenReportReceipt } from "../notify-receipts.js";

const LA = "America/Los_Angeles";
const SHANGHAI = "Asia/Shanghai"; // UTC+8, no DST
const EXPECT_ON = { FLYWHEEL_NOTIFY_DIGEST_EXPECT: "1" };

let dir: string;
let receiptsPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly929-qa-datecontract-"));
	receiptsPath = join(dir, "notify-receipts.json");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("FLY-929 QA · 01:00 deadline is inclusive", () => {
	// PDT = UTC-7. 2026-07-07T08:00:00Z = exactly 01:00:00 local.
	it("exactly 01:00 local → the check runs (localHour === 1, not before-deadline)", async () => {
		const now = new Date("2026-07-07T08:00:00Z");
		expect(localHour(now, LA)).toBe(1);
		const alert = vi.fn().mockResolvedValue({ sent: true });
		// No receipt written → past the (inclusive) deadline ⇒ it must alert,
		// which proves the tick did NOT short-circuit as "before-deadline".
		const outcome = await notifyDigestExpectTick({
			now,
			tz: LA,
			receiptsPath,
			alert,
			env: EXPECT_ON,
		});
		expect(outcome).toBe("alerted");
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("one minute before (00:59 local) → before-deadline, silent", async () => {
		const now = new Date("2026-07-07T07:59:00Z"); // 00:59 PDT
		expect(localHour(now, LA)).toBe(0);
		const alert = vi.fn();
		const outcome = await notifyDigestExpectTick({
			now,
			tz: LA,
			receiptsPath,
			alert,
			env: EXPECT_ON,
		});
		expect(outcome).toBe("before-deadline");
		expect(alert).not.toHaveBeenCalled();
	});
});

describe("FLY-929 QA · non-US report timezone round-trip (Asia/Shanghai, UTC+8)", () => {
	// 2026-07-06T18:00:00Z = 2026-07-07 02:00 Shanghai — past the 01:00 deadline,
	// so the expected report day is yesterday-in-Shanghai = 2026-07-06.
	const NOW = new Date("2026-07-06T18:00:00Z");

	it("expectedReportDate aligns with the Shanghai civil day", () => {
		expect(expectedReportDate(NOW, SHANGHAI)).toBe("2026-07-06");
	});

	it("real receipt for the expected Shanghai day → receipt-ok (quiet)", async () => {
		writeTokenReportReceipt(
			{ date: "2026-07-06", messageId: "sh-1" },
			{ env: EXPECT_ON, path: receiptsPath },
		);
		const alert = vi.fn();
		const outcome = await notifyDigestExpectTick({
			now: NOW,
			tz: SHANGHAI,
			receiptsPath,
			alert,
			env: EXPECT_ON,
		});
		expect(outcome).toBe("receipt-ok");
		expect(alert).not.toHaveBeenCalled();
	});

	it("real receipt for the PREVIOUS Shanghai day → alerted (stale)", async () => {
		writeTokenReportReceipt(
			{ date: "2026-07-05" },
			{ env: EXPECT_ON, path: receiptsPath },
		);
		const alert = vi.fn().mockResolvedValue({ sent: true });
		const outcome = await notifyDigestExpectTick({
			now: NOW,
			tz: SHANGHAI,
			receiptsPath,
			alert,
			env: EXPECT_ON,
		});
		expect(outcome).toBe("alerted");
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({ eventId: "notify_digest_failed:2026-07-06" }),
		);
	});

	it("before 01:00 Shanghai → before-deadline regardless of receipt", async () => {
		const now = new Date("2026-07-06T16:30:00Z"); // 2026-07-07 00:30 Shanghai
		expect(localHour(now, SHANGHAI)).toBe(0);
		const alert = vi.fn();
		const outcome = await notifyDigestExpectTick({
			now,
			tz: SHANGHAI,
			receiptsPath,
			alert,
			env: EXPECT_ON,
		});
		expect(outcome).toBe("before-deadline");
		expect(alert).not.toHaveBeenCalled();
	});
});

describe("FLY-929 QA · civil-date shift is DST- and rollover-safe", () => {
	// The UTC-arithmetic shiftDay must land on the correct previous civil date
	// even when the offset changes across the DST boundary.
	it("LA spring-forward day (2026-03-08) → previous civil day is 03-07", () => {
		// 2026-03-08T18:00:00Z = 11:00 PDT (already sprung forward to UTC-7).
		const now = new Date("2026-03-08T18:00:00Z");
		expect(localHour(now, LA)).toBe(11);
		expect(expectedReportDate(now, LA)).toBe("2026-03-07");
	});

	it("LA fall-back day (2026-11-01) → previous civil day is 10-31", () => {
		// 2026-11-01T18:00:00Z = 10:00 PST (fallen back to UTC-8).
		const now = new Date("2026-11-01T18:00:00Z");
		expect(localHour(now, LA)).toBe(10);
		expect(expectedReportDate(now, LA)).toBe("2026-10-31");
	});

	it("month rollover: 1st of month → last day of the previous month", () => {
		// 2026-07-01 05:00Z, judged in UTC → expected = 2026-06-30.
		expect(expectedReportDate(new Date("2026-07-01T05:00:00Z"), "UTC")).toBe(
			"2026-06-30",
		);
	});

	it("year rollover: Jan 1 → Dec 31 of the previous year", () => {
		expect(expectedReportDate(new Date("2026-01-01T05:00:00Z"), "UTC")).toBe(
			"2025-12-31",
		);
	});
});
