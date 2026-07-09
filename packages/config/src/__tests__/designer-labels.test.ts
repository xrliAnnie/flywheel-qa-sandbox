import { describe, expect, it } from "vitest";
import { isUiDesignFlavored, UI_DESIGN_LABELS } from "../designer-labels.js";

describe("designer-labels (FLY-1059)", () => {
	it("UI_DESIGN_LABELS is the visual/UI-flavored set (lowercase, no dupes)", () => {
		expect(UI_DESIGN_LABELS).toEqual([
			"ui",
			"ux",
			"web",
			"frontend",
			"fe",
			"dashboard",
			"design",
			"designer",
			"mockup",
			"visual",
		]);
		// all lowercase + directory-safe-ish tokens, no duplicates
		expect(new Set(UI_DESIGN_LABELS).size).toBe(UI_DESIGN_LABELS.length);
		for (const l of UI_DESIGN_LABELS) {
			expect(l).toBe(l.toLowerCase());
		}
	});

	it("positive: any UI-flavored label makes it design-flavored", () => {
		for (const label of UI_DESIGN_LABELS) {
			expect(isUiDesignFlavored([label])).toBe(true);
		}
		// mixed with unrelated labels still hits
		expect(isUiDesignFlavored(["backend", "ui"])).toBe(true);
		expect(isUiDesignFlavored(["infra", "dashboard", "chore"])).toBe(true);
	});

	it("negative: non-visual labels are not design-flavored", () => {
		for (const label of [
			"backend",
			"api",
			"server",
			"infra",
			"tooling",
			"doc",
			"docs",
			"pm",
			"product",
			"research",
			"plan",
			"test",
			"qa",
			"bug",
			"eng",
		]) {
			expect(isUiDesignFlavored([label])).toBe(false);
		}
	});

	it("empty / undefined → false (fail-closed)", () => {
		expect(isUiDesignFlavored([])).toBe(false);
		expect(isUiDesignFlavored(undefined)).toBe(false);
	});

	it("case-insensitive: defensively lowercases each label (R1#6)", () => {
		expect(isUiDesignFlavored(["UI"])).toBe(true);
		expect(isUiDesignFlavored(["Mockup"])).toBe(true);
		expect(isUiDesignFlavored(["Dashboard", "Backend"])).toBe(true);
		expect(isUiDesignFlavored(["BACKEND"])).toBe(false);
	});
});
