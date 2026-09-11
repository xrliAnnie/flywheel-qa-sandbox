import { Window } from "happy-dom";
import { expect, it } from "vitest";
import { buildAttention } from "../attention.js";
import { renderEpicPageBundle } from "../render-html.js";
import { attentionFixture, sourceCell } from "./fixtures/attention.js";
import { EPIC_SHAPE_NOW } from "./fixtures/epic-shape.js";
import { pageForBudgetBase } from "./fixtures/founder-budget.js";

it("keeps empty upstream slots collapsed and preserves the baseline bytes", () => {
	const bundle = renderEpicPageBundle(pageForBudgetBase(60), EPIC_SHAPE_NOW);
	const html = bundle.html;
	const doc = new Window().document;
	doc.write(html);
	expect(doc.querySelectorAll("details[open]")).toHaveLength(0);
	expect(
		doc.querySelectorAll(".synthetic-note,.synthetic-attention"),
	).toHaveLength(0);
	expect(doc.querySelectorAll(".epic")).toHaveLength(8);
	expect(doc.querySelectorAll(".kid")).toHaveLength(60);
	expect(Buffer.byteLength(html)).toBeLessThanOrEqual(
		Buffer.byteLength(bundle.html),
	);
});
it("reserves attention first and notes beside machine progress within the 60-child budget", () => {
	const page = {
		...pageForBudgetBase(60),
		...buildAttention(attentionFixture(), EPIC_SHAPE_NOW.toISOString()),
		schema_version: 2 as const,
		generator: {
			version: "epic-page/2" as const,
			trigger: "manual" as const,
			reasons: ["manual" as const],
		},
		epic_scope: sourceCell({ available: true as const }),
	};
	const note = {
		value: "注".repeat(280),
		provenance: {
			kind: "lead_note" as const,
			role: "engineering",
			written_at: EPIC_SHAPE_NOW.toISOString(),
		},
		observed_at: EPIC_SHAPE_NOW.toISOString(),
		source_updated_at: EPIC_SHAPE_NOW.toISOString(),
	};
	for (const item of page.items) item.lead_note = [note];
	for (const root of page.header.roots.value ?? []) root.lead_note = [note];
	const html = renderEpicPageBundle(page, EPIC_SHAPE_NOW).html;
	const doc = new Window().document;
	doc.write(html);
	expect(doc.querySelector("main")?.firstElementChild?.className).toBe(
		"attention-section",
	);
	expect(doc.querySelectorAll("[data-attention-key]")).toHaveLength(3);
	expect(
		doc.querySelector("[data-attention-section]")?.closest("details"),
	).toBeNull();
	for (const body of doc.querySelectorAll(".e-b"))
		expect(body.firstElementChild?.classList.contains("lead-note")).toBe(true);
	for (const machine of doc.querySelectorAll("[data-machine-line]"))
		expect(machine.nextElementSibling?.classList.contains("lead-note")).toBe(
			true,
		);
	expect(doc.querySelectorAll(".lead-note")).toHaveLength(76);
	expect(doc.querySelectorAll(".epic > summary > .lead-note")).toHaveLength(8);
	expect(doc.querySelectorAll("details[open]")).toHaveLength(0);
	const bytes = Buffer.byteLength(html);
	console.info({
		integrated_note_displays: 76,
		chars_per_note: 280,
		html_bytes: bytes,
		upstream_renderers: "real attention and Lead notes",
	});
	expect(bytes).toBeLessThanOrEqual(480 * 1024);
});
