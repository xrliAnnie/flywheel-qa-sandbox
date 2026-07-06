/**
 * FLY-892: message-level phase tag + model display-name helpers (founder-approved
 * ①). `phaseMessageTag` prepends `[设计·Fable] ` etc. to a phase session's
 * founder-facing thread messages; a main / non-phase role → `""` (byte-compat).
 */

import { describe, expect, it } from "vitest";
import { modelDisplayName } from "../model-tiers.js";
import {
	PHASE_THREAD_BADGE,
	phaseMessageTag,
	phaseThreadBadge,
} from "../three-stage-phases.js";

describe("modelDisplayName (FLY-892)", () => {
	it("maps canonical ids to family display names", () => {
		expect(modelDisplayName("claude-fable-5")).toBe("Fable");
		expect(modelDisplayName("claude-opus-4-8")).toBe("Opus");
		expect(modelDisplayName("claude-sonnet-5")).toBe("Sonnet");
		expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku");
	});
	it("maps bare aliases and [1m] variants", () => {
		expect(modelDisplayName("opus")).toBe("Opus");
		expect(modelDisplayName("claude-opus-4-8[1m]")).toBe("Opus");
		expect(modelDisplayName("claude-fable-5[1m]")).toBe("Fable");
	});
	it("falls back to the tier name for account-default / unknown model", () => {
		expect(modelDisplayName(null, "heavy")).toBe("Fable");
		expect(modelDisplayName(undefined, "medium")).toBe("Opus");
		expect(modelDisplayName("gpt-5-codex", "light")).toBe("Sonnet");
	});
	it("returns undefined when unknown and no fallback tier", () => {
		expect(modelDisplayName(null)).toBeUndefined();
		expect(modelDisplayName("some-non-claude-model")).toBeUndefined();
	});
});

describe("phaseMessageTag (FLY-892)", () => {
	it("tags each phase with its own runner model", () => {
		expect(phaseMessageTag("design", "claude-fable-5")).toBe("[设计·Fable] ");
		expect(phaseMessageTag("implement", "claude-opus-4-8")).toBe(
			"[实现·Opus] ",
		);
		expect(phaseMessageTag("qa", "claude-sonnet-5")).toBe("[QA·Sonnet] ");
	});
	it("falls back to the phase's planned tier when runner_model is absent", () => {
		expect(phaseMessageTag("design")).toBe("[设计·Fable] ");
		expect(phaseMessageTag("implement", null)).toBe("[实现·Opus] ");
		expect(phaseMessageTag("qa", undefined)).toBe("[QA·Sonnet] ");
	});
	it("is EMPTY for a main / non-phase role (byte-compat)", () => {
		expect(phaseMessageTag("main")).toBe("");
		expect(phaseMessageTag(undefined)).toBe("");
		expect(phaseMessageTag(null)).toBe("");
		expect(phaseMessageTag("something-else", "claude-opus-4-8")).toBe("");
	});
});

describe("phaseThreadBadge (FLY-892)", () => {
	it("returns Annie's locked stage badges for phase roles", () => {
		expect(phaseThreadBadge("design")).toBe("🎨设计");
		expect(phaseThreadBadge("implement")).toBe("🔨实现");
		expect(phaseThreadBadge("qa")).toBe("🧪QA");
		expect(PHASE_THREAD_BADGE.design).toBe("🎨设计");
	});
	it("is EMPTY for a main / non-phase role", () => {
		expect(phaseThreadBadge("main")).toBe("");
		expect(phaseThreadBadge(undefined)).toBe("");
	});
});
