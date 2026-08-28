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
	PROTECTED_LEGACY_FLAG_NAMES,
	RETIRED_FLAG_STORE_ROWS,
	STORE_MANAGED_FLAGS,
} from "../feature-flags/store-policy.js";

const MANAGED = [
	"loop_profiler",
	"shipped_husk_force",
	"flag_retirement_scan",
	"workflow_rework_reentry",
	"skill_framework_mode",
	"workflow_turn_divergence_alerts",
] as const;

const PROJECT_MANAGED = [
	"doc_flow",
	"pipeline_dag",
	"pipeline_work_kind",
	"proofshot",
	"xiaohongshu_learning",
] as const;

const PROTECTED = ["mailbox_queue", "merge_approval_gate_killswitch"] as const;

const LEGACY_UNMANAGED = [
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
] as const;

const LEGACY_EXEMPTIONS = [
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
	"env:FLYWHEEL_CLAUDE_FRESHNESS_BYPASS",
	"env:FLYWHEEL_CLAUDE_QUOTA_BYPASS",
	"env:FLYWHEEL_CMUX_DRY_RUN",
	"env:FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL",
	"env:FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE",
	"env:FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH",
	"env:FLYWHEEL_CMUX_TEST_SYNC_FUNCTIONS",
	"env:FLYWHEEL_DISCORD_CUTOVER_TEST_SEAMS",
	"env:FLYWHEEL_LEAD_V2_DRY_RUN",
	"env:FLYWHEEL_LEAD_V2_TEST_MODE",
	"env:FLYWHEEL_PROFILE_IDENTITY_BYPASS",
	"env:FLYWHEEL_QUOTA_E2E_KEEP",
	"env:FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT",
	"env:FLYWHEEL_CMUX_ORPHAN_REAPER",
	"env:FLYWHEEL_CMUX_REOPEN_SWEEP",
	"env:FLYWHEEL_CMUX_RESTORED_ADOPTION",
	"env:FLYWHEEL_CMUX_STOCK_ADOPTION",
	"env:FLYWHEEL_CODEX_HEALTH_GUARD",
	"env:FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT",
	"env:FLYWHEEL_DAEMON_SKIP_PS_SELF_PROBE",
	"env:FLYWHEEL_DISABLE_MAILBOX_SENTINEL",
	"env:FLYWHEEL_FOUNDER_APPROVAL_ACK",
	"env:FLYWHEEL_LEAD_CTX_RESUME_GATE",
	"env:FLYWHEEL_MERGED_GATE_GUARD",
	"env:FLYWHEEL_TURN_BELT_MERGED_RECLAIM",
	"env:FLYWHEEL_ELEVEN_AUTOSTART",
	"env:FLYWHEEL_GEMINI_AGENT",
	"env:FLYWHEEL_GEMINI_AUTOSTART",
	"env:FLYWHEEL_HEADPHONE_INCLUDE_ROUNDTABLE",
	"env:FLYWHEEL_HUDDLE_EARCON",
	"env:FLYWHEEL_HUDDLE_FILLER",
	"env:FLYWHEEL_RUNNER_SLIM_MCP",
	"env:FLYWHEEL_TUI_WINDOW_ALERT",
	"env:FLYWHEEL_VOICE_APPROVAL",
	"env:FLYWHEEL_VOICE_EDGE_TTS",
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
				file: "packages/example/src/config.ts",
				symbol: "future project flag",
				pattern: "config",
				timing: "call_time",
				configAccess: "future.enabled",
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
	it("freezes the M0-approved managed and protected sets", () => {
		expect([...STORE_MANAGED_FLAGS]).toEqual(expect.arrayContaining(MANAGED));
		expect([...PROJECT_STORE_MANAGED_FLAGS]).toEqual(PROJECT_MANAGED);
		expect([...PROTECTED_LEGACY_FLAG_NAMES]).toEqual(PROTECTED);
		expect([...RETIRED_FLAG_STORE_ROWS]).toEqual([
			"workflow_resume",
			"auto_qa_killswitch",
		]);
		for (const name of MANAGED) {
			const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
			expect(spec, name).toBeDefined();
			expect(getStoreEligibility(spec!)).toEqual({ eligible: true });
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
		expect(exemptionBaseline).toEqual(LEGACY_EXEMPTIONS);
		expect(Object.isFrozen(unmanagedBaseline)).toBe(true);
		expect(Object.isFrozen(exemptionBaseline)).toBe(true);

		const unmanaged = FEATURE_FLAGS.filter(
			(spec) =>
				!STORE_MANAGED_FLAGS.has(spec.name) &&
				!PROJECT_STORE_MANAGED_FLAGS.has(spec.name),
		).map((spec) => spec.name);
		for (const name of unmanaged) {
			expect(unmanagedBaseline, name).toContain(name);
		}
		for (const exemption of FlagExemptions.FLAG_EXEMPTIONS) {
			expect(
				exemptionBaseline,
				`${exemption.kind}:${exemption.name}`,
			).toContain(`${exemption.kind}:${exemption.name}`);
		}
	});

	it("accepts the current registry without freezing managed growth at four", () => {
		expect(validateFlagAuthoringPolicy()).toEqual([]);
	});

	it("assigns every current registry spec to exactly one active authoring branch", () => {
		for (const spec of FEATURE_FLAGS) {
			const memberships = [
				STORE_MANAGED_FLAGS.has(spec.name),
				PROJECT_STORE_MANAGED_FLAGS.has(spec.name),
				LEGACY_UNMANAGED.includes(
					spec.name as (typeof LEGACY_UNMANAGED)[number],
				) &&
					!STORE_MANAGED_FLAGS.has(spec.name) &&
					!PROJECT_STORE_MANAGED_FLAGS.has(spec.name),
			].filter(Boolean);
			expect(memberships, spec.name).toHaveLength(1);
		}
	});

	it("permits compliant project-scoped store growth", () => {
		expect(
			validateFlagAuthoringPolicy({
				flags: [...FEATURE_FLAGS, futureProjectSpec()],
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
		["governance", { category: "governance_gate" }],
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

	it("rejects a name assigned to both managed branches", () => {
		const issues = validateFlagAuthoringPolicy({
			projectStoreManagedFlags: new Set([
				...PROJECT_STORE_MANAGED_FLAGS,
				"loop_profiler",
			]),
		});
		expect(issues.join("\n")).toMatch(/loop_profiler.*both managed branches/i);
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

	it("does not let a new spec self-exempt by claiming governance_gate", () => {
		const issues = validateFlagAuthoringPolicy({
			flags: [...FEATURE_FLAGS, futureSpec({ category: "governance_gate" })],
		});
		expect(issues.join("\n")).toMatch(/future_dynamic_flag.*store-managed/i);
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
			/future_dynamic_flag.*project_config/i,
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

	it("rejects constant codecs, unsupported value codecs, and degenerate enums", () => {
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
			/future_dynamic_flag.*valueKind.*unsupported/i,
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

	it("refuses protected, governance, unlisted, value, and self-referential flags", () => {
		for (const name of PROTECTED) {
			const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
			expect(spec, name).toBeDefined();
			expect(getStoreEligibility(spec!)).toMatchObject({
				eligible: false,
			});
		}
		for (const name of [
			"voice_qa_presence_override",
			"issue_display_sweep_ticks",
			"flag_store",
		]) {
			const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
			expect(spec, name).toBeDefined();
			expect(getStoreEligibility(spec as never)).toMatchObject({
				eligible: false,
			});
		}
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

	it("keeps every managed codec aligned with its registry default and polarity", () => {
		for (const name of MANAGED) {
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
