import http from "node:http";
import { FEATURE_FLAGS } from "../../../../packages/config/dist/index.js";
import { getFleetConsoleHtml } from "../../../../packages/teamlead/dist/bridge/fleet-console-html.js";

const port = Number(process.env.FLY2257_EVIDENCE_PORT || 18857);
const linkedRole =
	"https://github.com/xrliAnnie/flywheel/blob/main/.flywheel/agents/engineering/engineer-executor.md";

function managed(targetId, current, writable = true, reason = "") {
	return {
		targetId,
		current,
		source: { kind: "test_fixture", location: "memory", revision: `fixture:${targetId}` },
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

function graphNode(id, type, execution = "agent") {
	return {
		id,
		name: id.replaceAll("_", " "),
		type,
		execution,
	};
}

function dag(id, templateId, title, nodeTypes, loop = false) {
	const nodes = nodeTypes.map(([nodeId, type, execution]) =>
		graphNode(nodeId, type, execution),
	);
	const edges = nodes.slice(1).map((node, index) => ({
		id: `${nodes[index].id}_to_${node.id}`,
		from: nodes[index].id,
		to: node.id,
	}));
	const agent = nodes.find((node) => node.execution === "agent");
	return {
		id,
		templateId,
		title,
		revision: 1,
		digest: `fixture:${id}`,
		seedOwner: "system",
		graph: {
			nodes,
			edges,
			loops:
				loop && nodes.length > 2
					? [
							{
								id: `${id}_retry`,
								from: nodes.at(-2).id,
								to: nodes[1].id,
								maxIterations: 3,
							},
						]
					: [],
		},
		nodes: agent
			? [
					{
						id: `${templateId}/${agent.id}`,
						nodeId: agent.id,
						name: agent.name,
						dispatch: {
							...managed(`${id}/${agent.id}`, {
								provider: "anthropic",
								model: "claude-opus-5-1m",
								effort: "high",
							}),
							canonicalModel: "claude-opus-5-1m",
						},
					},
				]
			: [],
	};
}

function flagViews() {
	return FEATURE_FLAGS.map((spec, index) => ({
		id: `flag/${spec.name}`,
		name: spec.name,
		description: spec.description,
		polarity: spec.polarity,
		default: spec.default,
		valueKind: spec.valueKind,
		onMeans: spec.onMeans ?? null,
		global: managed(
			`flag/${spec.name}/global`,
			spec.default,
			index % 4 === 0,
			index % 4 === 0 ? "" : "read-only registry",
		),
		projectOverrides: [],
	}));
}

function snapshot() {
	const dags = [
		dag("product-brief", "product_brief", "Product brief", [
			["brief", "generic", "agent"],
			["founder_gate", "gate", "gate"],
			["land", "land", "engine"],
		]),
		dag("product-review", "product_review", "Product review", [
			["review", "review", "agent"],
			["founder_gate", "gate", "gate"],
			["land", "land", "engine"],
		]),
		dag("generic-task", "generic_task", "Generic task", [
			["generic", "generic", "agent"],
			["founder_gate", "gate", "gate"],
			["land", "land", "engine"],
		]),
		dag(
			"engineering-nine",
			"engineering_nine",
			"Nine-node worst case",
			[
				["design_a", "design", "agent"],
				["design_b", "design", "agent"],
				["implement_a", "implement", "agent"],
				["implement_b", "implement", "agent"],
				["review_a", "review", "agent"],
				["qa_a", "qa", "agent"],
				["qa_b", "qa", "agent"],
				["founder_gate", "gate", "gate"],
				["land", "land", "engine"],
			],
			true,
		),
		dag(
			"engineering-five",
			"tpl_code",
			"Code workflow",
			[
				["design", "design", "agent"],
				["implement", "implement", "agent"],
				["qa", "qa", "agent"],
				["founder_gate", "gate", "gate"],
				["land", "land", "engine"],
			],
			true,
		),
		dag("engineering-four", "simple_code", "Simple code", [
			["implement", "implement", "agent"],
			["qa", "qa", "agent"],
			["founder_gate", "gate", "gate"],
			["land", "land", "engine"],
		]),
	];
	return {
		schemaVersion: 2,
		snapshotRevision: "fixture:fly2257",
		generatedAt: "2026-09-03T00:00:00.000Z",
		sources: [
			{ id: "fixture", kind: "test_fixture", revision: "fixture:1", ok: true },
		],
		presentationGroups: [
			{
				id: "flywheel",
				label: "flywheel",
				projectIds: ["project-flywheel"],
				leadIds: [],
				derived: false,
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
				sourceRevision: "fixture:fly2257",
				leads: [],
				roles: [
					{
						id: "role-engineer",
						name: "Engineer",
						department: "engineering",
						agentFile: "engineer-executor.md",
						sourceLink: linkedRole,
					},
					{
						id: "role-qa",
						name: "QA",
						department: "engineering",
						agentFile: "qa-executor.md",
						sourceLink:
							"https://github.com/xrliAnnie/flywheel/blob/main/.flywheel/agents/engineering/qa-executor.md",
					},
					{
						id: "role-unlinked",
						name: "Unlinked role",
						department: "product",
						agentFile: "unlinked.md",
						sourceLink: null,
						error: "sourceLink unavailable",
					},
				],
				dags,
				crons: [],
				runnerDefault: null,
			},
		],
		unassignedCrons: [],
		flags: flagViews(),
		extensions: [],
	};
}

const html = getFleetConsoleHtml();
http
	.createServer((request, response) => {
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
		if (url.pathname === "/favicon.ico") {
			response.statusCode = 204;
			response.end();
			return;
		}
		response.statusCode = 404;
		response.end("not found");
	})
	.listen(port, "127.0.0.1", () => {
		console.log(`FLY-2257 evidence server http://127.0.0.1:${port}`);
	});
