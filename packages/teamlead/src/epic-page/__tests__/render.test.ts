import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { escapeHtml } from "../../bridge/xhs-review-html.js";
import { escapeMarkdownTableCell } from "../escape.js";
import { generateEpicPage } from "../generate.js";
import { label } from "../labels.js";
import type { Cell, EpicPage, Signal } from "../model.js";
import { buildEpicPageRenderReceipt } from "../receipt.js";
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

function pageWithLiveness(): EpicPage {
	const snapshot = epicShapeSnapshot();
	const observedAt = EPIC_SHAPE_NOW.toISOString();
	const signals: Signal[] = [
		{
			kind: "question_pending",
			since: "2026-09-03T03:00:00.000Z",
			execution_id8: "exec-one",
			provenance: {
				kind: "commdb",
				table: "mailbox",
				key: { execution_id: "exec-one-full" },
			},
			observed_at: observedAt,
		},
		{
			kind: "waiting_founder",
			since: "2026-09-03T03:30:00.000Z",
			execution_id8: "exec-one",
			provenance: {
				kind: "commdb",
				table: "mailbox",
				key: { execution_id: "exec-one-full" },
			},
			observed_at: observedAt,
		},
	];
	return generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => emptyItemFacts()),
		itemSignals: snapshot.items.map((item, index) => ({
			signals: index === 0 ? signals : [],
			signal_sources: {
				statestore: {
					value: { signals: 0 },
					provenance: {
						kind: "statestore" as const,
						table: "sessions",
						key: { issue_id: item.id },
					},
					observed_at: observedAt,
				},
				commdb: {
					value: { signals: index === 0 ? 2 : 0 },
					provenance: {
						kind: "commdb" as const,
						table: "mailbox",
						key: { issue_identifier: item.identifier },
					},
					observed_at: observedAt,
				},
			},
		})),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "event",
		version: 3,
		reasons: ["session_completed", "dependency_changed"],
		freshness: {
			history: {
				last_generated: {
					version: 2,
					attempted_at: "2026-09-03T03:50:00.000Z",
					trigger: "scan",
				},
				last_published: {
					version: 1,
					attempted_at: "2026-09-03T03:30:00.000Z",
					trigger: "event",
				},
				publish_failures_since_last_published: 1,
				last_publish_failure: {
					attempted_at: "2026-09-03T03:45:00.000Z",
					token: "transient: publish_failed:blob",
				},
				last_failure: {
					attempted_at: "2026-09-03T03:55:00.000Z",
					token: "FREE_TEXT_SENTINEL_MUST_NOT_RENDER",
				},
			},
			publication: {
				token: "0123456789abcdef0123456789abcdef",
				published: true,
				first_published_at: "2026-09-02T03:30:00.000Z",
				last_published_at: "2026-09-03T03:30:00.000Z",
				last_version: 1,
			},
			scanSchedule: {
				leadId: "flywheel-eng-lead",
				intervalMs: 30 * 60_000,
			},
		},
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
	const block = html.slice(start, next < 0 ? undefined : next);
	const ref = block.match(/data-src="(\d+)"/)?.[1];
	return block + (ref === undefined ? "" : dictionaryText(html, ref));
}

function dictionaryText(html: string, ref: string): string {
	const json = html.match(
		/<script type="application\/json" id="epic-audit-data">([\s\S]*?)<\/script>/,
	)![1]!;
	const data = JSON.parse(json);
	const [source, observed, updated] = data.cells[Number(ref)];
	return (
		JSON.stringify(data.sources[source]) +
		data.times[observed] +
		(updated === undefined ? "" : data.times[updated])
	);
}

function firstHtmlItemCard(html: string): string {
	const window = new Window({
		settings: { disableJavaScriptEvaluation: true },
	});
	window.document.write(html);
	const child = window.document.querySelector('[data-item="EPX-1"]');
	expect(child).not.toBeNull();
	return (
		child!.outerHTML +
		[...child!.querySelectorAll("[data-src]")]
			.map((e) => dictionaryText(html, e.getAttribute("data-src")!))
			.join("")
	);
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
	"/dependency_review",
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
	it("renders bounded freshness and distinct stuck/founder-wait signals", () => {
		const document = pageWithLiveness();
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		const markdown = renderEpicPageMarkdown(document, EPIC_SHAPE_NOW);

		for (const output of [html, markdown]) {
			expect(output).toContain(label("page.freshness"));
			expect(output).toContain(label("section.stuck"));
			expect(output).toContain(label("section.waiting_founder"));
			expect(output).toContain(label("signal.kind.question_pending"));
			expect(output).toContain(label("signal.kind.waiting_founder"));
			expect(output).toContain("EPX-1");
			expect(output).toContain("本版成功之前");
			expect(output).toContain("失败 1 次");
			expect(output).toContain("transient: publish_failed:blob");
			expect(output).toContain("01234567");
			expect(output).not.toContain("0123456789abcdef0123456789abcdef");
			expect(output).not.toContain("FREE_TEXT_SENTINEL_MUST_NOT_RENDER");
		}

		const stuck = htmlBlock(html, "/stuck_items").split("</article>")[0]!;
		expect(stuck).toContain(label("signal.kind.question_pending"));
		expect(stuck).not.toContain(label("signal.kind.waiting_founder"));
	});

	it("uses one inert nonce script for reader age and no self-supplied CSP", () => {
		const html = renderEpicPageHtml(pageWithLiveness(), EPIC_SHAPE_NOW);
		const scripts = (
			html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []
		).filter((s) => !s.includes('type="application/json"'));

		expect(html).not.toContain('http-equiv="Content-Security-Policy"');
		expect(html).toContain(
			`data-generated-at="${EPIC_SHAPE_NOW.toISOString()}"`,
		);
		expect(html).toContain(EPIC_SHAPE_NOW.toISOString());
		expect(scripts).toHaveLength(1);
		expect(scripts[0]).toContain('nonce="__CSP_NONCE__"');
		expect(scripts[0]).toContain("textContent");
		expect(scripts[0]).not.toMatch(/innerHTML|fetch\(|https?:\/\//);
	});

	it("says zero signals explicitly", () => {
		const document = page();
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		const markdown = renderEpicPageMarkdown(document, EPIC_SHAPE_NOW);

		for (const output of [html, markdown]) {
			expect(output).toContain(label("section.stuck"));
			expect(output).toContain(label("section.waiting_founder"));
			expect(output).toContain(label("page.signal_none"));
		}
	});

	it("renders an explicit empty dependency review between ready and scope", () => {
		const document = page();
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		const markdown = renderEpicPageMarkdown(document, EPIC_SHAPE_NOW);
		expect(markdown).toContain("## 依赖需要减法的地方");

		for (const output of [html, markdown]) {
			const ready = output.indexOf(label("section.ready"));
			const review = output.indexOf(label("section.review"));
			const scope = output.indexOf(label("section.scope"));
			expect(review).toBeGreaterThan(ready);
			expect(review).toBeLessThan(scope);
			expect(output).toContain(label("review.none"));
			expect(output).toContain(
				label("page.default_rule_note", { rule: "subtraction.v1" }),
			);
		}
	});

	it("renders every dependency review shape and escapes its identifiers", () => {
		const document = page();
		document.dependency_review.value = [
			{
				kind: "canceled_blocker",
				item: "EPX-2<script>alert(1)</script>",
				blocker: "EPX-1",
			},
			{ kind: "dependency_cycle", members: ["EPX-2", "EPX-3"] },
			{
				kind: "all_blocked",
				non_terminal: 2,
				blocking_edges: [
					{
						blocker: "EXT-1",
						blocked: "EPX-2",
						blocker_state_type: "backlog",
						in_scope: false,
					},
				],
				blocking_edges_truncated: true,
			},
		];

		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		const markdown = renderEpicPageMarkdown(document, EPIC_SHAPE_NOW);
		for (const output of [html, markdown]) {
			for (const marker of [
				"EPX-1",
				"EPX-2",
				"EPX-3",
				"EXT-1",
				"范围外",
				label("review.blocking_edges_truncated"),
			]) {
				expect(output).toContain(marker);
			}
			expect(output).not.toContain("<script>alert(1)</script>");
			expect(output).toContain("&lt;script&gt;alert");
		}
	});

	it("keeps derived dependency review data out of the render receipt", () => {
		const receipt = buildEpicPageRenderReceipt(page());
		expect(
			receipt.sources.some(({ path }) => path === "/dependency_review"),
		).toBe(false);
		expect(receipt.sources).not.toEqual([]);
	});

	it("renders child rows within collapsed Epic cards without tables or batches", () => {
		const document = page();
		document.items[1]!.acceptance.value = null;
		document.items[1]!.acceptance.missing = { reason: "no_acceptance_section" };
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		expect(html.match(/class="kid" data-item=/g)).toHaveLength(
			document.items.length,
		);
		expect(html).toContain('class="epic" data-root="EPX-100"');
		expect(html).not.toContain("<table");
		expect(html).not.toMatch(/<details[^>]* open/);
		expect(html).toContain("等 EPX-1");
		expect(html).toContain("no_acceptance_section");
		expect(html).not.toContain("data-batch");
	});

	it("keeps item provenance and timestamps inside its audit", () => {
		const document = page(),
			html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		const child = firstHtmlItemCard(html);
		expect(child).toContain('class="audit"');
		expect(child).toContain(document.items[0]!.url.value!);
		expect(child).toContain(document.items[0]!.title.observed_at);
		expect(child).toContain(document.items[0]!.title.source_updated_at!);
		expect(child).toContain("dependents.v1");
		expect(child).toContain("/items/0/blocked_by");
		expect(child).toContain('data-cell="/items/0/parent"');
	});

	it("puts the Lead diagnostic panel after the Epic cards", () => {
		const html = renderEpicPageHtml(page(), EPIC_SHAPE_NOW);
		const epic = html.indexOf('<details class="epic"');
		const lead = html.indexOf('<details class="lead-panel"');
		expect(epic).toBeGreaterThan(0);
		expect(lead).toBeGreaterThan(epic);
		for (const key of ["section.ready", "section.scope"] as const)
			expect(html.indexOf(label(key))).toBeGreaterThan(lead);
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

	it("renders all 8 root and 14 item Cell paths with value, provenance, and time", () => {
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
			"section.review",
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

		expect(html).not.toContain("<script>alert(1)</script>");
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

	it("keeps ledger_live_count in Markdown and the child audit", () => {
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
		expect(htmlSummary.indexOf("ledger_live_count=2")).toBeGreaterThan(
			htmlSummary.indexOf('class="audit"'),
		);
		expect(markdownSummary).toContain("completed/design&#40;deadbeef&#41;");
		expect(htmlSummary).toContain("completed/design(deadbeef)");
	});

	it("keeps full dependency titles in audit cells while the badge names the blocker", () => {
		const html = renderEpicPageHtml(page(), EPIC_SHAPE_NOW);
		expect(htmlBlock(html, "/items/0/blocks")).toContain("Task B");
		expect(htmlBlock(html, "/items/1/blocked_by")).toContain("Task A");
		expect(html).toContain("等 EPX-1");
		expect(html).toContain("dependents.v1");
	});
});

it("marks scope.v2 and counts.v1 as founder-decided, with HTML root counts", () => {
	const document = page();
	for (const render of [renderEpicPageHtml, renderEpicPageMarkdown]) {
		const output = render(document, EPIC_SHAPE_NOW);
		expect(output).toContain("已获 founder 裁定的规则 scope.v2");
		expect(output).not.toContain("规则 scope.v1");
		if (render === renderEpicPageHtml)
			expect(output).toContain('data-cell="/header/root_counts/0"');
		else expect(output).not.toContain('data-cell="/header/root_counts');
		const probe = structuredClone(document);
		// Exercise the existing rendered Cell seam; counts remain data-only in real pages.
		probe.ready_items.provenance = {
			kind: "derived",
			rule: "counts.v1",
			from: [],
		};
		expect(render(probe, EPIC_SHAPE_NOW)).toContain(
			label("page.decided_rule_note", { rule: "counts.v1" }),
		);
	}
});
