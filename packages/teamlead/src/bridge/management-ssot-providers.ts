import { createHash } from "node:crypto";
import {
	buildModelCatalog,
	canonicalJsonString,
	type ModelSurface,
} from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
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
					projects: input.projects(),
					configs: input.projectConfigs(),
					projectsRevision: revision,
					onlineByLead: input.onlineByLead?.(),
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
			read: () => ({
				revision: registrySourceRevision(1),
				hint: "flywheel-config/model-registry",
				fragment: {
					modelCatalog: Object.fromEntries(
						MODEL_SURFACES.map((surface) => [
							surface,
							buildModelCatalog(surface),
						]),
					),
				},
			}),
		},
	];
}
