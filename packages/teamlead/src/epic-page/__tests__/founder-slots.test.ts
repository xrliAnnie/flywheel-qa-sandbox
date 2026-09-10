import { Window } from "happy-dom";
import { expect, it } from "vitest";
import { renderEpicPageBundle } from "../render-html.js";
import { EPIC_SHAPE_NOW } from "./fixtures/epic-shape.js";
import { pageForBudgetBase } from "./fixtures/founder-budget.js";

// Lead ruling 12b30083: exercise reserved positions synthetically until E2/E4
// merge. This is not a substitute for their real renderer/budget regression.
function compose(html: string, populated: boolean): string {
	const note = populated
		? `<aside class="synthetic-note">${"注".repeat(280)} · 出处 #1 · 2026-09-10T00:00:00Z</aside>`
		: "";
	return html
		.replace(
			/<!-- Slot A:[\s\S]*?-->/,
			populated
				? '<section class="synthetic-attention">体积上限，部分事项未显示</section>'
				: "",
		)
		.replace(/<!-- Slot B1:[\s\S]*?-->/g, note)
		.replace(/<!-- Slot B2:[\s\S]*?-->/g, note);
}
it("keeps empty upstream slots collapsed and preserves the baseline bytes", () => {
	const bundle = renderEpicPageBundle(pageForBudgetBase(60), EPIC_SHAPE_NOW);
	const html = compose(bundle.html, false);
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
	const html = compose(
		renderEpicPageBundle(pageForBudgetBase(60), EPIC_SHAPE_NOW).html,
		true,
	);
	const doc = new Window().document;
	doc.write(html);
	expect(doc.querySelector("main")?.firstElementChild?.className).toBe(
		"synthetic-attention",
	);
	for (const body of doc.querySelectorAll(".e-b"))
		expect(body.firstElementChild?.className).toBe("synthetic-note");
	for (const machine of doc.querySelectorAll("[data-machine-line]"))
		expect(machine.nextElementSibling?.className).toBe("synthetic-note");
	expect(doc.querySelectorAll(".synthetic-note")).toHaveLength(68);
	expect(doc.querySelectorAll("details[open]")).toHaveLength(0);
	const bytes = Buffer.byteLength(html);
	console.info({
		synthetic_notes: 68,
		chars_per_note: 280,
		html_bytes: bytes,
		upstream_renderers: "not integrated",
	});
	expect(bytes).toBeLessThanOrEqual(480 * 1024);
});
