import { expect, it } from "vitest";
import {
	buildReplay,
	replayVerdict,
} from "../../../../../engineering/doc/FLY-2390-criteria-c-aggregator/fixtures/replay.js";
import { renderReadinessReport } from "../release-readiness/report.js";

it("replays raw observation occurrences, bug tags, missing heartbeat and founder days into all three states", () => {
	const green = replayVerdict(buildReplay("green"));
	expect(green.state).toBe("green");
	expect(green.evidence.counts).toMatchObject({ severe: 0, warning: 1 });
	const holdInput = buildReplay("hold");
	const hold = replayVerdict(holdInput);
	expect(hold.state).toBe("hold");
	expect(hold.reasons.map((r) => r.code)).toContain("founder_thumbs_down");
	expect(hold.evidence.founder.days.map((d) => d.sentiment)).toEqual([
		"down",
		"up",
	]);
	expect(hold.evidence.counts.bugs).toBe(1);
	const unknown = replayVerdict(buildReplay("unknown"));
	expect(unknown.state).toBe("unknown");
	expect(unknown.reasons.map((r) => r.code)).toEqual(
		expect.arrayContaining([
			"heartbeat_stale",
			"outbox_pending",
			"bug_source_unhealthy",
		]),
	);
	expect(unknown.evidence.window.windowTruncated).toBe(true);
	expect(unknown.evidence.counts.unattributedSevere).toBe(1);
	const html = renderReadinessReport(holdInput, hold, "2026-09-11");
	expect(html).toContain("founder_thumbs_down");
	expect(Buffer.byteLength(html)).toBeLessThanOrEqual(512 * 1024);
	expect(
		readFileSync(
			new URL(
				"../../../../../engineering/doc/FLY-2390-criteria-c-aggregator/fixtures/report-sample.html",
				import.meta.url,
			),
			"utf8",
		),
	).toBe(renderReadinessReport(holdInput, hold, "2026-09-11 · 回放样例"));
});

import { readFileSync } from "node:fs";
