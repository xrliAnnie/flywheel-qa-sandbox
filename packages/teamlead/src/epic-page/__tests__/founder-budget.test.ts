import { expect, it } from "vitest";
import { renderEpicPageBundle } from "../render-html.js";
import { EPIC_SHAPE_NOW } from "./fixtures/epic-shape.js";
import { pageForBudgetBase } from "./fixtures/founder-budget.js";

it("fits the 60-child E1 baseline before sibling note and attention integration", () => {
	const page = pageForBudgetBase(60);
	const bytes = Buffer.byteLength(
		renderEpicPageBundle(page, EPIC_SHAPE_NOW).html,
	);
	console.info(
		JSON.stringify({
			baseline_children: 60,
			html_bytes: bytes,
			notes_and_attention: "not integrated",
		}),
	);
	expect(bytes).toBeLessThanOrEqual(491520);
});
