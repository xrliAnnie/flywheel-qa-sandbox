import { describe, expect, it } from "vitest";
import { scheduledAtOrBefore } from "../../bridge/patrol-tick.js";
import { buildFreshness } from "../freshness.js";

const GENERATED_AT = "2026-09-05T04:00:00.000Z";

describe("FLY-2143 Epic page freshness", () => {
	it("builds nine independently sourced cells without timestamps inside values", () => {
		const freshness = buildFreshness({
			projectName: "flywheel",
			generatedAt: GENERATED_AT,
			version: 7,
			trigger: "event",
			reasons: ["session_completed"],
			history: {
				last_generated: {
					version: 6,
					attempted_at: "2026-09-05T03:30:00.000Z",
					trigger: "scan",
				},
				last_published: {
					version: 5,
					attempted_at: "2026-09-05T03:00:00.000Z",
					trigger: "event",
				},
				publish_failures_since_last_published: 2,
				last_publish_failure: {
					attempted_at: "2026-09-05T03:45:00.000Z",
					token: "transient: publish_failed:blob",
				},
				last_failure: {
					attempted_at: "2026-09-05T03:50:00.000Z",
					token: "transient: linear_unavailable",
				},
			},
			publication: {
				token: "0123456789abcdef0123456789abcdef",
				published: true,
				first_published_at: "2026-09-04T01:00:00.000Z",
				last_published_at: "2026-09-05T03:00:00.000Z",
				last_version: 5,
			},
			sourceCells: [
				{
					path: "/items/0/title",
					observedAt: "2026-09-05T02:00:00.000Z",
				},
				{
					path: "/items/0/session",
					observedAt: GENERATED_AT,
				},
			],
			scanSchedule: { leadId: "flywheel-eng-lead", intervalMs: 30 * 60_000 },
		});

		expect(freshness.current).toMatchObject({
			value: {
				version: 7,
				trigger: "event",
				reasons: ["session_completed"],
			},
			provenance: { kind: "statestore", table: "epic_page" },
			observed_at: GENERATED_AT,
			source_updated_at: GENERATED_AT,
		});
		expect(freshness.last_generated).toMatchObject({
			value: { version: 6, trigger: "scan" },
			provenance: { kind: "statestore", table: "epic_page_refresh" },
			source_updated_at: "2026-09-05T03:30:00.000Z",
		});
		expect(freshness.last_published).toMatchObject({
			value: { version: 5, trigger: "event" },
			source_updated_at: "2026-09-05T03:00:00.000Z",
		});
		expect(freshness.publish_failures.value).toEqual({ count: 2 });
		expect(freshness.last_failure).toMatchObject({
			value: { token: "transient: linear_unavailable" },
			source_updated_at: "2026-09-05T03:50:00.000Z",
		});
		expect(freshness.last_publish_failure).toMatchObject({
			value: { token: "transient: publish_failed:blob" },
			source_updated_at: "2026-09-05T03:45:00.000Z",
		});
		expect(freshness.hosted).toMatchObject({
			value: { token8: "01234567", published: true, last_version: 5 },
			provenance: {
				kind: "statestore",
				table: "epic_page_publication",
			},
			source_updated_at: "2026-09-05T03:00:00.000Z",
		});
		expect(freshness.oldest_source).toMatchObject({
			value: { path: "/items/0/title" },
			provenance: {
				kind: "derived",
				rule: "freshness.v1",
				from: expect.arrayContaining([
					"/items/0/title",
					"/freshness/current",
					"/freshness/hosted",
				]),
			},
		});
		const generatedMs = Date.parse(GENERATED_AT);
		const intervalMs = 30 * 60_000;
		const next =
			scheduledAtOrBefore(generatedMs, "flywheel-eng-lead", intervalMs) +
			intervalMs;
		expect(freshness.next_scan.value).toEqual({
			expected_in_seconds: Math.ceil((next - generatedMs) / 1_000),
		});

		for (const cell of Object.values(freshness)) {
			if (cell.value && typeof cell.value === "object") {
				expect(Object.keys(cell.value).some((key) => key.endsWith("_at"))).toBe(
					false,
				);
			}
		}
	});

	it("self-reports absent history, publication, and scan ownership", () => {
		const freshness = buildFreshness({
			projectName: "flywheel",
			generatedAt: GENERATED_AT,
			version: 1,
			trigger: "manual",
			reasons: ["manual"],
			history: { publish_failures_since_last_published: 0 },
			sourceCells: [],
		});

		expect(freshness.last_generated.missing?.reason).toBe(
			"no_prior_generation",
		);
		expect(freshness.last_published.missing?.reason).toBe(
			"no_prior_publication",
		);
		expect(freshness.last_failure.missing?.reason).toBe("no_prior_failure");
		expect(freshness.last_publish_failure.missing?.reason).toBe(
			"no_prior_failure",
		);
		expect(freshness.hosted.missing?.reason).toBe("no_publication");
		expect(freshness.next_scan.missing?.reason).toBe("no_scan_schedule");
		expect(freshness.oldest_source.value).toEqual({
			path: "/freshness/current",
		});
	});
});
