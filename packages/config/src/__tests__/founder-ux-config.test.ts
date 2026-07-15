/**
 * FLY-869 — resolveEffectiveFounderUxConfig unit tests.
 *
 * This is the ONE resolution choke point every runtime consumer (DirectEventSink
 * snapshot, Blueprint prompt injection, runs-route trigger, claude-lead.sh rule
 * injection) must go through so an ABSENT `founder_ux_gate` config block
 * resolves to `enforce` (FLY-869 flips the FLY-598 default from opt-in `off`
 * to default-on `enforce`), while an EXPLICIT `mode: off` / `audit_only` /
 * `enforce` always passes through untouched (byte-compatible kill-switch).
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_FOUNDER_UX_EXEMPT_LABELS,
	isFounderUxGateEnabled,
	resolveEffectiveFounderUxConfig,
} from "../founder-ux-config.js";
import { FOUNDER_UX_GATE_DEFAULT_MODE } from "../types.js";

describe("FLY-869 resolveEffectiveFounderUxConfig", () => {
	it("absent (undefined) config → enforce + default exempt labels", () => {
		expect(resolveEffectiveFounderUxConfig(undefined)).toEqual({
			mode: "enforce",
			exempt_labels: ["brainstorm-exempt"],
		});
	});

	it("no-argument call → same as absent (enforce default)", () => {
		expect(resolveEffectiveFounderUxConfig()).toEqual({
			mode: "enforce",
			exempt_labels: ["brainstorm-exempt"],
		});
	});

	it("FOUNDER_UX_GATE_DEFAULT_MODE constant is enforce (FLY-869 flip)", () => {
		expect(FOUNDER_UX_GATE_DEFAULT_MODE).toBe("enforce");
	});

	it.each(["off", "audit_only", "enforce"] as const)(
		"explicit mode:%s passes through untouched (no exempt_labels given → default exempt list)",
		(mode) => {
			expect(resolveEffectiveFounderUxConfig({ mode })).toEqual({
				mode,
				exempt_labels: ["brainstorm-exempt"],
			});
		},
	);

	it("explicit mode:off is the byte-compat kill-switch — passes through as off, not enforce", () => {
		const result = resolveEffectiveFounderUxConfig({ mode: "off" });
		expect(result.mode).toBe("off");
	});

	it("custom exempt_labels are respected verbatim when explicitly set", () => {
		expect(
			resolveEffectiveFounderUxConfig({
				mode: "enforce",
				exempt_labels: ["no-brainstorm", "chore"],
			}),
		).toEqual({
			mode: "enforce",
			exempt_labels: ["no-brainstorm", "chore"],
		});
	});

	it("explicit empty exempt_labels array is respected (not replaced with the default)", () => {
		expect(
			resolveEffectiveFounderUxConfig({ mode: "enforce", exempt_labels: [] }),
		).toEqual({
			mode: "enforce",
			exempt_labels: [],
		});
	});

	it("DEFAULT_FOUNDER_UX_EXEMPT_LABELS matches the resolver's default", () => {
		expect(DEFAULT_FOUNDER_UX_EXEMPT_LABELS).toEqual(["brainstorm-exempt"]);
	});

	it("mutating the returned exempt_labels array does not mutate the input config", () => {
		const raw = { mode: "enforce" as const, exempt_labels: ["chore"] };
		const result = resolveEffectiveFounderUxConfig(raw);
		result.exempt_labels.push("mutated");
		expect(raw.exempt_labels).toEqual(["chore"]);
	});
});

describe("FLY-900 isFounderUxGateEnabled (fleet-wide kill-switch)", () => {
	it("default OFF: unset env → false (gate disabled)", () => {
		expect(isFounderUxGateEnabled({})).toBe(false);
	});

	it('"1" → true (only value that re-enables the gate)', () => {
		expect(
			isFounderUxGateEnabled({ FLYWHEEL_FOUNDER_UX_GATE_ENABLED: "1" }),
		).toBe(true);
	});

	it('"0" → false (explicit disable)', () => {
		expect(
			isFounderUxGateEnabled({ FLYWHEEL_FOUNDER_UX_GATE_ENABLED: "0" }),
		).toBe(false);
	});

	it.each(["true", "TRUE", "yes", "on", "", " 1", "1 ", "enabled"])(
		'non-"1" value %j → false (opt_in idiom is strict, matches resolve.ts)',
		(raw) => {
			expect(
				isFounderUxGateEnabled({ FLYWHEEL_FOUNDER_UX_GATE_ENABLED: raw }),
			).toBe(false);
		},
	);

	it("reads process.env by default when no env argument is given", () => {
		const prev = process.env.FLYWHEEL_FOUNDER_UX_GATE_ENABLED;
		try {
			process.env.FLYWHEEL_FOUNDER_UX_GATE_ENABLED = "1";
			expect(isFounderUxGateEnabled()).toBe(true);
			delete process.env.FLYWHEEL_FOUNDER_UX_GATE_ENABLED;
			expect(isFounderUxGateEnabled()).toBe(false);
		} finally {
			if (prev === undefined)
				delete process.env.FLYWHEEL_FOUNDER_UX_GATE_ENABLED;
			else process.env.FLYWHEEL_FOUNDER_UX_GATE_ENABLED = prev;
		}
	});
});
