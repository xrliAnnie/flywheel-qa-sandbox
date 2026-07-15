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
						efforts: ["low", "medium", "high", "xhigh"],
					},
					{
						id: "claude-opus-4-8",
						label: "Opus 4.8",
						runtimeVendor: "claude",
						efforts: ["low", "medium", "high", "xhigh"],
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
				dags: [],
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
						warnings: [],
					},
				],
				runnerDefault: { dispatch: managed("runner-target", null) },
			},
		],
		unassignedCrons: [],
		flags: [],
		extensions: [],
	};
}

describe("management console browser interactions", () => {
	let requests: Array<{ path: string; body?: unknown }>;

	beforeEach(async () => {
		requests = [];
		const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
			requests.push({
				path,
				body: options?.body ? JSON.parse(String(options.body)) : undefined,
			});
			const body =
				path === "/api/fleet/snapshot"
					? snapshot()
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
});
