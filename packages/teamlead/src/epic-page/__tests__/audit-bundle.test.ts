import { createHash } from "node:crypto";
import { Window } from "happy-dom";
import { expect, it } from "vitest";
import { decodeAuditSidecar } from "../audit-sidecar.js";
import { resolvePointer } from "../model.js";
import { renderEpicPageBundle } from "../render-html.js";
import { EPIC_SHAPE_NOW } from "./fixtures/epic-shape.js";
import { pageForBudgetBase } from "./fixtures/founder-budget.js";

it("allows the hosted audit footer's full hash to wrap on narrow screens", () => {
	const window = new Window({ width: 390 });
	const bundle = renderEpicPageBundle(pageForBudgetBase(60), EPIC_SHAPE_NOW);
	window.document.write(bundle.html);
	const footer = window.document.querySelector("footer")!;
	expect(footer.textContent).toContain(bundle.audit.sha256);
	expect(window.getComputedStyle(footer).overflowWrap).toBe("anywhere");
});

it("binds a compact HTML to a lossless sidecar for every rendered audit cell", () => {
	const page = pageForBudgetBase(60);
	const bundle = renderEpicPageBundle(page, EPIC_SHAPE_NOW);
	const doc = new Window().document;
	doc.write(bundle.html);
	const entries = decodeAuditSidecar(bundle.audit.json);
	expect(bundle.audit.sha256).toBe(
		createHash("sha256").update(bundle.audit.json).digest("hex"),
	);
	expect(bundle.audit.path).toBe(`${bundle.audit.sha256}/index.audit.json`);
	expect(doc.querySelector("footer")?.textContent).toContain(
		String(Buffer.byteLength(bundle.audit.json)),
	);
	expect(doc.querySelector("footer a")?.getAttribute("href")).toBe(
		bundle.audit.path,
	);
	expect(doc.querySelectorAll("[data-cell]")).not.toHaveLength(0);
	for (const el of doc.querySelectorAll("[data-cell]")) {
		const cell = resolvePointer(page, el.getAttribute("data-cell")!);
		expect(entries[Number(el.getAttribute("data-audit"))]).toEqual(cell);
		expect(el.textContent).toContain(
			(cell as { observed_at: string }).observed_at,
		);
	}
	for (const el of doc.querySelectorAll("[data-view-rule]")) {
		expect(el.hasAttribute("data-view-from")).toBe(false);
		expect(entries[Number(el.getAttribute("data-audit"))]).toMatchObject({
			rule: el.getAttribute("data-view-rule"),
			from: expect.any(Array),
		});
	}
	expect(bundle.html).not.toContain("epic-audit-data");
	expect(bundle.html).not.toContain("fetch(");
	expect(Buffer.byteLength(bundle.html)).toBeLessThanOrEqual(480 * 1024);
	console.info({
		html_bytes: Buffer.byteLength(bundle.html),
		audit_bytes: Buffer.byteLength(bundle.audit.json),
		entries: entries.length,
	});
	expect(renderEpicPageBundle(page, EPIC_SHAPE_NOW)).toEqual(bundle);
});
