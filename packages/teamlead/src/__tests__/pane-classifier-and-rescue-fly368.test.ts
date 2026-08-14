/** FLY-368 pure pane-classifier and safe-resume fixture coverage. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyLeadAlertPane } from "../bridge/pane-blocked-classifier.js";
import { isSafeResumeMenuForEnter } from "../bridge/rescue.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const fx = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

describe("classifyLeadAlertPane (FLY-368 public classifier)", () => {
	it("classifies a real rate-limit pane as rate_limit", () => {
		expect(classifyLeadAlertPane(fx("rate-limit-real.txt"))).toBe("rate_limit");
	});
	it("classifies a real usage-limit pane as usage_limit", () => {
		expect(classifyLeadAlertPane(fx("usage-limit-real.txt"))).toBe(
			"usage_limit",
		);
	});
	it("returns the legacy sentinel when no blocked kind is present", () => {
		expect(classifyLeadAlertPane(fx("idle-cos-lead.txt"))).toBe(
			"pane_hash_stuck",
		);
	});
});

describe("isSafeResumeMenuForEnter (FLY-368 narrow resume-menu recognizer)", () => {
	it("TRUE only for the exact resume menu", () => {
		expect(isSafeResumeMenuForEnter(fx("freeze-resume-menu.txt"))).toBe(true);
	});
	it("FALSE for the compact prompt (Enter starts compaction — not safe)", () => {
		expect(isSafeResumeMenuForEnter(fx("freeze-compact-prompt.txt"))).toBe(
			false,
		);
	});
	it("FALSE for an in-flight compaction", () => {
		expect(isSafeResumeMenuForEnter(fx("freeze-compacting.txt"))).toBe(false);
	});
	it("FALSE for idle / rate-limit / empty panes", () => {
		expect(isSafeResumeMenuForEnter(fx("idle-cos-lead.txt"))).toBe(false);
		expect(isSafeResumeMenuForEnter(fx("rate-limit-real.txt"))).toBe(false);
		expect(isSafeResumeMenuForEnter("")).toBe(false);
	});
});
