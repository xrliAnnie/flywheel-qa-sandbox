import { readFileSync } from "node:fs";
import http from "node:http";
import { getFleetConsoleHtml } from "../../../../packages/teamlead/dist/bridge/fleet-console-html.js";

const prototypeHtml = readFileSync(
	new URL(
		"../../../../product/doc/FLY-1038-unified-management-dashboard/prototype/dashboard.html",
		import.meta.url,
	),
	"utf8",
);
const productionHtml = getFleetConsoleHtml();
const port = Number(process.env.FLY2054_EVIDENCE_PORT || 18854);

function managed(targetId, current, consequence = "new-run") {
	return {
		targetId,
		current,
		source: { kind: "project_config", revision: `fixture:${targetId}` },
		writeCapability: {
			writable: true,
			consequence,
			requiresAcknowledgement: false,
		},
	};
}

function catalog(surface) {
	return {
		version: 1,
		surface,
		providers: [
			{
				id: "anthropic",
				label: "Anthropic",
				models: [
					{
						id: "claude-opus-5-1m",
						label: "Opus 5 (1M)",
						runtimeVendor: "claude",
						efforts:
							surface === "cron"
								? []
								: ["low", "medium", "high", "xhigh"],
					},
				],
			},
		],
	};
}

function snapshot(missingModel) {
	const workflowDag = {
		id: "dag-engineer",
		templateId: "tpl_eng_heavy_land_v1",
		title: "engineer-executor",
		revision: 1,
		nodes: ["design", "implement", "qa"].map((name) => ({
			id: name,
			name,
			dispatch: managed(`dag-${name}`, {
				provider: "anthropic",
				model: "claude-opus-5-1m",
				effort: name === "implement" ? "high" : null,
			}),
		})),
	};
	if (missingModel) {
		workflowDag.error = "workflow node orphan-agent has no model binding";
	}
	return {
		schemaVersion: 1,
		snapshotRevision: "fixture:fly2054",
		generatedAt: "2026-08-25T22:00:00.000Z",
		sources: [
			{ id: "fixture", kind: "test_fixture", revision: "fixture:1", ok: true },
		],
		presentationGroups: [
			{
				id: "flywheel",
				label: "flywheel",
				projectIds: ["project-flywheel"],
				leadIds: ["lead-product"],
				derived: false,
			},
			{
				id: "infra",
				label: "Infra",
				projectIds: ["project-flywheel"],
				leadIds: ["lead-infra-claude", "lead-infra-codex"],
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
				id: "project-flywheel",
				name: "flywheel",
				presentationGroup: "flywheel",
				sourceRevision: "file:e98f58f0123456789abcdef",
				leads: [
					{
						id: "lead-product",
						displayName: "flywheel-product-lead",
						department: "product",
						backend: "claude-code",
						online: "online",
						dispatch: managed(
							"lead-product-dispatch",
							{
								provider: "anthropic",
								model: "claude-opus-5-1m",
								effort: null,
							},
							"restart-lead",
						),
					},
					...[
						["lead-infra-claude", "claude-infra-bot-lead"],
						["lead-infra-codex", "codex-infra-bot-lead"],
					].map(([id, displayName], index) => ({
						id,
						displayName,
						department: "infra",
						backend: "claude-code",
						online: index ? "degraded" : "online",
						dispatch: managed(
							`${id}-dispatch`,
							{
								provider: "anthropic",
								model: "claude-opus-5-1m",
								effort: "high",
							},
							"restart-lead",
						),
					})),
				],
				roles: [
					{
						id: "role-engineer",
						name: "engineer-executor",
						department: "engineering",
						agentFile: ".flywheel/agents/engineering/engineer-executor.md",
						sourceLink:
							"https://github.com/xrliAnnie/flywheel/blob/main/.flywheel/agents/engineering/engineer-executor.md",
					},
				],
				dags: [workflowDag],
				crons: [
					{
						id: "cron-daily",
						label: "daily-standup",
						projectName: "flywheel",
						sourceHint: "com.flywheel.daily-standup.plist",
						schedule: managed(
							"cron-daily-schedule",
							{
								days: [1, 2, 3, 4, 5, 6, 7],
								times: [{ hour: 3, minute: 0 }],
								label: "每日",
							},
							"reload-launchd",
						),
						enabled: managed(
							"cron-daily-enabled",
							true,
							"reload-launchd",
						),
						loaded: true,
						model: managed(
							"cron-daily-model",
							{
								provider: "anthropic",
								model: "claude-opus-5-1m",
								effort: null,
							},
							"reload-launchd",
						),
						warnings: [],
					},
				],
				runnerDefault: {
					dispatch: managed("runner-default", {
						provider: "anthropic",
						model: "claude-opus-5-1m",
						effort: null,
					}),
				},
			},
		],
		unassignedCrons: [],
		flags: [
			{
				id: "flag-auto-qa",
				name: "qa.auto",
				category: "工作流",
				description: "code-review 后自动启动独立 QA runner",
				global: managed("flag-auto-qa-global", true),
				projectOverrides: [
					{
						projectName: "flywheel",
						value: managed("flag-auto-qa-flywheel", true),
					},
				],
			},
			{
				id: "flag-doc-flow",
				name: "doc_flow.enabled",
				category: "工作流",
				description: "启用部门优先过程文档",
				global: managed("flag-doc-flow-global", false),
				projectOverrides: [],
			},
		],
		extensions: [],
	};
}

http
	.createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
		if (url.pathname === "/prototype") {
			response.setHeader("content-type", "text/html; charset=utf-8");
			response.end(prototypeHtml);
			return;
		}
		if (
			url.pathname === "/production" ||
			url.pathname === "/production-missing"
		) {
			response.setHeader("content-type", "text/html; charset=utf-8");
			response.end(productionHtml);
			return;
		}
		if (url.pathname === "/api/fleet/snapshot") {
			const missingModel = String(request.headers.referer ?? "").includes(
				"production-missing",
			);
			response.setHeader("content-type", "application/json; charset=utf-8");
			response.end(JSON.stringify(snapshot(missingModel)));
			return;
		}
		if (url.pathname === "/favicon.ico") {
			response.statusCode = 204;
			response.end();
			return;
		}
		response.statusCode = 404;
		response.end("not found");
	})
	.listen(port, "127.0.0.1", () => {
		console.log(`FLY-2054 evidence server http://127.0.0.1:${port}`);
	});
