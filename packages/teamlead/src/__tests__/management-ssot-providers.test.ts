import { describe, expect, it } from "vitest";
import { composeManagementSnapshot } from "../bridge/management-console-snapshot.js";
import { createManagementSsotProviders } from "../bridge/management-ssot-providers.js";
import type { LoadedProjectConfig } from "../bridge/management-topology-source.js";
import type { ProjectEntry } from "../ProjectConfig.js";

function project(name: string, leadId: string): ProjectEntry {
	return {
		projectName: name,
		projectRoot: `/tmp/${name}`,
		leads: [
			{
				agentId: leadId,
				chatChannel: "test",
				match: { labels: ["engineering"] },
				canSpawnRunners: true,
			},
		],
	};
}

describe("management SSOT providers", () => {
	it("re-reads the authoritative roster so new projects and Leads appear automatically", () => {
		let projects = [project("alpha", "first-lead")];
		const configs = new Map<string, LoadedProjectConfig>([
			["alpha", { revision: "file:alpha" }],
		]);
		const providers = createManagementSsotProviders({
			projects: () => projects,
			projectsRevision: () => `file:${projects.length}`,
			projectConfigs: () => configs,
		});

		const before = composeManagementSnapshot({ providers });
		projects = [...projects, project("beta", "new-lead")];
		configs.set("beta", { revision: "file:beta" });
		const after = composeManagementSnapshot({ providers });

		expect(before.projects.map((item) => item.name)).toEqual(["alpha"]);
		expect(after.projects.map((item) => item.name)).toEqual(["alpha", "beta"]);
		expect(after.projects[1]!.leads[0]!.leadId).toBe("new-lead");
	});

	it("publishes every canonical model cascade and project-config provenance", () => {
		const providers = createManagementSsotProviders({
			projects: () => [project("alpha", "lead")],
			projectsRevision: () => "file:projects",
			projectConfigs: () => new Map([["alpha", { revision: "file:config" }]]),
		});
		const snapshot = composeManagementSnapshot({ providers });

		expect(Object.keys(snapshot.modelCatalog).sort()).toEqual([
			"cron",
			"dispatch",
			"lead",
			"runner",
			"workflow",
		]);
		expect(snapshot.sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "projects_json", ok: true }),
				expect.objectContaining({ kind: "project_config", ok: true }),
				expect.objectContaining({ kind: "model_registry", ok: true }),
			]),
		);
	});
});
