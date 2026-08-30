import type { ResolvedAgentConfig } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { AgentDispatcher } from "../AgentDispatcher.js";

function resolved(
	nodeName: string,
	labels: string[],
	departments: string[],
): ResolvedAgentConfig {
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
	generic: resolved("general", [], []),
	qa: resolved("qa", [], ["engineering"]),
};

describe("AgentDispatcher resolved registry configs", () => {
	it("uses registry departments for scoped and top-level matching", () => {
		const dispatcher = new AgentDispatcher(
			{
				designer: resolved(
					"product_design",
					["designer"],
					["engineering", "product"],
				),
				general: resolved("general", ["chore"], []),
			},
			undefined,
			FALLBACKS,
		);

		expect(
			dispatcher.dispatch({
				issueLabels: ["designer"],
				owningDept: "product",
			}),
		).toMatchObject({
			agentName: "designer",
			matchMethod: "label",
			department: "product",
			agentConfig: { nodeName: "product_design" },
		});
		expect(
			dispatcher.dispatch({ issueLabels: ["chore"], owningDept: "product" }),
		).toMatchObject({
			agentName: "general",
			department: undefined,
			agentConfig: { nodeName: "general" },
		});
	});

	it("uses registered general and QA nodes for shipped fallbacks", () => {
		const dispatcher = new AgentDispatcher({}, undefined, FALLBACKS);

		const generic = dispatcher.dispatch({
			issueLabels: ["unknown"],
			owningDept: undefined,
		});
		expect(generic).toMatchObject({
			agentName: "generic",
			matchMethod: "shipped-generic",
			agentConfig: {
				nodeName: "general",
				agentFile: "/project/.flywheel/agents/nodes/general.md",
			},
		});
		expect(generic).not.toHaveProperty("agentFileRoot");

		const qa = dispatcher.dispatchByName("qa");
		expect(qa).toMatchObject({
			matchMethod: "shipped-qa",
			agentConfig: { nodeName: "qa" },
		});
	});

	it("lets a configured QA route override the registered fallback", () => {
		const configuredQa = resolved("qa", ["qa"], ["engineering"]);
		const dispatcher = new AgentDispatcher(
			{ qa: configuredQa },
			undefined,
			FALLBACKS,
		);

		expect(dispatcher.dispatchByName("qa")).toMatchObject({
			matchMethod: "override",
			agentConfig: configuredQa,
		});
	});
});
