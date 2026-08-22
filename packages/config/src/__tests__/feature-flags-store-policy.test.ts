import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import {
	getFlagStoreCodec,
	getStoreEligibility,
	PROTECTED_LEGACY_FLAG_NAMES,
	STORE_MANAGED_FLAGS,
} from "../feature-flags/store-policy.js";

const MANAGED = [
	"flag_retirement_scan",
	"workflow_rework_reentry",
	"skill_framework_mode",
	"workflow_resume",
	"workflow_turn_divergence_alerts",
] as const;

const PROTECTED = [
	"mailbox_queue",
	"auto_qa_killswitch",
	"codex_hard_gate_killswitch",
	"merge_approval_gate_killswitch",
	"qa_done_gate_killswitch",
	"ship_ci_guard",
] as const;

describe("FLY-1778 flag store policy", () => {
	it("freezes the M0-approved managed and protected sets", () => {
		expect([...STORE_MANAGED_FLAGS]).toEqual(MANAGED);
		expect([...PROTECTED_LEGACY_FLAG_NAMES]).toEqual(PROTECTED);
		for (const name of MANAGED) {
			const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
			expect(spec, name).toBeDefined();
			expect(getStoreEligibility(spec!)).toEqual({ eligible: true });
		}
	});

	it("refuses protected, governance, unlisted, value, and self-referential flags", () => {
		for (const name of PROTECTED) {
			const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
			expect(spec, name).toBeDefined();
			expect(getStoreEligibility(spec!)).toMatchObject({
				eligible: false,
			});
		}
		for (const name of [
			"founder_consent_decision_mode",
			"voice_qa_presence_override",
			"issue_display_sweep_ticks",
			"flag_store",
		]) {
			const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
			expect(spec, name).toBeDefined();
			expect(getStoreEligibility(spec as never)).toMatchObject({
				eligible: false,
			});
		}
	});

	it("preserves the two existing boolean raw-value idioms", () => {
		const defaultOn = getFlagStoreCodec("flag_retirement_scan");
		const optIn = getFlagStoreCodec("workflow_resume");
		expect(defaultOn?.parse({ hasOverride: false, raw: null })).toBe(true);
		expect(defaultOn?.parse({ hasOverride: true, raw: "0" })).toBe(false);
		expect(defaultOn?.parse({ hasOverride: true, raw: "garbage" })).toBe(true);
		expect(optIn?.parse({ hasOverride: false, raw: null })).toBe(false);
		expect(optIn?.parse({ hasOverride: true, raw: "1" })).toBe(true);
		expect(optIn?.parse({ hasOverride: true, raw: "true" })).toBe(false);
		expect(defaultOn?.canonicalEffective(false)).toBe("false");
		expect(optIn?.canonicalEffective(true)).toBe("true");
	});

	it("keeps every managed codec aligned with its registry default and polarity", () => {
		for (const name of MANAGED) {
			const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name)!;
			const codec = getFlagStoreCodec(name)!;
			expect(codec.parse({ hasOverride: false, raw: null }), name).toBe(
				spec.default,
			);
			if (spec.valueKind !== "bool") continue;
			expect(codec.parse({ hasOverride: true, raw: "garbage" }), name).toBe(
				spec.polarity === "default_on",
			);
		}
	});

	it("canonicalizes skill_framework_mode as a global control, including split", () => {
		const codec = getFlagStoreCodec("skill_framework_mode");
		for (const [raw, expected] of [
			[null, "superpowers"],
			["", "superpowers"],
			["invalid", "superpowers"],
			["superpowers", "superpowers"],
			["matt", "matt"],
			["bare", "bare"],
			["bare-ponytail", "bare-ponytail"],
			["split", "split"],
		] as const) {
			expect(
				codec?.parse({ hasOverride: raw !== null, raw }),
				String(raw),
			).toBe(expected);
			expect(codec?.canonicalEffective(expected)).toBe(expected);
		}
	});
});
