import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	getModelConfigSnapshot,
	resetModelConfigCacheForTests,
} from "../model-config.js";

const dirs: string[] = [];
const previous = process.env.FLYWHEEL_MODELS_CONFIG;
afterEach(() => {
	if (previous === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
	else process.env.FLYWHEEL_MODELS_CONFIG = previous;
	resetModelConfigCacheForTests();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const policy = (codexPercent: unknown) => ({
	enabled: true,
	rule: "issue_number_percentage",
	codexPercent,
	codex: { arm: "A", model: "astra" },
	fable: { arm: "B", model: "fable" },
});
function snapshot(value: unknown) {
	const dir = mkdtempSync(join(tmpdir(), "fly2570-config-"));
	dirs.push(dir);
	process.env.FLYWHEEL_MODELS_CONFIG = join(dir, "models.json");
	writeFileSync(
		process.env.FLYWHEEL_MODELS_CONFIG,
		JSON.stringify({ version: 1, modelSplit: value }),
	);
	return getModelConfigSnapshot();
}
it.each([0, 100, 75, 37.125])(
	"accepts runtime percentage %s and derives its version",
	(percent) => {
		const result = snapshot(policy(percent));
		expect(result.runtimeModelSplitStatus).toBe("valid");
		expect(result.modelSplit).toMatchObject({
			codexPercent: percent,
			version: expect.stringMatching(/^fly2570-v1:[a-f0-9]{64}$/),
		});
	},
);
it("derives a new version for a manual ratio edit despite stale supplied version", () => {
	const old = snapshot(policy(75)).modelSplit;
	const changed = snapshot({ ...policy(0), version: old?.version });
	expect(changed.runtimeModelSplitStatus).toBe("valid");
	expect(changed.modelSplit?.version).not.toBe(old?.version);
	expect(changed.modelSplit?.version).toBe(
		snapshot(policy(0)).modelSplit?.version,
	);
});
it.each([-1, 101, "75", null])("rejects invalid percentage %s", (value) => {
	expect(snapshot(policy(value)).runtimeModelSplitStatus).toBe("invalid");
});
it("rejects malformed arms and unknown keys", () => {
	for (const value of [
		{ ...policy(75), codex: { arm: "A", model: "fable" } },
		{ ...policy(75), typo: 1 },
		{ ...policy(75), enabled: false },
	]) {
		expect(snapshot(value).runtimeModelSplitStatus).toBe("invalid");
	}
});

it("uses a frozen deterministic bucket and exact endpoints", async () => {
	const { parsePercentageModelSplit, resolvePercentageModelSplit } =
		await import("../model-split.js");
	const p = parsePercentageModelSplit(policy(75));
	const first = resolvePercentageModelSplit(p, 2570);
	expect(first).toEqual(resolvePercentageModelSplit(p, 2570));
	// Golden value independently computed with Python hashlib, freezes the v1 hash input.
	expect(first.bucket).toBe(80.939447054086);
	expect(first.arm.arm).toBe("B");
	expect(first.bucket).toBeGreaterThanOrEqual(0);
	expect(first.bucket).toBeLessThan(100);
	let count = 0;
	for (let n = 1; n <= 10000; n++) {
		if (resolvePercentageModelSplit(p, n).arm.arm === "A") count++;
		expect(
			resolvePercentageModelSplit(parsePercentageModelSplit(policy(0)), n).arm
				.arm,
		).toBe("B");
		expect(
			resolvePercentageModelSplit(parsePercentageModelSplit(policy(100)), n).arm
				.arm,
		).toBe("A");
	}
	expect(count).toBeGreaterThan(7300);
	expect(count).toBeLessThan(7700);
	for (const n of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
		expect(() => resolvePercentageModelSplit(p, n)).toThrow();
	for (const n of [NaN, Infinity, -Infinity])
		expect(() => parsePercentageModelSplit(policy(n))).toThrow();
});
