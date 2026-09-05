import { createHash } from "node:crypto";
import http from "node:http";
import { getFleetConsoleHtml } from "../../../../packages/teamlead/dist/bridge/fleet-console-html.js";

const FIXTURE_ID = "fly2364-v1";
const port = Number(process.env.FLY2364_EVIDENCE_PORT || 18864);
const linkedRole =
	"https://github.com/xrliAnnie/flywheel/blob/main/.flywheel/agents/engineering/engineer-executor.md";

function managed(targetId, current, options = {}) {
	const { writable = true, reason = "", hint = "" } = options;
	return {
		targetId,
		current,
		source: {
			kind: "test_fixture",
			location: "memory",
			revision: `fixture:${targetId}`,
			...(hint ? { hint } : {}),
		},
		writeCapability: {
			writable,
			consequence: "new-run",
			requiresAcknowledgement: false,
			...(reason ? { reason } : {}),
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
						id: "claude-fable-5-1",
						label: "Fable 5.1",
						runtimeVendor: "claude",
						efforts: surface === "cron" ? [] : ["low", "medium", "high", "xhigh"],
					},
					{
						id: "claude-opus-5-1m",
						label: "Opus 5 (1M)",
						runtimeVendor: "claude",
						efforts: surface === "cron" ? [] : ["low", "medium", "high", "xhigh"],
					},
				],
			},
		],
	};
}

function graphNode(id, name, type, execution = "agent") {
	return { id, name, type, execution };
}

function edgeList(nodes) {
	return nodes.slice(1).map((node, index) => ({
		id: `${nodes[index].id}_to_${node.id}`,
		from: nodes[index].id,
		to: node.id,
	}));
}

function dispatchNode(templateId, node, revision = 1) {
	return {
		id: `${templateId}/${node.id}`,
		nodeId: node.id,
		name: node.name,
		dispatch: {
			...managed(
				`workflow/${templateId}/${node.id}`,
				{ provider: "anthropic", model: "fable", effort: "high" },
				{ hint: `${templateId}@${revision}` },
			),
			canonicalModel: "claude-fable-5-1",
		},
	};
}

function dag(templateId, title, nodes, loops = []) {
	const revision = 1;
	return {
		id: `dag/${templateId}`,
		templateId,
		title,
		revision,
		digest: `fixture:${templateId}`,
		seedOwner: "system",
		graph: { nodes, edges: edgeList(nodes), loops },
		nodes: nodes
			.filter((node) => node.execution === "agent")
			.map((node) => dispatchNode(templateId, node, revision)),
	};
}

function lead(id, displayName, department) {
	return {
		id,
		displayName,
		department,
		backend: "codex-tmux",
		online: "online",
		dispatch: {
			...managed(`lead/${id}`, {
				provider: "anthropic",
				model: "claude-opus-5-1m",
				effort: "high",
			}),
			canonicalModel: "claude-opus-5-1m",
		},
	};
}

function flag(name, { writable = false, reason = "", override = false } = {}) {
	return {
		id: `flag/${name}`,
		name,
		description: `${name} 的 fixture 说明`,
		polarity: "opt_in",
		default: false,
		valueKind: "bool",
		onMeans: "enables",
		global: managed(`flag/${name}/global`, false, { writable, reason }),
		projectOverrides: override
			? [
					{
						projectId: "project/flywheel",
						projectName: "flywheel",
						via: "project_row",
						value: managed(`flag/${name}/project/flywheel`, true, {
							writable: false,
							reason: "read-only project override",
						}),
					},
				]
			: [],
	};
}

function emptyProject(name) {
	return {
		id: `project/${name}`,
		name,
		presentationGroup: name,
		sourceRevision: `fixture:${name}`,
		leads: [],
		roles: [],
		dags: [],
		crons: [],
		runnerDefault: null,
	};
}

function snapshot() {
	const codeNodes = [
		graphNode("design", "设计(工程)", "design"),
		graphNode("implement", "实现", "implement"),
		graphNode("qa", "QA 验证", "qa"),
		graphNode("founder_gate", "创始人门", "gate", "gate"),
		graphNode("land", "合入", "land", "engine"),
	];
	const simpleNodes = [
		graphNode("implement", "实现", "implement"),
		graphNode("qa", "QA 验证", "qa"),
		graphNode("founder_gate", "创始人门", "gate", "gate"),
		graphNode("land", "合入", "land", "engine"),
	];
	const legacyNodes = [
		graphNode("implement", "实现", "implement"),
		graphNode("qa", "QA 验证", "qa"),
		graphNode("founder_gate", "创始人门", "gate", "gate"),
	];
	const productNodes = (name) => [
		graphNode("work", name, "generic"),
		graphNode("founder_gate", "创始人门", "gate", "gate"),
		graphNode("land", "合入", "land", "engine"),
	];
	const primary = {
		id: "project/flywheel",
		name: "flywheel",
		presentationGroup: "flywheel",
		sourceRevision: "fixture:fly2364",
		leads: [
			lead("lead/product", "Peter", "product"),
			lead("lead/infra-one", "Oliver", "infra"),
			lead("lead/infra-two", "Tadashi", "infra"),
		],
		roles: [
			{
				id: "role-engineer",
				name: "Engineer",
				department: "engineering",
				agentFile: "engineer-executor.md",
				sourceLink: linkedRole,
			},
		],
		dags: [
			dag("tpl_product_brief", "产品简报", productNodes("产品设计")),
			dag("tpl_product_review", "产品评审", productNodes("产品评审")),
			dag("tpl_generic", "通用任务", productNodes("通用执行")),
			dag("tpl_code", "代码工作流", codeNodes, [
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
			]),
			dag("tpl_simple_code", "简单代码", simpleNodes),
			dag("tpl_legacy_loop", "旧后端回环", legacyNodes, [
				{
					id: "legacy_retry",
					from: "qa",
					to: "implement",
					maxIterations: null,
				},
			]),
		],
		crons: [],
		runnerDefault: {
			dispatch: {
				...managed("runner/project/flywheel", {
					provider: "anthropic",
					model: "fable",
					effort: "medium",
				}),
				canonicalModel: "claude-fable-5-1",
			},
		},
	};
	const projectNames = [
		"flywheel",
		"geoforge3d",
		"cad-tools",
		"operations",
		"research",
		"sandbox",
	];
	return {
		schemaVersion: 2,
		snapshotRevision: "fixture:fly2364",
		generatedAt: "2026-09-05T00:00:00.000Z",
		sources: [{ id: "fixture", kind: "test_fixture", revision: FIXTURE_ID, ok: true }],
		presentationGroups: [
			...projectNames.map((name) => ({
				id: `group/${name}`,
				label: name,
				projectIds: [`project/${name}`],
				leadIds: [],
				derived: false,
			})),
			{
				id: "infra",
				label: "Infra",
				projectIds: ["project/flywheel"],
				leadIds: ["lead/infra-one", "lead/infra-two"],
				derived: true,
			},
		],
		modelCatalog: {
			lead: catalog("lead"),
			runner: catalog("runner"),
			workflow: catalog("workflow"),
			cron: catalog("cron"),
		},
		projects: [primary, ...projectNames.slice(1).map(emptyProject)],
		unassignedCrons: [
			{
				id: "cron/unassigned",
				label: "未归属巡检",
				sourceHint: "fixture",
				loaded: true,
				schedule: managed("cron/unassigned/schedule", {
					days: [1, 2, 3, 4, 5],
					times: [{ hour: 9, minute: 0 }],
					label: "工作日",
				}),
				enabled: managed("cron/unassigned/enabled", true),
				model: null,
				warnings: [],
			},
		],
		flags: [
			flag("fixture_readonly", { reason: "read-only registry" }),
			flag("fixture_cli", {
				reason: "use flywheel-comm feature-flags set fixture_cli true",
			}),
			flag("fixture_writable", { writable: true }),
			flag("fixture_project", {
				reason: "project-scoped flag has no global override",
				override: true,
			}),
		],
		extensions: [],
	};
}

const html = getFleetConsoleHtml();
const htmlSha256 = createHash("sha256").update(html).digest("hex");

http
	.createServer((request, response) => {
		if (request.method !== "GET") {
			response.statusCode = 405;
			response.setHeader("allow", "GET");
			response.end("read-only evidence harness");
			return;
		}
		const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
		if (url.pathname === "/") {
			response.setHeader("content-type", "text/html; charset=utf-8");
			response.end(html);
			return;
		}
		if (url.pathname === "/api/fleet/snapshot") {
			response.setHeader("content-type", "application/json; charset=utf-8");
			response.end(JSON.stringify(snapshot()));
			return;
		}
		if (url.pathname === "/__fixture") {
			response.setHeader("content-type", "application/json; charset=utf-8");
			response.end(
				JSON.stringify({ fixtureId: FIXTURE_ID, htmlSha256, processId: process.pid }),
			);
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
		console.log(`FLY-2364 evidence server http://127.0.0.1:${port}`);
	});
