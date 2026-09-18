import { describe, expect, it } from "vitest";
import { recoverDailyReportStep } from "./controller.js";

describe("daily report recovery", () => {
	it.each([
		["generating", "generate"],
		["generated", "write"],
		["file_written", "ingest"],
		["ingesting", "reconcile_ingest"],
		["ingested", "announce"],
		["posting", "reconcile_announcement"],
		["posted", "complete"],
		["posted_unknown", "stop_unknown"],
	] as const)(
		"maps %s to %s without rerunning prior side effects",
		(status, step) => {
			expect(recoverDailyReportStep({ v: 1, date: "2026-09-08", status })).toBe(
				step,
			);
		},
	);
});
