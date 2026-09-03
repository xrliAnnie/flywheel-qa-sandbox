import { resolveAllFlags } from "flywheel-config";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFleetConsoleHtml } from "../bridge/fleet-console-html.js";
import { readManagementDags } from "../bridge/management-dag-source.js";
import { createManagementFlagProvider } from "../bridge/management-existing-writers.js";
import { StateStore } from "../StateStore.js";

function snapshot(dag: unknown) {
	const emptyCatalog = { version: 1, surface: "workflow", providers: [] };
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
			workflow: emptyCatalog,
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
			window = new Window({ url: "http://127.0.0.1/" });
			window.fetch = vi.fn(
				async () =>
					new window!.Response(JSON.stringify(snapshot(current)), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);
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
