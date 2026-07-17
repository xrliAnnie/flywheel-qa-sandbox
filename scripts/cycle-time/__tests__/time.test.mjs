import assert from "node:assert/strict";
import test from "node:test";

import {
	buildLoadOverlays,
	buildNightOverlays,
	zonedDateTimeToMs,
} from "../lib/time.mjs";

test("night overlay is 23:00-08:00 in America/Los_Angeles during PDT", () => {
	const start = Date.parse("2026-07-17T05:00:00Z");
	const end = Date.parse("2026-07-17T17:00:00Z");
	assert.deepEqual(buildNightOverlays(start, end, "America/Los_Angeles"), [
		{
			start_ms: Date.parse("2026-07-17T06:00:00Z"),
			end_ms: Date.parse("2026-07-17T15:00:00Z"),
		},
	]);
});

test("night overlay honors the spring DST jump instead of assuming nine elapsed hours", () => {
	const start = Date.parse("2026-03-08T06:00:00Z");
	const end = Date.parse("2026-03-08T17:00:00Z");
	const [night] = buildNightOverlays(start, end, "America/Los_Angeles");
	assert.equal(night.start_ms, Date.parse("2026-03-08T07:00:00Z"));
	assert.equal(night.end_ms, Date.parse("2026-03-08T15:00:00Z"));
	assert.equal(night.end_ms - night.start_ms, 8 * 60 * 60 * 1000);
});

test("load overlay distinguishes saturated buckets from missing telemetry", () => {
	const start = zonedDateTimeToMs(
		{ year: 2026, month: 7, day: 16, hour: 22, minute: 58, second: 0 },
		"America/Los_Angeles",
	);
	const end = start + 3 * 60_000;
	const overlays = buildLoadOverlays(
		"2026-07-16 22:58:00 load averages: 10.00 9.00 8.00\n2026-07-16 23:00:00 load averages: 108.76 50.00 30.00\n",
		{
			start_ms: start,
			end_ms: end,
			timezone: "America/Los_Angeles",
			threshold: 30,
		},
	);
	assert.deepEqual(overlays, [
		{
			kind: "load_unknown",
			intervals: [{ start_ms: start + 60_000, end_ms: start + 120_000 }],
		},
		{
			kind: "load_saturated",
			intervals: [{ start_ms: start + 120_000, end_ms: start + 180_000 }],
		},
	]);
});

test("load overlay parses the production two-line system-health block format", () => {
	const start = zonedDateTimeToMs(
		{ year: 2026, month: 7, day: 17, hour: 0, minute: 0, second: 40 },
		"America/Los_Angeles",
	);
	const overlays = buildLoadOverlays(
		[
			"===== 2026-07-17 00:00:40 PDT =====",
			"-- uptime / load --",
			" 0:00 up 3 days, load averages: 35.16 33.08 38.34",
			"===== 2026-07-17 00:01:40 PDT =====",
			"-- uptime / load --",
			" 0:01 up 3 days, load averages: 10.00 9.00 8.00",
		].join("\n"),
		{
			start_ms: start,
			end_ms: start + 120_000,
			timezone: "America/Los_Angeles",
			threshold: 30,
		},
	);
	assert.deepEqual(overlays, [
		{
			kind: "load_saturated",
			intervals: [{ start_ms: start, end_ms: start + 60_000 }],
		},
	]);
});
