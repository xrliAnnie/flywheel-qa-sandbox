import { describe, expect, it } from "vitest";
import {
	type ProjectEntry,
	resolveLeadByAgentIdAcrossRegistry,
} from "../ProjectConfig.js";

function project(projectName: string, agentId: string): ProjectEntry {
	return {
		projectName,
		projectRoot: `/tmp/${projectName}`,
		leads: [
			{
				agentId,
				summaryRole: "producer",
				chatChannel: `${projectName}-chat`,
				match: { labels: [projectName] },
			},
		],
	};
}

describe("resolveLeadByAgentIdAcrossRegistry", () => {
	it("returns undefined for zero matches and the exact project plus lead for one", () => {
		const projects = [project("flywheel", "simba"), project("raya", "raya")];
		expect(
			resolveLeadByAgentIdAcrossRegistry(projects, "missing"),
		).toBeUndefined();
		expect(resolveLeadByAgentIdAcrossRegistry(projects, "raya")).toEqual({
			project: projects[1],
			lead: projects[1]!.leads[0],
		});
	});

	it("fails closed when an agent id is ambiguous across projects", () => {
		expect(() =>
			resolveLeadByAgentIdAcrossRegistry(
				[project("flywheel", "shared"), project("raya", "shared")],
				"shared",
			),
		).toThrow(/lead_ambiguous.*flywheel.*raya/);
	});
});
