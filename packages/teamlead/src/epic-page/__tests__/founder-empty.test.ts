import { expect, it } from "vitest";
import { buildFounderView } from "../founder-view.js";
import { generateEpicPage } from "../generate.js";
import { renderEpicPageBundle } from "../render-html.js";
import {
	EPIC_SHAPE_NOW,
	epicShapeSnapshot,
	v3ItemFacts,
} from "./fixtures/epic-shape.js";

it("excludes a childless root without asserting that it is fully done", () => {
	const snapshot = epicShapeSnapshot();
	const page = generateEpicPage({
		snapshot,
		itemFacts: v3ItemFacts(snapshot),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "manual",
	});
	expect(
		page.header.root_counts.find((c) => c.value?.root === "EPX-200")?.value
			?.counts.total,
	).toBe(0);
	const view = buildFounderView(page);
	expect(view.epics.map((e) => e.identifier)).not.toContain("EPX-200");
	expect(view.hiddenDoneEpics?.count).toBe(0);
	const html = renderEpicPageBundle(page, EPIC_SHAPE_NOW).html;
	expect(html).not.toContain("个 Epic 全做完");
	expect(html).not.toContain('data-root="EPX-200"');
});
