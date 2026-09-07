// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { getFleetConsoleHtml } from "../bridge/fleet-console-html.js";

function project(input: {
	registryActive: boolean;
	rosterStatus?: "not_applicable" | "ready" | "absent" | "unreadable";
	resolvedRefs?: string[];
	roles?: Array<{
		id: string;
		name: string;
		agentFile: string;
		handbookRefs: string[];
		sourceLink?: string | null;
	}>;
	nodes: Array<{
		id: string;
		name: string;
		type: "generic" | "gate" | "land";
		execution: "agent" | "gate" | "engine";
		handbookRef: string | null;
	}>;
}) {
	return {
		id: "project-1",
		name: "test-project",
		presentationGroup: "test-project",
		sourceRevision: "project:1",
		leads: [],
		roles: (input.roles ?? []).map((role) => ({
			...role,
			sourceLink: role.sourceLink ?? null,
		})),
		handbookRegistryActive: input.registryActive,
		handbookRosterAvailable: input.rosterStatus === "ready",
		handbookRosterStatus:
			input.rosterStatus ??
			(input.registryActive ? "not_applicable" : "absent"),
		handbookResolvedRefs: input.resolvedRefs ?? [],
		dags: [
			{
				id: "dag-1",
				templateId: "tpl_test",
				title: "Test workflow",
				revision: 1,
				digest: "digest:1",
				seedOwner: "system",
				graph: { nodes: input.nodes, edges: [], loops: [] },
				nodes: [],
			},
		],
		crons: [],
	};
}

function snapshot(projects: unknown[]) {
	return {
		schemaVersion: 2,
		snapshotRevision: "snapshot:1",
		generatedAt: "2026-09-06T00:00:00.000Z",
		sources: [],
		modelCatalog: {},
		projects,
		presentationGroups: [],
		unassignedCrons: [],
		flags: [],
		extensions: [],
	};
}

async function boot(projects: unknown[]) {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify(snapshot(projects)), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		),
	);
	const html = getFleetConsoleHtml();
	const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
	document.open();
	document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
	document.close();
	Function(script)();
	await vi.waitFor(() =>
		expect(document.querySelector('[data-tab="dag"]')).not.toBeNull(),
	);
	(document.querySelector('[data-tab="dag"]') as HTMLElement).click();
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.documentElement.innerHTML = "";
});

it("keeps linked handbook cards in the native keyboard tab order", async () => {
	await boot([
		project({
			registryActive: true,
			roles: [
				{
					id: "role-general",
					name: "通用执行",
					agentFile: ".flywheel/agents/nodes/general.md",
					handbookRefs: ["general"],
					sourceLink:
						"https://github.com/xrliAnnie/flywheel/blob/main/.flywheel/agents/nodes/general.md",
				},
			],
			nodes: [
				{
					id: "general",
					name: "General",
					type: "generic",
					execution: "agent",
					handbookRef: "general",
				},
			],
		}),
	]);
	const card = document.querySelector(
		'[data-role="role-general"]',
	) as HTMLAnchorElement;

	expect(card.tagName).toBe("A");
	expect(card.getAttribute("tabindex")).toBeNull();
	expect(card.tabIndex).toBe(0);
});

it("highlights one exact handbook card and supports mouse, focus, click, and keyboard location", async () => {
	await boot([
		project({
			registryActive: true,
			resolvedRefs: ["general"],
			roles: [
				{
					id: "role-general",
					name: "通用执行",
					agentFile: ".flywheel/agents/nodes/general.md",
					handbookRefs: ["general"],
				},
			],
			nodes: [
				{
					id: "general",
					name: "General",
					type: "generic",
					execution: "agent",
					handbookRef: "general",
				},
			],
		}),
	]);
	const chip = document.querySelector(
		'[data-node="tpl_test/general"]',
	) as HTMLElement;
	const card = document.querySelector(
		'[data-role="role-general"]',
	) as HTMLElement;
	const scrollIntoView = vi.fn();
	card.scrollIntoView = scrollIntoView;

	expect(chip.dataset.handbookRole).toBe("role-general");
	expect(chip.getAttribute("role")).toBe("button");
	expect(chip.tabIndex).toBe(0);
	expect(card.dataset.handbookRefs).toBe('["general"]');

	chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
	expect(chip.classList).toContain("handbook-highlight");
	expect(card.classList).toContain("handbook-highlight");
	chip.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
	expect(chip.classList).not.toContain("handbook-highlight");
	expect(card.classList).not.toContain("handbook-highlight");

	chip.focus();
	expect(chip.classList).toContain("handbook-highlight");
	expect(card.classList).toContain("handbook-highlight");
	chip.click();
	expect(scrollIntoView).toHaveBeenCalledTimes(1);
	expect(document.activeElement).toBe(card);
	expect(card.classList).toContain("handbook-highlight");

	chip.focus();
	chip.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
	);
	chip.focus();
	chip.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
	expect(scrollIntoView).toHaveBeenCalledTimes(3);
});

it("makes schema 2 and dangling refs visibly unlinked without mislabeling gate or land", async () => {
	await boot([
		project({
			registryActive: true,
			roles: [],
			nodes: [
				{
					id: "old",
					name: "Old",
					type: "generic",
					execution: "agent",
					handbookRef: null,
				},
				{
					id: "dangling",
					name: "Dangling",
					type: "generic",
					execution: "agent",
					handbookRef: "missing",
				},
				{
					id: "founder_gate",
					name: "Gate",
					type: "gate",
					execution: "gate",
					handbookRef: null,
				},
				{
					id: "land",
					name: "Land",
					type: "land",
					execution: "engine",
					handbookRef: null,
				},
			],
		}),
	]);
	const old = document.querySelector('[data-node="tpl_test/old"]')!;
	const dangling = document.querySelector('[data-node="tpl_test/dangling"]')!;
	const gate = document.querySelector('[data-node="tpl_test/founder_gate"]')!;
	const land = document.querySelector('[data-node="tpl_test/land"]')!;

	expect(old.querySelector(".dc-f")?.textContent).toBe("generic · 未关联");
	expect(old.getAttribute("title")).toContain("模板未提供执行手册引用");
	expect(old.getAttribute("aria-label")).toContain("模板未提供执行手册引用");
	expect(dangling.querySelector(".dc-f")?.textContent).toBe("generic · 未关联");
	expect(dangling.getAttribute("title")).toContain("找不到对应角色卡");
	expect(dangling.hasAttribute("data-handbook-role")).toBe(false);
	expect(gate.querySelector(".dc-f")?.textContent).toBe("gate · 人工审批");
	expect(land.querySelector(".dc-f")?.textContent).toBe("land · 引擎执行");
});

it("links the personal-assistant roster exception and explains each legacy miss precisely", async () => {
	await boot([
		project({
			registryActive: false,
			rosterStatus: "ready",
			resolvedRefs: ["general", "orphan"],
			roles: [
				{
					id: "role-life",
					name: "Life",
					agentFile: ".flywheel/agents/life/life-executor.md",
					handbookRefs: ["general"],
				},
			],
			nodes: [
				{
					id: "general",
					name: "General",
					type: "generic",
					execution: "agent",
					handbookRef: "general",
				},
				{
					id: "unknown",
					name: "Unknown",
					type: "generic",
					execution: "agent",
					handbookRef: "unknown",
				},
				{
					id: "orphan",
					name: "Orphan",
					type: "generic",
					execution: "agent",
					handbookRef: "orphan",
				},
			],
		}),
	]);
	const general = document.querySelector('[data-node="tpl_test/general"]')!;
	const unknown = document.querySelector('[data-node="tpl_test/unknown"]')!;
	const orphan = document.querySelector('[data-node="tpl_test/orphan"]')!;

	expect(general.getAttribute("data-handbook-role")).toBe("role-life");
	expect(general.getAttribute("title")).toContain(
		"按项目 ic-roster 解析到同一手册",
	);
	expect(unknown.getAttribute("title")).toContain(
		"该节点未在项目 ic-roster 中配置",
	);
	expect(orphan.getAttribute("title")).toContain(
		"该项目 roster 解析到的文件与任何唯一角色卡不同",
	);
	for (const chip of [unknown, orphan]) {
		expect(chip.querySelector(".dc-f")?.textContent).toBe("generic · 未关联");
	}
});

it("keeps absent rosters and duplicate role refs inert with explicit reasons", async () => {
	await boot([
		project({
			registryActive: false,
			rosterStatus: "absent",
			roles: [
				{
					id: "role-a",
					name: "A",
					agentFile: "a.md",
					handbookRefs: ["duplicate"],
				},
				{
					id: "role-b",
					name: "B",
					agentFile: "b.md",
					handbookRefs: ["duplicate"],
				},
			],
			nodes: [
				{
					id: "missing-roster",
					name: "Missing roster",
					type: "generic",
					execution: "agent",
					handbookRef: "not-there",
				},
				{
					id: "duplicate",
					name: "Duplicate",
					type: "generic",
					execution: "agent",
					handbookRef: "duplicate",
				},
			],
		}),
	]);
	const absent = document.querySelector(
		'[data-node="tpl_test/missing-roster"]',
	)!;
	const duplicate = document.querySelector('[data-node="tpl_test/duplicate"]')!;

	expect(absent.getAttribute("title")).toContain(
		"该项目无 ic-roster / 无 overlay",
	);
	expect(duplicate.getAttribute("title")).toContain("对应多张角色卡");
	expect(duplicate.hasAttribute("data-handbook-role")).toBe(false);
	expect(
		document.querySelectorAll('[data-rule="eng-node-types"]'),
	).toHaveLength(1);
	expect(
		document.querySelectorAll('[data-rule="handbook-links"]'),
	).toHaveLength(1);
});
