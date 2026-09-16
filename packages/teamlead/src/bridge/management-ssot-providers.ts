import { createHash } from "node:crypto";
import {
	canonicalJsonString,
	getModelConfigSnapshot,
	type ModelSurface,
} from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { LeadConfigView } from "./lead-config-service.js";
import { registrySourceRevision } from "./management-console-contract.js";
import type { ManagementSnapshotProvider } from "./management-console-snapshot.js";
import {
	buildTopologyView,
	type LoadedProjectConfig,
} from "./management-topology-source.js";

const MODEL_SURFACES: readonly ModelSurface[] = [
	"dispatch",
	"lead",
	"runner",
	"workflow",
	"cron",
];

export interface ManagementSsotSources {
	tuningByLead?(): ReadonlyMap<string, LeadConfigView | undefined>;
	codexHotConfigAvailable?: boolean;
	projects(): ProjectEntry[];
	projectsRevision(): string;
	projectConfigs(): ReadonlyMap<string, LoadedProjectConfig>;
	onlineByLead?(): ReadonlyMap<
		string,
		"online" | "offline" | "degraded" | "unknown"
	>;
}

function configRevision(
	configs: ReadonlyMap<string, LoadedProjectConfig>,
): string {
	const provenance = [...configs.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => ({
			name,
			revision: value.revision,
			error: value.error,
		}));
	return `config:${createHash("sha256")
		.update(canonicalJsonString(provenance))
		.digest("hex")}`;
}

/**
 * Adapters from the real backend authorities into the management snapshot.
 * Every `read()` is live; no project, Lead, or model option is copied into a
 * frontend-specific list.
 */
export function createManagementSsotProviders(
	input: ManagementSsotSources,
): readonly ManagementSnapshotProvider[] {
	return [
		{
			id: "topology",
			sourceKind: "projects_json",
			read: () => {
				const revision = input.projectsRevision();
				const topology = buildTopologyView({
					codexHotConfigAvailable: input.codexHotConfigAvailable,
					projects: input.projects(),
					configs: input.projectConfigs(),
					projectsRevision: revision,
					onlineByLead: input.onlineByLead?.(),
					tuningByLead: input.tuningByLead?.(),
				});
				return {
					revision,
					hint: "~/.flywheel/projects.json",
					fragment: topology,
				};
			},
		},
		{
			id: "project-configs",
			sourceKind: "project_config",
			read: () => ({
				revision: configRevision(input.projectConfigs()),
				hint: "<project>/.flywheel/config.yaml",
				fragment: {},
			}),
		},
		{
			id: "model-registry",
			sourceKind: "model_registry",
			read: () => {
				const snapshot = getModelConfigSnapshot();
				return {
					revision: registrySourceRevision(snapshot.revision),
					hint: snapshot.sourcePath,
					fragment: {
						modelCatalog: Object.fromEntries(
							MODEL_SURFACES.map((surface) => [
								surface,
								snapshot.buildModelCatalog(surface),
							]),
						),
					},
				};
			},
		},
	];
}
