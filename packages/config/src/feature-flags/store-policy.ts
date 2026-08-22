import {
	SKILL_FRAMEWORK_MODES,
	SKILL_FRAMEWORK_SPLIT,
} from "../skill-framework-mode.js";
import type { FeatureFlagSpec } from "./registry.js";

export const STORE_MANAGED_FLAGS: ReadonlySet<string> = new Set([
	"flag_retirement_scan",
	"workflow_rework_reentry",
	"skill_framework_mode",
	"workflow_resume",
	"workflow_turn_divergence_alerts",
] as const);

export const PROTECTED_LEGACY_FLAG_NAMES: ReadonlySet<string> = new Set([
	"mailbox_queue",
	"auto_qa_killswitch",
	"codex_hard_gate_killswitch",
	"merge_approval_gate_killswitch",
	"qa_done_gate_killswitch",
	"ship_ci_guard",
] as const);

export interface FlagStoreRawValue {
	hasOverride: boolean;
	raw: string | null;
}

export interface FlagStoreCodec {
	parse(value: FlagStoreRawValue): boolean | string;
	canonicalEffective(value: boolean | string): string;
}

const defaultOnCodec: FlagStoreCodec = {
	parse: ({ hasOverride, raw }) => !hasOverride || raw !== "0",
	canonicalEffective: String,
};

const optInCodec: FlagStoreCodec = {
	parse: ({ hasOverride, raw }) => hasOverride && raw === "1",
	canonicalEffective: String,
};

const skillFrameworkCodec: FlagStoreCodec = {
	parse: ({ hasOverride, raw }) =>
		hasOverride &&
		raw !== null &&
		(
			[...SKILL_FRAMEWORK_MODES, SKILL_FRAMEWORK_SPLIT] as readonly string[]
		).includes(raw)
			? raw
			: "superpowers",
	canonicalEffective: String,
};

export function getFlagStoreCodec(name: string): FlagStoreCodec | undefined {
	if (name === "skill_framework_mode") return skillFrameworkCodec;
	if (name === "flag_retirement_scan" || name === "workflow_rework_reentry") {
		return defaultOnCodec;
	}
	if (
		name === "workflow_resume" ||
		name === "workflow_turn_divergence_alerts"
	) {
		return optInCodec;
	}
	return undefined;
}

export function getStoreEligibility(
	spec: FeatureFlagSpec,
): { eligible: true } | { eligible: false; reason: string } {
	if (spec.category === "governance_gate") {
		return { eligible: false, reason: "governance_gate" };
	}
	if (PROTECTED_LEGACY_FLAG_NAMES.has(spec.name)) {
		return { eligible: false, reason: "protected_legacy" };
	}
	if (!STORE_MANAGED_FLAGS.has(spec.name)) {
		return { eligible: false, reason: "not_store_managed" };
	}
	return { eligible: true };
}
