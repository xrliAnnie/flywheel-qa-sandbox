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
	});
	it("recognizes the GPT family BEFORE the tier fallback (FLY-1224)", () => {
		// A codex phase session's runner_model must never display as a Claude
		// name — that was the display lie C2 fixes.
		expect(modelDisplayName("gpt-5.6-sol")).toBe("GPT-5.6");
		expect(modelDisplayName("gpt-5.6-sol", "heavy")).toBe("GPT-5.6");
		expect(modelDisplayName("gpt-5-codex", "light")).toBe("GPT");
	});
	it("returns undefined when unknown and no fallback tier", () => {
		expect(modelDisplayName(null)).toBeUndefined();
		expect(modelDisplayName("some-non-claude-model")).toBeUndefined();
	});
});

describe("phaseMessageTag (FLY-892)", () => {
	it("FLY-1259: locked design backend beats the opposite global switch", () => {
		const previous = process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN;
		try {
			process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN = "0";
			expect(phaseMessageTag("design", null, "codex")).toBe("[设计·GPT-5.6] ");
			process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN = "1";
			expect(phaseMessageTag("design", undefined, "claude")).toBe(
				"[设计·Fable] ",
			);
			expect(phaseMessageTag("design", undefined, undefined)).toBe(
				"[设计·GPT-5.6] ",
			);
		} finally {
			if (previous === undefined) {
				delete process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN;
			} else {
				process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN = previous;
			}
		}
	});

	it("tags each phase with its own runner model", () => {
		expect(phaseMessageTag("design", "claude-fable-5", undefined)).toBe(
			"[设计·Fable] ",
		);
		expect(phaseMessageTag("implement", "claude-opus-4-8", undefined)).toBe(
			"[实现·Opus] ",
		);
		expect(phaseMessageTag("qa", "claude-sonnet-5", undefined)).toBe(
			"[QA·Sonnet] ",
		);
	});
	it("shows GPT for a codex phase session's runner model (FLY-1224 T9)", () => {
		expect(phaseMessageTag("implement", "gpt-5.6-sol", undefined)).toBe(
			"[实现·GPT-5.6] ",
		);
	});
	it("falls back to the phase's PLANNED DISPATCH model when runner_model is absent", () => {
		// FLY-1224 (Annie's 2026-07-13 table): design → Fable, implement → Codex
		// GPT-5.6, qa → Opus. A pending/no-runner_model implement row must show the
		// model it WILL run on, not the legacy tier (the display lie R1 #3 fixed).
		expect(phaseMessageTag("design", undefined, undefined)).toBe(
			"[设计·Fable] ",
		);
		expect(phaseMessageTag("implement", null, undefined)).toBe(
			"[实现·GPT-5.6] ",
		);
		expect(phaseMessageTag("qa", undefined, undefined)).toBe("[QA·Opus] ");
	});
	it("kill-switch: implement fallback shows Fable when codex-implement is off (FLY-1224 T9)", () => {
		// phaseMessageTag reads the dispatch table (kill-switch aware) — flip the
		// env for the duration of this test only.
		const prev = process.env.FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT;
		process.env.FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT = "0";
		try {
			expect(phaseMessageTag("implement", undefined, undefined)).toBe(
				"[实现·Fable] ",
			);
		} finally {
			if (prev === undefined) {
				delete process.env.FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT;
			} else {
				process.env.FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT = prev;
			}
		}
	});
	it("is EMPTY for a main / non-phase role (byte-compat)", () => {
		expect(phaseMessageTag("main", undefined, undefined)).toBe("");
		expect(phaseMessageTag(undefined, undefined, undefined)).toBe("");
		expect(phaseMessageTag(null, undefined, undefined)).toBe("");
		expect(
			phaseMessageTag("something-else", "claude-opus-4-8", undefined),
		).toBe("");
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
