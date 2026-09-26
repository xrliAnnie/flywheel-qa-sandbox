import { describe, expect, it } from "vitest";
import { deriveWorktreeKey, resolveWorktreeKey } from "../WorktreeManager.js";

describe("resolveWorktreeKey (FLY-793 shared branch)", () => {
	it("byte-compat: absent shareParentBranch → role-aware key (== deriveWorktreeKey)", () => {
		expect(resolveWorktreeKey("FLY-793", { sessionRole: "main" })).toBe(
			deriveWorktreeKey("FLY-793", "main"),
		);
		expect(resolveWorktreeKey("FLY-793", { sessionRole: "qa" })).toBe(
			"FLY-793-qa",
		);
		expect(resolveWorktreeKey("FLY-793")).toBe("FLY-793");
	});

	it("shareParentBranch → all phases derive the SAME parent branch key (identifier)", () => {
		const design = resolveWorktreeKey("FLY-793", {
			sessionRole: "design",
			shareParentBranch: true,
		});
		const implement = resolveWorktreeKey("FLY-793", {
			sessionRole: "implement",
			shareParentBranch: true,
		});
		const qa = resolveWorktreeKey("FLY-793", {
			sessionRole: "qa",
			shareParentBranch: true,
		});
		expect(design).toBe("FLY-793");
		expect(implement).toBe("FLY-793");
		expect(qa).toBe("FLY-793");
		// All three collapse to the one branch B (= the parent main key).
		expect(new Set([design, implement, qa]).size).toBe(1);
	});

	it("shared key is the parent's own main key — never an externally-supplied string", () => {
		// resolveWorktreeKey ignores sessionRole under shareParentBranch and always
		// returns deriveWorktreeKey(identifier, "main") — no injection surface.
		expect(
			resolveWorktreeKey("FLY-793", {
				sessionRole: "../evil",
				shareParentBranch: true,
			}),
		).toBe(deriveWorktreeKey("FLY-793", "main"));
	});
});
