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
						id: "claude-fable-5",
						label: "Fable 5",
						runtimeVendor: "claude",
						efforts,
					},
					{
						id: "claude-opus-4-8",
						label: "Opus 4.8",
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
		schemaVersion: 1,
		snapshotRevision: "snapshot:1",
		generatedAt: "2026-07-15T00:00:00.000Z",
		sources: [],
		presentationGroups: [
			{
				id: "group",
				label: "Projects",
				projectIds: ["project-1"],
				leadIds: [],
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
				name: "alpha",
				presentationGroup: "Projects",
				sourceRevision: "project:1",
				leads: [
					{
						id: "lead-1",
						displayName: "Alpha Lead",
						backend: "claude-code",
						online: "online",
						dispatch: managed("lead-target", null, "restart-lead"),
					},
				],
				roles: [],
				dags: [
					{
						id: "dag-1",
						templateId: "default",
						title: "Default workflow",
						revision: 1,
						nodes: [
							{
								id: "implement",
								name: "Implement",
								dispatch: managed("dag-target", {
									provider: "anthropic",
									model: "claude-fable-5",
									effort: null,
								}),
							},
						],
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
		],
		unassignedCrons: [],
		flags: [],
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

	it("does not advertise nullable provider/model choices to concrete-only DAG and cron writers", () => {
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
