import { expect, it } from "vitest";
import { deriveEffectiveFounderTitleState } from "../issue-display.js";

it("shares title and page visibility through ship holds and terminal transitions", () => {
	const base = {
		phaseStates: new Map(),
		phaseStatuses: new Map(),
		shipFinalizationClaimed: false,
		mainSessionStatus: "running",
		mainSessionStage: "implement",
		founderGateActive: false,
		founderAttention: "answer" as const,
		qaHeld: false,
		reviewHeld: false,
	};
	expect(deriveEffectiveFounderTitleState(base)).toMatchObject({
		level: "answer",
		badge: { kind: "needs_answer" },
	});
	for (const status of ["blocked", "completed", "approved_to_ship"]) {
		expect(
			deriveEffectiveFounderTitleState({ ...base, mainSessionStatus: status })
				.level,
		).toBeNull();
	}
	expect(
		deriveEffectiveFounderTitleState({ ...base, founderGateActive: true }),
	).toMatchObject({
		level: "ship",
		badge: { kind: "stage", stage: "approve" },
	});
	expect(
		deriveEffectiveFounderTitleState({
			...base,
			founderGateActive: true,
			qaHeld: true,
		}),
	).toMatchObject({ level: null, badge: { kind: "stage", stage: "test" } });
	expect(
		deriveEffectiveFounderTitleState({
			...base,
			founderGateActive: true,
			reviewHeld: true,
		}).level,
	).toBeNull();
	expect(
		deriveEffectiveFounderTitleState({
			...base,
			qaHeld: true,
			reviewHeld: true,
		}).level,
	).toBe("answer");
});
