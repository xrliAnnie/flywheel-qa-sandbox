import {
	SKILL_FRAMEWORK_MODES,
	SKILL_FRAMEWORK_SPLIT,
} from "../skill-framework-mode.js";
import {
	FLAG_EXEMPTIONS,
	type FlagExemption,
	LEGACY_FLAG_EXEMPTION_BASELINE,
} from "./exemptions.js";
import { FEATURE_FLAGS, type FeatureFlagSpec } from "./registry.js";

export const FLAG_AUTHORING_RUNBOOK =
	"doc/engineer/implementation/flag-authoring-runbook.md";

/**
 * FLY-1981: immutable maximum ledger for the 31 pre-store registry specs.
 * It is intentionally literal, never computed from FEATURE_FLAGS. Existing
 * entries may migrate into the store or retire; no new unmanaged name may enter.
 */
export const LEGACY_UNMANAGED_BASELINE = Object.freeze([
	"flag_store",
	"founder_review_orphan_monitor",
	"mailbox_queue",
	"liveness_activity_window_ms",
	"converge_cmux_symlink",
	"cmux_view_helper",
	"cmux_node_presence",
	"voice_qa_presence_override",
	"merge_approval_gate_killswitch",
	"issue_gate_supersede_mode",
	"deferred_approval_ttl_ms",
	"founder_reply_deadletter_age_ms",
	"issue_display_sweep_ticks",
	"ship_gate_grace_ms",
	"external_merge_reconcile",
	"merge_reconcile_window_days",
	"ship_gate_card_grace_ms",
	"ghost_guard_wait_ms",
	"lead_lease_bypass",
	"checkpoint_enabled",
	"pipeline_dag",
	"pipeline_work_kind",
	"xiaohongshu_auto_create",
	"doc_flow",
	"skill_framework_split_participation",
	"proofshot",
	"xiaohongshu_learning",
	"ponytail",
	"done_thread_reconcile_interval_min",
	"done_thread_reconcile_max_per_run",
	"publish_broker",
] as const);

const LEGACY_UNMANAGED_NAMES: ReadonlySet<string> = new Set(
	LEGACY_UNMANAGED_BASELINE,
);
const LEGACY_EXEMPTION_KEYS: ReadonlySet<string> = new Set(
	LEGACY_FLAG_EXEMPTION_BASELINE,
);

export const STORE_MANAGED_FLAGS: ReadonlySet<string> = new Set([
	"alert_system",
	"loop_profiler",
	"shipped_husk_force",
	"flag_retirement_scan",
	"workflow_rework_reentry",
	"skill_framework_mode",
	"workflow_turn_divergence_alerts",
] as const);

/**
 * Former store-managed identities whose current-value row is removed on
 * upgrade. Their append-only changelog rows remain durable audit history.
 */
export const RETIRED_FLAG_STORE_ROWS: ReadonlySet<string> = new Set([
	"workflow_resume",
	"auto_qa_killswitch",
] as const);

export const PROTECTED_LEGACY_FLAG_NAMES: ReadonlySet<string> = new Set([
	"mailbox_queue",
	"merge_approval_gate_killswitch",
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
	if (
		name === "alert_system" ||
		name === "loop_profiler" ||
		name === "shipped_husk_force" ||
		name === "flag_retirement_scan" ||
		name === "workflow_rework_reentry"
	) {
		return defaultOnCodec;
	}
	if (name === "workflow_turn_divergence_alerts") {
		return optInCodec;
	}
	return undefined;
}

export function getStoreEligibility(
	spec: FeatureFlagSpec,
): { eligible: true } | { eligible: false; reason: string } {
	return getStoreEligibilityAgainst(spec, STORE_MANAGED_FLAGS);
}

function getStoreEligibilityAgainst(
	spec: FeatureFlagSpec,
	managedFlags: ReadonlySet<string>,
): { eligible: true } | { eligible: false; reason: string } {
	if (spec.category === "governance_gate") {
		return { eligible: false, reason: "governance_gate" };
	}
	if (PROTECTED_LEGACY_FLAG_NAMES.has(spec.name)) {
		return { eligible: false, reason: "protected_legacy" };
	}
	if (!managedFlags.has(spec.name)) {
		return { eligible: false, reason: "not_store_managed" };
	}
	return { eligible: true };
}

export interface FlagAuthoringPolicyInput {
	flags?: readonly FeatureFlagSpec[];
	exemptions?: readonly FlagExemption[];
	storeManagedFlags?: ReadonlySet<string>;
	codecForName?: (name: string) => FlagStoreCodec | undefined;
}

function authoringIssue(message: string): string {
	return `${message}; see ${FLAG_AUTHORING_RUNBOOK}`;
}

/**
 * FLY-1981 C-group mechanical authoring gate.
 *
 * Baseline names are the only specs allowed to remain unmanaged. Every managed
 * spec (including any new name) must use the global env-backed SQLite path and
 * declare an exact named wrapper that the read-site AST guard verifies. The
 * formula deliberately has no category or FLAG_EXEMPTIONS escape hatch.
 */
export function validateFlagAuthoringPolicy(
	input: FlagAuthoringPolicyInput = {},
): string[] {
	const flags = input.flags ?? FEATURE_FLAGS;
	const exemptions = input.exemptions ?? FLAG_EXEMPTIONS;
	const managedFlags = input.storeManagedFlags ?? STORE_MANAGED_FLAGS;
	const codecForName = input.codecForName ?? getFlagStoreCodec;
	const issues: string[] = [];
	const registryNames = new Set(flags.map((spec) => spec.name));
	const resolverOwners = new Map<string, string>();

	for (const exemption of exemptions) {
		const key = `${exemption.kind}:${exemption.name}`;
		if (!LEGACY_EXEMPTION_KEYS.has(key)) {
			issues.push(
				authoringIssue(
					`${key}: FLAG_EXEMPTIONS is frozen and accepts no new entries`,
				),
			);
		}
	}

	for (const name of managedFlags) {
		if (!registryNames.has(name)) {
			issues.push(
				authoringIssue(`${name}: STORE_MANAGED_FLAGS has no registry spec`),
			);
		}
	}

	for (const spec of flags) {
		const managed = managedFlags.has(spec.name);
		const legacyUnmanaged = LEGACY_UNMANAGED_NAMES.has(spec.name);
		if (!managed) {
			if (!legacyUnmanaged) {
				issues.push(
					authoringIssue(
						`${spec.name}: new registry spec must be store-managed`,
					),
				);
				if (spec.source === "project_config") {
					issues.push(
						authoringIssue(
							`${spec.name}: new project_config specs are forbidden until project-scoped store authority exists`,
						),
					);
				}
			}
			continue;
		}

		const eligibility = getStoreEligibilityAgainst(spec, managedFlags);
		if (!eligibility.eligible) {
			issues.push(
				authoringIssue(
					`${spec.name}: store eligibility rejected ${eligibility.reason}`,
				),
			);
		}
		if (
			spec.source !== "env" ||
			spec.scope !== "bridge_global" ||
			!spec.envVar
		) {
			issues.push(
				authoringIssue(
					`${spec.name}: managed specs must be bridge_global env specs with envVar; project_config is unsupported`,
				),
			);
		}
		if (spec.toggleable !== "direct") {
			issues.push(
				authoringIssue(
					`${spec.name}: managed specs must be direct-toggleable for the management route`,
				),
			);
		}

		const codec = codecForName(spec.name);
		if (!codec) {
			issues.push(authoringIssue(`${spec.name}: missing flag-store codec`));
		} else {
			try {
				const defaultValue = codec.parse({ hasOverride: false, raw: null });
				if (defaultValue !== spec.default) {
					issues.push(
						authoringIssue(
							`${spec.name}: codec default ${JSON.stringify(defaultValue)} does not match registry default ${JSON.stringify(spec.default)}`,
						),
					);
				}
				if (spec.valueKind === "value") {
					issues.push(
						authoringIssue(
							`${spec.name}: managed valueKind=value is unsupported until a store codec contract is implemented`,
						),
					);
				} else if (spec.valueKind === "bool") {
					const polarityDefault = spec.polarity === "default_on";
					if (spec.default !== polarityDefault) {
						issues.push(
							authoringIssue(
								`${spec.name}: boolean default does not match ${spec.polarity} polarity`,
							),
						);
					}
					const rawZero = codec.parse({ hasOverride: true, raw: "0" });
					const rawOne = codec.parse({ hasOverride: true, raw: "1" });
					if (rawZero !== false || rawOne !== true) {
						issues.push(
							authoringIssue(
								`${spec.name}: boolean codec must parse canonical raw 0/1 to both states`,
							),
						);
					}
					if (
						codec.canonicalEffective(false) !== "false" ||
						codec.canonicalEffective(true) !== "true"
					) {
						issues.push(
							authoringIssue(
								`${spec.name}: boolean codec canonicalEffective must distinguish false and true`,
							),
						);
					}
					const invalidOverride = codec.parse({
						hasOverride: true,
						raw: "__invalid__",
					});
					if (invalidOverride !== polarityDefault) {
						issues.push(
							authoringIssue(
								`${spec.name}: codec invalid-value behavior does not match ${spec.polarity} polarity`,
							),
						);
					}
				} else {
					const values = spec.enumValues ?? [];
					const failedMember = values.find(
						(member) =>
							codec.parse({ hasOverride: true, raw: member }) !== member ||
							codec.canonicalEffective(member) !== member,
					);
					if (values.length === 0 || failedMember !== undefined) {
						issues.push(
							authoringIssue(
								`${spec.name}: enum codec must round-trip every registry enumValues member`,
							),
						);
					}
					const unsupported = codec.parse({
						hasOverride: true,
						raw: "__unsupported__",
					});
					if (
						unsupported !== spec.default ||
						codec.canonicalEffective(unsupported) !== String(spec.default)
					) {
						issues.push(
							authoringIssue(
								`${spec.name}: enum codec unsupported value must coherently fall back to the registry default`,
							),
						);
					}
				}
			} catch (error) {
				issues.push(
					authoringIssue(
						`${spec.name}: codec contract threw ${error instanceof Error ? error.message : String(error)}`,
					),
				);
			}
		}

		const canonicalRead = (site: FeatureFlagSpec["readSites"][number]) =>
			site.pattern === "delegated" &&
			site.timing === "call_time" &&
			site.resolverModule ===
				"packages/teamlead/src/bridge/flag-store-runtime.ts" &&
			Boolean(site.resolverSymbol?.trim());
		if (spec.readSites.length === 0 || !spec.readSites.every(canonicalRead)) {
			issues.push(
				authoringIssue(
					`${spec.name}: every readSite must be delegated call_time through a named flag-store-runtime wrapper`,
				),
			);
		}
		const resolverSymbols = new Set(
			spec.readSites
				.filter(canonicalRead)
				.map((site) => site.resolverSymbol as string),
		);
		if (resolverSymbols.size !== 1) {
			issues.push(
				authoringIssue(
					`${spec.name}: managed specs must declare exactly one resolver identity across all readSites`,
				),
			);
		}
		for (const resolverSymbol of resolverSymbols) {
			const owner = resolverOwners.get(resolverSymbol);
			if (owner && owner !== spec.name) {
				issues.push(
					authoringIssue(
						`${spec.name}: resolver ${resolverSymbol} already belongs to managed spec ${owner}; one resolver may bind only one managed spec`,
					),
				);
			} else {
				resolverOwners.set(resolverSymbol, spec.name);
			}
		}
		const wrapperRead = spec.readSites.some((site) => canonicalRead(site));
		if (!wrapperRead) {
			issues.push(
				authoringIssue(
					`${spec.name}: missing delegated call_time read through a named flag-store-runtime wrapper`,
				),
			);
		}
	}

	return issues;
}
