import type { FlagView } from "flywheel-config";

export type DagControlName =
	| "workflow_force_legacy"
	| "workflow_claims_write"
	| "workflow_claims_read"
	| "workflow_generalized_templates"
	| "workflow_template_dispatch";

export type DagDispatchState = "ready" | "off" | "degraded";
export type DagShipReader =
	| "forced_legacy"
	| "claims"
	| "blocked_fail_closed"
	| "degraded";

export interface DagDispatchFact {
	state: DagDispatchState;
	missing: DagControlName[];
}

export interface DagPreset {
	enabled: boolean;
	phase1Command: string;
	phase2Command?: string;
	disabledReason?: string;
}

export interface DagFlagPanel {
	levers: Record<DagControlName, boolean | undefined>;
	degradedFlags: DagControlName[];
	v1Dispatch: DagDispatchFact;
	v2Dispatch: DagDispatchFact;
	shipReader: DagShipReader;
	presets: {
		enableV1: DagPreset;
		enableV2: DagPreset;
		disable: DagPreset;
	};
}

export const DAG_CONTROL_NAMES: readonly DagControlName[] = [
	"workflow_force_legacy",
	"workflow_claims_write",
	"workflow_claims_read",
	"workflow_generalized_templates",
	"workflow_template_dispatch",
];

const V1_REQUIRED: readonly DagControlName[] = [
	"workflow_template_dispatch",
	"workflow_claims_write",
	"workflow_claims_read",
];
const V2_REQUIRED: readonly DagControlName[] = [
	...V1_REQUIRED,
	"workflow_generalized_templates",
];

function applyCommand(name: DagControlName, value: boolean): string {
	return `flywheel-comm feature-flags apply --name ${name} --to ${value ? "on" : "off"}`;
}

function dispatchFact(
	levers: DagFlagPanel["levers"],
	degraded: Set<DagControlName>,
	required: readonly DagControlName[],
): DagDispatchFact {
	const unavailable = required.filter((name) => degraded.has(name));
	if (unavailable.length > 0) {
		return { state: "degraded", missing: unavailable };
	}
	const missing = required.filter((name) => levers[name] !== true);
	return { state: missing.length === 0 ? "ready" : "off", missing };
}

function enablePreset(
	levers: DagFlagPanel["levers"],
	degraded: DagControlName[],
	version: 1 | 2,
): DagPreset {
	if (degraded.length > 0) {
		return {
			enabled: false,
			phase1Command: "",
			disabledReason: `来源分歧或不可用: ${degraded.join(", ")}`,
		};
	}
	const required = version === 2 ? V2_REQUIRED : V1_REQUIRED;
	const commands: string[] = [];
	// An already-ON template with a missing prerequisite is unsafe. Normalize it
	// before changing anything else so every subsequent prefix is self-consistent.
	if (
		levers.workflow_template_dispatch === true &&
		required.some((name) => levers[name] !== true)
	) {
		commands.push(applyCommand("workflow_template_dispatch", false));
		levers = { ...levers, workflow_template_dispatch: false };
	}
	if (levers.workflow_force_legacy !== true) {
		commands.push(applyCommand("workflow_force_legacy", true));
	}
	for (const name of [
		"workflow_claims_write",
		"workflow_claims_read",
		...(version === 2 ? (["workflow_generalized_templates"] as const) : []),
	] as const) {
		if (levers[name] !== true) commands.push(applyCommand(name, true));
	}
	if (levers.workflow_template_dispatch !== true) {
		commands.push(applyCommand("workflow_template_dispatch", true));
	}
	return {
		enabled: true,
		phase1Command: commands.join(" && "),
		// This appears only on a refreshed state that proves claims-read is ON
		// while the legacy fallback is still holding the ship reader safe.
		...(levers.workflow_force_legacy === true &&
		levers.workflow_claims_read === true
			? {
					phase2Command: applyCommand("workflow_force_legacy", false),
				}
			: {}),
	};
}

function disablePreset(
	levers: DagFlagPanel["levers"],
	degraded: DagControlName[],
): DagPreset {
	if (degraded.length > 0) {
		return {
			enabled: false,
			phase1Command: "",
			disabledReason: `来源分歧或不可用: ${degraded.join(", ")}`,
		};
	}
	const commands: string[] = [];
	for (const [name, target] of [
		["workflow_force_legacy", true],
		["workflow_template_dispatch", false],
		["workflow_claims_write", false],
		["workflow_claims_read", false],
		["workflow_generalized_templates", false],
	] as const) {
		if (levers[name] !== target) commands.push(applyCommand(name, target));
	}
	return { enabled: true, phase1Command: commands.join(" && ") };
}

export function buildDagFlagPanel(flags: readonly FlagView[]): DagFlagPanel {
	const byName = new Map(flags.map((flag) => [flag.name, flag]));
	const levers = {} as Record<DagControlName, boolean | undefined>;
	const degradedFlags: DagControlName[] = [];
	for (const name of DAG_CONTROL_NAMES) {
		const flag = byName.get(name);
		const value = flag?.displayEffective;
		if (!flag || flag.divergence || typeof value !== "boolean") {
			levers[name] = undefined;
			degradedFlags.push(name);
		} else {
			levers[name] = value;
		}
	}
	const degraded = new Set(degradedFlags);
	let shipReader: DagShipReader;
	if (
		degraded.has("workflow_force_legacy") ||
		degraded.has("workflow_claims_read")
	) {
		shipReader = "degraded";
	} else if (levers.workflow_force_legacy) {
		shipReader = "forced_legacy";
	} else if (levers.workflow_claims_read) {
		shipReader = "claims";
	} else {
		shipReader = "blocked_fail_closed";
	}
	return {
		levers,
		degradedFlags,
		v1Dispatch: dispatchFact(levers, degraded, V1_REQUIRED),
		v2Dispatch: dispatchFact(levers, degraded, V2_REQUIRED),
		shipReader,
		presets: {
			enableV1: enablePreset(levers, degradedFlags, 1),
			enableV2: enablePreset(levers, degradedFlags, 2),
			disable: disablePreset(levers, degradedFlags),
		},
	};
}
