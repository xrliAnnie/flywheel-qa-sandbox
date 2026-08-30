import { join } from "node:path";
import type { AgentConfig, FlywheelConfig } from "flywheel-config";
import {
	loadBundledRegistry,
	resolveAgentConfigs,
	resolveProjectRegistry,
} from "flywheel-config";
import { AgentDispatcher, type AgentFallbacks } from "../AgentDispatcher.js";

export function resolvedTestAgent(input: {
	nodeName: string;
	labels?: string[];
	departments?: string[];
	projectRoot?: string;
	relativeFile?: string;
	domainFile?: string;
}): AgentConfig {
	const projectRoot = input.projectRoot ?? "/project";
	const agentFileRoot = join(projectRoot, ".flywheel", "agents");
	const departments = input.departments ?? [];
	return {
		nodeName: input.nodeName,
		label: input.nodeName,
		agentFile: join(
			agentFileRoot,
			input.relativeFile ?? `nodes/${input.nodeName}.md`,
		),
		agentFileRoot,
		...(input.domainFile ? { domainFile: input.domainFile } : {}),
		...(departments[0] ? { department: departments[0] } : {}),
		departments,
		match: { labels: input.labels ?? [] },
	};
}

export function testAgentFallbacks(projectRoot = "/flywheel"): AgentFallbacks {
	return {
		generic: resolvedTestAgent({ nodeName: "general", projectRoot }),
		qa: resolvedTestAgent({
			nodeName: "qa",
			departments: ["engineering"],
			projectRoot,
		}),
	};
}

/** Mirror the production self-hosting registry/config composition in focused tests. */
export function resolvedRepoDispatcher(
	config: Pick<FlywheelConfig, "agents" | "default_agent" | "project">,
	projectRoot: string,
): {
	agents: Readonly<Record<string, AgentConfig>>;
	dispatcher: AgentDispatcher;
} {
	const bundled = loadBundledRegistry(
		join(projectRoot, ".flywheel", "agents", "registry.yaml"),
	);
	const registry = resolveProjectRegistry({
		bundled,
		projectName: config.project,
		projectRoot,
	});
	const agents = resolveAgentConfigs(config.agents ?? {}, registry);
	const fallbacks = resolveAgentConfigs(
		{
			generic: { node: "general", match: { labels: [] } },
			qa: { node: "qa", match: { labels: [] } },
		},
		registry,
	);
	return {
		agents,
		dispatcher: new AgentDispatcher(agents, config.default_agent, {
			generic: fallbacks.generic!,
			qa: fallbacks.qa!,
		}),
	};
}
