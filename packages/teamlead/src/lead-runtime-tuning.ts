import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { compileLeadIdentityRows } from "flywheel-comm/lead-identity";
import { readRegularFileNoFollow } from "flywheel-comm/lead-registry-file-io";
import { readSummaryGranularity } from "flywheel-comm/summary-config";
import { verifySummaryRegistryActivation } from "flywheel-comm/summary-registry-migration";
import {
	canonicalSubmissionDigest,
	getModelConfigSnapshot,
} from "flywheel-config";
import { validateProjectsText } from "./bin/validate-projects.js";
import type { CodexLeadRuntimeConfig } from "./lead-backends/codex/codex-lead-runtime.js";

/** Read immediately before start/resume; inherited launch tuning is never a fallback. */
export function readLeadRuntimeSource(
	config: Pick<
		CodexLeadRuntimeConfig,
		| "projectsFile"
		| "projectName"
		| "leadId"
		| "leadKey"
		| "identityDigest"
		| "botUserId"
		| "modelContextWindow"
	>,
	options: { home?: string; receiptPath?: string } = {},
) {
	const home = options.home ?? homedir();
	const projectsPath =
		config.projectsFile ?? join(home, ".flywheel/projects.json");
	const receiptPath =
		options.receiptPath ??
		join(home, ".flywheel/state/summary-registry/migration-receipt.json");
	if (!isAbsolute(projectsPath) || !isAbsolute(receiptPath))
		throw new Error("registry_path_invalid");
	if (existsSync(`${receiptPath}.lead-registry-intent.json`))
		throw new Error("lead_registry_recovery_required");
	const source = readRegularFileNoFollow(projectsPath, "projects registry");
	const receipt = readRegularFileNoFollow(receiptPath, "summary receipt");
	const selection = readSummaryGranularity({ homeDir: home });
	verifySummaryRegistryActivation(
		{ projectsPath, receiptPath, homeDir: home },
		{
			validateTeamleadCandidate: (path) => {
				if (
					validateProjectsText(
						readRegularFileNoFollow(path, "projects candidate"),
					).code !== 0
				)
					throw new Error("projects_schema_invalid");
			},
		},
	);
	const matches = compileLeadIdentityRows(JSON.parse(source), {
		homeDir: home,
		summarySelection: selection,
	}).filter(
		(row) =>
			row.identity.projectName === config.projectName &&
			row.identity.leadId === config.leadId,
	);
	if (matches.length !== 1) throw new Error("lead_identity_not_found");
	const identity = matches[0]!.identity;
	if (
		identity.backend !== "codex-app-server" ||
		identity.leadKey !== config.leadKey ||
		identity.identityDigest !== config.identityDigest ||
		identity.botUserId !== config.botUserId ||
		identity.modelContextWindow !== config.modelContextWindow
	)
		throw new Error("lead_runtime_identity_changed");
	const snapshot = getModelConfigSnapshot();
	const model = identity.model
		? snapshot.getModelRegistryEntry(identity.model)?.id
		: undefined;
	if (
		identity.model &&
		(!model ||
			!snapshot.isModelSelectionSupported({
				surface: "lead",
				model,
				effort: identity.effort,
				runtimeVendor: "codex",
			}))
	)
		throw new Error("unsupported_lead_model_selection");
	if (
		readRegularFileNoFollow(projectsPath, "projects registry") !== source ||
		readRegularFileNoFollow(receiptPath, "summary receipt") !== receipt ||
		JSON.stringify(readSummaryGranularity({ homeDir: home })) !==
			JSON.stringify(selection) ||
		existsSync(`${receiptPath}.lead-registry-intent.json`)
	)
		throw new Error("registry_source_changed_during_validation");
	const postimage = {
		...(identity.model !== undefined ? { model: identity.model } : {}),
		...(identity.effort !== undefined ? { effort: identity.effort } : {}),
	};
	return {
		model,
		reasoningEffort: identity.effort,
		modelRegistryRevision: snapshot.revision,
		configDigest:
			model && identity.effort
				? canonicalSubmissionDigest({
						leadKey: identity.leadKey,
						identityDigest: identity.identityDigest,
						postimage,
						resolved: { model, effort: identity.effort },
						modelRegistryRevision: snapshot.revision,
					})
				: undefined,
	};
}

export function readLeadRuntimeTuning(
	...args: Parameters<typeof readLeadRuntimeSource>
): Pick<CodexLeadRuntimeConfig, "model" | "reasoningEffort"> {
	const { model, reasoningEffort } = readLeadRuntimeSource(...args);
	return { model, reasoningEffort };
}
