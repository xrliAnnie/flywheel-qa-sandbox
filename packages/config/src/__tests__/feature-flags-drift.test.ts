import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	FLAG_EXEMPTIONS,
	type FlagExemption,
} from "../feature-flags/exemptions.js";
import {
	FEATURE_FLAGS,
	type FeatureFlagSpec,
} from "../feature-flags/registry.js";
import {
	getFlagStoreCodec,
	STORE_MANAGED_FLAGS,
	validateFlagAuthoringPolicy,
} from "../feature-flags/store-policy.js";
import {
	NON_FLAG_ALLOWLIST,
	NON_FLAG_CONFIG_KEYS,
	RETIRED_CONFIG_PATHS,
	RETIRED_FLAGS,
} from "../feature-flags/truth.js";
import {
	auditFlagAccounts,
	collectProductionSources,
	driftScanParseStats,
	enumerateBooleanConfigPaths,
	resetDriftScanParseStats,
	scanSources,
	validateDeclaredReadSites,
} from "./drift-scan/index.js";

// FLY-1455: the registry-or-owned-exemption invariant runs over every package
// production src plus production TS/MJS/shell scripts. AST hits are the only
// TypeScript/MJS authority; regex candidates are diagnostic cross-checks.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const sources = collectProductionSources(REPO_ROOT);
const sourceByFile = new Map(
	sources.map((source) => [source.file, source.text]),
);
const scan = scanSources(sources);
const configPaths = enumerateBooleanConfigPaths(
	join(REPO_ROOT, "packages/config/src/types.ts"),
);
const registeredEnvVars = new Set(
	FEATURE_FLAGS.flatMap((flag) => (flag.envVar ? [flag.envVar] : [])),
);
const registeredConfigKeys = new Set(
	FEATURE_FLAGS.flatMap((flag) =>
		flag.valueKind === "bool" && flag.configKey ? [flag.configKey] : [],
	),
);

describe("feature-flag drift guard", () => {
	it("scans every production package root plus root/package scripts", () => {
		expect(
			sources.some((source) =>
				source.file.startsWith("packages/claude-runner/src/"),
			),
		).toBe(true);
		expect(
			sources.some((source) =>
				source.file.startsWith("packages/voice-bridge/src/"),
			),
		).toBe(true);
		expect(sources.some((source) => source.file.endsWith(".mjs"))).toBe(true);
		expect(
			sources.some(
				(source) =>
					source.file === "packages/onboard-shell/bin/flywheel-onboard.js",
			),
		).toBe(true);
		expect(
			sources.some(
				(source) => source.file === "packages/onboard-shell/lib/key.mjs",
			),
		).toBe(true);
		expect(
			sources.some(
				(source) =>
					source.file.startsWith("scripts/") && source.file.endsWith(".sh"),
			),
		).toBe(true);
		expect(
			sources.some(
				(source) =>
					source.file.startsWith("scripts/") && source.file.endsWith(".ts"),
			),
		).toBe(true);
	});

	it("parses every TypeScript/MJS source and reconciles every code regex occurrence", () => {
		expect(
			scan.diagnostics,
			`drift scanner diagnostics:\n${scan.diagnostics.join("\n")}`,
		).toEqual([]);
	});

	it("finds known direct, helper, MJS, and shell gates", () => {
		const found = new Set(scan.rawCodeHits.map((hit) => hit.name));
		expect(found.has("FLYWHEEL_MERGE_APPROVAL_GATE")).toBe(true);
		expect(found.has("FLYWHEEL_CMUX_REOPEN_SWEEP")).toBe(true);
	});

	// FLY-1852: the registry-wide pass lives in validateDeclaredReadSites() so
	// that the code counted by the work-sharing invariants in drift-scan.test.ts
	// is the same code that ships here. It groups the declared sites by file, so
	// each production file is parsed and scanned ONCE for all of its sites.
	// Site-by-site evaluation re-derived both artifacts per site — and twice per
	// site, because the nested scan parsed the file again — which put this single
	// assertion at ~3s of its 5s budget and made it time out whenever the CI
	// runner was busy. Same sites, same evidence rules, same declaration-ordered
	// failure text; only the work sharing changed.
	//
	// The work is asserted HERE, on the real registry, and not only in
	// drift-scan.test.ts against the helper (Codex review R2, Medium): otherwise
	// this guard could quietly go back to calling the helper once per site — an
	// unchanged helper, unchanged [] result, unchanged helper-level tests, and
	// the timeout right back. Measured, that revert costs 71 parses / 59 scans.
	//
	// The invariant is per file rather than a total, because a total only
	// supports a threshold and the threshold has slack. Measured: dropping the
	// scan memo for packages/teamlead/src/bridge/plugin.ts alone — 4 sites,
	// 1624ms of the original 2962ms — takes that file from 1 scan to 4 while the
	// total only moves 39 -> 42 against 47 distinct files, so the total-form
	// assertion passed 7/7 with that regression present. The per-file form
	// caught it at 4 > 1, and stays correct as the registry grows.
	it("validates every declared readSite with pattern-aware code evidence", () => {
		const declaredFiles = new Set(
			FEATURE_FLAGS.flatMap((flag) =>
				flag.readSites
					.map((site) => site.file)
					.filter((file) => sourceByFile.has(file)),
			),
		);
		const declaredSites = FEATURE_FLAGS.reduce(
			(count, flag) => count + flag.readSites.length,
			0,
		);

		resetDriftScanParseStats();
		const missing = validateDeclaredReadSites({
			flags: FEATURE_FLAGS,
			sourceByFile,
		});
		const work = driftScanParseStats();

		expect(
			missing,
			`registered readSite evidence missing:\n${missing.join("\n")}`,
		).toEqual([]);

		// Work sharing: no file is parsed or scanned twice for the whole pass.
		expect(work.maxFileParses).toBeLessThanOrEqual(1);
		expect(work.maxFileScans).toBeLessThanOrEqual(1);
		// Coverage: every declared site reached a verdict. This is counted, not
		// derived from the artifact tallies (Codex review R4, Medium): a floor
		// over parses+scans is satisfiable while most of the registry goes
		// unchecked, because a checked file contributes both a parse and a scan
		// and can cover for a skipped one. Measured, evaluating only the first 26
		// of 56 flags produced 24 parses + 24 scans against 47 files and passed;
		// so did deduping config sites by (file, symbol), which silently dropped
		// five real sites while every other number matched the baseline exactly.
		expect(declaredFiles.size).toBeGreaterThan(0);
		expect(work.siteChecks).toBe(declaredSites);
	});

	it("rejects a plausible delegated wrapper name unless production imports and calls it", () => {
		const template = FEATURE_FLAGS.find(
			(flag) => flag.name === "flag_retirement_scan",
		) as FeatureFlagSpec;
		const injected: FeatureFlagSpec = {
			...template,
			name: "future_dynamic_flag",
			envVar: "FLYWHEEL_FUTURE_DYNAMIC_FLAG",
			readSites: [
				{
					file: "packages/teamlead/src/bridge/plugin.ts",
					symbol: "futureFlagInjection",
					pattern: "delegated",
					timing: "call_time",
					resolverModule: "packages/teamlead/src/bridge/flag-store-runtime.ts",
					resolverSymbol: "storeFutureDynamicFlagEnabled",
				},
			],
		};
		expect(
			validateDeclaredReadSites({ flags: [injected], sourceByFile }).join("\n"),
		).toMatch(/future_dynamic_flag.*consumer anchor.*not found/i);
	});

	it("binds a delegated store resolver body to the exact managed flag identity", () => {
		const template = FEATURE_FLAGS.find(
			(flag) => flag.name === "flag_retirement_scan",
		) as FeatureFlagSpec;
		const borrowed: FeatureFlagSpec = {
			...template,
			name: "future_dynamic_flag",
			envVar: "FLYWHEEL_FUTURE_DYNAMIC_FLAG",
		};
		expect(
			validateDeclaredReadSites({ flags: [borrowed], sourceByFile }).join("\n"),
		).toMatch(
			/future_dynamic_flag.*resolver.*does not read.*future_dynamic_flag/i,
		);

		const consumerFile = "packages/example/src/future-consumer.ts";
		const resolverFile = "packages/teamlead/src/bridge/flag-store-runtime.ts";
		const fakeAnchor: FeatureFlagSpec = {
			...borrowed,
			readSites: [
				{
					file: consumerFile,
					symbol: "futureConsumer",
					pattern: "delegated",
					timing: "call_time",
					resolverModule: resolverFile,
					resolverSymbol: "storeFutureDynamicFlagEnabled",
				},
			],
		};
		const syntheticSources = new Map(sourceByFile);
		syntheticSources.set(
			consumerFile,
			[
				'import { storeFutureDynamicFlagEnabled } from "../../teamlead/src/bridge/flag-store-runtime.js";',
				"function futureConsumer(): boolean {",
				"  return storeFutureDynamicFlagEnabled(runtime);",
				"}",
			].join("\n"),
		);
		syntheticSources.set(
			resolverFile,
			[
				"function readBoolean(runtime: unknown, name: string): boolean { return Boolean(runtime && name); }",
				"export function storeFutureDynamicFlagEnabled(runtime: unknown): boolean {",
				'  const featureAnchor = "future_dynamic_flag";',
				'  return readBoolean(runtime, "flag_retirement_scan") && Boolean(featureAnchor);',
				"}",
			].join("\n"),
		);
		expect(
			validateDeclaredReadSites({
				flags: [fakeAnchor],
				sourceByFile: syntheticSources,
			}).join("\n"),
		).toMatch(
			/future_dynamic_flag.*resolver.*does not read.*future_dynamic_flag/i,
		);
	});

	it("binds a delegated resolver call to the declared consumer AST anchor", () => {
		const template = FEATURE_FLAGS.find(
			(flag) => flag.name === "flag_retirement_scan",
		) as FeatureFlagSpec;
		const consumerFile = "packages/example/src/future-consumer.ts";
		const resolverFile = "packages/teamlead/src/bridge/flag-store-runtime.ts";
		const injected: FeatureFlagSpec = {
			...template,
			name: "future_dynamic_flag",
			envVar: "FLYWHEEL_FUTURE_DYNAMIC_FLAG",
			readSites: [
				{
					file: consumerFile,
					symbol: "nonexistentFeatureAnchor",
					pattern: "delegated",
					timing: "call_time",
					resolverModule: resolverFile,
					resolverSymbol: "storeFutureDynamicFlagEnabled",
				},
			],
		};
		const syntheticSources = new Map(sourceByFile);
		syntheticSources.set(
			consumerFile,
			[
				'import { storeFutureDynamicFlagEnabled } from "../../teamlead/src/bridge/flag-store-runtime.js";',
				"storeFutureDynamicFlagEnabled(runtime);",
			].join("\n"),
		);
		syntheticSources.set(
			resolverFile,
			[
				"function readBoolean(runtime: unknown, name: string): boolean { return Boolean(runtime && name); }",
				"export function storeFutureDynamicFlagEnabled(runtime: unknown): boolean {",
				'  return readBoolean(runtime, "future_dynamic_flag");',
				"}",
			].join("\n"),
		);
		expect(
			validateDeclaredReadSites({
				flags: [injected],
				sourceByFile: syntheticSources,
			}).join("\n"),
		).toMatch(/nonexistentFeatureAnchor.*not found|declared consumer.*anchor/i);
	});

	it("pins migrated config, delegated, and dynamic readSite identities", () => {
		expect(
			FEATURE_FLAGS.find((flag) => flag.name === "checkpoint_enabled")
				?.readSites[0],
		).toEqual({
			file: "packages/edge-worker/src/Blueprint.ts",
			symbol: "Blueprint.runInner",
			pattern: "config",
			timing: "call_time",
			configAccess: "cpConfig.enabled",
		});

		const configFlags = new Set([
			"doc_flow",
			"skill_framework_split_participation",
			"proofshot",
			"xiaohongshu_learning",
			"ponytail",
		]);
		expect(
			FEATURE_FLAGS.filter((flag) => configFlags.has(flag.name)).map(
				(flag) => ({
					name: flag.name,
					site: flag.readSites[0],
				}),
			),
		).toEqual([
			{
				name: "doc_flow",
				site: {
					file: "packages/edge-worker/src/Blueprint.ts",
					symbol: "Blueprint.runInner",
					pattern: "config",
					timing: "call_time",
					configAccess: "this.docFlowConfig.enabled",
				},
			},
			{
				name: "skill_framework_split_participation",
				site: {
					file: "packages/teamlead/src/bridge/skill-framework-participation.ts",
					symbol: "makeSkillFrameworkParticipationReader",
					pattern: "config",
					timing: "call_time",
					configAccess: "skillFramework.split",
				},
			},
			{
				name: "proofshot",
				site: {
					file: "packages/config/src/ConfigLoader.ts",
					symbol: "ConfigLoader.validate",
					pattern: "config",
					timing: "call_time",
					configAccess: "ps.enabled",
				},
			},
			{
				name: "xiaohongshu_learning",
				site: {
					file: "packages/config/src/ConfigLoader.ts",
					symbol: "ConfigLoader.validate",
					pattern: "config",
					timing: "call_time",
					configAccess: "xhs.enabled",
				},
			},
			{
				name: "ponytail",
				site: {
					file: "packages/config/src/ConfigLoader.ts",
					symbol: "ConfigLoader.validate",
					pattern: "config",
					timing: "call_time",
					configAccess: "ponytail.enabled",
				},
			},
		]);

		expect(
			FEATURE_FLAGS.flatMap((flag) =>
				flag.readSites
					.filter((site) => site.pattern === "delegated")
					.map((site) => ({ name: flag.name, site })),
			),
		).toEqual([
			...[
				["alert_system", "storeAlertSystemEnabled"],
				["loop_profiler", "storeLoopProfilerEnabled"],
				["shipped_husk_force", "storeShippedHuskForceEnabled"],
			].map(([name, resolverSymbol]) => ({
				name,
				site: {
					file: "packages/teamlead/src/bridge/plugin.ts",
					symbol: "startBridge",
					pattern: "delegated",
					timing: "call_time",
					resolverModule: "packages/teamlead/src/bridge/flag-store-runtime.ts",
					resolverSymbol,
				},
			})),
			{
				name: "flag_retirement_scan",
				site: {
					file: "packages/teamlead/src/bridge/plugin.ts",
					symbol: "flagRetirementScanner",
					pattern: "delegated",
					timing: "call_time",
					resolverModule: "packages/teamlead/src/bridge/flag-store-runtime.ts",
					resolverSymbol: "storeFlagRetirementScanEnabled",
				},
			},
			...[
				[
					"workflow_rework_reentry",
					"packages/teamlead/src/bridge/plugin.ts",
					"workflowReworkCoordinatorHolder.current",
					"storeWorkflowReworkReentryEnabled",
				],
				[
					"workflow_rework_reentry",
					"packages/teamlead/src/bridge/plugin.ts",
					"workflowEngineDispatcher",
					"storeWorkflowReworkReentryEnabled",
				],
				[
					"skill_framework_mode",
					"packages/teamlead/src/bridge/plugin.ts",
					"runsRouter",
					"storeSkillFrameworkModeControl",
				],
				[
					"skill_framework_mode",
					"packages/teamlead/src/bridge/run-infra.ts",
					"skillFrameworkModeControl",
					"storeSkillFrameworkModeControl",
				],
				[
					"skill_framework_mode",
					"packages/teamlead/src/bridge/run-infra.ts",
					"createRunInfraDispatcher",
					"storeSkillFrameworkModeControl",
				],
				[
					"workflow_turn_divergence_alerts",
					"packages/teamlead/src/bridge/plugin.ts",
					"gatePoller",
					"storeWorkflowTurnDivergenceAlertsEnabled",
				],
			].map(([name, file, symbol, resolverSymbol]) => ({
				name,
				site: {
					file,
					symbol,
					pattern: "delegated",
					timing: "call_time",
					resolverModule: "packages/teamlead/src/bridge/flag-store-runtime.ts",
					resolverSymbol,
				},
			})),
		]);

		expect(
			FEATURE_FLAGS.flatMap((flag) =>
				flag.readSites
					.filter((site) => site.pattern === "dynamic")
					.map((site) => `${flag.name}:${site.symbol}`),
			),
		).toEqual([
			"mailbox_queue:resolveLiveMailboxQueueEnabled",
			"merge_approval_gate_killswitch:resolveDefaultOnGate",
		]);
	});

	it("enforces registry-or-reasoned-accounting for every env/config boolean", () => {
		const storeManagedEnvVars = new Set(
			FEATURE_FLAGS.filter((spec) =>
				STORE_MANAGED_FLAGS.has(spec.name),
			).flatMap((spec) => (spec.envVar ? [spec.envVar] : [])),
		);
		const issues = auditFlagAccounts({
			rawCodeHits: scan.rawCodeHits,
			configPaths,
			registeredEnvVars,
			registeredConfigKeys,
			nonFlagEnv: NON_FLAG_ALLOWLIST,
			nonFlagConfigKeys: NON_FLAG_CONFIG_KEYS,
			exemptions: FLAG_EXEMPTIONS,
			retiredEnvVars: new Set(RETIRED_FLAGS.map((flag) => flag.envVar)),
			retiredConfigPaths: new Set(
				RETIRED_CONFIG_PATHS.map((entry) => entry.path),
			),
			storeManagedEnvVars,
		});
		const skillModeCompatibilityReads = scan.rawCodeHits.filter(
			(hit) =>
				hit.name === "FLYWHEEL_SKILL_FRAMEWORK_MODE" &&
				hit.file === "packages/config/src/skill-framework-mode.ts" &&
				hit.code === "args.env[SKILL_FRAMEWORK_MODE_ENV]" &&
				hit.anchorSymbol === "resolveSkillFrameworkMode" &&
				typeof hit.anchorStart === "number" &&
				typeof hit.anchorEnd === "number" &&
				hit.anchorStart <= hit.start &&
				hit.end <= hit.anchorEnd,
		);
		expect(
			skillModeCompatibilityReads,
			"the sole store-fed synthetic env compatibility read must be exercised",
		).toHaveLength(1);
		expect(issues, `flag accounting violations:\n${issues.join("\n")}`).toEqual(
			[],
		);
	});

	it("rejects undeclared raw env reads for a store-managed registry spec", () => {
		const template = FEATURE_FLAGS.find(
			(spec) => spec.name === "flag_retirement_scan",
		) as FeatureFlagSpec;
		const consumerFile = "packages/teamlead/src/bridge/future-flag-consumer.ts";
		const resolverFile = "packages/teamlead/src/bridge/flag-store-runtime.ts";
		const futureSpec: FeatureFlagSpec = {
			...template,
			name: "future_dynamic_flag",
			envVar: "FLYWHEEL_FUTURE_DYNAMIC_FLAG",
			readSites: [
				{
					file: consumerFile,
					symbol: "futureFeatureAnchor",
					pattern: "delegated",
					timing: "call_time",
					resolverModule: resolverFile,
					resolverSymbol: "storeFutureDynamicFlagEnabled",
				},
			],
		};
		const flags = [...FEATURE_FLAGS, futureSpec];
		const storeManagedFlags = new Set([
			...STORE_MANAGED_FLAGS,
			futureSpec.name,
		]);
		expect(
			validateFlagAuthoringPolicy({
				flags,
				storeManagedFlags,
				codecForName: (name) =>
					name === futureSpec.name
						? {
								parse: ({ hasOverride, raw }) => !hasOverride || raw !== "0",
								canonicalEffective: String,
							}
						: getFlagStoreCodec(name),
			}),
		).toEqual([]);
		const compliantSources = new Map(sourceByFile);
		compliantSources.set(
			consumerFile,
			[
				'import { storeFutureDynamicFlagEnabled } from "./flag-store-runtime.js";',
				"export function futureFeatureAnchor(): boolean {",
				"  return storeFutureDynamicFlagEnabled(runtime);",
				"}",
			].join("\n"),
		);
		compliantSources.set(
			resolverFile,
			`${sourceByFile.get(resolverFile) ?? ""}\nexport function storeFutureDynamicFlagEnabled(runtime: FlagStoreRuntime): boolean { return readBoolean(runtime, "future_dynamic_flag"); }`,
		);
		expect(
			validateDeclaredReadSites({
				flags: [futureSpec],
				sourceByFile: compliantSources,
			}),
		).toEqual([]);
		const injectedRead = scanSources([
			{
				file: "packages/example/src/raw-future-flag.ts",
				text: "const enabled = process.env.FLYWHEEL_FUTURE_DYNAMIC_FLAG === '1';",
			},
		]);
		const issues = auditFlagAccounts({
			rawCodeHits: injectedRead.rawCodeHits,
			configPaths: [],
			registeredEnvVars: new Set(
				flags.flatMap((spec) => (spec.envVar ? [spec.envVar] : [])),
			),
			registeredConfigKeys: new Set(),
			nonFlagEnv: {},
			nonFlagConfigKeys: {},
			exemptions: [],
			retiredEnvVars: new Set(),
			retiredConfigPaths: new Set(),
			storeManagedEnvVars: new Set(
				flags
					.filter((spec) => storeManagedFlags.has(spec.name))
					.flatMap((spec) => (spec.envVar ? [spec.envVar] : [])),
			),
		});
		expect(issues.join("\n")).toMatch(
			/FLYWHEEL_FUTURE_DYNAMIC_FLAG.*store-managed.*raw/i,
		);
	});

	it("allows only one skill-mode compatibility read inside its named resolver", () => {
		const duplicateRead = scanSources([
			{
				file: "packages/config/src/skill-framework-mode.ts",
				text: [
					'const SKILL_FRAMEWORK_MODE_ENV = "FLYWHEEL_SKILL_FRAMEWORK_MODE";',
					"function resolveSkillFrameworkMode(args: { env: Record<string, string | undefined> }) {",
					"  const first = args.env[SKILL_FRAMEWORK_MODE_ENV];",
					"  const duplicate = args.env[SKILL_FRAMEWORK_MODE_ENV];",
					"  return first ?? duplicate;",
					"}",
				].join("\n"),
			},
		]);
		expect(duplicateRead.rawCodeHits).toHaveLength(2);
		const issues = auditFlagAccounts({
			rawCodeHits: duplicateRead.rawCodeHits,
			configPaths: [],
			registeredEnvVars: new Set(["FLYWHEEL_SKILL_FRAMEWORK_MODE"]),
			registeredConfigKeys: new Set(),
			nonFlagEnv: {},
			nonFlagConfigKeys: {},
			exemptions: [],
			retiredEnvVars: new Set(),
			retiredConfigPaths: new Set(),
			storeManagedEnvVars: new Set(["FLYWHEEL_SKILL_FRAMEWORK_MODE"]),
		});
		expect(issues.join("\n")).toMatch(
			/FLYWHEEL_SKILL_FRAMEWORK_MODE.*(?:single|cardinality|raw)/i,
		);
	});

	it("freezes exemptions even when the old audit sees a legal entry and real read", () => {
		const injectedExemption: FlagExemption = {
			name: "FLYWHEEL_FUTURE_INVOCATION_SEAM",
			kind: "env",
			persistentEnvAllowed: false,
			reason: "synthetic one-invocation seam for the bypass control",
			owner: "flywheel-eng-lead",
			issue: "FLY-1981",
		};
		const injectedRead = scanSources([
			{
				file: "packages/synthetic/src/future.ts",
				text: `export const enabled = process.env.${injectedExemption.name} === "1";`,
			},
		]);
		expect(injectedRead.rawCodeHits.map((hit) => hit.name)).toContain(
			injectedExemption.name,
		);
		const exemptions = [...FLAG_EXEMPTIONS, injectedExemption];
		expect(
			auditFlagAccounts({
				rawCodeHits: [...scan.rawCodeHits, ...injectedRead.rawCodeHits],
				configPaths,
				registeredEnvVars,
				registeredConfigKeys,
				nonFlagEnv: NON_FLAG_ALLOWLIST,
				nonFlagConfigKeys: NON_FLAG_CONFIG_KEYS,
				exemptions,
				retiredEnvVars: new Set(RETIRED_FLAGS.map((flag) => flag.envVar)),
				retiredConfigPaths: new Set(
					RETIRED_CONFIG_PATHS.map((entry) => entry.path),
				),
				storeManagedEnvVars: new Set(
					FEATURE_FLAGS.filter((spec) =>
						STORE_MANAGED_FLAGS.has(spec.name),
					).flatMap((spec) => (spec.envVar ? [spec.envVar] : [])),
				),
			}),
		).toEqual([]);
		const policyIssues = validateFlagAuthoringPolicy({ exemptions });
		expect(policyIssues.join("\n")).toMatch(
			/FLAG_EXEMPTIONS is frozen.*flag-authoring-runbook\.md/i,
		);
	});

	it("keeps drift tooling test-only and out of production package exports", () => {
		for (const file of ["src/index.ts", "src/feature-flags/index.ts"]) {
			const text = readFileSync(
				join(REPO_ROOT, "packages/config", file),
				"utf8",
			);
			expect(text).not.toContain("drift-scan");
			expect(text).not.toContain("exemptions");
		}
	});
});
