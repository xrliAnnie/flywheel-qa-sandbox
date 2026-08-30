import type { AgentConfig } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { AgentDispatcher, InvalidAgentNameError } from "../AgentDispatcher.js";

function agent(
	nodeName: string,
	labels: string[],
	departments: string[],
): AgentConfig {
	return {
		nodeName,
		label: nodeName,
		agentFile: `/project/.flywheel/agents/nodes/${nodeName}.md`,
		agentFileRoot: "/project/.flywheel/agents",
		...(departments[0] ? { department: departments[0] } : {}),
		departments,
		match: { labels },
	};
}

const FALLBACKS = {
	generic: agent("general", [], []),
	qa: agent("qa", [], ["engineering"]),
};

function makeAgents(): Record<string, AgentConfig> {
	return {
		backend: agent("engineer", ["backend", "api"], ["engineering"]),
		frontend: agent("engineer", ["frontend", "ui", "design"], ["engineering"]),
		product: agent("pm", ["pm", "product"], ["engineering", "product"]),
		general: agent("general", ["chore", "tooling"], []),
	};
}

describe("AgentDispatcher", () => {
	it("uses the bundled general fallback when no configured route matches", () => {
		const dispatcher = new AgentDispatcher({}, undefined, FALLBACKS);
		expect(
			dispatcher.dispatch({ issueLabels: ["unknown"], owningDept: undefined }),
		).toMatchObject({
			agentName: "generic",
			matchMethod: "shipped-generic",
			agentConfig: { nodeName: "general" },
		});
	});

	it("matches scoped departments, aliases, and configured-label case", () => {
		const agents = makeAgents();
		agents.backend = {
			...agents.backend!,
			match: { labels: ["Backend", "API"] },
		};
		const dispatcher = new AgentDispatcher(agents, undefined, FALLBACKS);
		expect(
			dispatcher.dispatch({
				issueLabels: ["backend"],
				owningDept: "engineering",
			}),
		).toMatchObject({ agentName: "backend", department: "engineering" });
		expect(
			dispatcher.dispatch({
				issueLabels: ["design"],
				owningDept: "engineering",
			}),
		).toMatchObject({ agentName: "frontend" });
	});

	it("preserves dual-register scope without leaking to an unlisted department", () => {
		const dispatcher = new AgentDispatcher(makeAgents(), undefined, FALLBACKS);
		expect(
			dispatcher.dispatch({ issueLabels: ["product"], owningDept: "product" }),
		).toMatchObject({ agentName: "product", department: "product" });
		expect(
			dispatcher.dispatch({ issueLabels: ["product"], owningDept: "content" }),
		).toMatchObject({ agentName: "generic" });
	});

	it("uses top-level catch-all for known, multiple, and absent owning departments", () => {
		const dispatcher = new AgentDispatcher(makeAgents(), undefined, FALLBACKS);
		for (const owningDept of ["engineering", "multiple", undefined] as const) {
			expect(
				dispatcher.dispatch({ issueLabels: ["chore"], owningDept }),
			).toMatchObject({
				agentName: "general",
				matchMethod: "label",
				department: undefined,
			});
		}
	});

	it("uses configured default_agent before the bundled fallback", () => {
		const agents = makeAgents();
		const dispatcher = new AgentDispatcher(agents, "backend", FALLBACKS);
		expect(
			dispatcher.dispatch({ issueLabels: ["unknown"], owningDept: undefined }),
		).toMatchObject({
			agentName: "backend",
			matchMethod: "default",
			department: "engineering",
		});
		const missing = new AgentDispatcher(agents, "missing", FALLBACKS);
		expect(
			missing.dispatch({ issueLabels: ["unknown"], owningDept: undefined }),
		).toMatchObject({ agentName: "generic" });
	});

	it("keeps first-configured precedence for the same scoped label", () => {
		const dispatcher = new AgentDispatcher(
			{
				first: agent("engineer", ["shared"], ["engineering"]),
				second: agent("qa", ["shared"], ["engineering"]),
			},
			undefined,
			FALLBACKS,
		);
		expect(
			dispatcher.dispatch({
				issueLabels: ["shared"],
				owningDept: "engineering",
			}),
		).toMatchObject({ agentName: "first" });
	});

	it("resolves explicit names, registered fallbacks, and invalid names", () => {
		const dispatcher = new AgentDispatcher(makeAgents(), undefined, FALLBACKS);
		expect(dispatcher.dispatchByName("backend")).toMatchObject({
			matchMethod: "override",
			agentConfig: { nodeName: "engineer" },
		});
		expect(dispatcher.dispatchByName("generic")).toMatchObject({
			matchMethod: "shipped-generic",
			agentConfig: { nodeName: "general" },
		});
		expect(dispatcher.dispatchByName("qa")).toMatchObject({
			matchMethod: "shipped-qa",
			agentConfig: { nodeName: "qa" },
		});
		expect(dispatcher.availableNames()).toEqual([
			"backend",
			"frontend",
			"product",
			"general",
			"generic",
			"qa",
		]);
		expect(() => dispatcher.dispatchByName("missing")).toThrow(
			InvalidAgentNameError,
		);
	});

	it("lets a configured QA entry override the bundled QA fallback", () => {
		const configured = agent("qa", ["qa"], ["engineering"]);
		const dispatcher = new AgentDispatcher(
			{ qa: configured },
			undefined,
			FALLBACKS,
		);
		expect(dispatcher.dispatchByName("qa")).toMatchObject({
			matchMethod: "override",
			agentConfig: configured,
		});
	});
});
