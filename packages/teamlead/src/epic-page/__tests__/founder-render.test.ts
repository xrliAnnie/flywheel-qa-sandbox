import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { buildFounderView } from "../founder-view.js";
import { generateEpicPage } from "../generate.js";
import { resolvePointer } from "../model.js";
import { renderEpicPageHtml } from "../render-html.js";
import {
	EPIC_SHAPE_NOW,
	epicShapeSnapshotV3,
	permuteSnapshot,
	v3ItemFacts,
} from "./fixtures/epic-shape.js";

function fixture() {
	const snapshot = epicShapeSnapshotV3();
	const page = generateEpicPage({
		snapshot,
		itemFacts: v3ItemFacts(snapshot),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "manual",
	});
	const html = renderEpicPageHtml(page, EPIC_SHAPE_NOW);
	const window = new Window({
		settings: { disableJavaScriptEvaluation: true },
	});
	window.document.write(html);
	return { page, html, doc: window.document };
}
describe("founder Epic HTML", () => {
	it("renders the exact open-root collection, collapsed, with Linear state and counts", () => {
		const { page, html, doc } = fixture();
		expect(
			[...doc.querySelectorAll("details.epic")].map((e) =>
				e.getAttribute("data-root"),
			),
		).toEqual(buildFounderView(page).epics.map((e) => e.identifier));
		expect(doc.querySelectorAll("details[open]").length).toBe(0);
		expect(doc.querySelector('[data-root="EPX-300"]')).toBeNull();
		expect(
			doc.querySelector('[data-source-value="/header/roots/value/2"]'),
		).toBeNull();
		expect(doc.querySelector(".epic-hidden")?.textContent).toContain("1");
		expect(doc.querySelector('[data-root="EPX-200"] .e-st')?.textContent).toBe(
			"In Progress",
		);
		expect(doc.querySelector('[data-root="EPX-200"] .e-c')?.textContent).toBe(
			"0 在跑 · 1 未开始 · 共 1",
		);
		expect(html).not.toContain("<table");
	});
	it("shows dependency and machine progress wording in their intended positions", () => {
		const { doc } = fixture();
		expect(doc.querySelector('[data-item="EPX-2"] .s')?.textContent).toBe(
			"等 EPX-1",
		);
		expect(doc.querySelector('[data-item="EPX-3"] .s')?.textContent).toContain(
			"等 EPX-20(在 EPX-200)",
		);
		expect(doc.querySelector('[data-item="EPX-4"] .s')?.textContent).toContain(
			"等 EPX-90(范围外)",
		);
		expect(
			doc.querySelector('[data-root="EPX-400"] > summary .e-wait')?.textContent,
		).toBe("整块在等 EPX-20 / EPX-90");
		expect(
			doc.querySelector('[data-item="EPX-1"] .kid-a')?.textContent,
		).toContain("到「实现」· 第 2 次 · 会话 running");
		expect(doc.querySelector('[data-item="EPX-8"]')).toBeNull();
		expect(doc.querySelector('[data-cell="/items/7/state"]')).toBeNull();
		expect(
			doc.querySelector('[data-root="EPX-100"] .terminal-tail')?.textContent,
		).toBe("另有 1 张已完成 · 1 张已取消(不列)");
	});
	it("keeps every emitted cell unique and all projections auditable", () => {
		const { page, doc } = fixture();
		const paths = [...doc.querySelectorAll("[data-cell]")].map((e) =>
			e.getAttribute("data-cell"),
		);
		expect(new Set(paths).size).toBe(paths.length);
		expect(doc.querySelectorAll('[data-cell="/header/roots"]').length).toBe(1);
		expect(
			doc.querySelector('.lead-panel [data-cell="/header/roots"]'),
		).not.toBeNull();
		for (const epic of buildFounderView(page).epics) {
			const projection = doc.querySelector(
				`[data-source-value="/header/roots/value/${epic.rootIndex}"]`,
			);
			expect(projection?.textContent).toContain(epic.identifier);
			expect(projection?.textContent).toContain(page.header.roots.observed_at);
		}
		const rules = [...doc.querySelectorAll("[data-view-rule]")];
		expect(
			new Set(rules.map((e) => e.getAttribute("data-view-rule"))).size,
		).toBe(6);
		for (const element of rules)
			for (const path of element.getAttribute("data-view-from")!.split(","))
				expect(resolvePointer(page, path)).toMatchObject({
					observed_at: expect.any(String),
				});
		expect(
			doc.querySelector("details.lead-panel")?.previousElementSibling
				?.className,
		).not.toBe("epic");
	});
	it("produces identical bytes for the same inputs", () => {
		const { page, html } = fixture();
		expect(renderEpicPageHtml(page, EPIC_SHAPE_NOW)).toBe(html);
	});
});

it("keeps all fifteen cells and their observations for each visible child", () => {
	const { page, doc } = fixture();
	for (const child of [
		...buildFounderView(page).epics.flatMap((e) => e.children),
		...buildFounderView(page).unattached,
	]) {
		const item = page.items[child.itemIndex]!;
		for (const key of [
			"parent",
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
		] as const) {
			const selector = `[data-cell="/items/${child.itemIndex}/${key}"]`;
			const element = doc.querySelector(selector);
			expect(element, selector).not.toBeNull();
			const data = JSON.parse(
				doc.querySelector("#epic-audit-data")!.textContent,
			);
			const ref = data.cells[Number(element!.getAttribute("data-src"))];
			expect(data.times[ref[1]]).toBe(item[key].observed_at);
		}
	}
});
it("escapes hostile root and blocker text while keeping every URL inert unless Linear", () => {
	const { page } = fixture();
	page.header.roots.value![0]!.title = "<img src=x onerror=alert(1)>";
	page.header.roots.value![0]!.url = "javascript:alert(1)";
	const blocker = page.items[1]!.blocked_by.value![0]!;
	blocker.identifier = "<script>alert(1)</script>";
	blocker.in_scope = false;
	const html = renderEpicPageHtml(page, EPIC_SHAPE_NOW);
	expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	expect(html).not.toContain("<img src=x");
	expect(html).not.toContain("<script>alert");
	expect(html).not.toContain('href="javascript:');
});

it("limits blocker badge labels without losing the full audit and shows missing live fields honestly", () => {
	const { page } = fixture();
	const item = page.items[1]!,
		base = item.blocked_by.value![0]!;
	item.blocked_by.value = [4, 3, 2, 1].map((n) => ({
		...base,
		identifier: `OUT-${n}`,
		in_scope: false,
	}));
	page.items[0]!.attempt.value = [];
	page.items[0]!.session.value = { latest: [], ledger_live_count: 1 };
	const html = renderEpicPageHtml(page, EPIC_SHAPE_NOW);
	const window = new Window({
		settings: { disableJavaScriptEvaluation: true },
	});
	window.document.write(html);
	expect(
		window.document.querySelector('[data-item="EPX-2"] .s')!.textContent,
	).toBe("等 OUT-1(范围外) / OUT-2(范围外) / OUT-3(范围外) 等 4 张");
	expect(
		window.document.querySelector('[data-cell="/items/1/blocked_by"]')!
			.textContent,
	).toContain("OUT-4");
	expect(
		window.document.querySelector('[data-item="EPX-1"] .kid-a')!.textContent,
	).toContain("第 不知道 次 · 会话 不知道");
});

it("renders the same root and child sequence after raw snapshot permutation", () => {
	const snapshot = epicShapeSnapshotV3();
	const render = (seed: number) =>
		renderEpicPageHtml(
			generateEpicPage({
				...permuteSnapshot(snapshot, v3ItemFacts(snapshot), undefined, seed),
				now: EPIC_SHAPE_NOW,
				projectName: "example",
				trigger: "manual",
			}),
			EPIC_SHAPE_NOW,
		);
	const sequence = (html: string, kind: string) =>
		[...html.matchAll(new RegExp(`data-${kind}="([^"]+)"`, "g"))].map(
			(m) => m[1],
		);
	for (const kind of ["root", "item"])
		expect(sequence(render(13), kind)).toEqual(sequence(render(37), kind));
});

it("resolves every child source and timestamp from the page dictionary", () => {
	const { page, html, doc } = fixture();
	const dataElement = doc.querySelector("#epic-audit-data");
	expect(dataElement).not.toBeNull();
	const data = JSON.parse(dataElement!.textContent);
	for (const element of doc.querySelectorAll(".kid [data-cell]")) {
		const path = element.getAttribute("data-cell")!;
		const cell = resolvePointer(page, path) as {
			provenance: unknown;
			observed_at: string;
			source_updated_at?: string;
		};
		const [source, observed, updated] =
			data.cells[Number(element.getAttribute("data-src"))];
		expect(data.sources[source]).toEqual(cell.provenance);
		expect(data.times[observed]).toBe(cell.observed_at);
		expect(updated === undefined ? undefined : data.times[updated]).toBe(
			cell.source_updated_at,
		);
		expect(element.textContent).not.toContain(cell.observed_at);
	}
	expect(html.match(/id="epic-audit-data"/g)).toHaveLength(1);
});

it("hydrates audit sources as inert text with the existing nonce script", async () => {
	const { page } = fixture();
	page.items[0]!.title.provenance = {
		kind: "linear",
		entity: "issue",
		id: "</script><img src=x onerror=alert(1)>",
		field: "title",
	};
	const window = new Window({ settings: { enableJavaScriptEvaluation: true } });
	try {
		window.document.write(renderEpicPageHtml(page, EPIC_SHAPE_NOW));
		const cell = window.document.querySelector('[data-cell="/items/0/title"]')!;
		expect(cell.querySelector(".cell-source")?.textContent).toContain(
			page.items[0]!.title.observed_at,
		);
		expect(cell.querySelector(".cell-source")?.textContent).toContain(
			"</script><img src=x onerror=alert(1)>",
		);
		expect(window.document.querySelector("img")).toBeNull();
	} finally {
		await window.happyDOM.close();
	}
});

it("shows short dependency titles but retains the complete title in the shared dictionary", () => {
	const { page } = fixture();
	const title = "完整标题".repeat(30);
	page.items[1]!.blocked_by.value![0]!.title = title;
	page.items[0]!.blocks.value![0]!.title = title;
	const html = renderEpicPageHtml(page, EPIC_SHAPE_NOW);
	const window = new Window();
	window.document.write(html);
	const data = JSON.parse(
		window.document.querySelector("#epic-audit-data")!.textContent,
	);
	for (const path of ["/items/1/blocked_by", "/items/0/blocks"]) {
		const entry = window.document.querySelector(
			`[data-cell="${path}"] [data-fulltext]`,
		)!;
		expect(entry).not.toBeNull();
		expect(entry.textContent).not.toContain(title);
		expect(data.texts[Number(entry.getAttribute("data-fulltext"))]).toBe(title);
		expect(
			[...entry.querySelector(".dep-title")!.textContent].length,
		).toBeLessThanOrEqual(40);
	}
	expect(data.texts.filter((t: string) => t === title)).toHaveLength(1);
	const acceptance = window.document.querySelector(
		'[data-cell="/items/0/acceptance"]',
	)!;
	expect(acceptance.querySelector("a")?.getAttribute("href")).toBe(
		page.items[0]!.url.value,
	);
});
