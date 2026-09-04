import { describe, expect, it } from "vitest";
import type { FlagExemption } from "../feature-flags/exemptions.js";
import * as FlagExemptions from "../feature-flags/exemptions.js";
import {
	FEATURE_FLAGS,
	type FeatureFlagSpec,
} from "../feature-flags/registry.js";
import * as FlagStorePolicy from "../feature-flags/store-policy.js";
import {
	type FlagStoreCodec,
	getFlagStoreCodec,
	getStoreEligibility,
	PROJECT_STORE_MANAGED_FLAGS,
	RETIRED_FLAG_STORE_ROWS,
	STORE_MANAGED_FLAGS,
} from "../feature-flags/store-policy.js";

const _MANAGED = [
	"summary_absorption_cadence_ms",
	"loop_profiler",
	"shipped_husk_force",
	"flag_retirement_scan",
	"workflow_rework_reentry",
	"workflow_node_reuse",
	"skill_framework_mode",
	"workflow_turn_divergence_alerts",
] as const;

const _PROJECT_MANAGED = [
	"doc_flow",
	"pipeline_dag",
	"pipeline_work_kind",
	"proofshot",
	"xiaohongshu_learning",
	"ponytail",
	"skill_framework_split_participation",
] as const;

const LEGACY_UNMANAGED = [] as const;

const TRUE_EXEMPTIONS = [
	"env:FLYWHEEL_LEAD_DRY_RUN",
	"env:FLYWHEEL_DONE_THREAD_RECONCILE",
	"env:FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED",
	"env:FLYWHEEL_QUOTA_QA_INJECTION",
	"env:FLYWHEEL_SYNC_BIN_ALLOW_TEMP_ROOT",
	"env:FLYWHEEL_ALLOW_LICENSE_KEY_ENV",
	"env:FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION",
	"env:FLYWHEEL_BUDDY_DEMO",
	"env:FLYWHEEL_BUDDY_PREVIEW_DRY_RUN",
	"env:FLYWHEEL_BUDDY_PREVIEW_LIVE",
	"env:FLYWHEEL_CMUX_DRY_RUN",
	"env:FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL",
	"env:FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE",
	"env:FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH",
	"env:FLYWHEEL_CMUX_TEST_SYNC_FUNCTIONS",
	"env:FLYWHEEL_DISCORD_CUTOVER_TEST_SEAMS",
	"env:FLYWHEEL_LEAD_V2_DRY_RUN",
	"env:FLYWHEEL_LEAD_V2_TEST_MODE",
	"env:FLYWHEEL_LINEAR_STARTED_SYNC",
	"env:FLYWHEEL_PROFILE_IDENTITY_BYPASS",
	"env:FLYWHEEL_QUOTA_E2E_KEEP",
	"env:FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT",
	"env:FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT",
	"env:FLYWHEEL_DAEMON_SKIP_PS_SELF_PROBE",
	"env:FLYWHEEL_DISABLE_MAILBOX_SENTINEL",
	"env:FLYWHEEL_ELEVEN_AUTOSTART",
	"env:FLYWHEEL_GEMINI_AUTOSTART",
	"env:FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE",
] as const;

type ValidateFlagAuthoringPolicy = (input?: {
	flags?: readonly FeatureFlagSpec[];
	exemptions?: readonly FlagExemption[];
	storeManagedFlags?: ReadonlySet<string>;
	projectStoreManagedFlags?: ReadonlySet<string>;
	codecForName?: (name: string) => FlagStoreCodec | undefined;
}) => string[];

function validateFlagAuthoringPolicy(
	input?: Parameters<ValidateFlagAuthoringPolicy>[0],
): string[] {
	const validate = Reflect.get(
		FlagStorePolicy,
		"validateFlagAuthoringPolicy",
	) as ValidateFlagAuthoringPolicy | undefined;
	expect(validate).toBeTypeOf("function");
	return validate?.(input) ?? [];
}

function futureSpec(over: Partial<FeatureFlagSpec> = {}): FeatureFlagSpec {
	return {
		name: "future_dynamic_flag",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FUTURE_DYNAMIC_FLAG",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "injected authoring-policy control",
		readSites: [
			{
				file: "packages/teamlead/src/bridge/plugin.ts",
				symbol: "future flag injection",
				pattern: "delegated",
				timing: "call_time",
				resolverModule: "packages/teamlead/src/bridge/flag-store-runtime.ts",
				resolverSymbol: "storeFutureDynamicFlagEnabled",
			},
		],
		toggleable: "direct",
		directToggleProof: "future-route.test.ts: live read",
		...over,
	};
}

const futureCodec: FlagStoreCodec = {
	parse: ({ hasOverride, raw }) => !hasOverride || raw !== "0",
	canonicalEffective: String,
};

const constantCodec: FlagStoreCodec = {
	parse: () => true,
	canonicalEffective: () => "true",
};

function withFutureManaged(): Set<string> {
	return new Set([...STORE_MANAGED_FLAGS, "future_dynamic_flag"]);
}

function futureProjectSpec(
	over: Partial<FeatureFlagSpec> = {},
): FeatureFlagSpec {
	return futureSpec({
		source: "project_config",
		scope: "project",
		envVar: undefined,
		configKey: "future.enabled",
		polarity: "opt_in",
		default: false,
		readSites: [
			{
				file: "packages/example/src/future-project.ts",
				symbol: "futureProjectFlag",
				pattern: "delegated",
				timing: "call_time",
				resolverModule: "packages/teamlead/src/bridge/flag-store-runtime.ts",
				resolverSymbol: "storeFutureProjectFlagEnabled",
			},
		],
		toggleable: "conversational",
		directToggleProof: undefined,
		...over,
	});
}

function withFutureProjectManaged(): Set<string> {
	return new Set([...PROJECT_STORE_MANAGED_FLAGS, "future_dynamic_flag"]);
}

describe("FLY-1778 flag store policy", () => {
	it("keeps the registry and store ledgers closed over the same names", () => {
		const registryNames = FEATURE_FLAGS.map(({ name }) => name).sort();
		const projectNames = FEATURE_FLAGS.filter(
			({ scope }) => scope === "project",
		).map(({ name }) => name);
		expect(STORE_MANAGED_FLAGS.size).toBe(FEATURE_FLAGS.length);
		expect([...STORE_MANAGED_FLAGS].sort()).toEqual(registryNames);
		expect([...PROJECT_STORE_MANAGED_FLAGS]).toEqual(projectNames);
		expect([...RETIRED_FLAG_STORE_ROWS]).toEqual([
			"workflow_resume",
			"auto_qa_killswitch",
		]);
		for (const spec of FEATURE_FLAGS) {
			expect(getStoreEligibility(spec), spec.name).toEqual(
				spec.scope === "bridge_global"
					? { eligible: true }
					: { eligible: false, reason: "project_scope" },
			);
		}
	});

	it("freezes literal only-shrink baselines for unmanaged specs and exemptions", () => {
		const unmanagedBaseline = Reflect.get(
			FlagStorePolicy,
			"LEGACY_UNMANAGED_BASELINE",
		) as readonly string[] | undefined;
		const exemptionBaseline = Reflect.get(
			FlagExemptions,
			"LEGACY_FLAG_EXEMPTION_BASELINE",
		) as readonly string[] | undefined;
		expect(unmanagedBaseline).toEqual(LEGACY_UNMANAGED);
		expect(exemptionBaseline).toEqual([]);
		expect(Object.isFrozen(unmanagedBaseline)).toBe(true);
		expect(Object.isFrozen(exemptionBaseline)).toBe(true);

		expect(unmanagedBaseline).toHaveLength(0);
		expect(exemptionBaseline).toHaveLength(0);
	});

	it("pins only bounded transient exemptions with retirement conditions", () => {
		expect(
			FlagExemptions.FLAG_EXEMPTIONS.map(
				(exemption) => `${exemption.kind}:${exemption.name}`,
			).sort(),
		).toEqual([...TRUE_EXEMPTIONS].sort());
		for (const exemption of FlagExemptions.FLAG_EXEMPTIONS) {
			expect(
				["qa_isolation", "dry_run", "one_time_migration"],
				exemption.name,
			).toContain(Reflect.get(exemption, "seam"));
			expect(
				Reflect.get(exemption, "persistentEnvAllowed"),
				exemption.name,
			).toBe(false);
			expect(Reflect.get(exemption, "retireWhen"), exemption.name).toMatch(
				/\S/,
			);
		}
	});

	it("accepts the current registry without freezing managed growth at four", () => {
		expect(validateFlagAuthoringPolicy()).toEqual([]);
	});

	it("assigns every registry spec to the all-set and only project specs to the routing subset", () => {
		for (const spec of FEATURE_FLAGS) {
			expect(STORE_MANAGED_FLAGS.has(spec.name), spec.name).toBe(true);
			expect(PROJECT_STORE_MANAGED_FLAGS.has(spec.name), spec.name).toBe(
				spec.scope === "project",
			);
		}
	});

	it("permits compliant project-scoped store growth", () => {
		expect(
			validateFlagAuthoringPolicy({
				flags: [...FEATURE_FLAGS, futureProjectSpec()],
				storeManagedFlags: withFutureManaged(),
				projectStoreManagedFlags: withFutureProjectManaged(),
				codecForName: (name) =>
					name === "future_dynamic_flag"
						? {
								parse: ({ hasOverride, raw }) => hasOverride && raw === "1",
								canonicalEffective: String,
							}
						: getFlagStoreCodec(name),
			}),
		).toEqual([]);
	});

	it.each([
		["dormant", { dormant: true }],
		["readonly", { toggleable: "readonly" }],
		["array key", { configKey: "future.items[].enabled" }],
		["wildcard key", { configKey: "future.*.enabled" }],
	] as const)("rejects an unsafe project-store member: %s", (_label, over) => {
		const issues = validateFlagAuthoringPolicy({
			flags: [
				...FEATURE_FLAGS,
				futureProjectSpec(over as Partial<FeatureFlagSpec>),
			],
			storeManagedFlags: withFutureManaged(),
			projectStoreManagedFlags: withFutureProjectManaged(),
			codecForName: (name) =>
				name === "future_dynamic_flag"
					? {
							parse: ({ hasOverride, raw }) => hasOverride && raw === "1",
							canonicalEffective: String,
						}
					: getFlagStoreCodec(name),
		});
		expect(issues.join("\n")).toMatch(/future_dynamic_flag.*project-store/i);
	});

	it("rejects a bridge-global name in the project routing subset", () => {
		const issues = validateFlagAuthoringPolicy({
			projectStoreManagedFlags: new Set([
				...PROJECT_STORE_MANAGED_FLAGS,
				"loop_profiler",
			]),
		});
		expect(issues.join("\n")).toMatch(/loop_profiler.*project/i);
	});

	it("rejects a new env spec until every store-management contract is present", () => {
		const issues = validateFlagAuthoringPolicy({
			flags: [...FEATURE_FLAGS, futureSpec()],
		});
		expect(issues.join("\n")).toMatch(/future_dynamic_flag.*store-managed/i);
		expect(issues.join("\n")).toContain(
			"doc/engineer/implementation/flag-authoring-runbook.md",
		);
	});

	it("rejects missing codec, missing delegated wrapper, and project_config growth", () => {
		const missingCodec = validateFlagAuthoringPolicy({
			flags: [...FEATURE_FLAGS, futureSpec()],
			storeManagedFlags: withFutureManaged(),
		});
		expect(missingCodec.join("\n")).toMatch(/future_dynamic_flag.*codec/i);

		const missingWrapper = validateFlagAuthoringPolicy({
			flags: [
				...FEATURE_FLAGS,
				futureSpec({
					readSites: [
						{
							file: "packages/teamlead/src/bridge/plugin.ts",
							symbol: "raw future flag read",
							pattern: "process.env",
							timing: "call_time",
						},
					],
				}),
			],
			storeManagedFlags: withFutureManaged(),
			codecForName: (name) =>
				name === "future_dynamic_flag" ? futureCodec : getFlagStoreCodec(name),
		});
		expect(missingWrapper.join("\n")).toMatch(
			/future_dynamic_flag.*delegated.*flag-store-runtime/i,
		);

		const projectConfig = validateFlagAuthoringPolicy({
			flags: [
				...FEATURE_FLAGS,
				futureSpec({
					source: "project_config",
					scope: "project",
					envVar: undefined,
					configKey: "future.enabled",
				}),
			],
			storeManagedFlags: withFutureManaged(),
			codecForName: (name) =>
				name === "future_dynamic_flag" ? futureCodec : getFlagStoreCodec(name),
		});
		expect(projectConfig.join("\n")).toMatch(
			/future_dynamic_flag.*PROJECT_STORE_MANAGED_FLAGS/i,
		);
	});

	it("rejects borrowed resolver identities and mixed raw/delegated managed reads", () => {
		const borrowed = validateFlagAuthoringPolicy({
			flags: [
				...FEATURE_FLAGS,
				futureSpec({
					readSites: [
						{
							...futureSpec().readSites[0]!,
							resolverSymbol: "storeFlagRetirementScanEnabled",
						},
					],
				}),
			],
			storeManagedFlags: withFutureManaged(),
			codecForName: (name) =>
				name === "future_dynamic_flag" ? futureCodec : getFlagStoreCodec(name),
		});
		expect(borrowed.join("\n")).toMatch(
			/future_dynamic_flag.*resolver.*flag_retirement_scan|resolver.*one managed spec/i,
		);

		const mixed = validateFlagAuthoringPolicy({
			flags: [
				...FEATURE_FLAGS,
				futureSpec({
					readSites: [
						...futureSpec().readSites,
						{
							file: "packages/example/src/mixed-consumer.ts",
							symbol: "mixed raw production consumer",
							pattern: "process.env",
							timing: "call_time",
						},
					],
				}),
			],
			storeManagedFlags: withFutureManaged(),
			codecForName: (name) =>
				name === "future_dynamic_flag" ? futureCodec : getFlagStoreCodec(name),
		});
		expect(mixed.join("\n")).toMatch(
			/future_dynamic_flag.*every readSite.*delegated.*call_time/i,
		);

		const multipleResolvers = validateFlagAuthoringPolicy({
			flags: [
				...FEATURE_FLAGS,
				futureSpec({
					readSites: [
						...futureSpec().readSites,
						{
							...futureSpec().readSites[0]!,
							resolverSymbol: "storeFutureDynamicFlagAlternate",
						},
					],
				}),
			],
			storeManagedFlags: withFutureManaged(),
			codecForName: (name) =>
				name === "future_dynamic_flag" ? futureCodec : getFlagStoreCodec(name),
		});
		expect(multipleResolvers.join("\n")).toMatch(
			/future_dynamic_flag.*exactly one resolver/i,
		);
	});

	it("rejects constant booleans, permissive value codecs, and degenerate enums", () => {
		const constantBool = validateFlagAuthoringPolicy({
			flags: [...FEATURE_FLAGS, futureSpec()],
			storeManagedFlags: withFutureManaged(),
			codecForName: (name) =>
				name === "future_dynamic_flag"
					? constantCodec
					: getFlagStoreCodec(name),
		});
		expect(constantBool.join("\n")).toMatch(
			/future_dynamic_flag.*raw.*0.*1|boolean codec.*both states/i,
		);

		const unsupportedValue = validateFlagAuthoringPolicy({
			flags: [
				...FEATURE_FLAGS,
				futureSpec({
					valueKind: "value",
					default: "always",
					polarity: "default_on",
				}),
			],
			storeManagedFlags: withFutureManaged(),
			codecForName: (name) =>
				name === "future_dynamic_flag"
					? {
							parse: () => "always",
							canonicalEffective: String,
						}
					: getFlagStoreCodec(name),
		});
		expect(unsupportedValue.join("\n")).toMatch(
			/future_dynamic_flag.*value codec.*reject invalid writes/i,
		);

		const permissiveProjectValue = validateFlagAuthoringPolicy({
			flags: [
				...FEATURE_FLAGS,
				futureProjectSpec({
					valueKind: "value",
					default: "3",
					polarity: "default_on",
				}),
			],
			storeManagedFlags: withFutureManaged(),
			projectStoreManagedFlags: withFutureProjectManaged(),
			codecForName: (name) =>
				name === "future_dynamic_flag"
					? {
							parse: () => "3",
							canonicalEffective: String,
						}
					: getFlagStoreCodec(name),
		});
		expect(permissiveProjectValue.join("\n")).toMatch(
			/future_dynamic_flag.*value codec.*reject invalid writes/i,
		);

		const degenerateEnum = validateFlagAuthoringPolicy({
			codecForName: (name) =>
				name === "skill_framework_mode"
					? {
							parse: () => "superpowers",
							canonicalEffective: () => "superpowers",
						}
					: getFlagStoreCodec(name),
		});
		expect(degenerateEnum.join("\n")).toMatch(
			/skill_framework_mode.*enum.*round-trip/i,
		);
	});

	it("permits compliant managed growth without changing the legacy baseline", () => {
		expect(
			validateFlagAuthoringPolicy({
				flags: [...FEATURE_FLAGS, futureSpec()],
				storeManagedFlags: withFutureManaged(),
				codecForName: (name) =>
					name === "future_dynamic_flag"
						? futureCodec
						: getFlagStoreCodec(name),
			}),
		).toEqual([]);
	});

	it("preserves the two existing boolean raw-value idioms", () => {
		const defaultOn = getFlagStoreCodec("flag_retirement_scan");
		const optIn = getFlagStoreCodec("workflow_turn_divergence_alerts");
		expect(defaultOn?.parse({ hasOverride: false, raw: null })).toBe(true);
		expect(defaultOn?.parse({ hasOverride: true, raw: "0" })).toBe(false);
		expect(defaultOn?.parse({ hasOverride: true, raw: "garbage" })).toBe(true);
		expect(optIn?.parse({ hasOverride: false, raw: null })).toBe(false);
		expect(optIn?.parse({ hasOverride: true, raw: "1" })).toBe(true);
		expect(optIn?.parse({ hasOverride: true, raw: "true" })).toBe(false);
		expect(defaultOn?.canonicalEffective(false)).toBe("false");
		expect(optIn?.canonicalEffective(true)).toBe("true");
	});

	it("validates the summary absorption cadence as a bounded integer", () => {
		const codec = getFlagStoreCodec("summary_absorption_cadence_ms")!;
		expect(codec.parse({ hasOverride: false, raw: null })).toBe("21600000");
		expect(codec.parse({ hasOverride: true, raw: "60000" })).toBe("60000");
		expect(codec.parse({ hasOverride: true, raw: "2592000000" })).toBe(
			"2592000000",
		);
		for (const raw of ["", "0", "59999", "1.5", "2592000001", "Infinity"]) {
			expect(() => codec.parse({ hasOverride: true, raw }), raw).toThrow(
				/summary absorption cadence/i,
			);
		}
	});

	it("registers node dwell threshold hours as a strict project scalar", () => {
		const enabled = FEATURE_FLAGS.find(({ name }) => name === "node_dwell");
		expect(enabled).toMatchObject({
			source: "project_config",
			scope: "project",
			configKey: "patrol.node_dwell_enabled",
			polarity: "default_on",
			valueKind: "bool",
			default: true,
			toggleable: "conversational",
		});
		expect(
			getFlagStoreCodec("node_dwell")?.parse({
				hasOverride: false,
				raw: null,
			}),
		).toBe(true);

		const threshold = FEATURE_FLAGS.find(
			({ name }) => name === "node_dwell_threshold_hours",
		);
		expect(threshold).toMatchObject({
			source: "project_config",
			scope: "project",
			configKey: "patrol.node_dwell_threshold_hours",
			valueKind: "value",
			default: "3",
		});

		const codec = getFlagStoreCodec("node_dwell_threshold_hours")!;
		expect(codec.parse({ hasOverride: false, raw: null })).toBe("3");
		for (const raw of ["0.25", "3", "12.5"]) {
			expect(codec.parse({ hasOverride: true, raw }), raw).toBe(raw);
			expect(codec.canonicalEffective(raw), raw).toBe(raw);
		}
		for (const raw of ["", "0", "-1", "Infinity", "NaN", "3 hours"]) {
			expect(() => codec.parse({ hasOverride: true, raw }), raw).toThrow(
				/node dwell threshold/i,
			);
		}
	});

	it("keeps every registry codec aligned with its default and polarity", () => {
		for (const name of FEATURE_FLAGS.map(({ name }) => name)) {
			const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name)!;
			const codec = getFlagStoreCodec(name)!;
			expect(codec.parse({ hasOverride: false, raw: null }), name).toBe(
				spec.default,
			);
			if (spec.valueKind === "bool") {
				expect(codec.parse({ hasOverride: true, raw: "0" }), name).toBe(false);
				expect(codec.parse({ hasOverride: true, raw: "1" }), name).toBe(true);
				expect(codec.canonicalEffective(false), name).toBe("false");
				expect(codec.canonicalEffective(true), name).toBe("true");
				continue;
			}
			if (spec.valueKind === "enum") {
				for (const member of spec.enumValues ?? []) {
					expect(
						codec.parse({ hasOverride: true, raw: member }),
						`${name}:${member}`,
					).toBe(member);
					expect(codec.canonicalEffective(member), `${name}:${member}`).toBe(
						member,
					);
				}
				expect(
					codec.parse({ hasOverride: true, raw: "__unsupported__" }),
					name,
				).toBe(spec.default);
			}
		}
	});

	it("canonicalizes skill_framework_mode as a global control, including split", () => {
		const codec = getFlagStoreCodec("skill_framework_mode");
		for (const [raw, expected] of [
			[null, "superpowers"],
			["", "superpowers"],
			["invalid", "superpowers"],
			["superpowers", "superpowers"],
			["matt", "matt"],
			["bare", "bare"],
			["bare-ponytail", "bare-ponytail"],
			["split", "split"],
		] as const) {
			expect(
				codec?.parse({ hasOverride: raw !== null, raw }),
				String(raw),
			).toBe(expected);
			expect(codec?.canonicalEffective(expected)).toBe(expected);
		}
	});
});
