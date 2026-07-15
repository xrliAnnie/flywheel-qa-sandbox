import { createHash } from "node:crypto";
import {
	canonicalJsonString,
	type ModelCatalog,
	type ModelSurface,
} from "flywheel-config";
import {
	assertManagementSnapshot,
	MANAGEMENT_SCHEMA_VERSION,
	type ManagementExtensionSection,
	type ManagementFlagView,
	type ManagementProjectView,
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
		} catch (error) {
			sources.push({
				kind: provider.sourceKind,
				revision: "error",
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

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
