import { realpathSync } from "node:fs";
import { relative } from "node:path";
import type {
	FlywheelConfig,
	ResolvedAgentConfig,
	ResolvedProjectRegistry,
} from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import {
	computeLeadCapabilities,
	DISABLED_BACKEND_SWITCH,
	leadTuningWriteCapability,
	leadVendorForBackend,
} from "./fleet-capabilities.js";
import type { LeadConfigView } from "./lead-config-service.js";
import { leadDispatchSelection } from "./lead-dispatch-selection.js";
import {
	buildTargetId,
	type LeadRuntimeSettingsView,
	type ManagementLeadView,
	type ManagementProjectView,
	type PresentationGroupView,
	registrySourceRevision,
} from "./management-console-contract.js";

export interface LoadedProjectConfig {
	config?: FlywheelConfig;
	resolvedAgents?: Readonly<Record<string, ResolvedAgentConfig>>;
	resolvedRegistry?: ResolvedProjectRegistry;
	handbookRegistryActive?: boolean;
	handbookRosterAvailable?: boolean;
	handbookRosterStatus?: "not_applicable" | "ready" | "absent" | "unreadable";
	handbookResolvedFiles?: Readonly<Record<string, string>>;
	handbookResolutionError?: string;
	revision: string;
	error?: string;
}

export interface TopologyView {
	projects: ManagementProjectView[];
	presentationGroups: PresentationGroupView[];
}

export interface BuildTopologyInput {
	tuningByLead?: ReadonlyMap<string, LeadConfigView | undefined>;
	runtimeSettingsByLead?: ReadonlyMap<
		string,
		LeadRuntimeSettingsView | undefined
	>;
	codexHotConfigAvailable?: boolean;
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

function buildLead(
	project: ProjectEntry,
	lead: ProjectEntry["leads"][number],
	projectsRevision: string,
	onlineByLead?: BuildTopologyInput["onlineByLead"],
	codexHotConfigAvailable = false,
	tuning?: LeadConfigView,
	runtimeSettings?: LeadRuntimeSettingsView,
): ManagementLeadView {
	const capabilities = computeLeadCapabilities(lead);
	const presentationGroup =
		lead.department === "infra" ? "infra" : project.projectName;

	return {
		id: `${project.projectName}/${lead.agentId}`,
		...(tuning ? { tuning } : {}),
		...(runtimeSettings ? { runtimeSettings } : {}),
		leadId: lead.agentId,
		displayName: lead.agentId,
		department: lead.department,
		presentationGroup,
		online:
			onlineByLead?.get(`${project.projectName}-${lead.agentId}`) ?? "unknown",
		backend: capabilities.currentBackend,
		backendWritable: false,
		backendDisabledReason: DISABLED_BACKEND_SWITCH,
		vendor: leadVendorForBackend(capabilities.currentBackend),
		configured: {
			model: lead.model ?? null,
			effort: lead.effort ?? null,
		},
		dispatch: {
			targetId: buildTargetId("lead", [
				project.projectName,
				lead.agentId,
				"dispatch",
			]),
			current: leadDispatchSelection(lead),
			source: {
				kind: "projects_json",
				revision: projectsRevision,
				hint: "projects.json",
			},
			writeCapability: leadTuningWriteCapability(
				capabilities.currentBackend,
				codexHotConfigAvailable,
				lead.model !== undefined && lead.model !== null,
			),
		},
	};
}

function canonicalFile(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function buildRoles(
	project: ProjectEntry,
	loaded: LoadedProjectConfig | undefined,
): ManagementProjectView["roles"] {
	const registryActive = loaded?.handbookRegistryActive === true;
	const entries = registryActive
		? Object.entries(loaded?.resolvedRegistry?.nodes ?? {})
		: Object.entries(loaded?.resolvedAgents ?? {});
	const candidates = entries.map(([name, agent]) => ({
		name,
		agent,
		canonical: canonicalFile(agent.agentFile),
	}));
	const resolvedFiles = Object.entries(loaded?.handbookResolvedFiles ?? {});
	const uniqueLegacyRefs = new Map<string, string>();
	if (!registryActive) {
		for (const [ref, file] of resolvedFiles) {
			const matches = candidates.filter(
				(candidate) =>
					candidate.canonical !== undefined && candidate.canonical === file,
			);
			if (matches.length === 1) uniqueLegacyRefs.set(ref, matches[0]!.name);
		}
	}
	return candidates
		.sort((left, right) => left.name.localeCompare(right.name))
		.map(({ name, agent }) => {
			const agentFile = relative(project.projectRoot, agent.agentFile);
			const source = githubSourceLink(project.projectRepo, agentFile);
			const handbookRefs = registryActive
				? [name, agentFile].filter(
						(ref, index, all) => all.indexOf(ref) === index,
					)
				: [...uniqueLegacyRefs.entries()]
						.filter(([, roleName]) => roleName === name)
						.map(([ref]) => ref)
						.sort();
			return {
				id: `${project.projectName}/role/${name}`,
				name: agent.label,
				department: agent.department,
				agentFile,
				handbookRefs,
				sourceLink: source.link,
				error: source.error,
			};
		});
}

export function buildTopologyView(input: BuildTopologyInput): TopologyView {
	assertUniqueProjects(input.projects);
	const projects: ManagementProjectView[] = [];
	for (const project of [...input.projects].sort((a, b) =>
		a.projectName.localeCompare(b.projectName),
	)) {
		const loaded = input.configs.get(project.projectName);
		const roles = loaded?.config ? buildRoles(project, loaded) : [];
		const handbookRegistryActive = loaded?.handbookRegistryActive === true;
		const handbookRosterAvailable = loaded?.handbookRosterAvailable === true;
		const handbookRosterStatus =
			loaded?.handbookRosterStatus ??
			(handbookRegistryActive ? "not_applicable" : "absent");
		const handbookResolvedRefs = Object.keys(
			loaded?.handbookResolvedFiles ?? {},
		).sort();
		const projectError = loaded?.error ?? loaded?.handbookResolutionError;
		projects.push({
			id: `project/${encodeURIComponent(project.projectName)}`,
			name: project.projectName,
			presentationGroup: project.projectName,
			sourceRevision:
				loaded?.revision ?? registrySourceRevision("config-missing"),
			leads: [...project.leads]
				.sort((a, b) => a.agentId.localeCompare(b.agentId))
				.map((lead) =>
					buildLead(
						project,
						lead,
						input.projectsRevision,
						input.onlineByLead,
						input.codexHotConfigAvailable,
						input.tuningByLead?.get(`${project.projectName}-${lead.agentId}`),
						input.runtimeSettingsByLead?.get(
							`${project.projectName}-${lead.agentId}`,
						),
					),
				),
			roles,
			handbookRegistryActive,
			handbookRosterAvailable,
			handbookRosterStatus,
			handbookResolvedRefs,
			...(loaded?.handbookResolutionError
				? { handbookResolutionError: loaded.handbookResolutionError }
				: {}),
			dags: [],
			crons: [],
			error:
				projectError ??
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
