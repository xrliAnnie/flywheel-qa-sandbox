import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FlagExemption } from "../feature-flags/exemptions.js";
import {
	auditFlagAccounts,
	type CodeHit,
	collectProductionSources,
	enumerateBooleanConfigPaths,
	findRegexCandidates,
	reconcileRegexCandidates,
	type ScanSource,
	scanSources,
	validateReadSiteEvidence,
} from "./drift-scan/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
});

function source(file: string, text: string): ScanSource {
	return { file, text };
}

function names(result: ReturnType<typeof scanSources>): string[] {
	return [...new Set(result.rawCodeHits.map((hit) => hit.name))].sort();
}

describe("FLY-1455 production source discovery", () => {
	it("discovers every package src plus root/package production scripts", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1455-scan-"));
		tempDirs.push(root);
		for (const dir of [
			"packages/claude-runner/src",
			"packages/onboard-shell/bin",
			"packages/onboard-shell/lib",
			"packages/onboard-shell/coverage",
			"packages/onboard-shell/e2e",
			"packages/onboard-shell/examples",
			"packages/onboard-shell/test-scripts",
			"packages/voice-bridge/src",
			"packages/payload-endpoint/src",
			"packages/voice-bridge/scripts",
			"scripts/nested",
			"packages/voice-bridge/src/__tests__",
			"packages/voice-bridge/src/fixtures",
			"packages/voice-bridge/src/tests",
			"packages/voice-bridge/test",
		]) {
			mkdirSync(join(root, dir), { recursive: true });
		}
		writeFileSync(
			join(root, "packages/claude-runner/src/gate.ts"),
			"process.env.FLYWHEEL_CLAUDE_GATE;",
		);
		writeFileSync(
			join(root, "packages/onboard-shell/bin/flywheel-onboard.js"),
			"process.env.FLYWHEEL_ONBOARD_BIN_GATE;",
		);
		writeFileSync(
			join(root, "packages/onboard-shell/lib/key.mjs"),
			"process.env.FLYWHEEL_ONBOARD_LIB_GATE;",
		);
		for (const dir of ["coverage", "e2e", "examples", "test-scripts"]) {
			writeFileSync(
				join(root, `packages/onboard-shell/${dir}/ignored.mjs`),
				"process.env.FLYWHEEL_EXCLUDED_PACKAGE_DIR;",
			);
		}
		writeFileSync(
			join(root, "packages/voice-bridge/src/gate.ts"),
			"process.env.FLYWHEEL_VOICE_GATE;",
		);
		writeFileSync(
			join(root, "packages/payload-endpoint/src/index.mjs"),
			"process.env.FLYWHEEL_MJS_GATE;",
		);
		writeFileSync(
			join(root, "scripts/nested/gate.sh"),
			`[ "\${FLYWHEEL_SHELL_GATE:-0}" = "1" ]`,
		);
		writeFileSync(
			join(root, "scripts/gate.ts"),
			"process.env.FLYWHEEL_SCRIPT_TS_GATE;",
		);
		writeFileSync(
			join(root, "packages/voice-bridge/scripts/gate.mjs"),
			"process.env.FLYWHEEL_PACKAGE_SCRIPT_GATE;",
		);
		writeFileSync(
			join(root, "packages/voice-bridge/src/__tests__/ignored.ts"),
			"process.env.FLYWHEEL_IGNORED;",
		);
		writeFileSync(
			join(root, "packages/voice-bridge/src/fixtures/gate.ts"),
			"process.env.FLYWHEEL_FIXTURE_GATE;",
		);
		writeFileSync(
			join(root, "packages/voice-bridge/src/tests/helper.ts"),
			"process.env.FLYWHEEL_TEST_HELPER_GATE;",
		);
		writeFileSync(
			join(root, "packages/voice-bridge/vitest.config.ts"),
			"process.env.FLYWHEEL_VITEST_CONFIG_IGNORED;",
		);
		writeFileSync(
			join(root, "packages/voice-bridge/vitest.setup.ts"),
			"process.env.FLYWHEEL_VITEST_SETUP_IGNORED;",
		);
		writeFileSync(
			join(root, "packages/voice-bridge/test/setup.ts"),
			"process.env.FLYWHEEL_TEST_SETUP_IGNORED;",
		);
		writeFileSync(
			join(root, "packages/voice-bridge/test/fixtures.ts"),
			"process.env.FLYWHEEL_TEST_FIXTURES_IGNORED;",
		);
		writeFileSync(
			join(root, "packages/voice-bridge/src/ignored.test.mjs"),
			"process.env.FLYWHEEL_MJS_TEST_IGNORED;",
		);

		const found = collectProductionSources(root).map((entry) => entry.file);
		expect(found).toEqual([
			"packages/claude-runner/src/gate.ts",
			"packages/onboard-shell/bin/flywheel-onboard.js",
			"packages/onboard-shell/lib/key.mjs",
			"packages/payload-endpoint/src/index.mjs",
			"packages/voice-bridge/scripts/gate.mjs",
			"packages/voice-bridge/src/fixtures/gate.ts",
			"packages/voice-bridge/src/gate.ts",
			"packages/voice-bridge/src/tests/helper.ts",
			"scripts/gate.ts",
			"scripts/nested/gate.sh",
		]);
	});
});

describe("FLY-1455 TypeScript/MJS AST scanner", () => {
	it("recognizes direct, destructured, renamed, const-key, injected and truthy reads", () => {
		const result = scanSources([
			source(
				"packages/example/src/all.ts",
				`const DIRECT = process.env.FLYWHEEL_DIRECT;
const BRACKET = process.env["FLYWHEEL_BRACKET"];
const { FLYWHEEL_DESTRUCTURED, FLYWHEEL_RENAMED: renamed } = process.env;
const KEY = "FLYWHEEL_CONST_KEY";
const keyed = env[KEY];
if (cfg.FLYWHEEL_TRUTHY) use(cfg.FLYWHEEL_TRUTHY);
parseBool(opts.FLYWHEEL_HELPER);`,
			),
			source(
				"packages/example/src/all.mjs",
				`const { FLYWHEEL_MJS_DESTRUCTURED } = process.env;
if (cfg.FLYWHEEL_MJS_TRUTHY) run();`,
			),
		]);

		expect(result.diagnostics).toEqual([]);
		expect(names(result)).toEqual([
			"FLYWHEEL_BRACKET",
			"FLYWHEEL_CONST_KEY",
			"FLYWHEEL_DESTRUCTURED",
			"FLYWHEEL_DIRECT",
			"FLYWHEEL_HELPER",
			"FLYWHEEL_MJS_DESTRUCTURED",
			"FLYWHEEL_MJS_TRUTHY",
			"FLYWHEEL_RENAMED",
			"FLYWHEEL_TRUTHY",
		]);
	});

	it("does not count comment-only or string-only text as a read", () => {
		const result = scanSources([
			source(
				"packages/example/src/comments.ts",
				`// process.env.FLYWHEEL_COMMENT_ONLY
const sample = "process.env.FLYWHEEL_STRING_ONLY";
/* process.env.FLYWHEEL_BLOCK_COMMENT_ONLY */`,
			),
		]);

		expect(result.rawCodeHits).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});

	it("fails closed on a TypeScript parse error", () => {
		const result = scanSources([
			source(
				"packages/example/src/broken.ts",
				"if (process.env.FLYWHEEL_BROKEN {",
			),
		]);

		expect(result.diagnostics).toEqual(
			expect.arrayContaining([expect.stringMatching(/broken\.ts.*parse/i)]),
		);
	});

	it("reconciles regex candidates by occurrence span", () => {
		const fixture = source(
			"packages/example/src/two.ts",
			`process.env.FLYWHEEL_SAME;
process.env.FLYWHEEL_SAME;`,
		);
		const candidates = findRegexCandidates(fixture);
		const onlyFirstHit: CodeHit[] = [
			{
				name: "FLYWHEEL_SAME",
				file: fixture.file,
				form: "property",
				start: candidates[0]?.start ?? 0,
				end: candidates[0]?.end ?? 0,
			},
		];

		expect(reconcileRegexCandidates(fixture, candidates, onlyFirstHit)).toEqual(
			[expect.stringMatching(/unmatched.*FLYWHEEL_SAME.*occurrence/i)],
		);
	});
});

describe("FLY-1455 shell scanner", () => {
	it("recognizes comparison, case, boolean-default condition, presence, and alias forms", () => {
		const result = scanSources([
			source(
				"scripts/all.sh",
				`[ "\${FLYWHEEL_COMPARE:-0}" = "1" ]
case "\${FLYWHEEL_CASE:-}" in
  0|1) ;;
esac
if [[ "\${FLYWHEEL_DEFAULT_CONDITION:-true}" ]]; then :; fi
[ -n "\${FLYWHEEL_PRESENCE:-}" ]
local alias="\${FLYWHEEL_ALIAS:-false}"
if [ "$alias" = "true" ]; then :; fi
while [ "\${FLYWHEEL_WHILE:-0}" = "1" ]; do break; done
prepare && [ "\${FLYWHEEL_CHAINED:-false}" = "true" ]`,
			),
		]);

		expect(names(result)).toEqual([
			"FLYWHEEL_ALIAS",
			"FLYWHEEL_CASE",
			"FLYWHEEL_CHAINED",
			"FLYWHEEL_COMPARE",
			"FLYWHEEL_DEFAULT_CONDITION",
			"FLYWHEEL_PRESENCE",
			"FLYWHEEL_WHILE",
		]);
	});

	it("ignores full-line comments and non-boolean pass-through mentions", () => {
		const result = scanSources([
			source(
				"scripts/noise.sh",
				`# [ "\${FLYWHEEL_COMMENT_ONLY:-0}" = "1" ]
export FLYWHEEL_PASSTHROUGH
path="\${FLYWHEEL_PATH:-/tmp/file}"`,
			),
		]);

		expect(result.rawCodeHits).toEqual([]);
	});
});

describe("FLY-1455 config-schema enumeration", () => {
	it("enumerates the complete current FlywheelConfig boolean census", () => {
		const paths = enumerateBooleanConfigPaths(
			resolve(import.meta.dirname, "..", "types.ts"),
		);

		expect(paths).toEqual([
			"checkpoints.*.enabled",
			"doc_flow.enabled",
			"founder_milestone_report.enabled",
			"pipeline.dag",
			"pipeline.work_kind",
			"ponytail.enabled",
			"qa.auto",
			"skill_framework.split",
			"skills.enabled",
			"skills.proofshot.enabled",
			"skills.proofshot.vision_default",
			"xiaohongshu_learning.collections[].auto_create",
			"xiaohongshu_learning.enabled",
			"xiaohongshu_learning.video_opt_in",
		]);
		expect(paths).toContain("qa.auto");
	});
});

describe("FLY-1455 registry-or-exemption accounting", () => {
	const hit: CodeHit = {
		name: "FLYWHEEL_GATE",
		file: "scripts/gate.sh",
		form: "comparison",
		start: 0,
		end: 20,
	};
	const base = {
		rawCodeHits: [hit],
		configPaths: ["qa.auto"],
		registeredEnvVars: new Set<string>(),
		registeredConfigKeys: new Set<string>(),
		nonFlagEnv: {} as Record<string, string>,
		nonFlagConfigKeys: {} as Record<string, string>,
		retiredEnvVars: new Set<string>(),
	};

	it("rejects an unregistered env read and boolean config key", () => {
		expect(auditFlagAccounts({ ...base, exemptions: [] })).toEqual([
			expect.stringMatching(/FLYWHEEL_GATE.*register/i),
			expect.stringMatching(/qa\.auto.*register/i),
		]);
	});

	it("accepts a live exemption with a reason and owner", () => {
		const exemptions: FlagExemption[] = [
			{
				name: "FLYWHEEL_GATE",
				kind: "env",
				persistentEnvAllowed: false,
				reason: "QA fault injection seam",
				owner: "flywheel-eng-lead",
			},
		];
		expect(
			auditFlagAccounts({
				...base,
				exemptions,
				nonFlagConfigKeys: { "qa.auto": "ordinary config for fixture" },
			}),
		).toEqual([]);
	});

	it.each([
		{
			name: "FLYWHEEL_GATE",
			kind: "env",
			persistentEnvAllowed: false,
			reason: " ",
			owner: "team",
		},
		{
			name: "FLYWHEEL_GATE",
			kind: "env",
			persistentEnvAllowed: false,
			reason: "why",
			owner: " ",
		},
	] as FlagExemption[])("rejects blank exemption metadata", (exemption) => {
		expect(
			auditFlagAccounts({
				...base,
				exemptions: [exemption],
				nonFlagConfigKeys: { "qa.auto": "fixture" },
			}),
		).toEqual(expect.arrayContaining([expect.stringMatching(/blank/i)]));
	});

	it("rejects duplicate, overlapping, stale, and blank-ledger entries", () => {
		const exemptions: FlagExemption[] = [
			{
				name: "FLYWHEEL_STALE",
				kind: "env",
				persistentEnvAllowed: false,
				reason: "why",
				owner: "team",
			},
			{
				name: "FLYWHEEL_STALE",
				kind: "env",
				persistentEnvAllowed: false,
				reason: "again",
				owner: "team",
			},
		];
		const issues = auditFlagAccounts({
			...base,
			exemptions,
			registeredEnvVars: new Set(["FLYWHEEL_GATE"]),
			nonFlagEnv: { FLYWHEEL_GATE: " " },
			nonFlagConfigKeys: { "qa.auto": " " },
		});

		expect(issues).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/duplicate.*FLYWHEEL_STALE/i),
				expect.stringMatching(/stale.*FLYWHEEL_STALE/i),
				expect.stringMatching(/blank.*FLYWHEEL_GATE/i),
				expect.stringMatching(/blank.*qa\.auto/i),
				expect.stringMatching(/overlap.*FLYWHEEL_GATE/i),
			]),
		);
	});

	it("rejects retired env resurrection and stale config ledger entries", () => {
		const issues = auditFlagAccounts({
			...base,
			registeredConfigKeys: new Set(["missing.registered"]),
			exemptions: [
				{
					name: "missing.config",
					kind: "config_key",
					reason: "legacy seam",
					owner: "team",
				},
			],
			retiredEnvVars: new Set(["FLYWHEEL_GATE"]),
			nonFlagConfigKeys: { "qa.auto": "fixture" },
		});

		expect(issues).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/retired.*FLYWHEEL_GATE/i),
				expect.stringMatching(/stale.*missing\.registered/i),
				expect.stringMatching(/stale.*missing\.config/i),
			]),
		);
	});
});

describe("FLY-1455 reverse read-site evidence", () => {
	it("requires code evidence for direct reads, not comments", () => {
		expect(
			validateReadSiteEvidence({
				file: "packages/example/src/direct.ts",
				text: "// process.env.FLYWHEEL_DIRECT",
				envVar: "FLYWHEEL_DIRECT",
				site: {
					file: "packages/example/src/direct.ts",
					symbol: "read",
					pattern: "process.env",
					timing: "call_time",
				},
			}),
		).toMatch(/not found/i);
	});

	it("requires the canonical delegated import and call", () => {
		const site = {
			file: "packages/teamlead/src/bridge/consumer.ts",
			symbol: "codexHardGateEnabled",
			pattern: "delegated" as const,
			timing: "call_time" as const,
			resolverModule: "packages/teamlead/src/bridge/codex-gate.ts",
			resolverSymbol: "codexHardGateEnabled",
		};
		expect(
			validateReadSiteEvidence({
				file: site.file,
				text: "function codexHardGateEnabled() {}\ncodexHardGateEnabled();",
				envVar: "FLYWHEEL_CODEX_HARD_GATE",
				site,
			}),
		).toMatch(/canonical import/i);
		expect(
			validateReadSiteEvidence({
				file: site.file,
				text: 'import { codexHardGateEnabled as gate } from "./codex-gate.js";\ngate();',
				envVar: "FLYWHEEL_CODEX_HARD_GATE",
				site,
			}),
		).toBeNull();
	});

	it("anchors config evidence to the declared symbol and full access chain", () => {
		const site = {
			file: "packages/example/src/config.ts",
			symbol: "Reader.read",
			pattern: "config" as const,
			timing: "call_time" as const,
			configAccess: "this.cfg.enabled",
		};
		expect(
			validateReadSiteEvidence({
				file: site.file,
				text: "class Reader { read() { return other.enabled; } }",
				configKey: "example.enabled",
				site,
			}),
		).toMatch(/this\.cfg\.enabled/i);
		expect(
			validateReadSiteEvidence({
				file: site.file,
				text: "class Reader { read() { return (this.cfg as { enabled?: boolean })?.enabled!; } }",
				configKey: "example.enabled",
				site,
			}),
		).toBeNull();
	});

	it("requires real TS identifiers and shell assignment-plus-gate evidence for dynamic sites", () => {
		expect(
			validateReadSiteEvidence({
				file: "packages/example/src/dynamic.ts",
				text: 'const KEY = "FLYWHEEL_DYNAMIC"; readEnv(KEY);',
				envVar: "FLYWHEEL_DYNAMIC",
				site: {
					file: "packages/example/src/dynamic.ts",
					symbol: "descriptive prose",
					pattern: "dynamic",
					timing: "dotenv_live",
				},
			}),
		).toMatch(/identifier/i);
		expect(
			validateReadSiteEvidence({
				file: "scripts/dynamic.sh",
				text: `gate="\${FLYWHEEL_DYNAMIC:-1}"\n[ "$gate" = "1" ]`,
				envVar: "FLYWHEEL_DYNAMIC",
				site: {
					file: "scripts/dynamic.sh",
					symbol: "gate",
					pattern: "dynamic",
					timing: "cli_invocation",
				},
			}),
		).toBeNull();
		expect(
			validateReadSiteEvidence({
				file: "scripts/dynamic.sh",
				text: `# gate="\${FLYWHEEL_DYNAMIC:-1}"\nother=1`,
				envVar: "FLYWHEEL_DYNAMIC",
				site: {
					file: "scripts/dynamic.sh",
					symbol: "gate",
					pattern: "dynamic",
					timing: "cli_invocation",
				},
			}),
		).toMatch(/assignment/i);
	});
});
