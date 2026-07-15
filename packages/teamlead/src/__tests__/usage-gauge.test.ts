/**
 * FLY-696 M1/C2: parseUsageGauge — extract the Claude CLI status-bar
 * `5h ██ NN% reset <when> | 7d ██ NN% reset <when>` gauge into structured
 * 5h/weekly percentages + ABSOLUTE reset timestamps + which cap (scope) is hit.
 *
 * Fixtures are the committed real pane (`usage-limit-real.txt`) plus extrapolated
 * variants of the SAME confirmed status-bar format.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUsageGauge } from "../account-heal/usage-gauge.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const fx = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

// Deterministic anchor: Fri 2026-07-03 15:00 America/Chicago (CDT, UTC-5).
const NOW = new Date("2026-07-03T20:00:00Z");
const TZ = "America/Chicago";

describe("parseUsageGauge", () => {
	it("parses the committed real pane: 5h capped (100%), weekly at 82% → scope 5h", () => {
		const g = parseUsageGauge(fx("usage-limit-real.txt"), NOW, TZ);
		expect(g).not.toBeNull();
		expect(g?.fivehPct).toBe(100);
		expect(g?.weeklyPct).toBe(82);
		expect(g?.scope).toBe("5h");
		// today 21:30 CDT = 2026-07-04 02:30 UTC
		expect(g?.fivehResetAt).toBe("2026-07-04T02:30:00.000Z");
		// next Monday (Jul 6) 09:00 CDT = 14:00 UTC
		expect(g?.weeklyResetAt).toBe("2026-07-06T14:00:00.000Z");
		expect(g?.confidence).toBe("high");
	});

	it("parses a weekly cap: weekly 100%, 5h below → scope weekly", () => {
		const g = parseUsageGauge(fx("usage-limit-weekly.txt"), NOW, TZ);
		expect(g?.fivehPct).toBe(31);
		expect(g?.weeklyPct).toBe(100);
		expect(g?.scope).toBe("weekly");
		// today 18:00 CDT = 2026-07-03 23:00 UTC
		expect(g?.fivehResetAt).toBe("2026-07-03T23:00:00.000Z");
		expect(g?.weeklyResetAt).toBe("2026-07-06T14:00:00.000Z");
	});

	it("parses both caps at 100% → scope both", () => {
		const g = parseUsageGauge(fx("usage-limit-both.txt"), NOW, TZ);
		expect(g?.fivehPct).toBe(100);
		expect(g?.weeklyPct).toBe(100);
		expect(g?.scope).toBe("both");
	});

	it("returns null when the gauge line is absent (ambiguous → caller needs_human)", () => {
		expect(
			parseUsageGauge(fx("usage-gauge-ambiguous.txt"), NOW, TZ),
		).toBeNull();
	});

	it("returns null for a pane with no gauge at all", () => {
		expect(
			parseUsageGauge("just some text\nno gauge here\n", NOW, TZ),
		).toBeNull();
	});

	it("scope is null (low confidence) when the gauge parses but neither cap is 100%", () => {
		const pane =
			"  5h ███░░░░░░░ 30% reset today 21:30  |  7d ████░░░░░░ 40% reset Mon 09:00\n";
		const g = parseUsageGauge(pane, NOW, TZ);
		expect(g?.fivehPct).toBe(30);
		expect(g?.weeklyPct).toBe(40);
		expect(g?.scope).toBeNull();
	});

	it("resolves a weekday reset to the SAME day when its time is still ahead today", () => {
		// NOW is Friday 15:00 CDT; "Fri 21:30" is later today.
		const pane =
			"  5h ██████████ 100% reset Fri 21:30  |  7d ████████░░ 82% reset Mon 09:00\n";
		const g = parseUsageGauge(pane, NOW, TZ);
		expect(g?.fivehResetAt).toBe("2026-07-04T02:30:00.000Z");
	});
});
