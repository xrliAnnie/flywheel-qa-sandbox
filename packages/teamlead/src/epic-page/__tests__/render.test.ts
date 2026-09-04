import { describe, expect, it } from "vitest";
import { escapeHtml } from "../../bridge/xhs-review-html.js";
import { escapeMarkdownTableCell } from "../escape.js";
import { generateEpicPage } from "../generate.js";
import { label } from "../labels.js";
import type { Cell, EpicPage } from "../model.js";
import { renderEpicPageHtml } from "../render-html.js";
import { renderEpicPageMarkdown } from "../render-markdown.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "./fixtures/epic-shape.js";

function page(): EpicPage {
	const snapshot = epicShapeSnapshot();
	return generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => emptyItemFacts()),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "manual",
	});
}

function pageWithItemCount(count: number): EpicPage {
	const snapshot = epicShapeSnapshot();
	const template = snapshot.items[0]!;
	snapshot.items = Array.from({ length: count }, (_, index) => {
		const number = index + 1;
		return {
			...template,
			id: `child-uuid-${number}`,
			identifier: `EPX-${number}`,
			title: `Task ${number}`,
			url: `https://linear.app/example/issue/EPX-${number}`,
			priority: 0,
			labels: [],
			blockedBy: [],
			acceptance: {
				text: `Task ${number} is complete.`,
				truncated: false,
			},
		};
	});
	return generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => emptyItemFacts()),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "manual",
	});
}

function cellAt(document: EpicPage, path: string): Cell<unknown> {
	let value: unknown = document;
	for (const part of path.split("/").filter(Boolean)) {
		value = Array.isArray(value)
			? value[Number(part)]
			: (value as Record<string, unknown>)[part];
	}
	return value as Cell<unknown>;
}

function markdownBlock(markdown: string, path: string): string {
	const marker = `<!-- cell:${path} -->`;
	const start = markdown.indexOf(marker);
	expect(start, path).toBeGreaterThanOrEqual(0);
	const next = markdown.indexOf("<!-- cell:", start + marker.length);
	return markdown.slice(start, next < 0 ? undefined : next);
}

function htmlBlock(html: string, path: string): string {
	const marker = `data-cell="${path}"`;
	const start = html.indexOf(marker);
	expect(start, path).toBeGreaterThanOrEqual(0);
	const next = html.indexOf("data-cell=", start + marker.length);
	return html.slice(start, next < 0 ? undefined : next);
}

function firstHtmlItemCard(html: string): string {
	const start = html.indexOf('<article class="item-card');
	expect(start).toBeGreaterThanOrEqual(0);
	const end = html.indexOf("</article>", start);
	expect(end).toBeGreaterThan(start);
	return html.slice(start, end + "</article>".length);
}

function firstHtmlItemSummary(html: string): string {
	const card = firstHtmlItemCard(html);
	return card.slice(0, card.indexOf('<footer class="card-meta">'));
}

function valueMarker(value: unknown): string {
	if (value === null) return "";
	if (Array.isArray(value))
		return value.length === 0 ? "[]" : valueMarker(value[0]);
	if (typeof value === "object") {
		const first = Object.values(value as Record<string, unknown>)[0];
		return valueMarker(first);
	}
	return String(value);
}

const ROOT_PATHS = [
	"/header/scope_definition",
	"/header/roots",
	"/header/items",
	"/done_definition",
	"/founder_items",
	"/ready_items",
	"/gaps",
];
const ITEM_PATHS = [
	"title",
	"url",
	"state",
	"priority",
	"blocked_by",
	"blocks",
	"acceptance",
	"founder_named",
	"session",
	"run",
	"attempt",
	"gates",
	"carriers",
	"land",
].map((field) => `/items/0/${field}`);

describe("Epic page render parity", () => {
	it("renders one concise card per item with two-way dependencies and no batch", () => {
		const document = page();
		document.items[1]!.acceptance.value = null;
		document.items[1]!.acceptance.missing = {
			reason: "no_acceptance_section",
		};
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);

		expect(html.match(/<article class="item-card/g)).toHaveLength(
			document.items.length,
		);
		expect(html).not.toContain("<table");
		expect(html).not.toContain('class="cell-grid"');
		expect(html).toContain("是什么");
		expect(html).toContain("为什么");
		expect(html).toContain("做完你看到");
		expect(html).toContain("等谁");
		expect(html).toContain("谁在等我");
		expect(html).toContain("EPX-1 · Task A · Todo");
		expect(html).toContain("EPX-1 · Task A");
		expect(html).toContain("EPX-2 · Task B");
		expect(html).toContain("缺验收");
		expect(html).not.toContain("批次");
		expect(html).not.toContain("data-batch");
	});

	it("keeps item provenance and timestamps in a compact card footer", () => {
		const document = page();
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		const firstCard = firstHtmlItemCard(html);

		expect(firstCard).toContain('class="card-meta"');
		expect(firstCard).toContain(document.items[0]!.url.value ?? "");
		expect(firstCard).toContain(document.items[0]!.title.observed_at);
		expect(firstCard).toContain(
			document.items[0]!.title.source_updated_at ?? "",
		);
		expect(firstCard).toContain("dependents.v1");
		expect(firstCard).toContain("/items/0/blocked_by");
		expect(firstCard).toContain("已获 founder 裁定的规则");
	});

	it("puts ready first, then the active scope, above all item cards", () => {
		const html = renderEpicPageHtml(page(), EPIC_SHAPE_NOW);
		const firstCard = html.indexOf('<article class="item-card');
		const ready = html.indexOf(label("section.ready"));
		const scope = html.indexOf(label("section.scope"));
		expect(ready).toBeGreaterThanOrEqual(0);
		expect(ready).toBeLessThan(scope);
		for (const marker of [label("section.ready"), label("section.scope")]) {
			expect(html.indexOf(marker), marker).toBeGreaterThanOrEqual(0);
			expect(html.indexOf(marker), marker).toBeLessThan(firstCard);
		}
	});

	it("keeps derived overview pointers inside the collapsed audit body", () => {
		const document = page();
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);

		for (const path of [
			"/ready_items",
			"/done_definition",
			"/founder_items",
			"/gaps",
		]) {
			const cell = cellAt(document, path);
			if (cell.provenance.kind !== "derived") {
				throw new Error(`${path} must be derived`);
			}
			const block = htmlBlock(html, path);
			const summaryStart = block.indexOf("<summary>");
			const summaryEnd = block.indexOf("</summary>", summaryStart);
			const summary = block.slice(
				summaryStart,
				summaryEnd + "</summary>".length,
			);

			expect(summary, path).toBe(
				`<summary>${label("page.all_cells", { count: 1 })}</summary>`,
			);
			expect(summary, path).not.toContain("/items/");
			expect(block.slice(summaryEnd), path).toContain(cell.provenance.rule);
			expect(block.slice(summaryEnd), path).toContain(
				label(
					cell.provenance.rule === "ready.v1"
						? "page.decided_rule_note"
						: "page.default_rule_note",
					{ rule: cell.provenance.rule },
				),
			);
			for (const sourcePath of cell.provenance.from) {
				expect(block.slice(summaryEnd), `${path} <- ${sourcePath}`).toContain(
					sourcePath,
				);
			}
		}
	});

	it("renders all 7 root and 14 item Cell paths with value, provenance, and time", () => {
		const document = page();
		const markdown = renderEpicPageMarkdown(document, EPIC_SHAPE_NOW);
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);

		for (const path of [...ROOT_PATHS, ...ITEM_PATHS]) {
			const cell = cellAt(document, path);
			const mdBlock = markdownBlock(markdown, path);
			const webBlock = htmlBlock(html, path);
			const sourceMarker =
				cell.provenance.kind === "linear"
					? cell.provenance.id
					: cell.provenance.kind === "statestore"
						? cell.provenance.table
						: cell.provenance.rule;
			const marker =
				cell.value === null
					? (cell.missing?.reason ?? "")
					: valueMarker(cell.value);
			expect(mdBlock, `${path} value`).toContain(
				escapeMarkdownTableCell(marker),
			);
			expect(webBlock, `${path} value`).toContain(escapeHtml(marker));
			for (const block of [mdBlock, webBlock]) {
				expect(block, `${path} source`).toContain(sourceMarker);
				expect(block, `${path} observed_at`).toContain(cell.observed_at);
			}
		}
		expect(document.done_definition.value).toEqual({
			terminal_state: "completed",
		});
		expect(markdown).toContain("done.v1");
		expect(html).toContain("done.v1");
	});

	it("uses the fixed label order and says zero founder items explicitly", () => {
		const markdown = renderEpicPageMarkdown(page(), EPIC_SHAPE_NOW);
		const order = [
			"section.ready",
			"section.scope",
			"section.founder",
			"section.done",
			"section.gaps",
			"section.what",
		].map((key) => markdown.indexOf(label(key as never)));
		expect(order).toEqual([...order].sort((left, right) => left - right));
		expect(markdown).toContain(label("founder.none"));
		expect(markdown).toContain(label("cell.ledger_note"));
		expect(markdown).toContain(label("page.ready_rule_note"));
		expect(markdown).toContain(
			label("page.default_rule_note", { rule: "done.v1" }),
		);
		expect(markdown).not.toContain("批次");
	});

	it("escapes hostile text, keeps unsafe URLs inert, and preserves table shape", () => {
		const document = page();
		const hostile =
			"<script>alert(1)</script><img src=x onerror=evil()>|\n[x](javascript:alert(1))";
		document.items[0]!.title.value = hostile;
		document.items[0]!.url.value = "javascript:alert(1)";
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		const markdown = renderEpicPageMarkdown(document, EPIC_SHAPE_NOW);

		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img src=x onerror=");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain('href="javascript:');
		expect(markdown).not.toContain("<script>");
		expect(markdown).toContain("&lt;script&gt;");
		expect(markdown).toContain("\\|");
		expect(markdown).toContain(
			"&#91;x&#93;&#40;javascript:alert&#40;1&#41;&#41;",
		);
		const cardHeadings = markdown
			.split("\n")
			.filter((line) => line.startsWith("### EPX-"));
		expect(cardHeadings).toHaveLength(document.items.length);
	});

	it("protects Markdown link destinations that contain parentheses", () => {
		const document = page();
		const url = "https://linear.app/example/issue/EPX-1/a(b)-title";
		document.items[0]!.url.value = url;

		const markdown = renderEpicPageMarkdown(document, EPIC_SHAPE_NOW);

		expect(markdown).toContain(
			`[https://linear.app/example/issue/EPX-1/a&#40;b&#41;-title](<${url}>)`,
		);
	});

	it("keeps a 60-item HTML snapshot within the 512 KiB hosting limit", () => {
		const html = renderEpicPageHtml(pageWithItemCount(60), EPIC_SHAPE_NOW);

		expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(512 * 1024);
	});

	it("keeps identifiers and ready items equal across JSON, Markdown, and HTML", () => {
		const document = page();
		const markdown = renderEpicPageMarkdown(document, EPIC_SHAPE_NOW);
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		for (const item of document.items) {
			expect(markdown).toContain(item.identifier);
			expect(html).toContain(item.identifier);
		}
		for (const candidate of document.ready_items.value ?? []) {
			expect(markdown).toContain(candidate);
			expect(html).toContain(candidate);
		}
	});

	it("shows ledger_live_count in both first-screen execution summaries", () => {
		const document = page();
		document.items[0]!.session.value = {
			latest: [
				{
					status: "completed",
					role: "design",
					branch: null,
					execution_id8: "deadbeef",
				},
			],
			ledger_live_count: 2,
		};
		const markdown = renderEpicPageMarkdown(document, EPIC_SHAPE_NOW);
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		const firstHeading = markdown.indexOf("### EPX-1");
		const secondHeading = markdown.indexOf("### EPX-2", firstHeading);
		const markdownSummary = markdown.slice(firstHeading, secondHeading);
		const htmlSummary = firstHtmlItemCard(html);

		expect(markdownSummary).toContain("ledger_live_count=2");
		expect(htmlSummary).toContain("ledger_live_count=2");
		expect(markdownSummary).toContain("completed/design&#40;deadbeef&#41;");
		expect(htmlSummary).toContain("completed/design(deadbeef)");
	});

	it("shows concrete issue titles on both sides of each dependency", () => {
		const document = page();
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		const first = firstHtmlItemSummary(html);
		const secondStart = html.indexOf(
			'<article class="item-card',
			html.indexOf('<article class="item-card') + 1,
		);
		const secondEnd = html.indexOf('<footer class="card-meta">', secondStart);
		const second = html.slice(secondStart, secondEnd);

		expect(first).toContain("EPX-2 · Task B");
		expect(first).toContain(label("page.waiting_on_me"));
		expect(second).toContain("EPX-1 · Task A");
		expect(second).toContain(label("page.waiting_for"));
		expect(html).toContain("dependents.v1");
	});
});
