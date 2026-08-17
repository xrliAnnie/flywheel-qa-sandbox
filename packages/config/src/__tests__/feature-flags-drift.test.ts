import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FLAG_EXEMPTIONS } from "../feature-flags/exemptions.js";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import {
	NON_FLAG_ALLOWLIST,
	NON_FLAG_CONFIG_KEYS,
	RETIRED_FLAGS,
} from "../feature-flags/truth.js";
import {
	auditFlagAccounts,
	collectProductionSources,
	enumerateBooleanConfigPaths,
	type ReadSiteLike,
	scanSources,
	validateReadSiteEvidence,
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
		expect(found.has("FLYWHEEL_DESIGN_HTML_GATE")).toBe(true);
		expect(found.has("FLYWHEEL_MERGE_APPROVAL_GATE")).toBe(true);
		expect(found.has("FLYWHEEL_CONVERGE_CMUX_SYMLINK")).toBe(true);
	});

	it("validates every declared readSite with pattern-aware code evidence", () => {
		const missing: string[] = [];
		for (const flag of FEATURE_FLAGS) {
			for (const site of flag.readSites) {
				const text = sourceByFile.get(site.file);
				if (text === undefined) {
					missing.push(
						`${flag.name} @ ${site.file}: production file not scanned`,
					);
					continue;
				}
				const issue = validateReadSiteEvidence({
					file: site.file,
					text,
					site: site as ReadSiteLike,
					envVar: flag.envVar,
					configKey: flag.configKey,
				});
				if (issue) missing.push(`${flag.name} @ ${site.file}: ${issue}`);
			}
		}
		expect(
			missing,
			`registered readSite evidence missing:\n${missing.join("\n")}`,
		).toEqual([]);
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
			"qa_auto",
			"doc_flow",
			"skill_framework_split_participation",
			"proofshot",
			"xiaohongshu_learning",
			"ponytail",
			"founder_ux_gate",
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
				name: "qa_auto",
				site: {
					file: "packages/teamlead/src/bridge/auto-qa-policy.ts",
					symbol: "resolveAutoQaPolicy",
					pattern: "config",
					timing: "call_time",
					configAccess: "cfg.auto",
				},
			},
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
			{
				name: "founder_ux_gate",
				site: {
					file: "packages/config/src/ConfigLoader.ts",
					symbol: "ConfigLoader.validate",
					pattern: "config",
					timing: "call_time",
					configAccess: "founderUxGate.mode",
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
			{
				name: "codex_hard_gate_killswitch",
				site: {
					file: "packages/teamlead/src/bridge/auto-qa-held.ts",
					symbol: "codexHardGateEnabled",
					pattern: "delegated",
					timing: "call_time",
					resolverModule: "packages/teamlead/src/bridge/codex-gate.ts",
					resolverSymbol: "codexHardGateEnabled",
				},
			},
		]);

		expect(
			FEATURE_FLAGS.flatMap((flag) =>
				flag.readSites
					.filter((site) => site.pattern === "dynamic")
					.map((site) => `${flag.name}:${site.symbol}`),
			),
		).toEqual([
			"mailbox_queue:resolveLiveMailboxQueueEnabled",
			"converge_cmux_symlink:converge_cmux_symlink",
			"cmux_linked_view:load_cmux_bool_flag",
			"merge_approval_gate_killswitch:resolveDefaultOnGate",
			"qa_done_gate_killswitch:resolveDefaultOnGate",
			"workflow_claims_read:resolveDefaultOffGate",
			"workflow_claims_read:verifyApprovalWithBridgeHead",
		]);
	});

	it("enforces registry-or-reasoned-accounting for every env/config boolean", () => {
		const issues = auditFlagAccounts({
			rawCodeHits: scan.rawCodeHits,
			configPaths,
			registeredEnvVars,
			registeredConfigKeys,
			nonFlagEnv: NON_FLAG_ALLOWLIST,
			nonFlagConfigKeys: NON_FLAG_CONFIG_KEYS,
			exemptions: FLAG_EXEMPTIONS,
			retiredEnvVars: new Set(RETIRED_FLAGS.map((flag) => flag.envVar)),
		});
		expect(issues, `flag accounting violations:\n${issues.join("\n")}`).toEqual(
			[],
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
