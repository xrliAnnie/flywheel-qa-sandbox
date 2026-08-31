import { describe, expect, it } from "vitest";
import { AgentDispatcher } from "../AgentDispatcher.js";
import {
	resolvedTestAgent,
	testAgentFallbacks,
} from "./agent-dispatch-fixtures.js";

const GENERAL = resolvedTestAgent({ nodeName: "general" });
const QUIET = resolvedTestAgent({
	nodeName: "quiet",
	departments: ["engineering"],
});
const ENGINEER = resolvedTestAgent({
	nodeName: "engineer",
	labels: ["code"],
	departments: ["engineering"],
});

describe("FLY-1335 empty labels are not wildcard", () => {
	it("an empty-label entry does not win scoped or top-level label matching", () => {
		const dispatcher = new AgentDispatcher(
			{ quiet: QUIET, general: GENERAL },
			undefined,
			testAgentFallbacks(),
		);
		for (const owningDept of ["engineering", undefined] as const) {
			expect(
				dispatcher.dispatch({ issueLabels: ["unknown"], owningDept }),
			).toMatchObject({
				agentName: "generic",
				matchMethod: "shipped-generic",
			});
		}
	});

	it("an empty-label entry remains reachable as default or explicit override", () => {
		const dispatcher = new AgentDispatcher(
			{ quiet: QUIET, general: GENERAL },
			"general",
			testAgentFallbacks(),
		);
		expect(
			dispatcher.dispatch({ issueLabels: ["unknown"], owningDept: undefined }),
		).toMatchObject({ agentName: "general", matchMethod: "default" });
		expect(dispatcher.dispatchByName("quiet")).toMatchObject({
			agentName: "quiet",
			matchMethod: "override",
		});
	});

	it("non-empty label routing is unchanged", () => {
		const dispatcher = new AgentDispatcher(
			{ quiet: QUIET, engineer: ENGINEER },
			undefined,
			testAgentFallbacks(),
		);
		expect(
			dispatcher.dispatch({
				issueLabels: ["code"],
				owningDept: "engineering",
			}),
		).toMatchObject({ agentName: "engineer", matchMethod: "label" });
	});

	it("the reserved generic override always means the registry fallback", () => {
		const dispatcher = new AgentDispatcher(
			{ general: GENERAL },
			"general",
			testAgentFallbacks(),
		);
		expect(dispatcher.dispatchByName("generic")).toMatchObject({
			agentName: "generic",
			matchMethod: "shipped-generic",
			agentConfig: { nodeName: "general" },
		});
	});
});
