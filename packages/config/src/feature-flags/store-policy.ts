import {
	SKILL_FRAMEWORK_MODES,
	SKILL_FRAMEWORK_SPLIT,
} from "../skill-framework-mode.js";
import { FLAG_EXEMPTIONS, type FlagExemption } from "./exemptions.js";
import { FEATURE_FLAGS, type FeatureFlagSpec } from "./registry.js";

export const FLAG_AUTHORING_RUNBOOK =
	"doc/engineer/implementation/flag-authoring-runbook.md";

/** Closed: no registry flag may remain outside the store. */
export const LEGACY_UNMANAGED_BASELINE = Object.freeze([] as const);
const APPROVED_EXEMPTION_KEYS: ReadonlySet<string> = new Set(
	FLAG_EXEMPTIONS.map(({ kind, name }) => `${kind}:${name}`),
);

export const STORE_MANAGED_FLAGS: ReadonlySet<string> = new Set(
	FEATURE_FLAGS.map(({ name }) => name),
);

/**
 * FLY-2100: project-config flags whose explicit values may be stored per
 * project. Wildcard/array config families, governance gates, dormant flags,
 * and readonly escape hatches stay out because one boolean per project cannot
 * preserve their contracts.
 */
export const PROJECT_STORE_MANAGED_FLAGS: ReadonlySet<string> = new Set(
	FEATURE_FLAGS.filter(({ scope }) => scope === "project").map(
		({ name }) => name,
	),
);

/**
 * Former store-managed identities whose current-value row is removed on
 * upgrade. Their append-only changelog rows remain durable audit history.
 */
export const RETIRED_FLAG_STORE_ROWS: ReadonlySet<string> = new Set([
	"workflow_resume",
	"auto_qa_killswitch",
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

export const SUMMARY_ABSORPTION_CADENCE_DEFAULT_MS = 6 * 60 * 60_000;
export const SUMMARY_ABSORPTION_CADENCE_MIN_MS = 60_000;
export const SUMMARY_ABSORPTION_CADENCE_MAX_MS = 30 * 24 * 60 * 60_000;

function parseSummaryAbsorptionCadence(raw: string): string {
	if (!/^[1-9][0-9]*$/.test(raw)) {
		throw new Error("summary absorption cadence must be a positive integer");
	}
	const value = Number(raw);
	if (
		!Number.isSafeInteger(value) ||
		value < SUMMARY_ABSORPTION_CADENCE_MIN_MS ||
		value > SUMMARY_ABSORPTION_CADENCE_MAX_MS
	) {
		throw new Error(
			`summary absorption cadence must be ${SUMMARY_ABSORPTION_CADENCE_MIN_MS}..${SUMMARY_ABSORPTION_CADENCE_MAX_MS} ms`,
		);
	}
	return String(value);
}

const summaryAbsorptionCadenceCodec: FlagStoreCodec = {
	parse: ({ hasOverride, raw }) =>
		hasOverride
			? parseSummaryAbsorptionCadence(raw ?? "")
			: String(SUMMARY_ABSORPTION_CADENCE_DEFAULT_MS),
	canonicalEffective: (value) => parseSummaryAbsorptionCadence(String(value)),
};

export function getFlagStoreCodec(name: string): FlagStoreCodec | undefined {
	if (name === "summary_absorption_cadence_ms") {
		return summaryAbsorptionCadenceCodec;
	}
	if (name === "skill_framework_mode") return skillFrameworkCodec;
	if (
		name === "alert_system" ||
		name === "review_quota_auto_retry" ||
		name === "loop_profiler" ||
		name === "shipped_husk_force" ||
		name === "flag_retirement_scan" ||
		name === "workflow_rework_reentry"
	) {
		return defaultOnCodec;
	}
	if (
		name === "workflow_turn_divergence_alerts" ||
		name === "workflow_node_reuse"
	) {
		return optInCodec;
	}
	if (PROJECT_STORE_MANAGED_FLAGS.has(name)) {
		const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
		return spec?.polarity === "default_on" ? defaultOnCodec : optInCodec;
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
	if (spec.scope === "project") {
		return { eligible: false, reason: "project_scope" };
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
	projectStoreManagedFlags?: ReadonlySet<string>;
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
	const projectManagedFlags =
		input.projectStoreManagedFlags ?? PROJECT_STORE_MANAGED_FLAGS;
	const codecForName = input.codecForName ?? getFlagStoreCodec;
	const issues: string[] = [];
	const registryNames = new Set(flags.map((spec) => spec.name));
	const resolverOwners = new Map<string, string>();

	for (const exemption of exemptions) {
		const key = `${exemption.kind}:${exemption.name}`;
		if (!APPROVED_EXEMPTION_KEYS.has(key)) {
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
	for (const name of projectManagedFlags) {
		const spec = flags.find((candidate) => candidate.name === name);
		if (!spec) {
			issues.push(
				authoringIssue(
					`${name}: PROJECT_STORE_MANAGED_FLAGS has no registry spec`,
				),
			);
		} else if (spec.scope !== "project") {
			issues.push(
				authoringIssue(
					`${name}: project routing subset requires project scope`,
				),
			);
		}
	}

	for (const spec of flags) {
		const managed = managedFlags.has(spec.name);
		const projectManaged = projectManagedFlags.has(spec.name);
		if (!managed) {
			issues.push(
				authoringIssue(`${spec.name}: new registry spec must be store-managed`),
			);
			if (spec.scope === "project") {
				issues.push(
					authoringIssue(
						`${spec.name}: project specs must join PROJECT_STORE_MANAGED_FLAGS`,
					),
				);
			}
			continue;
		}
		if (projectManaged !== (spec.scope === "project")) {
			issues.push(
				authoringIssue(
					`${spec.name}: PROJECT_STORE_MANAGED_FLAGS must exactly match project scope`,
				),
			);
		}

		if (spec.scope === "project") {
			if (
				spec.source !== "project_config" ||
				spec.valueKind !== "bool" ||
				spec.category === "governance_gate" ||
				spec.dormant === true ||
				spec.toggleable === "readonly" ||
				!spec.configKey ||
				spec.configKey.includes("[]") ||
				spec.configKey.includes("*")
			) {
				issues.push(
					authoringIssue(
						`${spec.name}: project-store specs must be non-governance, active, writable project_config booleans with one exact configKey`,
					),
				);
			}
		} else {
			const eligibility = getStoreEligibilityAgainst(spec, managedFlags);
			if (!eligibility.eligible) {
				issues.push(
					authoringIssue(
						`${spec.name}: store eligibility rejected ${eligibility.reason}`,
					),
				);
			}
			if (spec.source !== "env" || !spec.envVar) {
				issues.push(
					authoringIssue(
						`${spec.name}: bridge-global managed specs require an envVar`,
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
					if (codec.canonicalEffective(defaultValue) !== String(spec.default)) {
						issues.push(
							authoringIssue(
								`${spec.name}: value codec must canonically round-trip its registry default`,
							),
						);
					}
					try {
						codec.parse({ hasOverride: true, raw: "__invalid__" });
						issues.push(
							authoringIssue(
								`${spec.name}: value codec must reject invalid writes`,
							),
						);
					} catch {
						// Expected: managed scalar values are strict, never fallback controls.
					}
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
