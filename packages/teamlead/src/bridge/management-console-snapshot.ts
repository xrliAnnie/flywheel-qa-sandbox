import { createHash } from "node:crypto";
import {
	canonicalJsonString,
	type ModelCatalog,
	type ModelSurface,
} from "flywheel-config";
import {
	assertManagementSnapshot,
	MANAGEMENT_SCHEMA_VERSION,
	type ManagementCronView,
	type ManagementDagView,
	type ManagementExtensionSection,
	type ManagementFlagView,
	type ManagementProjectView,
	type ManagementRunnerDefaultView,
	type ManagementSnapshotV1,
	type ManagementSourceKind,
	type PresentationGroupView,
} from "./management-console-contract.js";

export interface ManagementSnapshotFragment {
	projects?: ManagementProjectView[];
	presentationGroups?: PresentationGroupView[];
	flags?: ManagementFlagView[];
	extensions?: ManagementExtensionSection[];
	modelCatalog?: Partial<Record<ModelSurface, ModelCatalog>>;
	/** Provider-owned project sections joined after all authority reads complete. */
	projectDags?: Array<{ projectName: string; dags: ManagementDagView[] }>;
	projectCrons?: Array<{ projectName: string; crons: ManagementCronView[] }>;
	projectRunnerDefaults?: Array<{
		projectName: string;
		runnerDefault: ManagementRunnerDefaultView;
	}>;
	unassignedCrons?: ManagementCronView[];
}

export interface ManagementSnapshotProviderResult {
	revision: string;
	fragment: ManagementSnapshotFragment;
	hint?: string;
}

export interface ManagementSnapshotProvider {
	id: string;
	sourceKind: ManagementSourceKind;
	read(): ManagementSnapshotProviderResult;
}

function revisionOf(
	snapshot: Omit<ManagementSnapshotV1, "generatedAt" | "snapshotRevision">,
): string {
	return `snapshot:${createHash("sha256")
		.update(canonicalJsonString(snapshot))
		.digest("hex")}`;
}

export function composeManagementSnapshot(input: {
	providers: readonly ManagementSnapshotProvider[];
	now?: () => Date;
}): ManagementSnapshotV1 {
	const sources: ManagementSnapshotV1["sources"] = [];
	const projects: ManagementProjectView[] = [];
	const presentationGroups: PresentationGroupView[] = [];
	const flags: ManagementFlagView[] = [];
	const extensions: ManagementExtensionSection[] = [];
	const modelCatalog: ManagementSnapshotV1["modelCatalog"] = {};
	const projectDags: Array<{ projectName: string; dags: ManagementDagView[] }> =
		[];
	const projectCrons: Array<{
		projectName: string;
		crons: ManagementCronView[];
	}> = [];
	const projectRunnerDefaults: Array<{
		projectName: string;
		runnerDefault: ManagementRunnerDefaultView;
	}> = [];
	const unassignedCrons: ManagementCronView[] = [];
	for (const provider of [...input.providers].sort((a, b) =>
		a.id.localeCompare(b.id),
	)) {
		try {
			const result = provider.read();
			sources.push({
				kind: provider.sourceKind,
				revision: result.revision,
				hint: result.hint,
				ok: true,
			});
			projects.push(...(result.fragment.projects ?? []));
			presentationGroups.push(...(result.fragment.presentationGroups ?? []));
			flags.push(...(result.fragment.flags ?? []));
			extensions.push(...(result.fragment.extensions ?? []));
			Object.assign(modelCatalog, result.fragment.modelCatalog ?? {});
			projectDags.push(...(result.fragment.projectDags ?? []));
			projectCrons.push(...(result.fragment.projectCrons ?? []));
			projectRunnerDefaults.push(
				...(result.fragment.projectRunnerDefaults ?? []),
			);
			unassignedCrons.push(...(result.fragment.unassignedCrons ?? []));
		} catch (error) {
			sources.push({
				kind: provider.sourceKind,
				revision: "error",
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const projectsByName = new Map(
		projects.map((project) => [project.name, project]),
	);
	for (const section of projectDags) {
		const project = projectsByName.get(section.projectName);
		if (!project) continue;
		project.dags.push(...section.dags);
		project.dags.sort((a, b) => a.title.localeCompare(b.title));
	}
	for (const section of projectCrons) {
		const project = projectsByName.get(section.projectName);
		if (!project) continue;
		project.crons.push(...section.crons);
		project.crons.sort((a, b) => a.sourceHint.localeCompare(b.sourceHint));
	}
	for (const section of projectRunnerDefaults) {
		const project = projectsByName.get(section.projectName);
		if (!project) continue;
		project.runnerDefault = section.runnerDefault;
	}
	unassignedCrons.sort((a, b) => a.sourceHint.localeCompare(b.sourceHint));
	projects.sort((a, b) => a.name.localeCompare(b.name));
	presentationGroups.sort((a, b) => a.id.localeCompare(b.id));
	flags.sort((a, b) => a.name.localeCompare(b.name));
	extensions.sort((a, b) => a.id.localeCompare(b.id));
	const revisionInput = {
		schemaVersion: MANAGEMENT_SCHEMA_VERSION,
		sources,
		modelCatalog,
		projects,
		presentationGroups,
		unassignedCrons,
		flags,
		extensions,
	};
	const snapshot: ManagementSnapshotV1 = {
		...revisionInput,
		generatedAt: (input.now ?? (() => new Date()))().toISOString(),
		snapshotRevision: revisionOf(revisionInput),
	};
	assertManagementSnapshot(snapshot);
	return snapshot;
}
