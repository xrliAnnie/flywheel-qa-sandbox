import { describe, expect, it } from "vitest";
import { resolveAutoQaPolicy } from "../auto-qa-policy.js";

describe("resolveAutoQaPolicy", () => {
	it("enabled when qa.auto is true and no skip applies", () => {
		expect(
			resolveAutoQaPolicy({
				qaConfig: { auto: true },
				issueLabels: ["engineer"],
				env: {},
			}).enabled,
		).toBe(true);
	});

	it("OFF by default when qa config is absent (byte-compat opt-in)", () => {
		const d = resolveAutoQaPolicy({
			qaConfig: undefined,
			issueLabels: ["engineer"],
			env: {},
		});
		expect(d.enabled).toBe(false);
	});

	it("OFF when qa.auto is false", () => {
		expect(
			resolveAutoQaPolicy({
				qaConfig: { auto: false },
				issueLabels: [],
				env: {},
			}).enabled,
		).toBe(false);
	});

	it("global kill-switch FLYWHEEL_AUTO_QA=0 overrides an enabled project", () => {
		const d = resolveAutoQaPolicy({
			qaConfig: { auto: true },
			issueLabels: [],
			env: { FLYWHEEL_AUTO_QA: "0" },
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toContain("kill-switch");
	});

	it("kill-switch default (unset) = allowed (NOT a second opt-in)", () => {
		expect(
			resolveAutoQaPolicy({
				qaConfig: { auto: true },
				issueLabels: [],
				env: {},
			}).enabled,
		).toBe(true);
	});

	it("per-issue no-qa Linear label skips even when project qa.auto is true", () => {
		const d = resolveAutoQaPolicy({
			qaConfig: { auto: true },
			issueLabels: ["engineer", "no-qa"],
			env: {},
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toContain("no-qa");
	});

	it("skip_labels match (case-insensitive) disables auto-QA", () => {
		const d = resolveAutoQaPolicy({
			qaConfig: { auto: true, skip_labels: ["Docs", "chore"] },
			issueLabels: ["docs"],
			env: {},
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toContain("docs");
	});

	it("skip_labels that don't match leave auto-QA enabled", () => {
		expect(
			resolveAutoQaPolicy({
				qaConfig: { auto: true, skip_labels: ["docs"] },
				issueLabels: ["engineer"],
				env: {},
			}).enabled,
		).toBe(true);
	});
});
