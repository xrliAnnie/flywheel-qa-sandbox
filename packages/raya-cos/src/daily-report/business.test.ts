import { describe, expect, it } from "vitest";
import {
	assertDailyReportTransition,
	dueReportDate,
	parseReportDocument,
	serializeReportDocument,
} from "../contracts/daily-report.js";

const SHA = "a".repeat(40);

describe("daily-report business extraction from FLY-2380", () => {
	it("keeps the configured timezone cutoff", () => {
		expect(
			dueReportDate(
				Date.parse("2026-09-09T00:59:00.000Z"),
				"America/Los_Angeles",
				"18:00",
			),
		).toBe("2026-09-07");
		expect(
			dueReportDate(
				Date.parse("2026-09-09T01:00:00.000Z"),
				"America/Los_Angeles",
				"18:00",
			),
		).toBe("2026-09-08");
	});

	it("round-trips the report body and source provenance", () => {
		const document = serializeReportDocument(
			{
				issue: "FLY-2380",
				date: "2026-09-08",
				timezone: "America/Los_Angeles",
				generated_at: "2026-09-09T01:00:00.000Z",
				generation_turn_key: "daily-report:2026-09-08:gen:1",
				main_commit: SHA,
				sources: [
					{
						state: "merged",
						head: SHA,
						blob: SHA,
						path: "summaries/flywheel/2026-09-08--eng-lead--01.md",
						project: "flywheel",
						lead: "eng-lead",
						contract: "ok",
						bytes: 42,
						truncated: false,
						omitted: false,
						divergent: false,
						also_in: [],
					},
				],
				silent: [],
			},
			"## Judgment\nShip the standard Lead migration.",
		);

		expect(parseReportDocument(document, { date: "2026-09-08" })).toMatchObject(
			{
				body: "## Judgment\nShip the standard Lead migration.",
				meta: { date: "2026-09-08", sources: [{ project: "flywheel" }] },
			},
		);
	});

	it("rejects a false delivered transition", () => {
		expect(() =>
			assertDailyReportTransition(
				{ v: 1, date: "2026-09-08", status: "generating" },
				{ v: 1, date: "2026-09-08", status: "posted" },
			),
		).toThrow("generating -> posted");
	});
});
