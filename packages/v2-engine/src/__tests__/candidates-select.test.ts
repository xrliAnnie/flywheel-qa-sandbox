import { describe, expect, it } from "vitest";
import { selectNext } from "../candidates.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";

function candidate(
	lane: "F1" | "F2" | "N1" | "N2",
	seq: number,
	createdAt: string,
) {
	return {
		lane,
		seq,
		messageUid: `${lane}-${seq}`,
		payload: "{}",
		createdAt,
	};
}

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const RECENT = "2026-07-27T11:45:00.000Z";
const OLD = "2026-07-27T11:00:00.000Z";

describe("selectNext", () => {
	it("returns null for an empty candidate set", () => {
		expect(selectNext({}, 0, NOW, DEFAULT_ENGINE_CONFIG)).toBeNull();
	});

	it("uses deterministic created_at then seq ordering within the founder class", () => {
		const result = selectNext(
			{
				f1: candidate("F1", 4, RECENT),
				f2: candidate("F2", 3, RECENT),
			},
			0,
			NOW,
			DEFAULT_ENGINE_CONFIG,
		);
		expect(result).toEqual({
			pick: candidate("F2", 3, RECENT),
			nextStreak: 1,
		});
	});

	it("forces the oldest non-founder after K founder-class selections", () => {
		const result = selectNext(
			{
				f1: candidate("F1", 1, OLD),
				n1: candidate("N1", 9, RECENT),
				n2: candidate("N2", 8, OLD),
			},
			DEFAULT_ENGINE_CONFIG.vipBurst,
			NOW,
			DEFAULT_ENGINE_CONFIG,
		);
		expect(result).toEqual({
			pick: candidate("N2", 8, OLD),
			nextStreak: 0,
		});
	});

	it("does not let promotion bypass an exhausted non-founder quota", () => {
		const result = selectNext(
			{
				f1: candidate("F1", 1, "2026-07-27T10:00:00.000Z"),
				n1: candidate("N1", 2, OLD),
			},
			DEFAULT_ENGINE_CONFIG.vipBurst,
			NOW,
			DEFAULT_ENGINE_CONFIG,
		);
		expect(result?.pick.lane).toBe("N1");
		expect(result?.nextStreak).toBe(0);
	});

	it("promotes aged non-founder traffic into the founder class and clears debt", () => {
		const result = selectNext(
			{
				f1: candidate("F1", 2, RECENT),
				n1: candidate("N1", 1, OLD),
			},
			1,
			NOW,
			DEFAULT_ENGINE_CONFIG,
		);
		expect(result).toEqual({
			pick: candidate("N1", 1, OLD),
			nextStreak: 0,
		});
	});

	it("never skips a ready non-founder more than K consecutive picks", () => {
		let streak = 0;
		let skipped = 0;
		for (
			let round = 0;
			round < DEFAULT_ENGINE_CONFIG.vipBurst + 2;
			round += 1
		) {
			const result = selectNext(
				{
					f1: candidate("F1", round, RECENT),
					n1: candidate("N1", 100, RECENT),
				},
				streak,
				NOW,
				DEFAULT_ENGINE_CONFIG,
			);
			expect(result).not.toBeNull();
			if (result?.pick.lane === "N1") {
				expect(skipped).toBeLessThanOrEqual(DEFAULT_ENGINE_CONFIG.vipBurst);
				break;
			}
			skipped += 1;
			streak = result?.nextStreak ?? streak;
		}
		expect(skipped).toBe(DEFAULT_ENGINE_CONFIG.vipBurst);
	});

	it("starts conservatively at K after restart", () => {
		const result = selectNext(
			{
				f1: candidate("F1", 1, OLD),
				n1: candidate("N1", 2, RECENT),
			},
			DEFAULT_ENGINE_CONFIG.vipBurst,
			NOW,
			DEFAULT_ENGINE_CONFIG,
		);
		expect(result?.pick.lane).toBe("N1");
	});
});
