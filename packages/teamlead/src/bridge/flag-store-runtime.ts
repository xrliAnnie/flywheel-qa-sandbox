import {
	FEATURE_FLAGS,
	type FlagStoreRawValue,
	type FlagView,
	getFlagStoreCodec,
	PROJECT_STORE_MANAGED_FLAGS,
	resolveScopedEffective,
	STORE_MANAGED_FLAGS,
} from "flywheel-config";
import type { StateStore } from "../StateStore.js";

export type FlagStoreRuntime = { mode: "ready"; store: StateStore };

function bootstrapFlagEnv(
	env: Record<string, string | undefined>,
	log: (message: string) => void,
): Record<string, string | undefined> {
	let sanitized = env;
	for (const name of STORE_MANAGED_FLAGS) {
		const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
		const codec = getFlagStoreCodec(name);
		if (!spec?.envVar || !codec || env[spec.envVar] === undefined) continue;
		try {
			codec.canonicalEffective(
				codec.parse({ hasOverride: true, raw: env[spec.envVar] ?? null }),
			);
		} catch (error) {
			if (sanitized === env) sanitized = { ...env };
			delete sanitized[spec.envVar];
			const detail = error instanceof Error ? error.message : String(error);
			log(
				`[flag-store] ${spec.envVar} has an invalid bootstrap seed; using the registry default (${detail})`,
			);
		}
	}
	return sanitized;
}

export function initializeFlagStore(
	store: StateStore,
	env: Record<string, string | undefined>,
	now: number = Date.now(),
	log: (message: string) => void = console.warn,
): FlagStoreRuntime {
	store.ensureFlagValueRows({ env: bootstrapFlagEnv(env, log), now });
	return { mode: "ready", store };
}

function readFlagValue(
	runtime: FlagStoreRuntime,
	name: string,
): FlagStoreRawValue {
	if (
		!STORE_MANAGED_FLAGS.has(name) ||
		FEATURE_FLAGS.find((candidate) => candidate.name === name)?.scope !==
			"bridge_global"
	) {
		throw new Error(`flag is not store-managed: ${name}`);
	}
	const row = runtime.store.getFlagValueRow(name);
	if (!row) throw new Error(`missing managed flag row: ${name}`);
	return { hasOverride: row.hasOverride, raw: row.raw };
}

function readBoolean(runtime: FlagStoreRuntime, name: string): boolean {
	const effective = getFlagStoreCodec(name)?.parse(
		readFlagValue(runtime, name),
	);
	if (typeof effective !== "boolean") {
		throw new Error(`managed flag is not boolean: ${name}`);
	}
	return effective;
}

export function readScopedBoolean(
	runtime: FlagStoreRuntime,
	name: string,
	projectName: string,
): boolean {
	if (!PROJECT_STORE_MANAGED_FLAGS.has(name)) {
		throw new Error(`flag is not project-store-managed: ${name}`);
	}
	const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
	if (!spec) throw new Error(`missing flag registry entry: ${name}`);
	if (typeof spec.default !== "boolean") {
		throw new Error(`project-store flag is not boolean: ${name}`);
	}
	const codec = getFlagStoreCodec(name);
	if (!codec) throw new Error(`missing managed flag codec: ${name}`);
	const row =
		runtime.store.getFlagValueRow(name, projectName) ??
		runtime.store.getFlagValueRow(name, "*");
	if (!row) return spec.default;
	const effective = codec.parse({
		hasOverride: row.hasOverride,
		raw: row.raw,
	});
	if (typeof effective !== "boolean") {
		throw new Error(`project-store flag is not boolean: ${name}`);
	}
	return effective;
}

export function readScopedValue(
	runtime: FlagStoreRuntime,
	name: string,
	projectName: string,
): string {
	if (!PROJECT_STORE_MANAGED_FLAGS.has(name)) {
		throw new Error(`flag is not project-store-managed: ${name}`);
	}
	const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
	if (!spec) throw new Error(`missing flag registry entry: ${name}`);
	if (spec.valueKind !== "value" || typeof spec.default !== "string") {
		throw new Error(`project-store flag is not a scalar value: ${name}`);
	}
	const codec = getFlagStoreCodec(name);
	if (!codec) throw new Error(`missing managed flag codec: ${name}`);
	const row =
		runtime.store.getFlagValueRow(name, projectName) ??
		runtime.store.getFlagValueRow(name, "*");
	if (!row) return spec.default;
	const effective = codec.parse({
		hasOverride: row.hasOverride,
		raw: row.raw,
	});
	if (typeof effective !== "string") {
		throw new Error(`project-store flag is not a scalar value: ${name}`);
	}
	return effective;
}

export function storeNodeDwellThresholdHours(
	runtime: FlagStoreRuntime,
	projectName: string,
): number {
	const value = Number(
		readScopedValue(runtime, "node_dwell_threshold_hours", projectName),
	);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(
			"managed node dwell threshold is not positive finite hours",
		);
	}
	return value;
}

export function storeNodeDwellEnabled(
	runtime: FlagStoreRuntime,
	projectName: string,
): boolean {
	return readScopedBoolean(runtime, "node_dwell", projectName);
}

export function storeDocFlowEnabled(
	runtime: FlagStoreRuntime,
	projectName: string,
): boolean {
	return readScopedBoolean(runtime, "doc_flow", projectName);
}

export function storePipelineDagEnabled(
	runtime: FlagStoreRuntime,
	projectName: string,
): boolean {
	return readScopedBoolean(runtime, "pipeline_dag", projectName);
}

export function storePipelineWorkKindEnabled(
	runtime: FlagStoreRuntime,
	projectName: string,
): boolean {
	return readScopedBoolean(runtime, "pipeline_work_kind", projectName);
}

export function storeProofshotEnabled(
	runtime: FlagStoreRuntime,
	projectName: string,
): boolean {
	return readScopedBoolean(runtime, "proofshot", projectName);
}

export function storeXiaohongshuLearningEnabled(
	runtime: FlagStoreRuntime,
	projectName: string,
): boolean {
	return readScopedBoolean(runtime, "xiaohongshu_learning", projectName);
}

export function storePonytailEnabled(
	runtime: FlagStoreRuntime,
	projectName: string,
): boolean {
	return readScopedBoolean(runtime, "ponytail", projectName);
}

export function storeSkillFrameworkSplitParticipation(
	runtime: FlagStoreRuntime,
	projectName: string,
): boolean {
	return readScopedBoolean(
		runtime,
		"skill_framework_split_participation",
		projectName,
	);
}

export function storeSummaryAbsorptionCadenceMs(
	runtime: FlagStoreRuntime,
): number {
	const effective = getFlagStoreCodec("summary_absorption_cadence_ms")?.parse(
		readFlagValue(runtime, "summary_absorption_cadence_ms"),
	);
	const value = Number(effective);
	if (!Number.isSafeInteger(value)) {
		throw new Error("managed summary absorption cadence is not an integer");
	}
	return value;
}

export function storeAlertSystemEnabled(runtime: FlagStoreRuntime): boolean {
	return readBoolean(runtime, "alert_system");
}

export function storeCmuxWatcherRebuildDisabled(
	runtime: FlagStoreRuntime,
): boolean {
	return readBoolean(runtime, "cmux_watcher_rebuild_disabled");
}

export function storeCmuxRebindDisabled(runtime: FlagStoreRuntime): boolean {
	return readBoolean(runtime, "cmux_rebind_disabled");
}

export function storeReviewQuotaAutoRetryEnabled(
	runtime: FlagStoreRuntime,
): boolean {
	return readBoolean(runtime, "review_quota_auto_retry");
}

export function storeFlagRetirementScanEnabled(
	runtime: FlagStoreRuntime,
): boolean {
	return readBoolean(runtime, "flag_retirement_scan");
}

export function storeLoopProfilerEnabled(runtime: FlagStoreRuntime): boolean {
	return readBoolean(runtime, "loop_profiler");
}

export function storeShippedHuskForceEnabled(
	runtime: FlagStoreRuntime,
): boolean {
	return readBoolean(runtime, "shipped_husk_force");
}

export function storeWorkflowReworkReentryEnabled(
	runtime: FlagStoreRuntime,
): boolean {
	return readBoolean(runtime, "workflow_rework_reentry");
}

export function storeWorkflowNodeReuseEnabled(
	runtime: FlagStoreRuntime,
): boolean {
	return readBoolean(runtime, "workflow_node_reuse");
}

export function storeSkillFrameworkModeControl(
	runtime: FlagStoreRuntime,
): FlagStoreRawValue {
	return readFlagValue(runtime, "skill_framework_mode");
}

export function storeRunnerMemoryMode(
	runtime: FlagStoreRuntime,
): FlagStoreRawValue {
	return readFlagValue(runtime, "runner_memory_mode");
}

export function storeWorkflowTurnDivergenceAlertsEnabled(
	runtime: FlagStoreRuntime,
): boolean {
	return readBoolean(runtime, "workflow_turn_divergence_alerts");
}

export function enrichFlagViewsWithStore(
	views: FlagView[],
	runtime: FlagStoreRuntime,
	projectNames?: readonly string[],
): FlagView[] {
	let scopedRows: ReturnType<StateStore["listScopedFlagValueRows"]> | undefined;
	let scopedRowsError: string | undefined;
	try {
		scopedRows = runtime.store.listScopedFlagValueRows();
	} catch (error) {
		scopedRowsError = error instanceof Error ? error.message : String(error);
	}
	return views.map((view) => {
		if (PROJECT_STORE_MANAGED_FLAGS.has(view.name)) {
			try {
				if (scopedRowsError) throw new Error(scopedRowsError);
				const spec = FEATURE_FLAGS.find(
					(candidate) => candidate.name === view.name,
				);
				if (!spec) throw new Error(`missing flag registry entry: ${view.name}`);
				const codec = getFlagStoreCodec(view.name);
				if (!codec) throw new Error(`missing managed flag codec: ${view.name}`);
				const valueClocks = runtime.store
					.listFlagValueClocks(view.name)
					.map((clock) => ({
						scopeKey: clock.scopeKey,
						valueLastChanged: clock.valueLastChanged,
						firstRegisteredAt: clock.firstRegisteredAt,
						readiness: "ready" as const,
					}));
				const rows = (scopedRows ?? []).filter(
					(row) => row.flagName === view.name,
				);
				const publicRows = rows.map((row) => {
					if (!row.hasOverride || row.raw === null) {
						throw new Error(
							`invalid inherited scoped flag row: ${view.name}/${row.scope}`,
						);
					}
					return {
						scope: row.scope,
						raw: row.raw,
						value: codec.parse({ hasOverride: true, raw: row.raw }),
					};
				});
				const names = [...new Set(projectNames ?? [])];
				const effectiveByProject = names.map((projectName) => {
					return resolveScopedEffective({
						spec,
						projectName,
						rows: publicRows,
						codec,
					});
				});
				return {
					...view,
					storeManaged: false,
					projectStoreManaged: true,
					scopedStore: { rows: publicRows },
					effectiveByProject,
					clockReadiness: "ready",
					valueClocks,
				};
			} catch (error) {
				return {
					...view,
					storeManaged: false,
					projectStoreManaged: true,
					clockReadiness: "no_clock:degraded",
					valueClocks: undefined,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}
		if (!STORE_MANAGED_FLAGS.has(view.name)) {
			return {
				...view,
				storeManaged: false,
				clockReadiness: "no_clock:unmanaged",
			};
		}
		try {
			const value = readFlagValue(runtime, view.name);
			const codec = getFlagStoreCodec(view.name);
			if (!codec) throw new Error(`missing managed flag codec: ${view.name}`);
			const storeEffective = codec.parse(value);
			const valueLastChanged = runtime.store.getFlagValueRow(
				view.name,
			)?.valueLastChanged;
			if (valueLastChanged === undefined) {
				throw new Error(`missing managed flag row: ${view.name}`);
			}
			const valueClocks = runtime.store
				.listFlagValueClocks(view.name)
				.map((clock) => ({
					scopeKey: clock.scopeKey,
					valueLastChanged: clock.valueLastChanged,
					firstRegisteredAt: clock.firstRegisteredAt,
					readiness: "ready" as const,
				}));
			if (valueClocks.length === 0) {
				throw new Error(`missing managed flag clock: ${view.name}`);
			}
			return {
				...view,
				storeManaged: true,
				storeEffective,
				valueLastChanged,
				clockReadiness: "ready",
				valueClocks,
				effective: storeEffective,
				bridgeEffective: storeEffective,
				displayEffective: storeEffective,
				fileEffective: undefined,
				divergence: undefined,
				error: undefined,
				isDefault: storeEffective === view.default,
			};
		} catch (error) {
			return {
				...view,
				storeManaged: true,
				storeEffective: undefined,
				valueLastChanged: undefined,
				clockReadiness: "no_clock:degraded",
				valueClocks: undefined,
				effective: undefined,
				bridgeEffective: undefined,
				displayEffective: undefined,
				fileEffective: undefined,
				divergence: undefined,
				error: error instanceof Error ? error.message : String(error),
				isDefault: undefined,
			};
		}
	});
}
