import { describe, expect, it } from "vitest";
import { resolveAutoQaPolicy } from "../auto-qa-policy.js";

describe("resolveAutoQaPolicy (FLY-752 opt-out default)", () => {
	it("enabled when qa.auto is true and no skip applies", () => {
		expect(
			resolveAutoQaPolicy({
				qaConfig: { kind: "config", auto: true },
				issueLabels: ["engineer"],
				env: {},
			}).enabled,
		).toBe(true);
	});

	// FLY-752 opt-out flip: absent config now defaults ON (fleet-wide).
	it("ON by default when qa config is ABSENT (opt-out default, fleet-wide)", () => {
		expect(
			resolveAutoQaPolicy({
				qaConfig: { kind: "absent" },
				issueLabels: ["engineer"],
				env: {},
			}).enabled,
		).toBe(true);
	});

	it("ON when a qa block exists but `auto` is unset", () => {
		expect(
			resolveAutoQaPolicy({
				qaConfig: { kind: "config", skip_labels: ["docs"] },
				issueLabels: ["engineer"],
				env: {},
			}).enabled,
		).toBe(true);
	});

	it("ON when qaConfig is undefined (no entry) — treated as absent/default-on", () => {
		expect(
			resolveAutoQaPolicy({
				qaConfig: undefined,
				issueLabels: ["engineer"],
				env: {},
			}).enabled,
		).toBe(true);
	});

	// ── opt-outs (all still honoured) ──

	it("OFF when qa.auto is false (explicit per-project opt-out)", () => {
		const d = resolveAutoQaPolicy({
			qaConfig: { kind: "config", auto: false },
			issueLabels: [],
			env: {},
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toContain("opt-out");
	});

	it("OFF (fail-closed) when qa config is MALFORMED — never accidentally on", () => {
		const d = resolveAutoQaPolicy({
			qaConfig: { kind: "malformed", reason: "qa.auto must be a boolean" },
			issueLabels: [],
			env: {},
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toContain("malformed");
	});

	it("global kill-switch FLYWHEEL_AUTO_QA=0 overrides an enabled project", () => {
		const d = resolveAutoQaPolicy({
			qaConfig: { kind: "config", auto: true },
			issueLabels: [],
			env: { FLYWHEEL_AUTO_QA: "0" },
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toContain("kill-switch");
	});

	it("kill-switch default (unset) = allowed (NOT a second opt-in)", () => {
		expect(
			resolveAutoQaPolicy({
				qaConfig: { kind: "absent" },
				issueLabels: [],
				env: {},
			}).enabled,
		).toBe(true);
	});

	it("per-issue no-qa Linear label skips even when default-on", () => {
		const d = resolveAutoQaPolicy({
			qaConfig: { kind: "absent" },
			issueLabels: ["engineer", "no-qa"],
			env: {},
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toContain("no-qa");
	});

	it("skip_labels match (case-insensitive) disables auto-QA", () => {
		const d = resolveAutoQaPolicy({
			qaConfig: { kind: "config", auto: true, skip_labels: ["Docs", "chore"] },
			issueLabels: ["docs"],
			env: {},
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toContain("docs");
	});

	it("skip_labels that don't match leave auto-QA enabled", () => {
		expect(
			resolveAutoQaPolicy({
				qaConfig: { kind: "config", auto: true, skip_labels: ["docs"] },
				issueLabels: ["engineer"],
				env: {},
			}).enabled,
		).toBe(true);
	});
});
