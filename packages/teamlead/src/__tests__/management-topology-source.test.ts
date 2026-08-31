import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigLoader, type FlywheelConfig } from "flywheel-config";
import { describe, expect, it } from "vitest";
import {
	buildTopologyView,
	type LoadedProjectConfig,
} from "../bridge/management-topology-source.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "fly1262", "project-config.yaml");

async function config(project: string): Promise<FlywheelConfig> {
	const loader = new ConfigLoader((path) => readFile(path, "utf8"));
	const loaded = await loader.load(FIXTURE);
	return { ...loaded, project };
}

function project(
	projectName: string,
	leads: ProjectEntry["leads"],
	extra: Partial<ProjectEntry> = {},
): ProjectEntry {
	return {
		projectName,
		projectRoot: `/tmp/${projectName}`,
		projectRepo: `xrliAnnie/${projectName}`,
		leads,
		...extra,
	};
}

function lead(
	agentId: string,
	department?: string,
): ProjectEntry["leads"][number] {
	return {
		agentId,
		chatChannel: "test",
		match: { labels: [department ?? "engineering"] },
		department,
		canSpawnRunners: true,
	};
}

async function loadedConfigs(names: string[]) {
	const result = new Map<string, LoadedProjectConfig>();
	for (const name of names) {
		result.set(name, {
			config: await config(name),
			resolvedAgents: {
				personal: {
					nodeName: "personal",
					label: "Personal",
					agentFile: `/tmp/${name}/.flywheel/agents/nodes/personal.md`,
					agentFileRoot: `/tmp/${name}/.flywheel/agents`,
					department: "engineering",
					departments: ["engineering"],
					match: { labels: ["personal"] },
				},
			},
			revision: `file:${name}`,
		});
	}
	return result;
}

describe("management topology source", () => {
	it("discovers new Leads and sorts projects without a source list", async () => {
		const projects = [project("zeta", [lead("z-lead")]), project("alpha", [])];
		const configs = await loadedConfigs(["zeta", "alpha"]);
		const before = buildTopologyView({
			projects,
			configs,
			projectsRevision: "file:projects",
		});
		projects[1]!.leads.push(lead("new-lead"));
		const after = buildTopologyView({
			projects,
			configs,
			projectsRevision: "file:projects",
		});
		expect(before.projects.map((item) => item.name)).toEqual(["alpha", "zeta"]);
		expect(after.projects.flatMap((item) => item.leads)).toHaveLength(
			before.projects.flatMap((item) => item.leads).length + 1,
		);
	});

	it("derives Infra from department while preserving source project identity", async () => {
		const projects = [
			project("flywheel", [
				lead("eng-lead", "engineering"),
				lead("infra-bot", "infra"),
			]),
			project("tidal-echo", [lead("sub-lead", "content")]),
		];
		const view = buildTopologyView({
			projects,
			configs: await loadedConfigs(["flywheel", "tidal-echo"]),
			projectsRevision: "file:projects",
		});
		const infra = view.projects
			.flatMap((item) => item.leads)
			.find((item) => item.leadId === "infra-bot")!;
		const sub = view.projects
			.flatMap((item) => item.leads)
			.find((item) => item.leadId === "sub-lead")!;
		expect(infra.presentationGroup).toBe("infra");
		expect(
			view.projects.find((item) => item.name === "flywheel")?.leads,
		).toContain(infra);
		expect(sub.presentationGroup).toBe("tidal-echo");
	});

	it("creates one role card per validated agent entry with an encoded GitHub link", async () => {
		const view = buildTopologyView({
			projects: [project("flywheel", [lead("eng-lead")])],
			configs: await loadedConfigs(["flywheel"]),
			projectsRevision: "file:projects",
		});
		expect(view.projects[0]!.roles).toEqual([
			expect.objectContaining({
				name: "Personal",
				agentFile: ".flywheel/agents/nodes/personal.md",
				sourceLink:
					"https://github.com/xrliAnnie/flywheel/blob/main/.flywheel/agents/nodes/personal.md",
			}),
		]);
	});

	it("shows a missing repository diagnostic instead of inventing a link", async () => {
		const view = buildTopologyView({
			projects: [
				project("personal-assistant", [lead("personal-lead")], {
					projectRepo: undefined,
				}),
			],
			configs: await loadedConfigs(["personal-assistant"]),
			projectsRevision: "file:projects",
		});
		expect(view.projects[0]!.roles[0]).toMatchObject({
			sourceLink: null,
			error: "项目未声明 GitHub repository",
		});
	});

	it("surfaces one config error without dropping unaffected projects", async () => {
		const configs = await loadedConfigs(["healthy"]);
		configs.set("broken", { revision: "file:broken", error: "invalid yaml" });
		const view = buildTopologyView({
			projects: [project("healthy", []), project("broken", [])],
			configs,
			projectsRevision: "file:projects",
		});
		expect(view.projects).toHaveLength(2);
		expect(
			view.projects.find((item) => item.name === "broken")?.error,
		).toContain("invalid yaml");
	});

	it("surfaces a missing project config instead of presenting an empty healthy project", () => {
		const view = buildTopologyView({
			projects: [project("missing-config", [])],
			configs: new Map([["missing-config", { revision: "registry:absent" }]]),
			projectsRevision: "file:projects",
		});
		expect(view.projects[0]).toMatchObject({
			name: "missing-config",
			error: "项目配置不存在",
		});
	});

	it("fails closed on duplicate project names or roots", async () => {
		const configs = await loadedConfigs(["dup"]);
		expect(() =>
			buildTopologyView({
				projects: [project("dup", []), project("dup", [])],
				configs,
				projectsRevision: "file:projects",
			}),
		).toThrow(/duplicate project name/i);
		expect(() =>
			buildTopologyView({
				projects: [
					project("a", [], { projectRoot: "/tmp/same" }),
					project("b", [], { projectRoot: "/tmp/same" }),
				],
				configs,
				projectsRevision: "file:projects",
			}),
		).toThrow(/duplicate project root/i);
	});
});
