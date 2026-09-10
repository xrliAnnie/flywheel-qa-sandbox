import { Window } from "happy-dom";
import { expect, it } from "vitest";
import { generateEpicPage } from "../generate.js";
import { renderEpicPageBundle, renderEpicPageHtml } from "../render-html.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "./fixtures/epic-shape.js";

it.each(["preview", "hosted"])(
	"keeps every root judgment visible in collapsed card headers and full text in the body (%s)",
	(mode) => {
		const snapshot = epicShapeSnapshot();
		const text = `判断 <img src=x> </script> </textarea> " & ${"长句".repeat(80)}`;
		const document = generateEpicPage({
			snapshot,
			itemFacts: snapshot.items.map(() => emptyItemFacts()),
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "manual",
			leadNotes: ["engineering", "product"].map((role) => ({
				issue_uuid: snapshot.roots[0]!.id,
				role,
				text,
				written_at: EPIC_SHAPE_NOW.toISOString(),
			})),
		});
		const window = new Window();
		try {
			window.document.body.innerHTML =
				mode === "preview"
					? renderEpicPageHtml(document, EPIC_SHAPE_NOW)
					: renderEpicPageBundle(document, EPIC_SHAPE_NOW).html;
			const card = window.document.querySelector(
				'details.epic[data-root="EPX-100"]',
			);
			expect(card).not.toBeNull();
			expect(card!.hasAttribute("open")).toBe(false);
			const summary = card!.querySelector(":scope > summary")!;
			expect(summary.querySelector(".e-c")?.textContent).toBeTruthy();
			const notes = summary.querySelectorAll("[data-lead-written-at]");
			expect(notes).toHaveLength(2);
			for (const note of notes) {
				expect(note.querySelector("[title]")?.getAttribute("title")).toBe(text);
				expect(note.querySelector("time")?.textContent).toBe(
					EPIC_SHAPE_NOW.toISOString(),
				);
				expect(note.textContent).toContain("刚写");
				expect(note.textContent).toContain("未核验具体作者");
				expect(note.querySelector("img, script, textarea")).toBeNull();
			}
			const full = card!.querySelectorAll(
				":scope > .e-b > [data-lead-written-at]",
			);
			expect(full).toHaveLength(2);
			for (const note of full)
				expect(note.querySelector("p")?.textContent).toBe(text);
		} finally {
			window.close();
		}
	},
);
