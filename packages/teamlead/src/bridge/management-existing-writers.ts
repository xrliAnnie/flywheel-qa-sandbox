import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	type ApplyResult,
	applyRunnerDefaults,
	canonicalJsonString,
	FEATURE_FLAGS,
	type FlagView,
	type FlywheelConfig,
	getModelRegistryEntry,
	type RunnerDefaultsChange,
	readEnvFileSource,
	resolveAllFlags,
	STORE_MANAGED_FLAGS,
} from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { computeEnvSha } from "./env-file-writer.js";
import { formatFlagDivergence } from "./feature-flag-render.js";
import {
	applyFlagToggle,
	type FlagToggleDeps,
	isDirectToggleable,
} from "./flag-toggle.js";
import {
	buildCanonicalRequest,
	type CanonicalRequest,
	newBatchId,
} from "./fleet-admin.js";
import { computeLeadCapabilities } from "./fleet-capabilities.js";
import {
	buildTargetId,
	fileSourceRevision,
	type ManagedValue,
	type ManagementFlagView,
	type ManagementRunnerDefaultView,
	type ModelSelection,
} from "./management-console-contract.js";
import type { ManagementSnapshotProvider } from "./management-console-snapshot.js";
import type { CronSourceTarget } from "./management-cron-source.js";
import type { ManagementCronWriter } from "./management-cron-writer.js";
import { readManagementDags } from "./management-dag-source.js";
import { applyManagementDagEdit } from "./management-dag-writer.js";
import type { LoadedProjectConfig } from "./management-topology-source.js";
import {
	type ManagementPreparedChange,
	type ManagementResolvedTarget,
	type ManagementWriter,
	type ManagementWriterResult,
	preparedChange,
	rejectedPreflight,
} from "./management-writer.js";

type MaybePromise<T> = T | Promise<T>;

export interface ExistingManagementWriterDeps {
	projects(): ProjectEntry[];
	projectsRevision(): string;
	projectConfigs(): ReadonlyMap<string, LoadedProjectConfig>;
	readProjectConfig(path: string): string;
	applyRunner?: (
		configPath: string,
		change: RunnerDefaultsChange,
		opts: { expectedSha?: string },
	) => Promise<ApplyResult>;
	/** Existing Fleet engine/canonical request seam, never an Express route. */
	applyLeadCanonical(
		request: CanonicalRequest,
	): MaybePromise<ManagementWriterResult>;
	envPath: string;
	readEnvFile(path: string): string;
	writeEnvFile?: (path: string, content: string) => void;
	env?: Record<string, string | undefined>;
	flagViews?: () => FlagView[];
	flagLock?: FlagToggleDeps["lock"];
}

export interface ManagementRunnerProviderInput {
	projects(): ProjectEntry[];
	projectConfigs(): ReadonlyMap<string, LoadedProjectConfig>;
}

export interface ManagementFlagProviderInput {
	views(): FlagView[];
	revision(): string;
	projectNames(): string[];
}

/** Revision covers both persisted `.env` bytes and the Bridge's live call-time values. */
export function managementFlagRevision(
	envFile: string,
	env: Record<string, string | undefined>,
): string {
	const liveDirectValues = FEATURE_FLAGS.filter(
		(spec) => spec.envVar && isDirectToggleable(spec),
	)
		.map((spec): [string, string | null] => [
			spec.envVar as string,
			env[spec.envVar as string] ?? null,
		])
		.sort(([a], [b]) => a.localeCompare(b));
	return `flags:${createHash("sha256")
		.update(
			canonicalJsonString({
				fileSha: computeEnvSha(envFile),
				liveDirectValues,
			}),
		)
		.digest("hex")}`;
}

function rawSha(revision: string): string {
	return revision.startsWith("file:")
		? revision.slice("file:".length)
		: revision;
}

function exactRecord(
	value: unknown,
	allowed: readonly string[],
): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !allowed.includes(key))) return null;
	return record;
}

function parseSelection(
	value: unknown,
	surface: "lead" | "runner" | "workflow" | "cron",
): ModelSelection | null | { error: string } {
	if (value === null) return null;
	const record = exactRecord(value, ["provider", "model", "effort"]);
	if (!record) return { error: "model selection has unknown fields" };
	if (
		typeof record.provider !== "string" ||
		typeof record.model !== "string" ||
		("effort" in record &&
			record.effort !== null &&
			typeof record.effort !== "string")
	) {
		return { error: "provider/model strings and optional effort are required" };
	}
	const entry = getModelRegistryEntry(record.model);
	if (!entry || !entry.surfaces.includes(surface)) {
		return { error: `model is not registered for ${surface}: ${record.model}` };
	}
	if (entry.provider !== record.provider) {
		return { error: `provider does not own model: ${record.model}` };
	}
	const effort = record.effort as string | null | undefined;
	if (
		effort != null &&
		!(entry.effortsBySurface[surface] ?? []).includes(effort as never)
	) {
		return { error: `effort is not supported for ${record.model}: ${effort}` };
	}
	return {
		provider: entry.provider,
		model: entry.id,
		effort: effort ?? null,
	};
}

function selectionFromRunner(
	config: FlywheelConfig | undefined,
): ModelSelection | null {
	const runner = config?.roles?.runner;
	if (!runner?.model) return null;
	const entry = getModelRegistryEntry(runner.model);
	return {
		provider:
			entry?.provider ??
			(runner.backend === "codex-tmux" ? "openai" : "anthropic"),
		model: entry?.id ?? runner.model,
		effort: runner.effort ?? null,
	};
}

function selectionFromLead(
	lead: ProjectEntry["leads"][number],
): ModelSelection | null {
	if (!lead.model) return null;
	const entry = getModelRegistryEntry(lead.model);
	return {
		provider:
			entry?.provider ??
			(lead.backend === "codex-app-server" ? "openai" : "anthropic"),
		model: entry?.id ?? lead.model,
		effort: lead.effort ?? null,
	};
}

function runnerManagedValue(
	project: ProjectEntry,
	loaded: LoadedProjectConfig | undefined,
): ManagedValue<ModelSelection | null> {
	const writable = Boolean(loaded?.config) && !loaded?.error;
	return {
		targetId: buildTargetId("runner", [
			project.projectName,
			"default",
			"dispatch",
		]),
		current: selectionFromRunner(loaded?.config),
		source: {
			kind: "project_config",
			revision: loaded?.revision ?? "registry:config-missing",
			hint: `${project.projectName}/.flywheel/config.yaml`,
		},
		writeCapability: {
			writable,
			reason:
				loaded?.error ?? (writable ? undefined : "项目配置不存在或未加载"),
			consequence: writable ? "new-run" : "governance-readonly",
			requiresAcknowledgement: false,
		},
	};
}

/** Live runner-default projection joined onto the topology provider by project. */
export function createManagementRunnerProvider(
	input: ManagementRunnerProviderInput,
): ManagementSnapshotProvider {
	return {
		id: "runner-defaults",
		sourceKind: "project_config",
		read: () => {
			const configs = input.projectConfigs();
			const rows = input.projects().map((project) => ({
				projectName: project.projectName,
				runnerDefault: {
					dispatch: runnerManagedValue(
						project,
						configs.get(project.projectName),
					),
				} satisfies ManagementRunnerDefaultView,
			}));
			const revision = `configs:${createHash("sha256")
				.update(
					canonicalJsonString(
						rows.map((row) => ({
							projectName: row.projectName,
							revision: row.runnerDefault.dispatch.source.revision,
						})),
					),
				)
				.digest("hex")}`;
			return {
				revision,
				hint: "roles.runner",
				fragment: { projectRunnerDefaults: rows },
			};
		},
	};
}

function registryPolicyReason(view: FlagView): string {
	if (view.projectStoreManaged) {
		return "scoped SQLite rows are read-only here; use flywheel-comm feature-flags set --project (or clear --project)";
	}
	if (view.storeManaged) return "flag value is owned by the SQLite flag store";
	if (view.dormant) return "flag registry: dormant runtime path";
	if (view.category === "governance_gate") {
		return "flag registry: governance flag is readonly";
	}
	if (view.toggleable === "conversational") {
		return "flag registry: conversational change requires a separate workflow";
	}
	if (view.toggleable === "readonly") {
		return `flag registry: readonly${view.note ? ` (${view.note})` : ""}`;
	}
	return "flag registry: unsupported write path";
}

function flagManagedValue(input: {
	view: FlagView;
	current: unknown;
	targetId: string;
	revision: string;
	scopeMismatch?: string;
	error?: string;
}): ManagedValue<unknown> {
	const spec = FEATURE_FLAGS.find(
		(candidate) => candidate.name === input.view.name,
	);
	const direct = Boolean(
		spec && !input.view.storeManaged && isDirectToggleable(spec),
	);
	const writable = direct && !input.scopeMismatch && !input.error;
	return {
		targetId: input.targetId,
		current: input.current,
		source: {
			kind: "flag_registry",
			revision: input.revision,
			hint: input.view.envVar ?? input.view.configKey ?? input.view.source,
		},
		writeCapability: {
			writable,
			reason:
				input.scopeMismatch ??
				input.error ??
				(writable ? undefined : registryPolicyReason(input.view)),
			consequence: writable ? "hot" : "governance-readonly",
			requiresAcknowledgement: false,
		},
		error: input.error,
	};
}

function buildFlagView(
	view: FlagView,
	revision: string,
	projectNames: readonly string[],
): ManagementFlagView {
	const starRow = view.scopedStore?.rows.find((row) => row.scope === "*");
	const global = flagManagedValue({
		view,
		current:
			view.scope === "bridge_global"
				? (view.storeEffective ?? view.displayEffective ?? null)
				: (starRow?.value ?? view.default),
		targetId: buildTargetId("flag", [view.name, "global"]),
		revision,
		scopeMismatch:
			view.scope === "project"
				? view.projectStoreManaged
					? registryPolicyReason(view)
					: "project-scoped flag has no global override"
				: undefined,
		error: view.error ?? formatFlagDivergence(view),
	});
	const effectiveByProject = new Map(
		(view.effectiveByProject ?? []).map((row) => [row.projectName, row]),
	);
	const projectOverrides = projectNames.map((projectName) => {
		const row = effectiveByProject.get(projectName);
		return {
			projectName,
			value: flagManagedValue({
				view,
				current: row?.value ?? null,
				targetId: buildTargetId("flag", [view.name, "project", projectName]),
				revision,
				scopeMismatch:
					view.scope === "bridge_global"
						? "global-only flag does not support project overrides"
						: undefined,
				error: row?.error,
			}),
		};
	});
	return {
		id: `flag/${encodeURIComponent(view.name)}`,
		name: view.name,
		description: view.description,
		category: view.category,
		global,
		projectOverrides,
	};
}

export function createManagementFlagProvider(
	input: ManagementFlagProviderInput,
): ManagementSnapshotProvider {
	return {
		id: "feature-flags",
		sourceKind: "flag_registry",
		read: () => {
			const revision = input.revision();
			const names = input.projectNames().sort((a, b) => a.localeCompare(b));
			const views = input.views();
			return {
				revision,
				hint: "flywheel-config/feature-flags",
				fragment: {
					flags: views.map((view) =>
						buildFlagView(view, revision, names),
					),
				},
			};
		},
	};
}

function resolveLeadTarget(
	deps: ExistingManagementWriterDeps,
	targetId: string,
): (ManagementResolvedTarget & { projectName: string; leadId: string }) | null {
	for (const project of deps.projects()) {
		for (const lead of project.leads) {
			if (
				buildTargetId("lead", [
					project.projectName,
					lead.agentId,
					"dispatch",
				]) !== targetId
			) {
				continue;
			}
			const capability = computeLeadCapabilities(lead);
			const writable = capability.currentBackend === "claude-code";
			return {
				targetId,
				kind: "lead",
				projectName: project.projectName,
				leadId: lead.agentId,
				currentValue: selectionFromLead(lead),
				sourceRevision: deps.projectsRevision(),
				writeCapability: {
					writable,
					reason: writable ? undefined : "当前 Lead backend 不支持受管模型写回",
					consequence: writable ? "restart-lead" : "governance-readonly",
					requiresAcknowledgement: writable,
				},
			};
		}
	}
	return null;
}

function leadCanonical(
	deps: ExistingManagementWriterDeps,
	targetId: string,
	desired: ModelSelection | null,
): CanonicalRequest {
	const resolved = resolveLeadTarget(deps, targetId);
	if (!resolved) throw new Error("unknown Lead target");
	const project = deps
		.projects()
		.find((candidate) => candidate.projectName === resolved.projectName);
	const lead = project?.leads.find(
		(candidate) => candidate.agentId === resolved.leadId,
	);
	if (!lead) throw new Error("Lead target disappeared");
	const key = `${resolved.projectName}-${resolved.leadId}`;
	const change = {
		key,
		toModel: desired?.model ?? null,
		toEffort: desired?.effort ?? null,
	};
	return buildCanonicalRequest(
		newBatchId(),
		rawSha(deps.projectsRevision()),
		new Map([[key, lead.model ?? null]]),
		new Map([[key, lead.effort ?? null]]),
		[change],
	);
}

function leadCanonicalGroup(
	deps: ExistingManagementWriterDeps,
	changes: readonly ManagementPreparedChange[],
): CanonicalRequest {
	const models = new Map<string, string | null>();
	const efforts = new Map<string, string | null>();
	const drafts: Array<{
		key: string;
		toModel: string | null;
		toEffort: string | null;
	}> = [];
	for (const change of changes) {
		const resolved = resolveLeadTarget(deps, change.targetId);
		if (!resolved) throw new Error("Lead target disappeared");
		const lead = deps
			.projects()
			.find((project) => project.projectName === resolved.projectName)
			?.leads.find((candidate) => candidate.agentId === resolved.leadId);
		if (!lead) throw new Error("Lead target disappeared");
		const desired = parseSelection(change.newValue, "lead");
		if (desired && "error" in desired) throw new Error(desired.error);
		const key = `${resolved.projectName}-${resolved.leadId}`;
		models.set(key, lead.model ?? null);
		efforts.set(key, lead.effort ?? null);
		drafts.push({
			key,
			toModel: desired?.model ?? null,
			toEffort: desired?.effort ?? null,
		});
	}
	return buildCanonicalRequest(
		newBatchId(),
		rawSha(deps.projectsRevision()),
		models,
		efforts,
		drafts,
	);
}

async function applySequentiallyAgainstCurrentAuthority(
	writer: ManagementWriter,
	changes: readonly ManagementPreparedChange[],
): Promise<ManagementWriterResult[]> {
	const results: ManagementWriterResult[] = [];
	for (const change of changes) {
		const current = await writer.resolve(change.targetId);
		if (!current) {
			results.push({ status: "rejected", reason: "target disappeared" });
			continue;
		}
		if (
			canonicalJsonString(current.currentValue) !==
			canonicalJsonString(change.oldValue)
		) {
			results.push({
				status: "rejected",
				reason: "target value changed outside this approved batch",
			});
			continue;
		}
		results.push(
			await writer.apply({
				...change,
				oldValue: current.currentValue,
				sourceRevision: current.sourceRevision,
			}),
		);
	}
	return results;
}

function createLeadWriter(
	deps: ExistingManagementWriterDeps,
): ManagementWriter {
	const writer: ManagementWriter = {
		id: "existing-fleet-lead-v1",
		kind: "lead",
		resolve: (targetId) => resolveLeadTarget(deps, targetId),
		preflight: (target, desiredValue, observedRevision) => {
			if (observedRevision !== target.sourceRevision) {
				return rejectedPreflight(
					"stale_source",
					"projects.json changed since view",
				);
			}
			if (!target.writeCapability.writable) {
				return rejectedPreflight(
					"readonly_cross_provider",
					target.writeCapability.reason ?? "Lead is readonly",
				);
			}
			const record = exactRecord(desiredValue, ["provider", "model", "effort"]);
			if (desiredValue !== null && !record) {
				return rejectedPreflight(
					"readonly_cross_provider",
					"backend/provider authority cannot be changed in v1",
				);
			}
			if (record && record.provider !== "anthropic") {
				return rejectedPreflight(
					"readonly_cross_provider",
					"readonly_cross_provider: Lead provider/backend changes require manual cutover",
				);
			}
			const desired = parseSelection(desiredValue, "lead");
			if (desired && "error" in desired) {
				return rejectedPreflight("invalid_desired_value", desired.error);
			}
			try {
				leadCanonical(deps, target.targetId, desired);
			} catch (error) {
				return rejectedPreflight(
					"invalid_desired_value",
					error instanceof Error ? error.message : String(error),
				);
			}
			return preparedChange({ writer, target, newValue: desired });
		},
		apply: async (change) => {
			const target = await writer.resolve(change.targetId);
			if (!target)
				return { status: "rejected", reason: "Lead target disappeared" };
			const checked = await writer.preflight(
				target,
				change.newValue,
				change.sourceRevision,
			);
			if (!checked.ok) return { status: "rejected", reason: checked.reason };
			if (checked.status === "no_op") return { status: "no_op" };
			const desired = parseSelection(change.newValue, "lead");
			if (desired && "error" in desired) {
				return { status: "rejected", reason: desired.error };
			}
			return deps.applyLeadCanonical(
				leadCanonical(deps, change.targetId, desired),
			);
		},
		applyGroup: async (changes) => {
			try {
				const result = await deps.applyLeadCanonical(
					leadCanonicalGroup(deps, changes),
				);
				return changes.map(() => structuredClone(result));
			} catch (error) {
				return changes.map(() => ({
					status: "rejected",
					reason: error instanceof Error ? error.message : String(error),
				}));
			}
		},
	};
	return writer;
}

function resolveRunnerTarget(
	deps: ExistingManagementWriterDeps,
	targetId: string,
): (ManagementResolvedTarget & { projectName: string }) | null {
	const configs = deps.projectConfigs();
	for (const project of deps.projects()) {
		const managed = runnerManagedValue(
			project,
			configs.get(project.projectName),
		);
		if (managed.targetId !== targetId) continue;
		return {
			targetId,
			kind: "runner",
			projectName: project.projectName,
			currentValue: managed.current,
			sourceRevision: managed.source.revision,
			writeCapability: managed.writeCapability,
		};
	}
	return null;
}

function runnerChange(desired: ModelSelection | null): RunnerDefaultsChange {
	if (!desired) return { backend: null, model: null, effort: null };
	return {
		backend: desired.provider === "openai" ? "codex-tmux" : "claude-tmux",
		model: desired.model,
		effort: desired.effort ?? null,
	};
}

function runnerPath(
	deps: ExistingManagementWriterDeps,
	targetId: string,
): string {
	const target = resolveRunnerTarget(deps, targetId);
	if (!target) throw new Error("runner target disappeared");
	const matches = deps
		.projects()
		.filter((project) => project.projectName === target.projectName);
	if (matches.length !== 1) {
		throw new Error("runner project is missing or ambiguous");
	}
	return join(matches[0]!.projectRoot, ".flywheel", "config.yaml");
}

function createRunnerWriter(
	deps: ExistingManagementWriterDeps,
): ManagementWriter {
	const writer: ManagementWriter = {
		id: "existing-runner-config-v1",
		kind: "runner",
		resolve: (targetId) => resolveRunnerTarget(deps, targetId),
		preflight: (target, desiredValue, observedRevision) => {
			if (observedRevision !== target.sourceRevision) {
				return rejectedPreflight(
					"stale_source",
					"config.yaml changed since view",
				);
			}
			if (!target.writeCapability.writable) {
				return rejectedPreflight(
					"readonly",
					target.writeCapability.reason ?? "runner default is readonly",
				);
			}
			const desired = parseSelection(desiredValue, "runner");
			if (desired && "error" in desired) {
				return rejectedPreflight("invalid_desired_value", desired.error);
			}
			try {
				const content = deps.readProjectConfig(
					runnerPath(deps, target.targetId),
				);
				if (
					fileSourceRevision(Buffer.from(content)) !== target.sourceRevision
				) {
					return rejectedPreflight(
						"stale_source",
						"config cache no longer matches config.yaml",
					);
				}
			} catch (error) {
				return rejectedPreflight(
					"stale_source",
					error instanceof Error ? error.message : String(error),
				);
			}
			return preparedChange({ writer, target, newValue: desired });
		},
		apply: async (change) => {
			const target = await writer.resolve(change.targetId);
			if (!target)
				return { status: "rejected", reason: "runner target disappeared" };
			const checked = await writer.preflight(
				target,
				change.newValue,
				change.sourceRevision,
			);
			if (!checked.ok) return { status: "rejected", reason: checked.reason };
			if (checked.status === "no_op") return { status: "no_op" };
			const desired = parseSelection(change.newValue, "runner");
			if (desired && "error" in desired) {
				return { status: "rejected", reason: desired.error };
			}
			try {
				const result = await (deps.applyRunner ?? applyRunnerDefaults)(
					runnerPath(deps, change.targetId),
					runnerChange(desired),
					{ expectedSha: rawSha(change.sourceRevision) },
				);
				return {
					status: result.changed.length ? "applied" : "no_op",
					details: result,
				};
			} catch (error) {
				return {
					status: "rejected",
					reason: error instanceof Error ? error.message : String(error),
				};
			}
		},
		applyGroup: (changes) =>
			applySequentiallyAgainstCurrentAuthority(writer, changes),
	};
	return writer;
}

function flagViews(deps: ExistingManagementWriterDeps): FlagView[] {
	return (
		deps.flagViews?.() ??
		resolveAllFlags({
			env: deps.env,
			envFile: readEnvFileSource(deps.envPath, deps.readEnvFile),
		})
	);
}

function resolveFlagTarget(
	deps: ExistingManagementWriterDeps,
	targetId: string,
): ManagementResolvedTarget | null {
	const revision = managementFlagRevision(
		deps.readEnvFile(deps.envPath),
		deps.env ?? process.env,
	);
	const names = deps.projects().map((project) => project.projectName);
	for (const view of flagViews(deps)) {
		const built = buildFlagView(view, revision, names);
		if (built.global.targetId === targetId) {
			return {
				targetId,
				kind: "flag",
				currentValue: built.global.current,
				sourceRevision: built.global.source.revision,
				writeCapability: built.global.writeCapability,
			};
		}
		for (const override of built.projectOverrides) {
			if (override.value.targetId !== targetId) continue;
			return {
				targetId,
				kind: "flag",
				currentValue: override.value.current,
				sourceRevision: override.value.source.revision,
				writeCapability: override.value.writeCapability,
			};
		}
	}
	return null;
}

function directFlagName(targetId: string): string | null {
	for (const spec of FEATURE_FLAGS) {
		if (buildTargetId("flag", [spec.name, "global"]) === targetId)
			return spec.name;
	}
	return null;
}

function createFlagWriter(
	deps: ExistingManagementWriterDeps,
): ManagementWriter {
	const writer: ManagementWriter = {
		id: "existing-direct-flag-v1",
		kind: "flag",
		resolve: (targetId) => resolveFlagTarget(deps, targetId),
		preflight: (target, desiredValue, observedRevision) => {
			if (observedRevision !== target.sourceRevision) {
				return rejectedPreflight("stale_source", ".env changed since view");
			}
			const managedName = directFlagName(target.targetId);
			if (managedName && STORE_MANAGED_FLAGS.has(managedName)) {
				return rejectedPreflight(
					"readonly_registry_policy",
					"flag value is owned by the SQLite flag store",
				);
			}
			if (!target.writeCapability.writable) {
				return rejectedPreflight(
					"readonly_registry_policy",
					target.writeCapability.reason ??
						"flag registry marks target readonly",
				);
			}
			// FLY-1356: enum direct flags take a string ∈ enumValues; bool flags
			// keep the boolean-only contract (byte-compat).
			const pfName = directFlagName(target.targetId);
			const pfSpec = FEATURE_FLAGS.find((c) => c.name === pfName);
			if (pfSpec?.valueKind === "enum") {
				if (
					typeof desiredValue !== "string" ||
					!pfSpec.enumValues?.includes(desiredValue)
				) {
					return rejectedPreflight(
						"invalid_desired_value",
						`enum flag desired value must be one of ${(pfSpec.enumValues ?? []).join("|")}`,
					);
				}
				return preparedChange({ writer, target, newValue: desiredValue });
			}
			if (typeof desiredValue !== "boolean") {
				return rejectedPreflight(
					"invalid_desired_value",
					"direct flag desired value must be boolean",
				);
			}
			return preparedChange({ writer, target, newValue: desiredValue });
		},
		apply: async (change) => {
			const target = await writer.resolve(change.targetId);
			if (!target)
				return { status: "rejected", reason: "flag target disappeared" };
			const checked = await writer.preflight(
				target,
				change.newValue,
				change.sourceRevision,
			);
			if (!checked.ok) return { status: "rejected", reason: checked.reason };
			if (checked.status === "no_op") return { status: "no_op" };
			const name = directFlagName(change.targetId);
			const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
			if (!name || !spec?.envVar || !isDirectToggleable(spec)) {
				return { status: "rejected", reason: "flag is not direct-toggleable" };
			}
			// Re-capture the reviewed authorities as one baseline after preflight.
			// If either source changed in the await gap, reject instead of adopting
			// the new bytes/value as an unreviewed apply baseline. applyFlagToggle
			// rechecks both again under its file lock, closing the remaining gap.
			const authorityEnv = deps.env ?? process.env;
			const authorityFile = deps.readEnvFile(deps.envPath);
			if (
				managementFlagRevision(authorityFile, authorityEnv) !==
				change.sourceRevision
			) {
				return {
					status: "rejected",
					reason: ".env or live flag value changed since review",
				};
			}
			const rawFrom = authorityEnv[spec.envVar] ?? null;
			// FLY-1356: enum flags write the target value ITSELF (always explicit,
			// never delete — matches the flag-routes stage policy). Bool flags keep
			// the per-polarity delete-on-default policy byte-identically.
			let rawTo: string | null;
			if (spec.valueKind === "enum") {
				rawTo = String(change.newValue);
			} else {
				const desired = change.newValue as boolean;
				rawTo =
					spec.polarity === "default_on"
						? desired
							? null
							: "0"
						: desired
							? "1"
							: null;
			}
			const result = applyFlagToggle(
				{
					envPath: deps.envPath,
					readFile: deps.readEnvFile,
					writeFile: deps.writeEnvFile,
					env: deps.env,
					lock: deps.flagLock,
				},
				{
					name,
					rawFrom,
					rawTo,
					fileSha: computeEnvSha(authorityFile),
				},
			);
			return result.ok
				? { status: "applied", details: result }
				: { status: "rejected", reason: result.reason, details: result };
		},
		applyGroup: (changes) =>
			applySequentiallyAgainstCurrentAuthority(writer, changes),
	};
	return writer;
}

export function createExistingManagementWriters(
	deps: ExistingManagementWriterDeps,
): {
	lead: ManagementWriter;
	runner: ManagementWriter;
	flag: ManagementWriter;
} {
	return {
		lead: createLeadWriter(deps),
		runner: createRunnerWriter(deps),
		flag: createFlagWriter(deps),
	};
}

export function createManagementDagWriter(input: {
	store: StateStore;
	projectNames(): readonly string[];
	actor: string;
}): ManagementWriter {
	const resolve = (targetId: string): ManagementResolvedTarget | null => {
		for (const section of readManagementDags({
			reader: input.store,
			projectNames: input.projectNames(),
		}).projectDags) {
			for (const dag of section.dags) {
				for (const node of dag.nodes) {
					if (node.dispatch.targetId !== targetId) continue;
					return {
						targetId,
						kind: "dag",
						currentValue: node.dispatch.current,
						sourceRevision: node.dispatch.source.revision,
						writeCapability: node.dispatch.writeCapability,
					};
				}
			}
		}
		return null;
	};
	const writer: ManagementWriter = {
		id: "workflow-catalog-v1",
		kind: "dag",
		resolve,
		preflight: (target, desiredValue, observedRevision) => {
			if (observedRevision !== target.sourceRevision) {
				return rejectedPreflight("stale_source", "workflow revision changed");
			}
			if (!target.writeCapability.writable) {
				return rejectedPreflight(
					"readonly",
					target.writeCapability.reason ?? "workflow node is readonly",
				);
			}
			const desired = parseSelection(desiredValue, "workflow");
			if (!desired || "error" in desired) {
				return rejectedPreflight(
					"invalid_desired_value",
					desired && "error" in desired
						? desired.error
						: "workflow selection cannot be null",
				);
			}
			return preparedChange({ writer, target, newValue: desired });
		},
		apply: async (change) => {
			const target = resolve(change.targetId);
			if (!target)
				return { status: "rejected", reason: "DAG target disappeared" };
			const checked = await writer.preflight(
				target,
				change.newValue,
				change.sourceRevision,
			);
			if (!checked.ok) return { status: "rejected", reason: checked.reason };
			if (checked.status === "no_op") return { status: "no_op" };
			const match = /^db:(\d+):(.+)$/.exec(change.sourceRevision);
			if (!match) return { status: "rejected", reason: "invalid DAG revision" };
			const result = applyManagementDagEdit({
				store: input.store,
				targetId: change.targetId,
				expectedRevision: Number(match[1]),
				expectedDigest: match[2]!,
				desired: change.newValue as ModelSelection,
				actor: input.actor,
			});
			return result.status === "published"
				? { status: "applied", details: result }
				: {
						status: "rejected",
						reason:
							"reason" in result
								? result.reason
								: `workflow write ${result.status}`,
						details: result,
					};
		},
		applyGroup: (changes) =>
			applySequentiallyAgainstCurrentAuthority(writer, changes),
	};
	return writer;
}

function cronManagedTarget(
	targets: readonly CronSourceTarget[],
	targetId: string,
): ManagementResolvedTarget | null {
	for (const target of targets) {
		for (const managed of [
			target.view.schedule,
			target.view.enabled,
			target.view.model,
		]) {
			if (!managed || managed.targetId !== targetId) continue;
			return {
				targetId,
				kind: "cron",
				currentValue: managed.current,
				sourceRevision: managed.source.revision,
				writeCapability: managed.writeCapability,
			};
		}
	}
	return null;
}

export function createManagementCronWriterAdapter(input: {
	writer: ManagementCronWriter;
	targets(): readonly CronSourceTarget[];
}): ManagementWriter {
	const writer: ManagementWriter = {
		id: "launchd-cron-v1",
		kind: "cron",
		resolve: (targetId) => cronManagedTarget(input.targets(), targetId),
		preflight: (target, desiredValue, observedRevision) => {
			const staged = input.writer.stage({
				targetId: target.targetId,
				desiredValue,
				observedRevision,
			});
			if (staged.status === "rejected") {
				return rejectedPreflight(
					staged.reason.includes("stale") || staged.reason.includes("drift")
						? "stale_source"
						: target.writeCapability.writable
							? "invalid_desired_value"
							: "readonly",
					staged.reason,
				);
			}
			return preparedChange({
				writer,
				target,
				newValue:
					staged.status === "staged"
						? staged.change.newValue
						: target.currentValue,
			});
		},
		apply: async (change) => {
			const staged = input.writer.stage({
				targetId: change.targetId,
				desiredValue: change.newValue,
				observedRevision: change.sourceRevision,
			});
			if (staged.status === "no_op") return { status: "no_op" };
			if (staged.status === "rejected") {
				return { status: "rejected", reason: staged.reason };
			}
			const result = input.writer.apply(staged.change);
			if (result.status === "rolled_back") {
				return { status: "rolled_back", reason: result.error, details: result };
			}
			if (result.status === "partial") {
				return {
					status: "partial",
					reason: `${result.error}; rollback: ${result.rollbackError}`,
					details: result,
				};
			}
			return result;
		},
		applyGroup: (changes) =>
			applySequentiallyAgainstCurrentAuthority(writer, changes),
	};
	return writer;
}
