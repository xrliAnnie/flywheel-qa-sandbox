import {
	FEATURE_FLAGS,
	type FlagStoreRawValue,
	type FlagView,
	getFlagStoreCodec,
	STORE_MANAGED_FLAGS,
} from "flywheel-config";
import type { StateStore } from "../StateStore.js";

export type FlagStoreRuntime =
	| { mode: "ready"; store: StateStore }
	| { mode: "bypass"; env: Record<string, string | undefined> };

export function initializeFlagStore(
	store: StateStore,
	env: Record<string, string | undefined>,
	now: number = Date.now(),
): FlagStoreRuntime {
	if (env.FLYWHEEL_FLAG_STORE === "0") {
		try {
			store.markFlagStoreBypassSeen(now);
		} catch (error) {
			console.warn(
				`[flag-store] could not persist bypass fence: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const snapshot: Record<string, string | undefined> = {};
		for (const spec of FEATURE_FLAGS) {
			if (spec.envVar && STORE_MANAGED_FLAGS.has(spec.name)) {
				snapshot[spec.envVar] = env[spec.envVar];
			}
		}
		return { mode: "bypass", env: snapshot };
	}
	store.ensureFlagValueRows({ env, now });
	return { mode: "ready", store };
}

function readFlagValue(
	runtime: FlagStoreRuntime,
	name: string,
): FlagStoreRawValue {
	if (!STORE_MANAGED_FLAGS.has(name)) {
		throw new Error(`flag is not store-managed: ${name}`);
	}
	if (runtime.mode === "ready") {
		const row = runtime.store.getFlagValueRow(name);
		if (!row) throw new Error(`missing managed flag row: ${name}`);
		return { hasOverride: row.hasOverride, raw: row.raw };
	}
	const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
	if (!spec?.envVar) throw new Error(`missing managed flag policy: ${name}`);
	return {
		hasOverride: runtime.env[spec.envVar] !== undefined,
		raw: runtime.env[spec.envVar] ?? null,
	};
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

export function storeSkillFrameworkModeControl(
	runtime: FlagStoreRuntime,
): FlagStoreRawValue {
	return readFlagValue(runtime, "skill_framework_mode");
}

export function storeWorkflowTurnDivergenceAlertsEnabled(
	runtime: FlagStoreRuntime,
): boolean {
	return readBoolean(runtime, "workflow_turn_divergence_alerts");
}

export function enrichFlagViewsWithStore(
	views: FlagView[],
	runtime: FlagStoreRuntime,
): FlagView[] {
	return views.map((view) => {
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
			const valueLastChanged =
				runtime.mode === "ready"
					? runtime.store.getFlagValueRow(view.name)?.valueLastChanged
					: null;
			if (valueLastChanged === undefined) {
				throw new Error(`missing managed flag row: ${view.name}`);
			}
			// Ready SQLite rows are sole authority; static truth validation owns
			// detection of retired persistent-env inputs. Bypass still uses env.
			const legacyEnvIsAuthority = runtime.mode === "bypass";
			const divergence = !legacyEnvIsAuthority
				? undefined
				: view.divergence === "source_unavailable"
					? "source_unavailable"
					: view.fileEffective !== undefined &&
							view.fileEffective !== storeEffective
						? "split_brain"
						: undefined;
			return {
				...view,
				storeManaged: true,
				storeEffective,
				valueLastChanged,
				clockReadiness: runtime.mode === "ready" ? "ready" : "no_clock:bypass",
				effective: storeEffective,
				bridgeEffective: storeEffective,
				displayEffective: storeEffective,
				fileEffective: legacyEnvIsAuthority ? view.fileEffective : undefined,
				divergence,
				error: legacyEnvIsAuthority ? view.error : undefined,
				isDefault: storeEffective === view.default,
			};
		} catch (error) {
			return {
				...view,
				storeManaged: true,
				storeEffective: undefined,
				valueLastChanged: undefined,
				clockReadiness: "no_clock:degraded",
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
