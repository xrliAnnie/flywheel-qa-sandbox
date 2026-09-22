import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { buildFounderView } from "../founder-view.js";
import { generateEpicPage } from "../generate.js";
import { resolvePointer, type Signal } from "../model.js";
import { renderEpicPageHtml } from "../render-html.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
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

function stuckSignal(kind: "run_held" | "declared_blocked" | "runner_stopped") {
	return {
		kind,
		since: EPIC_SHAPE_NOW.toISOString(),
		execution_id8: "stuck001",
		...(kind === "runner_stopped" ? { reason: "blocked" as const } : {}),
		provenance: {
			kind:
				kind === "runner_stopped"
					? ("commdb" as const)
					: ("statestore" as const),
			table: kind === "run_held" ? "workflow_run" : "sessions",
			key: { execution_id: "stuck001-full" },
		},
		observed_at: EPIC_SHAPE_NOW.toISOString(),
	} satisfies Signal;
}

function itemSignals(
	snapshot: ReturnType<typeof epicShapeSnapshotV3>,
	index: number,
	signals: Signal[],
) {
	return snapshot.items.map((item, itemIndex) => {
		const selected = itemIndex === index ? signals : [];
		const statestoreCount = selected.filter(
			(signal) => signal.provenance.kind === "statestore",
		).length;
		return {
			signals: selected,
			signal_sources: {
				statestore: {
					value: { signals: statestoreCount },
					provenance: {
						kind: "statestore" as const,
						table: "sessions",
						key: { issue_id: item.id },
					},
					observed_at: EPIC_SHAPE_NOW.toISOString(),
				},
				commdb: {
					value: { signals: selected.length - statestoreCount },
					provenance: {
						kind: "commdb" as const,
						table: "mailbox",
						key: { issue_identifier: item.identifier },
					},
					observed_at: EPIC_SHAPE_NOW.toISOString(),
				},
			},
		};
	});
}

describe("founder Epic HTML", () => {
	it("separates stopped and truly running children from Linear In Progress", () => {
		const snapshot = epicShapeSnapshotV3();
		const stoppedFacts = v3ItemFacts(snapshot);
		stoppedFacts[
			snapshot.items.findIndex((item) => item.identifier === "EPX-1")
		] = emptyItemFacts();
		const stoppedPage = generateEpicPage({
			snapshot,
			itemFacts: stoppedFacts,
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "manual",
		});
		const stoppedDom = new Window().document;
		stoppedDom.write(renderEpicPageHtml(stoppedPage, EPIC_SHAPE_NOW));
		const stopped = stoppedDom.querySelector('[data-item="EPX-1"]')!;
		expect(stopped.querySelector(".s")?.textContent).toBe("停着·卡住");
		expect(stopped.querySelector(".kid-a")?.textContent).toContain(
			"没有机器在动·卡住",
		);
		expect(stopped.textContent).not.toContain("在跑");
		expect(stopped.textContent).not.toContain("还没起跑");

		const livePage = generateEpicPage({
			snapshot,
			itemFacts: v3ItemFacts(snapshot),
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "manual",
		});
		const liveDom = new Window().document;
		liveDom.write(renderEpicPageHtml(livePage, EPIC_SHAPE_NOW));
		expect(liveDom.querySelector('[data-item="EPX-1"] .s')?.textContent).toBe(
			"在跑",
		);
	});

	it("keeps an unrelated fresh session non-live without claiming no machine is moving", () => {
		const snapshot = epicShapeSnapshotV3();
		const facts = snapshot.items.map(() => emptyItemFacts());
		const index = snapshot.items.findIndex(
			(item) => item.identifier === "EPX-1",
		);
		facts[index]!.session.value = {
			latest: [
				{
					status: "running",
					role: "qa",
					branch: "flywheel-EPX-1",
					execution_id8: "unbound1",
				},
			],
			ledger_live_count: 1,
			machine_running_count: 1,
			running_heartbeat_stale_count: 0,
			running_heartbeat_missing_count: 0,
		};
		facts[index]!.run.value = [
			{
				run_id: "run-current",
				status: "active",
				current_node_id: "founder_gate",
				current_node_label: "Founder gate",
				label_source: "manifest",
				template_id: "workflow-v1",
			},
		];
		facts[index]!.attempt.value = [
			{
				state: "review",
				attempt: 1,
				ledger_open: true,
				machine_live: false,
				starting_recent: false,
				heartbeat_state: "not_applicable",
			},
		];
		const page = generateEpicPage({
			snapshot,
			itemFacts: facts,
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "manual",
		});
		const dom = new Window().document;
		dom.write(renderEpicPageHtml(page, EPIC_SHAPE_NOW));
		const card = dom.querySelector('[data-item="EPX-1"]')!;

		expect(card.getAttribute("data-class")).toBe("stopped_acceptance");
		expect(card.querySelector(".kid-h > .s")?.textContent).toBe("停着·等验收");
		expect(card.querySelector(".kid-a")?.textContent).toContain(
			"当前节点停着·另有会话活着·等验收",
		);
		expect(card.querySelector(".kid-a")?.textContent).not.toContain("在跑");
		expect(card.querySelector(".kid-a")?.textContent).not.toContain("卡住");
		expect(card.querySelector(".kid-a")?.textContent).not.toContain(
			"没有机器在动",
		);

		facts[index]!.run.value![0]!.status = "held";
		const stuckPage = generateEpicPage({
			snapshot,
			itemFacts: facts,
			itemSignals: itemSignals(snapshot, index, [stuckSignal("run_held")]),
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "manual",
		});
		const stuckDom = new Window().document;
		stuckDom.write(renderEpicPageHtml(stuckPage, EPIC_SHAPE_NOW));
		const stuckCard = stuckDom.querySelector('[data-item="EPX-1"]')!;
		expect(stuckCard.getAttribute("data-class")).toBe("stopped_stuck");
		expect(stuckCard.querySelector(".kid-h > .s")?.textContent).toBe(
			"停着·卡住",
		);
		expect(stuckCard.querySelector(".kid-a")?.textContent).toContain(
			"流程被 held·请看 land 重试耗尽·卡住·另有会话活着",
		);
		expect(stuckCard.querySelector(".kid-a")?.textContent).not.toContain(
			"在跑",
		);
		expect(stuckCard.querySelector(".kid-a")?.textContent).not.toContain(
			"没有机器在动",
		);
	});

	it.each([
		["declared_blocked", "IC 已声明卡住"],
		["runner_stopped", "runner 已停机·卡住"],
	] as const)(
		"renders the %s signal as the founder-visible stuck reason",
		(kind, expected) => {
			const snapshot = epicShapeSnapshotV3();
			const facts = snapshot.items.map(() => emptyItemFacts());
			const index = snapshot.items.findIndex(
				(item) => item.identifier === "EPX-1",
			);
			const page = generateEpicPage({
				snapshot,
				itemFacts: facts,
				itemSignals: itemSignals(snapshot, index, [stuckSignal(kind)]),
				now: EPIC_SHAPE_NOW,
				projectName: "example",
				trigger: "manual",
			});
			const dom = new Window().document;
			dom.write(renderEpicPageHtml(page, EPIC_SHAPE_NOW));
			const progress = dom.querySelector(
				'[data-item="EPX-1"] .kid-a',
			)?.textContent;

			expect(progress).toContain(expected);
			expect(progress).not.toContain("心跳");
		},
	);

	it("renders FLY-2598's held land reason and count from the final-head shape", () => {
		const snapshot = epicShapeSnapshotV3();
		const source = snapshot.items.find((item) => item.identifier === "EPX-1")!;
		source.identifier = "FLY-2598";
		source.title =
			"Runtime recovery: provider-specific configs + correct context windows";
		source.url = "https://linear.app/geoforge3d/issue/FLY-2598";
		source.state = { name: "In Progress", type: "started" };
		snapshot.items = [source];
		snapshot.descendantIds = [source.id];
		const facts = [emptyItemFacts()];
		facts[0]!.session.value = {
			latest: [
				{
					status: "completed",
					role: "qa",
					branch: "flywheel-FLY-2598",
					execution_id8: "8575b98f",
				},
			],
			ledger_live_count: 0,
			machine_running_count: 0,
			running_heartbeat_stale_count: 0,
			running_heartbeat_missing_count: 0,
		};
		facts[0]!.run.value = [
			{
				run_id: "d0e72d2d",
				status: "held",
				current_node_id: "land",
				current_node_label: "落地",
				label_source: "manifest",
				template_id: "workflow-v1",
			},
		];
		facts[0]!.attempt.value = [
			{
				state: "pending",
				attempt: 1,
				ledger_open: true,
				machine_live: false,
				starting_recent: false,
				heartbeat_state: "not_applicable",
			},
		];
		const page = generateEpicPage({
			snapshot,
			itemFacts: facts,
			itemSignals: itemSignals(snapshot, 0, [stuckSignal("run_held")]),
			now: EPIC_SHAPE_NOW,
			projectName: "flywheel",
			trigger: "manual",
		});
		const dom = new Window().document;
		dom.write(renderEpicPageHtml(page, EPIC_SHAPE_NOW));
		const card = dom.querySelector('[data-item="FLY-2598"]')!;

		expect(card.getAttribute("data-class")).toBe("stopped_stuck");
		expect(card.querySelector(".kid-h > .s")?.textContent).toBe("停着·卡住");
		expect(card.querySelector(".kid-a")?.textContent).toContain(
			"流程被 held·请看 land 重试耗尽·卡住",
		);
		expect(card.textContent).not.toContain("心跳");
		expect(
			card.closest("details.epic")?.querySelector(".e-c")?.textContent,
		).toBe("0 在跑 · 1 停着 · 0 说不准 · 0 未开始 · 共 1");
	});

	it("counts only fresh machine evidence as live, keeps stopped causes visible, and reserves 在跑 for live rows", () => {
		const snapshot = epicShapeSnapshotV3();
		snapshot.roots = snapshot.roots.filter(
			(root) => root.identifier === "EPX-100",
		);
		snapshot.items = snapshot.items
			.filter((item) =>
				[1, 2, 3, 4, 5, 6].includes(Number(item.identifier.slice(4))),
			)
			.map((item, index) => ({
				...item,
				state:
					index === 4
						? { name: "Todo", type: "unstarted" }
						: { name: "In Progress", type: "started" },
				blockedBy: [],
			}));
		snapshot.descendantIds = snapshot.items.map((item) => item.id);
		const facts = snapshot.items.map(() => emptyItemFacts());
		facts[0]!.session.value = {
			latest: [
				{
					status: "running",
					role: "implement",
					branch: null,
					execution_id8: "live0001",
				},
			],
			ledger_live_count: 1,
			machine_running_count: 1,
			running_heartbeat_stale_count: 0,
			running_heartbeat_missing_count: 0,
		};
		facts[1]!.session.value!.latest = [
			{
				status: "completed",
				role: "design",
				branch: null,
				execution_id8: "done0001",
			},
		];
		facts[3]!.session.value = {
			latest: [
				{
					status: "running",
					role: "implement",
					branch: null,
					execution_id8: "stale001",
				},
			],
			ledger_live_count: 1,
			machine_running_count: 0,
			running_heartbeat_stale_count: 1,
			running_heartbeat_missing_count: 0,
		};
		facts[5]!.run.value = [
			{
				run_id: "run-starting",
				status: "active",
				current_node_id: "implement",
				current_node_label: "实现",
				label_source: "manifest",
				template_id: "tpl",
			},
		];
		facts[5]!.attempt.value = [
			{
				state: "admitted",
				attempt: 1,
				ledger_open: true,
				machine_live: false,
				starting_recent: true,
				heartbeat_state: "not_applicable",
			},
		];
		const page = generateEpicPage({
			snapshot,
			itemFacts: facts,
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "manual",
		});
		const dom = new Window().document;
		dom.write(renderEpicPageHtml(page, EPIC_SHAPE_NOW));
		expect(dom.querySelector('[data-root="EPX-100"] .e-c')?.textContent).toBe(
			"1 在跑 · 2 停着 · 2 说不准 · 1 未开始 · 共 6",
		);
		expect(dom.querySelector('[data-item="EPX-2"] .s')?.textContent).toBe(
			"停着·等验收",
		);
		expect(dom.querySelector('[data-item="EPX-3"] .s')?.textContent).toBe(
			"停着·卡住",
		);
		expect(
			dom.querySelector('[data-item="EPX-4"] .kid-a')?.textContent,
		).toContain("心跳过期·说不准");
		expect(dom.querySelector('[data-item="EPX-6"] .s')?.textContent).toBe(
			"刚起跑·说不准",
		);
		expect(
			dom.querySelector('[data-item="EPX-6"] .kid-a')?.textContent,
		).toContain("等第一次心跳");
		expect(dom.querySelector('[data-item="EPX-6"]')?.textContent).not.toContain(
			"停着",
		);
		const nonLiveCards = [
			...dom.querySelectorAll<HTMLElement>('.kid:not([data-class="live"])'),
		];
		expect(new Set(nonLiveCards.map((card) => card.dataset.class))).toEqual(
			new Set(["stopped_acceptance", "stopped_stuck", "evidence_gap", "idle"]),
		);
		for (const card of nonLiveCards) {
			const context = `${card.dataset.item}/${card.dataset.class}`;
			expect(
				card.querySelector(".kid-h > .s")?.textContent,
				`${context} badge`,
			).not.toContain("在跑");
			expect(
				card.querySelector(".kid-a")?.textContent,
				`${context} progress`,
			).not.toContain("在跑");
		}

		facts[5]!.attempt.value![0]!.starting_recent = false;
		const expiredPage = generateEpicPage({
			snapshot,
			itemFacts: facts,
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "manual",
		});
		const expiredDom = new Window().document;
		expiredDom.write(renderEpicPageHtml(expiredPage, EPIC_SHAPE_NOW));
		expect(
			expiredDom.querySelector('[data-item="EPX-6"] .s')?.textContent,
		).toBe("停着·卡住（起跑后无心跳）");
		expect(
			expiredDom.querySelector('[data-item="EPX-6"] .kid-a')?.textContent,
		).toContain("起跑后从未发出心跳·卡住");
	});
	it("keeps an unfinished blocker visible when machine evidence says live", () => {
		const snapshot = epicShapeSnapshotV3();
		const live = snapshot.items.find((item) => item.identifier === "EPX-1")!;
		live.blockedBy = [
			{
				id: "outside",
				identifier: "OUT-1",
				title: "Outside",
				url: "https://linear.app/out",
				stateType: "unstarted",
				inScope: false,
			},
		];
		const page = generateEpicPage({
			snapshot,
			itemFacts: v3ItemFacts(snapshot),
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "manual",
		});
		const dom = new Window().document;
		dom.write(renderEpicPageHtml(page, EPIC_SHAPE_NOW));
		const child = dom.querySelector('[data-item="EPX-1"]')!;
		expect(child.querySelector(".s-live")?.textContent).toBe("在跑");
		expect(child.querySelector(".s-blocked")?.textContent).toBe(
			"等 OUT-1(范围外)",
		);
	});
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
			"0 在跑 · 0 停着 · 0 说不准 · 1 未开始 · 共 1",
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
		).toBeUndefined();
		expect(
			doc.querySelector('[data-item="EPX-1"] .kid-a')?.textContent,
		).toContain("到「实现」· 第 2 次 · 会话 running");
		expect(doc.querySelector('[data-item="EPX-8"]')).toBeNull();
		expect(doc.querySelector('[data-cell="/items/7/state"]')).toBeNull();
		expect(
			doc.querySelector('[data-root="EPX-100"] .terminal-tail')?.textContent,
		).toBe("另有 1 张已完成 · 1 张已取消(不展示)");
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
		).toBe(5);
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

it("limits blocker badges and keeps a missing-attempt live session non-live without calling it stuck", () => {
	const { page } = fixture();
	const item = page.items[1]!,
		base = item.blocked_by.value![0]!;
	item.blocked_by.value = [4, 3, 2, 1].map((n) => ({
		...base,
		identifier: `OUT-${n}`,
		in_scope: false,
	}));
	page.items[0]!.attempt.value = [];
	page.items[0]!.session.value = {
		latest: [],
		ledger_live_count: 1,
		machine_running_count: 1,
		running_heartbeat_stale_count: 0,
		running_heartbeat_missing_count: 0,
	};
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
	).toContain("当前节点停着·另有会话活着·等验收");
	expect(
		window.document.querySelector('[data-item="EPX-1"] .kid-a')!.textContent,
	).not.toContain("在跑");
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

it("matches the founder-approved v5 blocks without legacy overview furniture", () => {
	const { doc, html } = fixture();
	expect(doc.querySelector(".mock-bar")?.textContent).toContain("一个固定链接");
	expect(doc.querySelector(".mock-bar")?.textContent).toContain("按需刷新");
	expect(doc.querySelector(".mock-bar")?.textContent).toContain("页面快照截至");
	expect(html).not.toContain("系统自己刷新");
	expect(doc.querySelector(".m-h .note")?.textContent).toBe(
		"全部默认收起,点开才展开",
	);
	expect(
		doc
			.querySelector(".m-h")!
			.compareDocumentPosition(doc.querySelector("[data-attention-section]")!) &
			4,
	).toBe(4);
	expect(
		doc.querySelectorAll(
			".overview-card,.freshness-card,.e-wait,[data-machine-line],textarea",
		),
	).toHaveLength(0);
	for (const card of doc.querySelectorAll("details.epic")) {
		expect(card.hasAttribute("open")).toBe(false);
		expect(card.querySelector("summary .lead-note")).toBeNull();
		expect(card.querySelector(".e-b .leadnote")?.textContent).toContain(
			"还没有人写过",
		);
	}
	for (const child of doc.querySelectorAll(".kid")) {
		expect(child.querySelector(".kid-a")?.textContent).toContain("↳");
		expect(child.querySelector(".kid-a")?.textContent).toContain(
			"这张单还没有 thread",
		);
	}
});

it("strips title slugs from public Linear links", () => {
	const { page } = fixture();
	page.items[0]!.url.value =
		"https://linear.app/example/issue/EPX-1/private-person-name";
	const window = new Window();
	window.document.write(renderEpicPageHtml(page, EPIC_SHAPE_NOW));
	expect(
		window.document
			.querySelector('[data-item="EPX-1"] a')
			?.getAttribute("href"),
	).toBe("https://linear.app/example/issue/EPX-1");
});

it("carries a validated child Discord binding through generation to the row", () => {
	const snapshot = epicShapeSnapshotV3();
	const input = {
		snapshot,
		itemFacts: v3ItemFacts(snapshot),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "manual" as const,
		childThreads: new Map([
			[
				snapshot.items[0]!.id,
				{
					value: "https://discord.com/channels/123/456",
					observed_at: EPIC_SHAPE_NOW.toISOString(),
					provenance: {
						kind: "statestore" as const,
						table: "chat_threads",
						key: { issue_id: snapshot.items[0]!.id },
					},
				},
			],
		]),
	};
	const page = generateEpicPage(input);
	const window = new Window();
	window.document.write(renderEpicPageHtml(page, EPIC_SHAPE_NOW));
	expect(
		window.document
			.querySelector('[data-item="EPX-1"] .jump')
			?.getAttribute("href"),
	).toBe("https://discord.com/channels/123/456");
	expect(
		window.document
			.querySelector('[data-item="EPX-1"] .jump')
			?.hasAttribute("data-discord-app"),
	).toBe(true);
	expect(
		window.document
			.querySelector('[data-item="EPX-1"] [data-discord-fallback]')
			?.getAttribute("href"),
	).toBe("https://discord.com/channels/123/456");
});

it("uses short Epic names and calls a ready child unstarted", () => {
	const { page } = fixture();
	page.header.roots.value![0]!.title = `[进度页·E5] ${"长标题".repeat(30)}`;
	const doc = new Window().document;
	doc.write(renderEpicPageHtml(page, EPIC_SHAPE_NOW));
	const title = doc.querySelector('[data-root="EPX-100"] .e-n')!;
	expect([...title.textContent].length).toBeLessThanOrEqual(32);
	expect(title.textContent).not.toContain("[进度页");
	const ready = doc.querySelector('.kid[data-class="free"]');
	expect(ready).not.toBeNull();
	expect(ready!.querySelector(".s")?.textContent).toBe("未开始");
	expect(ready!.querySelector(".kid-a")?.textContent).toContain("还没起跑");
});
