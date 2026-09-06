// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFleetConsoleHtml } from "../bridge/fleet-console-html.js";

function managed(targetId: string, current: unknown, consequence = "new-run") {
	return {
		targetId,
		current,
		source: { kind: "project_config", revision: `revision:${targetId}` },
		writeCapability: {
			writable: true,
			consequence,
			requiresAcknowledgement: false,
		},
	};
}

function readOnlyManaged(targetId: string, current: unknown, reason?: string) {
	return {
		...managed(targetId, current),
		writeCapability: {
			writable: false,
			consequence: "new-run",
			requiresAcknowledgement: false,
			...(reason === undefined ? {} : { reason }),
		},
	};
}

function flag(
	name: string,
	current: unknown,
	options: {
		polarity?: "default_on" | "opt_in";
		default: boolean | string;
		valueKind?: "bool" | "int" | "enum";
		onMeans: "enables" | "disables" | null;
		whenOn?: string | null;
		global?: ReturnType<typeof managed> | ReturnType<typeof readOnlyManaged>;
		projectOverrides?: Array<{
			projectName: string;
			value: unknown;
			via: "project_row" | "star_row" | "default" | null;
			isDefault: boolean | null;
		}>;
	},
) {
	return {
		id: `flag/${name}`,
		name,
		description: `Description for ${name}`,
		polarity: options.polarity ?? "opt_in",
		default: options.default,
		valueKind: options.valueKind ?? "bool",
		onMeans: options.onMeans,
		whenOn:
			options.whenOn === undefined ? `Meaning for ${name}` : options.whenOn,
		global: options.global ?? managed(`flag-${name}`, current),
		projectOverrides: options.projectOverrides ?? [],
	};
}

function catalog(surface: string) {
	const efforts = surface === "cron" ? [] : ["low", "medium", "high", "xhigh"];
	return {
		version: 1,
		surface,
		providers: [
			{
				id: "anthropic",
				label: "Anthropic",
				models: [
					{
						id: "claude-fable-5-1",
						label: "Fable 5.1",
						runtimeVendor: "claude",
						efforts,
					},
					{
						id: "claude-fable-5",
						label: "Fable 5",
						runtimeVendor: "claude",
						efforts,
					},
					{
						id: "claude-opus-4-8",
						label: "Opus 5 (1M)",
						runtimeVendor: "claude",
						efforts,
					},
				],
			},
		],
	};
}

function snapshot() {
	return {
		schemaVersion: 2,
		snapshotRevision: "snapshot:1",
		generatedAt: "2026-07-15T00:00:00.000Z",
		sources: [],
		presentationGroups: [
			{
				id: "flywheel",
				label: "flywheel",
				projectIds: ["project-1"],
				leadIds: ["lead-1"],
				derived: false,
			},
			{
				id: "beta-portfolio",
				label: "portfolio",
				projectIds: ["project-2"],
				leadIds: [],
				derived: false,
			},
			{
				id: "infra",
				label: "Infra",
				projectIds: ["project-1", "project-2"],
				leadIds: ["lead-infra", "lead-beta-infra"],
				derived: true,
			},
		],
		modelCatalog: {
			lead: catalog("lead"),
			runner: catalog("runner"),
			workflow: catalog("workflow"),
			cron: catalog("cron"),
		},
		projects: [
			{
				id: "project-1",
				name: "flywheel",
				presentationGroup: "flywheel",
				sourceRevision: "project:1",
				leads: [
					{
						id: "lead-1",
						displayName: "Product Lead",
						department: "product",
						backend: "claude-code",
						online: "online",
						dispatch: managed("lead-target", null, "restart-lead"),
					},
					{
						id: "lead-infra",
						displayName: "Flywheel Infra Lead",
						department: "infra",
						backend: "claude-code",
						online: "online",
						dispatch: managed(
							"lead-infra-target",
							{
								provider: "anthropic",
								model: "claude-opus-4-8",
								effort: "high",
							},
							"restart-lead",
						),
					},
				],
				roles: [
					{
						id: "role-linked",
						name: "Engineer",
						agentFile: "engineer-executor.md",
						department: "engineering",
						sourceLink:
							"https://github.com/o/r/blob/main/.flywheel/agents/engineer-executor.md",
					},
					{
						id: "role-missing",
						name: "QA",
						agentFile: "qa-executor.md",
						department: "engineering",
						sourceLink: null,
						error: "sourceLink unavailable",
					},
				],
				dags: [
					{
						id: "dag-1",
						templateId: "tpl_code",
						title: "Code workflow",
						revision: 1,
						digest: "digest:dag-1",
						seedOwner: "system",
						graph: {
							nodes: [
								{
									id: "land",
									name: "Land",
									type: "land",
									execution: "engine",
								},
								{
									id: "design",
									name: "Design",
									type: "design",
									execution: "agent",
								},
								{
									id: "implement",
									name: "Implement",
									type: "implement",
									execution: "agent",
								},
								{
									id: "qa",
									name: "QA",
									type: "qa",
									execution: "agent",
								},
								{
									id: "founder_gate",
									name: "Founder gate",
									type: "gate",
									execution: "gate",
								},
							],
							edges: [
								{ id: "design_to_implement", from: "design", to: "implement" },
								{ id: "implement_to_qa", from: "implement", to: "qa" },
								{ id: "qa_to_gate", from: "qa", to: "founder_gate" },
								{ id: "gate_to_land", from: "founder_gate", to: "land" },
							],
							loops: [
								{
									id: "qa_retry",
									name: "QA 失败重来",
									from: "qa",
									to: "implement",
									maxIterations: 3,
								},
								{
									id: "founder_rework",
									name: "创始人打回重做",
									from: "founder_gate",
									to: "implement",
									maxIterations: null,
								},
							],
						},
						nodes: [
							{
								id: "design",
								name: "Design",
								dispatch: {
									...managed("dag-design-target", {
										provider: "anthropic",
										model: "claude-opus-4-8",
										effort: "high",
									}),
									source: {
										kind: "workflow_template",
										revision: "revision:dag-design-target",
										hint: "tpl_code@1",
									},
									canonicalModel: "claude-opus-4-8",
								},
							},
							{
								id: "implement",
								name: "Implement",
								policy: {
									status: "ready",
									nodeId: "implement",
									label: "实现",
									type: "implement",
									defaultModel: "codex",
									source:
										".flywheel/agents/registry.yaml#graphs.code.policies.implement",
									models: [
										{
											alias: "fable",
											provider: "anthropic",
											vendor: "claude",
											model: "claude-fable-5-1",
											label: "Fable 5.1",
											allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
											defaultEffort: "high",
										},
										{
											alias: "codex",
											provider: "openai",
											vendor: "codex",
											model: "gpt-5.6-sol",
											label: "GPT 5.6 Sol",
											allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
											defaultEffort: "xhigh",
										},
									],
									allowedSelections: [],
								},
								dispatch: {
									...managed("dag-target", {
										provider: "anthropic",
										model: "fable",
										effort: null,
									}),
									canonicalModel: "claude-fable-5-1",
								},
							},
							{
								id: "qa",
								name: "QA",
								dispatch: {
									...managed("dag-qa-target", {
										provider: "anthropic",
										model: "fable",
										effort: "xhigh",
									}),
									canonicalModel: "claude-fable-5-1",
								},
							},
						],
					},
					{
						id: "dag-2",
						templateId: "simple_code",
						title: "Simple code workflow",
						revision: 1,
						digest: "digest:dag-2",
						seedOwner: "system",
						graph: {
							nodes: [
								{
									id: "implement",
									name: "Implement",
									type: "implement",
									execution: "agent",
								},
								{ id: "land", name: "Land", type: "land", execution: "engine" },
							],
							edges: [
								{ id: "implement_to_land", from: "implement", to: "land" },
							],
							loops: [],
						},
						nodes: [],
					},
					{
						id: "dag-3",
						templateId: "generic",
						title: "Generic workflow A",
						revision: 1,
						digest: "digest:dag-3",
						seedOwner: "system",
						graph: {
							nodes: [
								{
									id: "generic",
									name: "Generic",
									type: "generic",
									execution: "agent",
								},
								{ id: "land", name: "Land", type: "land", execution: "engine" },
							],
							edges: [{ id: "generic_to_land", from: "generic", to: "land" }],
							loops: [],
						},
						nodes: [],
					},
					{
						id: "dag-4",
						templateId: "generic",
						title: "Generic workflow B",
						revision: 2,
						digest: "digest:dag-4",
						seedOwner: "founder",
						graph: {
							nodes: [
								{
									id: "generic",
									name: "Generic",
									type: "generic",
									execution: "agent",
								},
								{
									id: "founder_gate",
									name: "Founder gate",
									type: "gate",
									execution: "gate",
								},
								{ id: "land", name: "Land", type: "land", execution: "engine" },
							],
							edges: [
								{ id: "generic_to_gate", from: "generic", to: "founder_gate" },
								{ id: "gate_to_land", from: "founder_gate", to: "land" },
							],
							loops: [],
						},
						nodes: [],
					},
				],
				crons: [
					{
						id: "cron-1",
						label: "alpha.daily",
						projectName: "alpha",
						sourceHint: "alpha.daily.plist",
						schedule: managed(
							"schedule-target",
							{
								days: [1],
								times: [{ hour: 9, minute: 0 }],
								label: "自定义",
							},
							"reload-launchd",
						),
						enabled: managed("enabled-target", true, "reload-launchd"),
						loaded: true,
						model: managed(
							"cron-model-target",
							{
								provider: "anthropic",
								model: "claude-fable-5",
								effort: null,
							},
							"reload-launchd",
						),
						warnings: [],
					},
				],
				runnerDefault: { dispatch: managed("runner-target", null) },
			},
			{
				id: "project-2",
				name: "beta",
				presentationGroup: "beta",
				sourceRevision: "file:0123456789abcdef",
				leads: [
					{
						id: "lead-beta-infra",
						displayName: "Beta Infra Lead",
						department: "infra",
						backend: "claude-code",
						online: "degraded",
						dispatch: managed("lead-beta-infra-target", null, "restart-lead"),
					},
				],
				roles: [],
				dags: [
					{
						id: "dag-2",
						templateId: "beta-default",
						title: "Beta workflow",
						revision: 1,
						digest: "digest:dag-2",
						seedOwner: "system",
						graph: null,
						nodes: [],
						error: "manifest unavailable",
					},
				],
				crons: [],
				runnerDefault: {
					dispatch: managed("runner-beta-target", null),
				},
			},
		],
		unassignedCrons: [],
		flags: [
			flag("disables_open", true, {
				default: false,
				onMeans: "disables",
			}),
			flag("disables_closed", false, {
				default: false,
				onMeans: "disables",
			}),
			flag("default_on_open", true, {
				polarity: "default_on",
				default: true,
				onMeans: "enables",
			}),
			flag("default_on_closed", false, {
				polarity: "default_on",
				default: true,
				onMeans: "enables",
			}),
			flag("opt_in_open", true, {
				default: false,
				onMeans: "enables",
				projectOverrides: [
					{
						projectName: "flywheel",
						value: readOnlyManaged("flag-opt-in-project", true, "read-only"),
						via: "project_row",
						isDefault: false,
					},
				],
			}),
			flag("opt_in_closed", false, {
				default: false,
				onMeans: "enables",
			}),
			flag("numeric", "18", {
				default: "12",
				valueKind: "int",
				onMeans: null,
				whenOn: "节点运行多少小时后算停留过久",
				global: readOnlyManaged("flag-numeric", "18", "read-only registry"),
			}),
			flag("missing_semantics", true, {
				default: true,
				onMeans: null,
				whenOn: null,
				global: readOnlyManaged("flag-missing", true, "custom backend reason"),
			}),
			flag("unknown_value", null, {
				default: false,
				onMeans: null,
				whenOn: "发送系统告警",
				global: readOnlyManaged("flag-unknown", null),
			}),
		],
		extensions: [
			{
				id: "runtime",
				label: "运行参数",
				fields: [
					{
						id: "polling",
						label: "轮询间隔",
						kind: "number",
						help: "全局参数",
						value: managed("extension-target", 30),
					},
				],
			},
		],
	};
}

describe("management console browser interactions", () => {
	let requests: Array<{ path: string; body?: unknown }>;
	let stageResponses: unknown[];

	beforeEach(async () => {
		requests = [];
		stageResponses = [];
		const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
			requests.push({
				path,
				body: options?.body ? JSON.parse(String(options.body)) : undefined,
			});
			const body =
				path === "/api/fleet/snapshot"
					? snapshot()
					: path === "/api/fleet/changes/stage" && stageResponses.length
						? stageResponses.shift()
						: { batch: { changes: [], noOps: [] }, confirmationRequired: true };
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const html = getFleetConsoleHtml();
		const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
		document.open();
		document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
		document.close();
		Function(script)();
		await vi.waitFor(() => {
			expect(document.querySelector("[data-model-target]")).not.toBeNull();
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.documentElement.innerHTML = "";
	});

	it("renders the ordinary project and derived Infra group once with distinct detail", () => {
		expect(
			document.querySelectorAll('[data-project="project-1"]'),
		).toHaveLength(1);
		expect(document.querySelectorAll('[data-group="infra"]')).toHaveLength(1);
		expect(document.querySelector('[data-project="project-2"]')).not.toBeNull();

		const detail = document.getElementById("detail")!;
		expect(detail.textContent).toContain("Product Lead");
		expect(detail.textContent).not.toContain("Flywheel Infra Lead");
		expect(detail.querySelector(".topline .subtitle")?.textContent).toBe(
			"1 个可见 Lead · 4 个 DAG · 1 个 Cron",
		);
		expect(detail.textContent).toContain("另有 1 个 Lead 归在「Infra」分组下");
		expect(detail.textContent).toContain("1 个");
		expect(detail.textContent).not.toContain("真源 revision");

		(
			document.querySelector('[data-group="infra"]') as HTMLButtonElement
		).click();
		expect(detail.querySelector("h1")?.textContent).toBe("Infra");
		expect(detail.textContent).toContain("Flywheel Infra Lead");
		expect(detail.textContent).toContain("Beta Infra Lead");
		expect(detail.textContent).not.toContain("Product Lead");
		expect(detail.querySelector("[data-tab]")).toBeNull();
		expect(detail.textContent).toContain("按 dept 归组，不是独立项目");

		(
			document.querySelector('[data-project="project-1"]') as HTMLButtonElement
		).click();
		expect(detail.querySelectorAll("[data-tab]")).toHaveLength(3);
		expect(detail.textContent).toContain("Product Lead");
		expect(detail.textContent).not.toContain("Flywheel Infra Lead");
	});

	it("omits redundant single-project group titles without hiding the project", () => {
		const titles = Array.from(
			document.querySelectorAll(".project-rail .group-title"),
		).map((title) => title.textContent);
		expect(titles).not.toContain("flywheel");
		expect(titles).toContain("portfolio");
		expect(titles).toContain("分组");
		expect(
			document.querySelectorAll('[data-project="project-1"]'),
		).toHaveLength(1);
	});

	it("renders one shared heading for each Lead list and hides repeated row labels", () => {
		const detail = document.getElementById("detail")!;
		const head = detail.querySelector(".lead-list > .lead-head")!;
		expect(head).not.toBeNull();
		expect(
			Array.from(head.querySelectorAll("span")).map((span) => span.textContent),
		).toEqual(["Lead", "公司 → 型号 → effort"]);
		const rowLabel = detail.querySelector(".lead-row .field>label")!;
		expect(getComputedStyle(rowLabel).display).toBe("none");
		expect(
			Array.from(detail.querySelectorAll(".lead-row select")).map((select) =>
				select.getAttribute("aria-label"),
			),
		).toEqual([
			"公司 → 型号 → effort：公司",
			"公司 → 型号 → effort：型号",
			"公司 → 型号 → effort：effort",
		]);
		const runnerLabel = detail.querySelector(".grid .card .field>label")!;
		expect(getComputedStyle(runnerLabel).display).not.toBe("none");

		(
			document.querySelector('[data-group="infra"]') as HTMLButtonElement
		).click();
		expect(detail.querySelectorAll(".lead-list > .lead-head")).toHaveLength(1);
	});

	it("renders a sourceLink-only roster and keeps missing links visibly inert", () => {
		(document.querySelector('[data-tab="dag"]') as HTMLButtonElement).click();
		const linked = document.querySelector(
			'[data-role="role-linked"]',
		) as HTMLAnchorElement;
		expect(linked.matches("a.ic-link[href]")).toBe(true);
		expect(linked.getAttribute("href")).toBe(
			"https://github.com/o/r/blob/main/.flywheel/agents/engineer-executor.md",
		);
		expect(linked.getAttribute("rel")).toBe("noopener noreferrer");

		const missing = document.querySelector('[data-role="role-missing"]')!;
		expect(missing.matches("a[href]")).toBe(false);
		expect(missing.getAttribute("title")).toContain("后端没有给");
		expect(missing.textContent).toContain("sourceLink unavailable");
		for (const role of document.querySelectorAll("[data-role]")) {
			expect(role.closest(".side-box")).not.toBeNull();
		}
	});

	it("shows product and engineering templates in separate counted tabs", () => {
		(document.querySelector('[data-tab="dag"]') as HTMLButtonElement).click();
		const product = document.querySelector(
			'[data-kind="product"]',
		) as HTMLButtonElement;
		const engineering = document.querySelector(
			'[data-kind="engineering"]',
		) as HTMLButtonElement;
		expect(product.textContent).toContain("2");
		expect(engineering.textContent).toContain("2");
		expect(document.querySelectorAll("article.squad")).toHaveLength(2);
		expect(
			Array.from(document.querySelectorAll("article.squad")).map(
				(card) => (card as HTMLElement).dataset.template,
			),
		).toEqual(["generic", "generic"]);

		engineering.click();
		expect(document.querySelectorAll("article.squad")).toHaveLength(2);
		expect(
			Array.from(document.querySelectorAll("article.squad")).map(
				(card) => (card as HTMLElement).dataset.template,
			),
		).toEqual(["tpl_code", "simple_code"]);
		expect(
			document.querySelector('[data-rule="eng-node-types"]')?.textContent,
		).toContain("design / implement / qa");
	});

	it("draws explicit graph endpoints and preserves writable model controls", () => {
		(document.querySelector('[data-tab="dag"]') as HTMLButtonElement).click();
		(
			document.querySelector('[data-kind="engineering"]') as HTMLButtonElement
		).click();
		const card = document.querySelector(
			'article.squad[data-template="tpl_code"]',
		)!;
		const connections = card.querySelectorAll("[data-edge],[data-loop]");
		expect(connections).toHaveLength(6);
		expect(
			Array.from(connections).map((connection) => [
				connection.getAttribute("data-from"),
				connection.getAttribute("data-to"),
			]),
		).toEqual([
			["design", "implement"],
			["implement", "qa"],
			["qa", "founder_gate"],
			["founder_gate", "land"],
			["qa", "implement"],
			["founder_gate", "implement"],
		]);
		expect(card.textContent).not.toContain("端点读不到");
		expect(card.querySelectorAll("select[data-model-part]")).toHaveLength(9);
		expect(card.querySelectorAll(".dag-chip")).toHaveLength(5);
		expect(card.querySelector('[data-node="tpl_code/land"]')).not.toBeNull();
		expect(card.querySelectorAll(".dag-graphwrap .dag-row")).toHaveLength(0);
		expect(card.querySelectorAll(".dag-scroll .dag-row")).toHaveLength(0);
	});

	it("renders backend loop labels after every path and falls back to old-backend ids", async () => {
		(document.querySelector('[data-tab="dag"]') as HTMLButtonElement).click();
		(
			document.querySelector('[data-kind="engineering"]') as HTMLButtonElement
		).click();
		const loopTexts = () =>
			Array.from(
				document.querySelectorAll(
					'article.squad[data-template="tpl_code"] text[data-loop-label]',
				),
			).map((label) => label.textContent);
		expect(loopTexts()).toEqual(["QA 失败重来 ×3", "创始人打回重做"]);
		const card = document.querySelector(
			'article.squad[data-template="tpl_code"]',
		)!;
		const lastPath = card.querySelector("[data-loop]:last-of-type")!;
		const firstLabelBox = card.querySelector("[data-loop-label-box]")!;
		expect(
			lastPath.compareDocumentPosition(firstLabelBox) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).not.toBe(0);
		expect(card.querySelectorAll("[data-edge],[data-loop]")).toHaveLength(6);
		expect(card.textContent).not.toContain("不限次");

		const oldBackend = snapshot();
		const oldLoops = oldBackend.projects[0]!.dags[0]!.graph!.loops;
		for (const loop of oldLoops) Reflect.deleteProperty(loop, "name");
		vi.mocked(fetch).mockImplementationOnce(
			async () =>
				new Response(JSON.stringify(oldBackend), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		(document.getElementById("discard") as HTMLButtonElement).click();
		await vi.waitFor(() => {
			expect(loopTexts()).toEqual(["qa_retry ×3", "founder_rework"]);
		});
	});

	it("labels every template-bound model row with its persisted binding", () => {
		(document.querySelector('[data-tab="dag"]') as HTMLButtonElement).click();
		(
			document.querySelector('[data-kind="engineering"]') as HTMLButtonElement
		).click();
		const card = document.querySelector(
			'article.squad[data-template="tpl_code"]',
		)!;
		const rows = Array.from(card.querySelectorAll(".dag-row"));
		const tags = Array.from(
			card.querySelectorAll(".dag-row strong > .bind-tag"),
		);
		expect(rows).toHaveLength(3);
		expect(tags).toHaveLength(rows.length);

		const tagFor = (name: string) =>
			rows
				.find((row) =>
					row.querySelector("strong")?.textContent?.startsWith(name),
				)
				?.querySelector(".bind-tag")!;
		expect(tagFor("Implement").getAttribute("title")).toContain("fable");
		expect(tagFor("Implement").getAttribute("title")).not.toContain(
			"claude-fable-5-1",
		);
		expect(tagFor("Design").getAttribute("data-bind-source")).toBe(
			"tpl_code@1",
		);
		expect(tagFor("Design").getAttribute("title")).toContain("tpl_code@1 · ");
		for (const name of ["Implement", "QA"]) {
			const tag = tagFor(name);
			expect(tag.getAttribute("data-bind-source")).toBe("");
			expect(tag.getAttribute("title")).toMatch(/^模板绑定 [a-z]/);
			expect(tag.getAttribute("title")).not.toContain(" · ");
		}
	});

	it("uses a unique marker id when one template is bound twice", () => {
		(document.querySelector('[data-tab="dag"]') as HTMLButtonElement).click();
		const ids = Array.from(
			document.querySelectorAll("article.squad marker[id]"),
		).map((marker) => marker.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	it("falls back visibly when a template graph cannot be read", () => {
		(
			document.querySelector('[data-project="project-2"]') as HTMLButtonElement
		).click();
		(document.querySelector('[data-tab="dag"]') as HTMLButtonElement).click();
		expect(document.querySelector('[data-panel="dag"]')?.textContent).toContain(
			"读不到这个模板的完整形状",
		);
		expect(document.querySelector('[data-panel="dag"]')?.textContent).toContain(
			"manifest unavailable",
		);
	});

	it("renders every Flag in one list with exact current-state semantics", () => {
		(document.querySelector('[data-nav="flags"]') as HTMLButtonElement).click();
		const reading = (name: string) =>
			document.querySelector(
				`article.flag-row[data-flag="${name}"] .flag-read`,
			)!;
		const expected = {
			disables_open: "打开代表：Meaning for disables_open。",
			disables_closed: "打开代表：Meaning for disables_closed。",
			default_on_open: "打开代表：Meaning for default_on_open。",
			default_on_closed: "打开代表：Meaning for default_on_closed。",
			opt_in_open: "打开代表：Meaning for opt_in_open。",
			opt_in_closed: "打开代表：Meaning for opt_in_closed。",
			numeric: "这个设置决定：节点运行多少小时后算停留过久。",
			missing_semantics:
				"这条 flag 没有登记「打开代表什么」的人话说明，这里不猜。",
			unknown_value: "打开代表：发送系统告警。",
		};
		for (const [name, text] of Object.entries(expected)) {
			expect(reading(name).textContent).toBe(text);
		}
		expect(document.querySelectorAll("article.flag-row")).toHaveLength(9);
		expect(
			document.querySelector(".flag-group-title")?.textContent,
		).not.toMatch(/feature|kill_switch/);
		expect(reading("missing_semantics").getAttribute("data-tone")).toBe(
			"unknown",
		);
		expect(reading("unknown_value").getAttribute("data-tone")).toBe("unknown");
		expect(
			reading("unknown_value").parentElement?.querySelector(".flag-tail")
				?.textContent,
		).toBe("当前：未知；无法与默认比较（默认 关）");
		expect(
			reading("opt_in_open").matches('.flag-read[data-tone="changed"]'),
		).toBe(true);
	});

	it("updates the Flag sentence from the effective draft and stages the same target", async () => {
		(document.querySelector('[data-nav="flags"]') as HTMLButtonElement).click();
		const row = () =>
			document.querySelector('article.flag-row[data-flag="opt_in_closed"]')!;
		expect(row().querySelector(".flag-read")?.textContent).toBe(
			"打开代表：Meaning for opt_in_closed。",
		);
		expect(row().querySelector(".flag-tail")?.textContent).toBe(
			"当前：关；维持默认",
		);
		(row().querySelector(".flag-switch") as HTMLButtonElement).click();
		expect(row().querySelector(".flag-read")?.textContent).toBe(
			"打开代表：Meaning for opt_in_closed。",
		);
		expect(row().querySelector(".flag-tail")?.textContent).toBe(
			"当前：开；已偏离默认（默认 关）",
		);
		(document.getElementById("flagStage") as HTMLButtonElement).click();
		await vi.waitFor(() =>
			expect(
				requests.some((request) => request.path === "/api/fleet/changes/stage"),
			).toBe(true),
		);
		expect(
			requests.find((request) => request.path === "/api/fleet/changes/stage")
				?.body,
		).toMatchObject({
			changes: [{ targetId: "flag-opt_in_closed", desiredValue: true }],
		});
	});

	it("distinguishes known, unmapped, and missing read-only reasons and discloses overrides", () => {
		(document.querySelector('[data-nav="flags"]') as HTMLButtonElement).click();
		const lockText = (name: string) =>
			document.querySelector(`article.flag-row[data-flag="${name}"] .lock-chip`)
				?.textContent;
		expect(lockText("numeric")).toBe("登记表里锁死");
		expect(lockText("missing_semantics")).toBe("没认出这条原因");
		expect(lockText("unknown_value")).toBe("系统没有给原因");

		const pill = document.querySelector(
			'[data-ov-flag="opt_in_open"]',
		) as HTMLButtonElement;
		pill.click();
		expect(
			document.querySelector('[data-ov-body="opt_in_open"]')?.classList,
		).toContain("open");
	});

	it("searches the derived group by its own label instead of member projects", () => {
		const search = document.getElementById("projectSearch") as HTMLInputElement;
		search.value = "Infra";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		expect(document.querySelector('[data-group="infra"]')).not.toBeNull();
		expect(document.querySelector('[data-project="project-1"]')).toBeNull();

		search.value = "flywheel";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		expect(document.querySelector('[data-project="project-1"]')).not.toBeNull();
		expect(document.querySelector('[data-group="infra"]')).toBeNull();
	});

	it("keeps an all-derived project reachable with an explicit model empty state", () => {
		(
			document.querySelector('[data-project="project-2"]') as HTMLButtonElement
		).click();
		const detail = document.getElementById("detail")!;
		expect(detail.querySelector("h1")?.textContent).toBe("beta");
		expect(detail.querySelectorAll("[data-tab]")).toHaveLength(3);
		expect(detail.textContent).toContain(
			"0 个可见 Lead · 1 个 DAG · 0 个 Cron",
		);
		expect(detail.textContent).toContain("另有 1 个 Lead 归在「Infra」分组下");
		expect(detail.textContent).not.toContain("Beta Infra Lead");
	});

	it("keeps focus when a cron hour input is clicked and handles its change once", async () => {
		(document.querySelector('[data-tab="cron"]') as HTMLButtonElement).click();
		const hour = document.querySelector(
			'[data-schedule-action="hour"]',
		) as HTMLInputElement;
		hour.focus();
		hour.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(document.activeElement).toBe(hour);
		hour.value = "10";
		hour.dispatchEvent(new Event("change", { bubbles: true }));
		expect(
			(
				document.querySelector(
					'[data-schedule-action="hour"]',
				) as HTMLInputElement
			).value,
		).toBe("10");
	});

	it("renders unset model and effort as account defaults instead of fabricated choices", () => {
		const lead = document.querySelector('[data-model-target="lead-target"]')!;
		expect(
			(lead.querySelector('[data-model-part="model"]') as HTMLSelectElement)
				.value,
		).toBe("");
		expect(
			(lead.querySelector('[data-model-part="effort"]') as HTMLSelectElement)
				.value,
		).toBe("");

		const runner = document.querySelector(
			'[data-model-target="runner-target"]',
		)!;
		expect(
			(
				runner.querySelector(
					'[data-model-part="provider"]',
				) as HTMLSelectElement
			).value,
		).toBe("");
	});

	it("changing a model preserves account-default effort instead of pinning low", async () => {
		const lead = document.querySelector('[data-model-target="lead-target"]')!;
		const model = lead.querySelector(
			'[data-model-part="model"]',
		) as HTMLSelectElement;
		model.value = "claude-opus-4-8";
		model.dispatchEvent(new Event("change", { bubbles: true }));
		(document.getElementById("stage") as HTMLButtonElement).click();
		await vi.waitFor(() => {
			expect(
				requests.some((request) => request.path === "/api/fleet/changes/stage"),
			).toBe(true);
		});
		await vi.waitFor(() => {
			expect(
				document.getElementById("overlay")?.classList.contains("open"),
			).toBe(true);
		});
		const stage = requests.find(
			(request) => request.path === "/api/fleet/changes/stage",
		)!;
		expect(stage.body).toMatchObject({
			changes: [
				{
					targetId: "lead-target",
					desiredValue: {
						model: "claude-opus-4-8",
						effort: null,
					},
				},
			],
		});
	});

	it("applies a model change when a Lead already has a concrete model", async () => {
		(
			document.querySelector('[data-group="infra"]') as HTMLButtonElement
		).click();
		const model = document.querySelector(
			'[data-model-target="lead-infra-target"] [data-model-part="model"]',
		) as HTMLSelectElement;
		model.value = "claude-fable-5";
		model.dispatchEvent(new Event("change", { bubbles: true }));
		(document.getElementById("stage") as HTMLButtonElement).click();

		await vi.waitFor(() =>
			expect(
				requests.some((request) => request.path === "/api/fleet/changes/stage"),
			).toBe(true),
		);
		const stage = requests.find(
			(request) => request.path === "/api/fleet/changes/stage",
		)!;
		expect(stage.body).toMatchObject({
			changes: [
				{
					targetId: "lead-infra-target",
					desiredValue: {
						provider: "anthropic",
						model: "claude-fable-5",
						effort: null,
					},
				},
			],
		});
	});

	it("applies a model change when a Cron already has a concrete model", async () => {
		(document.querySelector('[data-tab="cron"]') as HTMLButtonElement).click();
		const model = document.querySelector(
			'[data-model-target="cron-model-target"] [data-model-part="model"]',
		) as HTMLSelectElement;
		model.value = "claude-opus-4-8";
		model.dispatchEvent(new Event("change", { bubbles: true }));
		(document.getElementById("stage") as HTMLButtonElement).click();

		await vi.waitFor(() =>
			expect(
				requests.some((request) => request.path === "/api/fleet/changes/stage"),
			).toBe(true),
		);
		const stage = requests.find(
			(request) => request.path === "/api/fleet/changes/stage",
		)!;
		expect(stage.body).toMatchObject({
			changes: [
				{
					targetId: "cron-model-target",
					desiredValue: {
						provider: "anthropic",
						model: "claude-opus-4-8",
						effort: null,
					},
				},
			],
		});
	});

	it("does not advertise nullable provider/model choices to concrete-only DAG and cron writers", () => {
		(document.querySelector('[data-tab="dag"]') as HTMLButtonElement).click();
		(
			document.querySelector('[data-kind="engineering"]') as HTMLButtonElement
		).click();
		for (const targetId of ["dag-target", "cron-model-target"]) {
			const holder = document.querySelector(
				`[data-model-target="${targetId}"]`,
			)!;
			for (const part of ["provider", "model"]) {
				const select = holder.querySelector(
					`[data-model-part="${part}"]`,
				) as HTMLSelectElement;
				expect([...select.options].map((option) => option.value)).not.toContain(
					"",
				);
			}
		}

		const cronEffort = document.querySelector(
			'[data-model-target="cron-model-target"] [data-model-part="effort"]',
		) as HTMLSelectElement;
		expect([...cronEffort.options].map((option) => option.value)).toEqual([""]);
	});

	it("renders a persisted workflow alias through its shape option and preserves it on effort edits", async () => {
		(document.querySelector('[data-tab="dag"]') as HTMLButtonElement).click();
		(
			document.querySelector('[data-kind="engineering"]') as HTMLButtonElement
		).click();
		const holder = document.querySelector('[data-model-target="dag-target"]')!;
		const model = holder.querySelector(
			'[data-model-part="model"]',
		) as HTMLSelectElement;
		expect(model.value).toBe("fable");
		expect(
			[...model.options].map((option) => option.textContent),
		).not.toContain("已退役 · fable");

		const effort = holder.querySelector(
			'[data-model-part="effort"]',
		) as HTMLSelectElement;
		effort.value = "high";
		effort.dispatchEvent(new Event("change", { bubbles: true }));
		(document.getElementById("stage") as HTMLButtonElement).click();
		await vi.waitFor(() =>
			expect(
				requests.some((request) => request.path === "/api/fleet/changes/stage"),
			).toBe(true),
		);
		const stage = requests.find(
			(request) => request.path === "/api/fleet/changes/stage",
		)!;
		expect(stage.body).toMatchObject({
			changes: [
				{
					targetId: "dag-target",
					desiredValue: { model: "fable", effort: "high" },
				},
			],
		});
	});

	it("derives DAG provider changes and default effort from the node policy", async () => {
		(document.querySelector('[data-tab="dag"]') as HTMLButtonElement).click();
		(
			document.querySelector('[data-kind="engineering"]') as HTMLButtonElement
		).click();
		const provider = document.querySelector(
			'[data-model-target="dag-target"] [data-model-part="provider"]',
		) as HTMLSelectElement;
		expect([...provider.options].map((option) => option.value)).toEqual([
			"anthropic",
			"openai",
		]);

		provider.value = "openai";
		provider.dispatchEvent(new Event("change", { bubbles: true }));
		(document.getElementById("stage") as HTMLButtonElement).click();
		await vi.waitFor(() =>
			expect(
				requests.some((request) => request.path === "/api/fleet/changes/stage"),
			).toBe(true),
		);
		const stage = requests.find(
			(request) => request.path === "/api/fleet/changes/stage",
		)!;
		expect(stage.body).toMatchObject({
			changes: [
				{
					targetId: "dag-target",
					desiredValue: {
						provider: "openai",
						model: "codex",
						effort: "xhigh",
					},
				},
			],
		});
	});

	it("keeps one cron time and adds a distinct row when 09:00 already exists", () => {
		(document.querySelector('[data-tab="cron"]') as HTMLButtonElement).click();
		const onlyRemove = document.querySelector(
			'[data-schedule-action="remove"]',
		) as HTMLButtonElement;
		expect(onlyRemove.disabled).toBe(true);

		(
			document.querySelector(
				'[data-schedule-action="add"]',
			) as HTMLButtonElement
		).click();
		const hours = [
			...document.querySelectorAll<HTMLInputElement>(
				'[data-schedule-action="hour"]',
			),
		].map((input) => input.value);
		expect(hours).toEqual(["09", "17"]);
	});

	it("renders extension targets once under an explicit global entry", () => {
		expect(document.querySelector('[data-tab="extension-runtime"]')).toBeNull();
		expect(document.querySelector("[data-extension-target]")).toBeNull();

		(
			document.querySelector(
				'[data-project="__extensions__"]',
			) as HTMLButtonElement
		).click();
		expect(document.getElementById("detail")?.textContent).toContain(
			"全局运行参数",
		);
		expect(
			document.querySelector('[data-extension-target="extension-target"]'),
		).not.toBeNull();
	});

	it("requires a fresh acknowledgement after canonical values drift", async () => {
		stageResponses.push(
			{
				batch: {
					changes: [
						{
							targetId: "enabled-target",
							oldValue: true,
							newValue: false,
							consequence: "reload-launchd",
						},
					],
					noOps: [],
					acknowledgementRequired: true,
				},
				confirmationRequired: true,
			},
			{
				batch: {
					changes: [
						{
							targetId: "enabled-target",
							oldValue: false,
							newValue: true,
							consequence: "reload-launchd",
						},
					],
					noOps: [],
					acknowledgementRequired: true,
				},
				confirmToken: "drifted-token",
			},
		);

		(document.querySelector('[data-tab="cron"]') as HTMLButtonElement).click();
		(
			document.querySelector(
				'[data-toggle-target="enabled-target"]',
			) as HTMLButtonElement
		).click();
		(document.getElementById("stage") as HTMLButtonElement).click();
		await vi.waitFor(() =>
			expect(document.getElementById("ack")).not.toBeNull(),
		);
		(document.getElementById("ack") as HTMLInputElement).checked = true;
		(document.getElementById("modalConfirm") as HTMLButtonElement).click();

		await vi.waitFor(() => {
			expect(document.getElementById("modal")?.textContent).toContain(
				"真源在确认期间发生变化",
			);
		});
		expect(document.getElementById("ack")).not.toBeNull();
		expect(document.getElementById("modalConfirm")?.textContent).toContain(
			"重新预检",
		);
	});
});

describe.each([1, 3])("management console schema mismatch v%i", (version) => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({ ...snapshot(), schemaVersion: version }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
			),
		);
		const html = getFleetConsoleHtml();
		const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
		document.open();
		document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
		document.close();
		Function(script)();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.documentElement.innerHTML = "";
	});

	it("asks for a refresh and renders no project controls", async () => {
		await vi.waitFor(() => {
			expect(document.getElementById("detail")?.textContent).toContain(
				"管理台已更新,请刷新页面",
			);
		});
		expect(document.querySelector("[data-project]")).toBeNull();
	});
});
