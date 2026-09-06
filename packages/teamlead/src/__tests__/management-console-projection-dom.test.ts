import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAllFlags } from "flywheel-config";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { getFleetConsoleHtml } from "../bridge/fleet-console-html.js";
import { readManagementDags } from "../bridge/management-dag-source.js";
import { createManagementFlagProvider } from "../bridge/management-existing-writers.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowMenuPolicyCatalog } from "../workflow-menu-policy.js";

const scratch: string[] = [];

function snapshot(dag: unknown) {
	const emptyCatalog = { version: 1, surface: "workflow", providers: [] };
	const globalWorkflowCatalog = {
		version: 1,
		surface: "workflow",
		providers: [
			{
				id: "anthropic",
				label: "Anthropic",
				models: [
					{
						id: "claude-fable-5-1",
						label: "Fable 5.1",
						runtimeVendor: "claude",
						efforts: ["low", "medium", "high", "xhigh", "max"],
						selectable: true,
					},
				],
			},
		],
	};
	return {
		schemaVersion: 2,
		snapshotRevision: "projection-dom:1",
		generatedAt: "2026-09-03T00:00:00.000Z",
		sources: [],
		presentationGroups: [
			{
				id: "flywheel",
				label: "flywheel",
				projectIds: ["flywheel"],
				leadIds: [],
				derived: false,
			},
		],
		modelCatalog: {
			lead: { ...emptyCatalog, surface: "lead" },
			runner: { ...emptyCatalog, surface: "runner" },
			workflow: globalWorkflowCatalog,
			cron: { ...emptyCatalog, surface: "cron" },
		},
		projects: [
			{
				id: "flywheel",
				name: "flywheel",
				presentationGroup: "flywheel",
				sourceRevision: "projection-dom:1",
				leads: [],
				roles: [],
				dags: [dag],
				crons: [],
				runnerDefault: null,
			},
		],
		unassignedCrons: [],
		flags: [],
		extensions: [],
	};
}

describe("management DAG source-to-DOM contract", () => {
	let window: Window | undefined;

	afterEach(() => {
		window?.close();
		window = undefined;
		while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true });
	});

	it("renders projected manifest endpoints and responds to graph DTO mutations", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const { importWorkflowMenuSeeds } = await import("../workflow-menu.js");
			importWorkflowMenuSeeds(store);
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "code",
				templateId: "tpl_code",
				updatedBy: "test",
			});
			const projected = readManagementDags({
				reader: store,
				projectNames: ["flywheel"],
			}).projectDags[0]!.dags[0]!;
			let current = projected;
			const requests: Array<{ path: string; body?: unknown }> = [];
			window = new Window({ url: "http://127.0.0.1/" });
			window.fetch = vi.fn(async (path: string, options?: RequestInit) => {
				requests.push({
					path,
					body: options?.body ? JSON.parse(String(options.body)) : undefined,
				});
				return new window!.Response(JSON.stringify(snapshot(current)), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const html = getFleetConsoleHtml();
			const scriptStart = html.indexOf("<script>") + "<script>".length;
			const scriptEnd = html.indexOf("</script>", scriptStart);
			const script = html.slice(scriptStart, scriptEnd);
			const markup =
				html.slice(0, html.indexOf("<script>")) +
				html.slice(scriptEnd + "</script>".length);
			window.document.write(markup);
			window.eval(script);
			await vi.waitFor(() =>
				expect(
					window!.document.querySelector('[data-tab="dag"]'),
				).not.toBeNull(),
			);
			(
				window.document.querySelector('[data-tab="dag"]') as HTMLElement
			).click();
			(
				window.document.querySelector(
					'[data-kind="engineering"]',
				) as HTMLElement
			).click();
			const graph = () =>
				window!.document.querySelector(
					'article.squad[data-template="tpl_code"]',
				)!;
			expect(graph().querySelectorAll("[data-edge],[data-loop]")).toHaveLength(
				6,
			);
			expect(graph().textContent).not.toContain("端点读不到");
			const qaRow = () =>
				[...graph().querySelectorAll(".dag-row")].find((row) =>
					row.querySelector("strong")?.textContent?.includes("QA"),
				)!;
			const implementRow = () =>
				[...graph().querySelectorAll(".dag-row")].find((row) =>
					row.querySelector("strong")?.textContent?.includes("实现"),
				)!;
			const optionValues = (part: string) =>
				[
					...(
						qaRow().querySelector(
							`[data-model-part="${part}"]`,
						) as HTMLSelectElement
					).options,
				].map((option) => option.value);
			expect(optionValues("provider")).toEqual(["anthropic"]);
			expect(optionValues("model")).toEqual(["opus"]);
			expect(optionValues("effort")).toEqual(["low", "medium", "high", "max"]);
			expect(qaRow().textContent).toContain(
				".flywheel/agents/registry.yaml#graphs.code.policies.qa",
			);

			let implementProvider = implementRow().querySelector(
				'[data-model-part="provider"]',
			) as HTMLSelectElement;
			expect(implementProvider.value).toBe("openai");
			implementProvider.value = "anthropic";
			implementProvider.dispatchEvent(
				new window.Event("change", { bubbles: true }),
			);
			implementProvider = implementRow().querySelector(
				'[data-model-part="provider"]',
			) as HTMLSelectElement;
			implementProvider.value = "openai";
			implementProvider.dispatchEvent(
				new window.Event("change", { bubbles: true }),
			);
			(window.document.getElementById("stage") as HTMLElement).click();
			expect(
				requests.filter(
					(request) => request.path === "/api/fleet/changes/stage",
				),
			).toEqual([]);

			const currentModel = qaRow().querySelector(
				'[data-model-part="model"]',
			) as HTMLSelectElement;
			currentModel.dispatchEvent(new window.Event("change", { bubbles: true }));
			(window.document.getElementById("stage") as HTMLElement).click();
			expect(
				requests.filter(
					(request) => request.path === "/api/fleet/changes/stage",
				),
			).toEqual([]);

			current = structuredClone(projected);
			current.nodes.find(
				(node) => node.nodeId === "qa",
			)!.dispatch.current.effort = "xhigh";
			(window.document.getElementById("discard") as HTMLElement).click();
			await vi.waitFor(() => {
				const effort = qaRow().querySelector(
					'[data-model-part="effort"]',
				) as HTMLSelectElement;
				expect(effort.value).toBe("xhigh");
				expect(effort.selectedOptions[0]?.disabled).toBe(true);
				expect(effort.selectedOptions[0]?.textContent).toContain(
					"当前值不在 shape 白名单",
				);
				expect(
					[...effort.options]
						.filter((option) => !option.disabled)
						.map((option) => option.value),
				).toEqual(["low", "medium", "high", "max"]);
			});

			current = structuredClone(projected);
			current.nodes.find(
				(node) => node.nodeId === "qa",
			)!.dispatch.current.effort = null;
			(window.document.getElementById("discard") as HTMLElement).click();
			await vi.waitFor(() => {
				const effort = qaRow().querySelector(
					'[data-model-part="effort"]',
				) as HTMLSelectElement;
				expect(effort.value).toBe("__policy_unset_effort__");
				expect(effort.selectedOptions[0]?.disabled).toBe(true);
				expect(effort.selectedOptions[0]?.textContent).toContain("未设置");
			});

			current = structuredClone(projected);
			const driftedQa = current.nodes.find((node) => node.nodeId === "qa")!;
			driftedQa.dispatch.current = {
				provider: "openai",
				model: "gpt-5.6-sol",
				effort: "high",
			};
			driftedQa.dispatch.canonicalModel = "gpt-5.6-sol";
			(window.document.getElementById("discard") as HTMLElement).click();
			await vi.waitFor(() => {
				const provider = qaRow().querySelector(
					'[data-model-part="provider"]',
				) as HTMLSelectElement;
				const model = qaRow().querySelector(
					'[data-model-part="model"]',
				) as HTMLSelectElement;
				expect(provider.value).toBe("openai");
				expect(provider.selectedOptions[0]?.disabled).toBe(true);
				expect(
					[...provider.options]
						.filter((option) => !option.disabled)
						.map((option) => option.value),
				).toEqual(["anthropic"]);
				expect(model.value).toBe("gpt-5.6-sol");
				expect(model.selectedOptions[0]?.disabled).toBe(true);
				expect(model.selectedOptions[0]?.textContent).toContain(
					"当前值不在 shape 白名单",
				);
			});

			current = structuredClone(projected);
			current.graph!.edges = current.graph!.edges.slice(1);
			(window.document.getElementById("discard") as HTMLElement).click();
			await vi.waitFor(() =>
				expect(
					graph().querySelectorAll("[data-edge],[data-loop]"),
				).toHaveLength(5),
			);

			current = structuredClone(projected);
			current.graph!.edges[0]!.to = "missing_node";
			(window.document.getElementById("discard") as HTMLElement).click();
			await vi.waitFor(() => {
				expect(
					graph().querySelectorAll("[data-edge],[data-loop]"),
				).toHaveLength(5);
				expect(graph().textContent).toContain("有 1 条连线端点读不到");
			});
		} finally {
			store.close();
		}
	});

	it("keeps DOM options exactly equal to the GET projection after one shape-line change", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2366-endpoint-dom-"));
		scratch.push(root);
		const registryPath = join(root, "registry.yaml");
		const bundled = readFileSync(
			new URL("../../../../.flywheel/agents/registry.yaml", import.meta.url),
			"utf8",
		);
		writeFileSync(
			registryPath,
			bundled.replace(
				"allowedEfforts: [low, medium, high, max]\n            defaultEffort: high",
				"allowedEfforts: [low, medium, max]\n            defaultEffort: medium",
			),
		);
		const endpointPolicy = buildWorkflowMenuPolicyCatalog({ registryPath })
			.taskCategories.find((category) => category.taskCategory === "code")
			?.nodes.find((node) => node.nodeId === "qa")!;
		const store = await StateStore.create(":memory:");
		try {
			const { importWorkflowMenuSeeds } = await import("../workflow-menu.js");
			importWorkflowMenuSeeds(store);
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "code",
				templateId: "tpl_code",
				updatedBy: "system:menu-binding-reconcile",
			});
			let currentDag = readManagementDags({
				reader: store,
				projectNames: ["flywheel"],
				registryPath,
			}).projectDags[0]!.dags[0]!;
			window = new Window({ url: "http://127.0.0.1/" });
			window.fetch = vi.fn(
				async () =>
					new window!.Response(JSON.stringify(snapshot(currentDag)), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);
			const html = getFleetConsoleHtml();
			const scriptStart = html.indexOf("<script>") + "<script>".length;
			const scriptEnd = html.indexOf("</script>", scriptStart);
			window.document.write(
				html.slice(0, html.indexOf("<script>")) +
					html.slice(scriptEnd + "</script>".length),
			);
			window.eval(html.slice(scriptStart, scriptEnd));
			await vi.waitFor(() =>
				expect(
					window!.document.querySelector('[data-tab="dag"]'),
				).not.toBeNull(),
			);
			(
				window.document.querySelector('[data-tab="dag"]') as HTMLElement
			).click();
			(
				window.document.querySelector(
					'[data-kind="engineering"]',
				) as HTMLElement
			).click();
			const qaRow = [...window.document.querySelectorAll(".dag-row")].find(
				(row) => row.querySelector("strong")?.textContent?.includes("QA"),
			)!;
			const values = (part: string) =>
				[
					...(
						qaRow.querySelector(
							`[data-model-part="${part}"]`,
						) as HTMLSelectElement
					).options,
				]
					.filter((option) => !option.disabled)
					.map((option) => option.value);

			expect(values("provider")).toEqual([
				...new Set(endpointPolicy.models.map((model) => model.provider)),
			]);
			expect(values("model")).toEqual(
				endpointPolicy.models.map((model) => model.alias),
			);
			expect(values("effort")).toEqual(
				endpointPolicy.models[0]!.allowedEfforts,
			);

			const removed = parse(bundled) as { graphs: Record<string, unknown> };
			delete removed.graphs.code;
			writeFileSync(registryPath, stringify(removed));
			currentDag = readManagementDags({
				reader: store,
				projectNames: ["flywheel"],
				registryPath,
			}).projectDags[0]!.dags[0]!;
			(window.document.getElementById("discard") as HTMLElement).click();
			await vi.waitFor(() => {
				const card = window!.document.querySelector(
					'article.squad[data-template="tpl_code"]',
				)!;
				const unavailableQa = [...card.querySelectorAll(".dag-row")].find(
					(row) => row.querySelector("strong")?.textContent?.includes("QA"),
				)!;
				expect(card.querySelector("select[data-model-part]")).toBeNull();
				expect(card.textContent).toContain("policy_shape_removed");
				expect(card.textContent).not.toContain("Fable 5.1");
				expect(unavailableQa.textContent).toContain(
					"当前值：anthropic / claude-opus-5 / high",
				);
			});
		} finally {
			store.close();
		}
	});

	it("counts only explicit project rows from the real flag provider as overrides", async () => {
		const resolved = resolveAllFlags({ env: {} });
		const docFlow = resolved.find((flag) => flag.name === "doc_flow");
		const loopProfiler = resolved.find((flag) => flag.name === "loop_profiler");
		if (!docFlow || !loopProfiler) throw new Error("missing flag fixtures");
		const provider = createManagementFlagProvider({
			views: () => [
				{
					...docFlow,
					projectStoreManaged: true,
					effectiveByProject: [
						{
							projectName: "alpha",
							value: true,
							isDefault: false,
							via: "project_row",
						},
						{
							projectName: "beta",
							value: false,
							isDefault: true,
							via: "default",
						},
						{
							projectName: "gamma",
							value: true,
							isDefault: false,
							via: "star_row",
						},
					],
				},
				loopProfiler,
			],
			revision: () => "registry:provider-dom",
			projectNames: () => ["alpha", "beta", "gamma"],
		});
		const flags = provider.read().fragment.flags ?? [];
		const base = snapshot({});
		const payload = {
			...base,
			projects: base.projects.map((project) => ({ ...project, dags: [] })),
			flags,
		};

		window = new Window({ url: "http://127.0.0.1/" });
		window.fetch = vi.fn(
			async () =>
				new window!.Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const html = getFleetConsoleHtml();
		const scriptStart = html.indexOf("<script>") + "<script>".length;
		const scriptEnd = html.indexOf("</script>", scriptStart);
		const script = html.slice(scriptStart, scriptEnd);
		window.document.write(
			html.slice(0, html.indexOf("<script>")) +
				html.slice(scriptEnd + "</script>".length),
		);
		window.eval(script);
		await vi.waitFor(() =>
			expect(
				window!.document.querySelector(
					'article.flag-row[data-flag="doc_flow"]',
				),
			).not.toBeNull(),
		);
		(
			window.document.querySelector('[data-nav="flags"]') as HTMLElement
		).click();

		const pill = window.document.querySelector(
			'[data-ov-flag="doc_flow"]',
		) as HTMLElement;
		expect(pill.textContent).toBe("1 个项目覆盖");
		expect(
			window.document.querySelector('[data-ov-flag="loop_profiler"]'),
		).toBeNull();
		pill.click();
		const body = window.document.querySelector('[data-ov-body="doc_flow"]')!;
		expect(body.textContent).toContain("alpha");
		expect(body.textContent).not.toContain("beta");
		expect(body.textContent).not.toContain("gamma");
	});
});
