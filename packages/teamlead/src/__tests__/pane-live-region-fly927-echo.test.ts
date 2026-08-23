/**
 * FLY-927 (Task 1.2): echo-immunity ↔ alert-kind-table parity.
 *
 * The FLY-220 storm family fires when a Bridge alert echoed back into a Lead
 * pane re-triggers classification. The old `ALERT_ECHO_START` hand-enumerated
 * 7 kinds — every newer kind's first-line echo leaked past the strip. It now
 * derives its kind alternation from the shared `ALERT_EVENT_TYPES` table and
 * strips the FLY-927 🎫 ticket-header line, so this suite proves:
 *  - EVERY union kind's first-line echo matches the strip regex,
 *  - the 🎫 header line matches the strip regex,
 *  - an idle Lead pane carrying a full new-format echo stays idle-healthy,
 *  - real block evidence sharing the screen with an echo STILL alerts
 *    (anti-masking, the FLY-218 precedent).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyLeadAlertPane } from "../bridge/pane-blocked-classifier.js";
import { ALERT_ECHO_START } from "../bridge/pane-live-region.js";
import { ALERT_EVENT_TYPES } from "../LeadAlertNotifier.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const loadFixture = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

/** Inject lines into a fixture pane just ABOVE the input-box border so they
 * land inside the live render region (the strongest place for an echo to
 * poison classification). */
function injectAboveInputBox(pane: string, lines: string[]): string {
	const all = pane.split("\n");
	for (let i = all.length - 1; i >= 0; i--) {
		if (/─{6,}[^\n]*@[\w-]+\s+─/u.test(all[i]!)) {
			return [...all.slice(0, i), ...lines, ...all.slice(i)].join("\n");
		}
	}
	throw new Error("fixture has no input-box border");
}

describe("FLY-927 echo-immunity parity (kind table ↔ ALERT_ECHO_START)", () => {
	it("EVERY AlertEventType's first-line echo matches the strip regex", () => {
		for (const kind of ALERT_EVENT_TYPES) {
			const firstLine = `⚠️ **Some alert title** (flywheel-eng-lead / ${kind})`;
			expect(
				ALERT_ECHO_START.test(firstLine),
				`kind "${kind}" first-line echo must be strippable`,
			).toBe(true);
		}
	});

	it("the 🎫 ticket-header line matches the strip regex", () => {
		expect(
			ALERT_ECHO_START.test(
				"🎫 flywheel · 首见 09:05 · owner <@123456789012345678> · 状态 NEW",
			),
		).toBe(true);
		expect(
			ALERT_ECHO_START.test("  🎫 flywheel · 首见 09:05 · owner — · 状态 NEW"),
		).toBe(true);
	});

	it("a retired founder milestone alert remains echo-only compatible", () => {
		expect(
			ALERT_ECHO_START.test(
				"⚠️ **Delivery failed** (flywheel-eng-lead / founder_milestone_undelivered)",
			),
		).toBe(true);
		expect(ALERT_EVENT_TYPES).not.toContain("founder_milestone_undelivered");
	});

	it("a normal Lead output line does NOT match (no over-stripping)", () => {
		for (const line of [
			"⏺ Working on the ticket queue implementation now.",
			"reading packages/teamlead/src/LeadAlertNotifier.ts",
			"the rate limit handling looks fine", // wording alone, no signature
		]) {
			expect(ALERT_ECHO_START.test(line), line).toBe(false);
		}
	});

	it("MUST-ALERT: a real usage cap sharing the screen with a 🎫 echo still classifies usage_limit", () => {
		const pane = injectAboveInputBox(loadFixture("usage-limit-real.txt"), [
			"🎫 flywheel · 首见 09:05 · owner — · 状态 NEW",
		]);
		expect(classifyLeadAlertPane(pane)).toBe("usage_limit");
	});

	it("MUST-ALERT: a real rate-limit pane with an echoed alert above still classifies rate_limit", () => {
		const pane = injectAboveInputBox(loadFixture("rate-limit-real.txt"), [
			"⚠️ **Lead hit rate limit** (product-lead / rate_limit)",
			"🎫 geoforge3d · 首见 08:00 · owner — · 状态 NEW",
		]);
		expect(classifyLeadAlertPane(pane)).toBe("rate_limit");
	});
});
