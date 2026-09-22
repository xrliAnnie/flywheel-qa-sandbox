import { Window } from "happy-dom";
import { expect, it } from "vitest";
import { decodeAuditSidecar } from "../audit-sidecar.js";
import { renderEpicPageBundle, renderEpicPageHtml } from "../render-html.js";
import { EPIC_SHAPE_NOW } from "./fixtures/epic-shape.js";
import { pageForBudgetBase } from "./fixtures/founder-budget.js";

it.each(["preview", "hosted"])(
	"uses the founder-approved v5 visible order and removes legacy sections (%s)",
	(mode) => {
		const page = pageForBudgetBase(60);
		page.dependency_review.value = [];
		const html =
			mode === "preview"
				? renderEpicPageHtml(page, EPIC_SHAPE_NOW)
				: renderEpicPageBundle(page, EPIC_SHAPE_NOW).html;
		const window = new Window();
		try {
			window.document.write(html);
			const doc = window.document;
			const headings = [...doc.querySelectorAll(".sec")]
				.filter((el) => !el.closest("details"))
				.map((el) => el.textContent);
			expect(headings).toEqual([
				"⚡ 现在要你看 · 0 件",
				"班车状态",
				"在做的 Epic(全做完的已拿掉;Linear 状态单列;在跑按机器会话)",
			]);
			expect(
				[...doc.querySelector("main > .mock")!.children]
					.slice(0, 4)
					.map((el) => el.className || el.tagName),
			).toEqual(["mock-bar", "m-h", "SECTION", "SECTION"]);
			for (const old of [
				"当前范围",
				"每件做完算什么样",
				"缺什么、缺在哪",
				"要回来找 founder 的",
			])
				expect(html).not.toContain(old);
			expect(doc.body.textContent).not.toContain("现在可以开始的");
			const cards = doc.querySelectorAll("details.epic");
			expect(cards).toHaveLength(8);
			for (const card of cards) {
				expect(card.hasAttribute("open")).toBe(false);
				expect(
					card.querySelector(":scope > .e-b > .leadnote")?.textContent,
				).toContain("还没有人写过");
				expect(card.querySelector(".e-st")?.textContent).toBeTruthy();
				expect(card.querySelector(".e-c")?.textContent).toBeTruthy();
			}
		} finally {
			window.close();
		}
	},
);

it("fits 60 children under 80KiB while retaining their full audit facts", () => {
	const page = pageForBudgetBase(60);
	const bundle = renderEpicPageBundle(page, EPIC_SHAPE_NOW);
	expect(Buffer.byteLength(bundle.html)).toBeLessThanOrEqual(80 * 1024);
	const entries = decodeAuditSidecar(bundle.audit.json);
	for (const item of page.items) expect(entries).toContainEqual(item);
	for (const cell of [
		page.header.roots,
		page.done_definition,
		page.gaps,
		page.founder_items,
	])
		expect(entries).toContainEqual(cell);
	expect(bundle.html).not.toMatch(/Annie|Simba|Tadashi|HoneyLemon/);
});

it("retains the visible card surfaces after removing legacy section styles", () => {
	const window = new Window();
	try {
		window.document.write(
			renderEpicPageBundle(pageForBudgetBase(60), EPIC_SHAPE_NOW).html,
		);
		for (const selector of [".m-h", ".epic"]) {
			const element = window.document.querySelector(selector)!;
			expect(element).not.toBeNull();
			const style = window.getComputedStyle(element);
			expect(style.borderTopWidth).toBe("1px");
			expect(style.borderRadius).toBe("10px");
		}
	} finally {
		window.close();
	}
});

it("matches the v5 inset container and keeps supplemental facts collapsed", () => {
	const doc = new Window().document;
	doc.write(renderEpicPageBundle(pageForBudgetBase(60), EPIC_SHAPE_NOW).html);
	const inset = doc.querySelector("main > .mock");
	expect(inset).not.toBeNull();
	expect(inset!.firstElementChild?.className).toBe("mock-bar");
	for (const audit of doc.querySelectorAll(
		"[data-item-audit],[data-root-audit],[data-judgment],.history-preview",
	)) {
		expect(audit.closest("details.lead-panel")).not.toBeNull();
	}
	expect(doc.querySelectorAll("details[open],.epic .audit")).toHaveLength(0);
});
