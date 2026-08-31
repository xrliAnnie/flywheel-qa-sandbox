import { describe, expect, it } from "vitest";
import type { ResolvedProjectRegistry } from "../agent-registry.js";
import { ConfigLoader, resolveAgentConfigs } from "../ConfigLoader.js";

const BASE = `
project: flywheel
linear:
  team_id: TEAM-1
runners:
  default: claude
  available:
    claude: { type: claude }
teams:
  - name: engineering
    orchestrators:
      - { type: code, runner: claude, budget_per_issue: 5 }
decision_layer:
  autonomy_level: observer
  escalation_channel: "#dev"
`;

function resolvedRegistry(): ResolvedProjectRegistry {
	return {
		projectName: "flywheel",
		projectRoot: "/project",
		structural: {},
		graphs: {},
		nodes: {
			engineer: {
				name: "engineer",
				label: "工程师",
				agentFile: "/project/.flywheel/agents/nodes/engineer.md",
				agentFileRoot: "/project/.flywheel/agents",
				department: "engineering",
				departments: ["engineering"],
			},
			product_designer: {
				name: "product_designer",
				label: "UX 设计",
				agentFile: "/project/.flywheel/agents/nodes/product_designer.md",
				agentFileRoot: "/project/.flywheel/agents",
				department: "engineering",
				departments: ["engineering", "product"],
			},
			general: {
				name: "general",
				label: "通用执行",
				agentFile: "/project/.flywheel/agents/nodes/general.md",
				agentFileRoot: "/project/.flywheel/agents",
				departments: [],
			},
		},
	};
}

describe("ConfigLoader registry-backed agents", () => {
	it("accepts node-only authoring and removes implementation fields", async () => {
		const loader = new ConfigLoader(
			async () => `${BASE}
agents:
  backend:
    node: engineer
    domain_file: .claude/domains/backend.md
    match:
      labels: [backend, api]
default_agent: backend
`,
		);

		const config = await loader.load("/project/.flywheel/config.yaml");
		expect(config.agents?.backend).toEqual({
			node: "engineer",
			domain_file: ".claude/domains/backend.md",
			match: { labels: ["backend", "api"] },
		});
	});

	it("keeps legacy agent_file projects runnable until registry activation", async () => {
		const loader = new ConfigLoader(
			async () => `${BASE}
agents:
  backend:
    agent_file: .flywheel/agents/nodes/engineer.md
    department: nodes
    departments: [nodes, platform]
    match: { labels: [backend] }
`,
		);

		const config = await loader.load("/project/.flywheel/config.yaml");
		const agents = resolveAgentConfigs(config.agents, undefined, "/project");

		expect(agents.backend).toEqual({
			nodeName: "backend",
			label: "backend",
			agentFile: "/project/.flywheel/agents/nodes/engineer.md",
			agentFileRoot: "/project",
			department: "nodes",
			departments: ["nodes", "platform"],
			match: { labels: ["backend"] },
		});
		expect(Object.isFrozen(agents.backend)).toBe(true);
	});

	it.each([
		[
			"both",
			`node: engineer\n    agent_file: .flywheel/agents/nodes/engineer.md`,
		],
		["neither", `domain_file: .claude/domains/backend.md`],
	])(
		"rejects agent sources with %s identity fields",
		async (_case, identity) => {
			const loader = new ConfigLoader(
				async () => `${BASE}
agents:
  backend:
    ${identity}
    match: { labels: [backend] }
`,
			);

			await expect(
				loader.load("/project/.flywheel/config.yaml"),
			).rejects.toThrow(/agents\.backend.*exactly one of node or agent_file/i);
		},
	);

	it("resolves node identities to immutable runtime agent configs", async () => {
		const loader = new ConfigLoader(
			async () => `${BASE}
agents:
  backend:
    node: engineer
    domain_file: .claude/domains/backend.md
    match: { labels: [backend] }
  product-designer:
    node: product_designer
    match: { labels: [designer, ux] }
  general:
    node: general
    match: { labels: [] }
default_agent: general
`,
		);
		const config = await loader.load("/project/.flywheel/config.yaml");

		const agents = resolveAgentConfigs(config.agents, resolvedRegistry());

		expect(agents.backend).toEqual({
			nodeName: "engineer",
			label: "工程师",
			agentFile: "/project/.flywheel/agents/nodes/engineer.md",
			agentFileRoot: "/project/.flywheel/agents",
			department: "engineering",
			departments: ["engineering"],
			domainFile: ".claude/domains/backend.md",
			match: { labels: ["backend"] },
		});
		expect(agents["product-designer"]?.departments).toEqual([
			"engineering",
			"product",
		]);
		expect(agents.general?.department).toBeUndefined();
		expect(agents.general?.departments).toEqual([]);
		expect(Object.isFrozen(agents)).toBe(true);
		expect(Object.isFrozen(agents.backend)).toBe(true);
	});

	it("fails loud when an authored node is absent from the resolved registry", async () => {
		const loader = new ConfigLoader(
			async () => `${BASE}
agents:
  backend:
    node: missing
    match: { labels: [backend] }
`,
		);
		const config = await loader.load("/project/.flywheel/config.yaml");

		expect(() =>
			resolveAgentConfigs(config.agents, resolvedRegistry()),
		).toThrow(/NODE_NOT_REGISTERED.*missing/i);
	});
});
