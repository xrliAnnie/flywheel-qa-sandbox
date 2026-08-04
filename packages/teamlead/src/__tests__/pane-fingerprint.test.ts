import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	detectInputBoxPresent,
	fingerprintOutput,
	isStuckEligibleStatus,
	sigFingerprint,
} from "../bridge/pane-fingerprint.js";

describe("pane fingerprints", () => {
	it("uses stable, distinct 16-hex hashes", () => {
		expect(fingerprintOutput("same")).toMatch(/^[0-9a-f]{16}$/);
		expect(fingerprintOutput("same")).toBe(fingerprintOutput("same"));
		expect(fingerprintOutput("same")).not.toBe(fingerprintOutput("different"));
		expect(sigFingerprint("error")).toMatch(/^sig:[0-9a-f]{16}$/);
	});

	it("only treats running sessions as eligible", () => {
		expect(isStuckEligibleStatus("running")).toBe(true);
		expect(isStuckEligibleStatus("awaiting_review")).toBe(false);
		expect(isStuckEligibleStatus("completed")).toBe(false);
	});
});

describe("detectInputBoxPresent", () => {
	it("detects an idle input box and rejects active output", () => {
		expect(
			detectInputBoxPresent(
				"some work\n╭───────────────╮\n│ > │\n╰───────────────╯",
			),
		).toBe(true);
		expect(detectInputBoxPresent("⎿ Running tests...\n  PASS 12/12")).toBe(
			false,
		);
	});

	const fixturesDir = join(__dirname, "fixtures", "lead-panes");
	for (const fixture of [
		"idle-cos-lead.txt",
		"idle-ops-lead.txt",
		"idle-product-lead.txt",
		"idle-product-lead-ctx100.txt",
	]) {
		it(`detects the idle input box in real capture ${fixture}`, () => {
			expect(
				detectInputBoxPresent(readFileSync(join(fixturesDir, fixture), "utf8")),
			).toBe(true);
		});
	}

	it("rejects the real resume-menu freeze capture", () => {
		expect(
			detectInputBoxPresent(
				readFileSync(join(fixturesDir, "freeze-resume-menu.txt"), "utf8"),
			),
		).toBe(false);
	});
});
