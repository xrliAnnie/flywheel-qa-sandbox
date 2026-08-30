import { relative } from "node:path";
import type { FlywheelConfig, ResolvedAgentConfig } from "flywheel-config";
import { getModelRegistryEntry } from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import { computeLeadCapabilities } from "./fleet-capabilities.js";
import {
	buildTargetId,
	type ManagementLeadView,
	type ManagementProjectView,
	type ModelSelection,
	type PresentationGroupView,
	registrySourceRevision,
} from "./management-console-contract.js";

export interface LoadedProjectConfig {
	config?: FlywheelConfig;
	resolvedAgents?: Readonly<Record<string, ResolvedAgentConfig>>;
	revision: string;
	error?: string;
}

export interface TopologyView {
	projects: ManagementProjectView[];
	presentationGroups: PresentationGroupView[];
}

export interface BuildTopologyInput {
	projects: ProjectEntry[];
	configs: ReadonlyMap<string, LoadedProjectConfig>;
	projectsRevision: string;
	onlineByLead?: ReadonlyMap<
		string,
		"online" | "offline" | "degraded" | "unknown"
	>;
}

function assertUniqueProjects(projects: readonly ProjectEntry[]): void {
	const names = new Set<string>();
	const roots = new Set<string>();
	for (const project of projects) {
		if (names.has(project.projectName)) {
			throw new Error(`duplicate project name: ${project.projectName}`);
		}
		if (roots.has(project.projectRoot)) {
			throw new Error(`duplicate project root: ${project.projectRoot}`);
		}
		names.add(project.projectName);
		roots.add(project.projectRoot);
	}
}

function githubSourceLink(
	projectRepo: string | undefined,
	agentFile: string,
): { link: string | null; error?: string } {
	if (!projectRepo) {
		return { link: null, error: "项目未声明 GitHub repository" };
	}
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(projectRepo)) {
		return { link: null, error: "项目 GitHub repository 格式无效" };
	}
	if (
		agentFile.startsWith("/") ||
		agentFile.split("/").some((part) => part === "..")
	) {
		return { link: null, error: "agent_file 不是安全的项目相对路径" };
	}
	const encoded = agentFile.split("/").map(encodeURIComponent).join("/");
	return {
		link: `https://github.com/${projectRepo}/blob/main/${encoded}`,
	};
}

function currentLeadSelection(
	lead: ProjectEntry["leads"][number],
): ModelSelection | null {
	if (!lead.model) return null;
	const registered = getModelRegistryEntry(lead.model);
	return {
		provider:
			registered?.provider ??
			(lead.backend === "codex-app-server" ? "openai" : "anthropic"),
		model: registered?.id ?? lead.model,
		effort: lead.effort ?? null,
	};
}

function buildLead(
	project: ProjectEntry,
	lead: ProjectEntry["leads"][number],
	projectsRevision: string,
	onlineByLead?: BuildTopologyInput["onlineByLead"],
): ManagementLeadView {
	const capabilities = computeLeadCapabilities(lead);
	const presentationGroup =
		lead.department === "infra" ? "infra" : project.projectName;
	const writable = capabilities.currentBackend === "claude-code";
	return {
		id: `${project.projectName}/${lead.agentId}`,
		leadId: lead.agentId,
		displayName: lead.agentId,
		department: lead.department,
		presentationGroup,
		online:
			onlineByLead?.get(`${project.projectName}-${lead.agentId}`) ?? "unknown",
		backend: capabilities.currentBackend,
		backendWritable: false,
		backendDisabledReason: "跨厂商 Lead 切换在 v1 中只读",
		dispatch: {
			targetId: buildTargetId("lead", [
				project.projectName,
				lead.agentId,
				"dispatch",
			]),
			current: currentLeadSelection(lead),
			source: {
				kind: "projects_json",
				revision: projectsRevision,
				hint: "projects.json",
			},
			writeCapability: {
				writable,
				reason: writable ? undefined : "当前 Lead backend 不支持受管模型写回",
				consequence: writable ? "restart-lead" : "governance-readonly",
				requiresAcknowledgement: writable,
			},
		},
	};
}

export function buildTopologyView(input: BuildTopologyInput): TopologyView {
	assertUniqueProjects(input.projects);
	const projects: ManagementProjectView[] = [];
	for (const project of [...input.projects].sort((a, b) =>
		a.projectName.localeCompare(b.projectName),
	)) {
		const loaded = input.configs.get(project.projectName);
		const roles: ManagementProjectView["roles"] = [];
		if (loaded?.config) {
			for (const [name, agent] of Object.entries(
				loaded.resolvedAgents ?? {},
			).sort(([a], [b]) => a.localeCompare(b))) {
				const agentFile = relative(project.projectRoot, agent.agentFile);
				const source = githubSourceLink(project.projectRepo, agentFile);
				roles.push({
					id: `${project.projectName}/role/${name}`,
					name: agent.label,
					department: agent.department,
					agentFile,
					sourceLink: source.link,
					error: source.error,
				});
			}
		}
		projects.push({
			id: `project/${encodeURIComponent(project.projectName)}`,
			name: project.projectName,
			presentationGroup: project.projectName,
			sourceRevision:
				loaded?.revision ?? registrySourceRevision("config-missing"),
			leads: [...project.leads]
				.sort((a, b) => a.agentId.localeCompare(b.agentId))
				.map((lead) =>
					buildLead(project, lead, input.projectsRevision, input.onlineByLead),
				),
			roles,
			dags: [],
			crons: [],
			error:
				loaded?.error ??
				(!loaded
					? "项目配置未加载"
					: !loaded.config
						? "项目配置不存在"
						: undefined),
		});
	}

	const groups = new Map<
		string,
		{ projectIds: Set<string>; leadIds: string[]; derived: boolean }
	>();
	for (const project of projects) {
		for (const lead of project.leads) {
			const group = groups.get(lead.presentationGroup) ?? {
				projectIds: new Set<string>(),
				leadIds: [],
				derived: lead.presentationGroup === "infra",
			};
			group.projectIds.add(project.id);
			group.leadIds.push(lead.id);
			groups.set(lead.presentationGroup, group);
		}
		if (project.leads.length === 0) {
			groups.set(project.name, {
				projectIds: new Set([project.id]),
				leadIds: [],
				derived: false,
			});
		}
	}
	const presentationGroups = [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, group]) => ({
			id,
			label: id === "infra" ? "Infra" : id,
			projectIds: [...group.projectIds],
			leadIds: group.leadIds,
			derived: group.derived,
		}));
	return { projects, presentationGroups };
}
