/**
 * FLY-696 M1/C3 — buildAccountLimitMetadata: turn a captured pane into the
 * AlertMetadata.accountLimit object the switch path consumes, or null when the
 * gauge is ambiguous (→ the alert stays needs_human, never a blind switch).
 *
 * NOTE: the 529/transient-throttle short-circuit (§3.3 hard boundary) is the
 * CALLER's job (isTransientThrottlePane runs before this). This builder assumes
 * it is only reached for a real cap, and independently returns null if the gauge
 * shows no cap — defense in depth.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAccountLimitMetadata } from "../account-heal/account-limit.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const fx = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

const NOW = new Date("2026-07-03T20:00:00Z");
const TZ = "America/Chicago";

const base = {
	now: NOW,
	timeZone: TZ,
	provider: "claude" as const,
	observedAccount: "personal",
	observedGeneration: 3,
};

describe("buildAccountLimitMetadata", () => {
	it("5h cap → provider/scope/observed snapshot + the 5h reset instant", () => {
		const m = buildAccountLimitMetadata({
			...base,
			pane: fx("usage-limit-real.txt"),
		});
		expect(m).toEqual({
			provider: "claude",
			scope: "5h",
			resetAt: "2026-07-04T02:30:00.000Z",
			observedAccount: "personal",
			observedGeneration: 3,
		});
	});

	it("weekly cap → uses the weekly reset instant", () => {
		const m = buildAccountLimitMetadata({
			...base,
			pane: fx("usage-limit-weekly.txt"),
		});
		expect(m?.scope).toBe("weekly");
		expect(m?.resetAt).toBe("2026-07-06T14:00:00.000Z");
	});

	it("both caps → scope 'both', weekly reset dominates the resetAt", () => {
		const m = buildAccountLimitMetadata({
			...base,
			pane: fx("usage-limit-both.txt"),
		});
		expect(m?.scope).toBe("both");
		expect(m?.resetAt).toBe("2026-07-06T14:00:00.000Z");
	});

	it("ambiguous gauge → null (no switch metadata; caller → needs_human)", () => {
		expect(
			buildAccountLimitMetadata({
				...base,
				pane: fx("usage-gauge-ambiguous.txt"),
			}),
		).toBeNull();
	});

	it("gauge parses but neither cap is 100% → null (defense in depth)", () => {
		const pane =
			"  5h ███░░░░░░░ 30% reset today 21:30  |  7d ████░░░░░░ 40% reset Mon 09:00\n";
		expect(buildAccountLimitMetadata({ ...base, pane })).toBeNull();
	});

	it("carries the caller's observed account + generation (CAS snapshot)", () => {
		const m = buildAccountLimitMetadata({
			...base,
			pane: fx("usage-limit-real.txt"),
			observedAccount: "school",
			observedGeneration: 9,
		});
		expect(m?.observedAccount).toBe("school");
		expect(m?.observedGeneration).toBe(9);
	});
});
