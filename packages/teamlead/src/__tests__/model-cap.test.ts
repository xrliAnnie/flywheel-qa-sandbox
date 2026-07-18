import { describe, expect, it } from "vitest";
import {
	BASE_MODEL_CAP_TTL_MS,
	computeModelCapTtlMs,
	MAX_MODEL_CAP_TTL_MS,
	parseModelCap,
} from "../account-heal/model-cap.js";

const REAL_FABLE_CAP =
	"⎿  You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";

describe("parseModelCap — daemon tri-state model-cap recognizer", () => {
	it.each([
		[REAL_FABLE_CAP, "Fable 5"],
		[
			"You've reached your Opus 4.8 limit. Run /usage-credits to continue or switch models with /model.",
			"Opus 4.8",
		],
		[
			[
				"You've reached your",
				"Sonnet 5 limit. Run",
				"/usage-credits to continue or",
				"switch models with /model.",
			].join("\n"),
			"Sonnet 5",
		],
	])("recognizes a generic current model cap", (pane, model) => {
		expect(parseModelCap(pane)).toEqual({ state: "capped", model });
	});

	it.each([
		"Claude usage limit reached. Your limit will reset at 9:00 PM.",
		"Context limit reached · /compact or /clear to continue",
		"You've reached your daily limit of free retries.",
		"5h ██░░ 10% reset today 23:09 | 7d ███░ 74% reset Thu",
	])("keeps non-model limit text clear", (pane) => {
		expect(parseModelCap(pane)).toEqual({ state: "clear" });
	});

	it("returns unknown when a cap is followed by an active spinner", () => {
		expect(
			parseModelCap(`${REAL_FABLE_CAP}\n✻ Cooking… (12s · esc to interrupt)`),
		).toMatchObject({ state: "unknown" });
	});

	it("treats a completed turn after an old cap as clear", () => {
		expect(
			parseModelCap(`${REAL_FABLE_CAP}\n⏺ Bash(pnpm test)\n✅ tests passed`),
		).toEqual({ state: "clear" });
	});

	it("uses the last cap episode rather than stale earlier scrollback", () => {
		const pane = [
			REAL_FABLE_CAP,
			"✅ tests passed",
			"You've reached your Opus 4.8 limit. Run /usage-credits to continue or switch models with /model.",
		].join("\n");
		expect(parseModelCap(pane)).toEqual({
			state: "capped",
			model: "Opus 4.8",
		});
	});
});

describe("computeModelCapTtlMs — finite per-model retry bench", () => {
	const now = new Date("2026-07-16T08:00:00.000Z");

	it("starts at 30 minutes", () => {
		expect(computeModelCapTtlMs(undefined, now)).toBe(BASE_MODEL_CAP_TTL_MS);
	});

	it("doubles a recent failed re-probe and caps at four hours", () => {
		const recent = new Date(now.getTime() - 60_000).toISOString();
		expect(
			computeModelCapTtlMs(
				{ until: recent, backoffMs: BASE_MODEL_CAP_TTL_MS },
				now,
			),
		).toBe(BASE_MODEL_CAP_TTL_MS * 2);
		expect(
			computeModelCapTtlMs(
				{ until: recent, backoffMs: MAX_MODEL_CAP_TTL_MS },
				now,
			),
		).toBe(MAX_MODEL_CAP_TTL_MS);
	});

	it("resets to base after a genuinely separate episode", () => {
		expect(
			computeModelCapTtlMs(
				{
					until: new Date(now.getTime() - 6 * 3_600_000).toISOString(),
					backoffMs: MAX_MODEL_CAP_TTL_MS,
				},
				now,
			),
		).toBe(BASE_MODEL_CAP_TTL_MS);
	});
});
