import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FlagExemption } from "../feature-flags/exemptions.js";
import {
	auditFlagAccounts,
	type CodeHit,
	collectProductionSources,
	driftScanParseStats,
	enumerateBooleanConfigPaths,
	findRegexCandidates,
	reconcileRegexCandidates,
	resetDriftScanParseStats,
	type ScanSource,
	scanSources,
	validateDeclaredReadSites,
	validateReadSiteEvidence,
	validateReadSitesForFile,
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
			"pipeline.dag",
			"pipeline.work_kind",
			"ponytail.enabled",
			"skill_framework.split",
			"skills.enabled",
			"skills.proofshot.enabled",
			"skills.proofshot.vision_default",
			"xiaohongshu_learning.collections[].auto_create",
			"xiaohongshu_learning.enabled",
			"xiaohongshu_learning.video_opt_in",
		]);
		expect(paths).not.toContain("qa.auto");
		expect(paths).not.toContain("founder_milestone_report.enabled");
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
		retiredConfigPaths: new Set<string>(),
		storeManagedEnvVars: new Set<string>(),
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

	it("rejects a boolean descendant under a retired top-level config path", () => {
		const issues = auditFlagAccounts({
			...base,
			exemptions: [],
			registeredEnvVars: new Set(["FLYWHEEL_GATE"]),
			retiredConfigPaths: new Set(["qa"]),
		});
		expect(issues).toEqual([
			"retired config path qa has a boolean schema descendant qa.auto",
		]);
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
			symbol: "readRetirementScan",
			pattern: "delegated" as const,
			timing: "call_time" as const,
			resolverModule: "packages/teamlead/src/bridge/flag-store-runtime.ts",
			resolverSymbol: "storeFlagRetirementScanEnabled",
		};
		expect(
			validateReadSiteEvidence({
				file: site.file,
				text: "function storeFlagRetirementScanEnabled() {}\nfunction readRetirementScan() { storeFlagRetirementScanEnabled(); }",
				envVar: "FLYWHEEL_FLAG_RETIREMENT_SCAN",
				site,
			}),
		).toMatch(/canonical import/i);
		expect(
			validateReadSiteEvidence({
				file: site.file,
				text: 'import { storeFlagRetirementScanEnabled as gate } from "./flag-store-runtime.js";\nfunction readRetirementScan() { return gate(); }',
				envVar: "FLYWHEEL_FLAG_RETIREMENT_SCAN",
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

// FLY-1852: the readSite evidence pass used to re-parse the whole production
// file once per declared site, and parsed it a second time inside the nested
// `scanSources([source])` call — two full `ts.createSourceFile` passes per site.
// Files carrying several sites (packages/teamlead/src/bridge/plugin.ts is 372KB
// with 4 sites) paid that bill repeatedly, which is what pushed the drift guard
// to ~3s of its 5s budget and made it time out under CI concurrency.
//
// These are deterministic work-count invariants, not timing assertions, so they
// stay meaningful on a loaded machine. The fixture deliberately mixes patterns:
// `config` sites reach the parse directly while `process.env` sites reach it
// only through the scan, so a lost memo on EITHER artifact is observable. A
// same-pattern fixture would not be — verified by re-breaking each memo in turn
// and confirming these go red.
describe("FLY-1852 readSite evidence work sharing", () => {
	const mixedSource = [
		"export function alpha(config: { gate: boolean }) {",
		"\treturn config.gate;",
		"}",
		"export function beta(config: { other: boolean }) {",
		"\treturn config.other;",
		"}",
		"export function gamma() {",
		"\treturn process.env.FLYWHEEL_SHARED_ONE === '1';",
		"}",
		"export function delta() {",
		"\treturn process.env.FLYWHEEL_SHARED_TWO === '1';",
		"}",
	].join("\n");

	const FILE = "packages/example/src/shared.ts";

	// two `config` sites reach parseOnce() directly; two `process.env` sites
	// reach it only via scanOnce(). One parse and one scan must serve all four.
	const mixedRequests = [
		{
			site: {
				file: FILE,
				symbol: "alpha",
				pattern: "config" as const,
				timing: "call_time",
				configAccess: "config.gate",
			},
		},
		{
			site: {
				file: FILE,
				symbol: "beta",
				pattern: "config" as const,
				timing: "call_time",
				configAccess: "config.other",
			},
		},
		{
			site: {
				file: FILE,
				symbol: "gamma",
				pattern: "process.env" as const,
				timing: "call_time",
			},
			envVar: "FLYWHEEL_SHARED_ONE",
		},
		{
			site: {
				file: FILE,
				symbol: "delta",
				pattern: "process.env" as const,
				timing: "call_time",
			},
			envVar: "FLYWHEEL_SHARED_TWO",
		},
	];

	it("parses and scans a file once no matter how many sites it carries", () => {
		resetDriftScanParseStats();
		const issues = validateReadSitesForFile({
			file: FILE,
			text: mixedSource,
			requests: mixedRequests,
		});
		expect(issues).toEqual([null, null, null, null]);
		expect(driftScanParseStats()).toEqual({
			sourceFileParses: 1,
			sourceScans: 1,
			maxFileParses: 1,
			maxFileScans: 1,
			siteChecks: 4,
		});
	});

	it("does not TypeScript-parse a shell file whose sites never need an AST", () => {
		resetDriftScanParseStats();
		const issues = validateReadSitesForFile({
			file: "scripts/example.sh",
			text: `if [ "\${FLYWHEEL_SHELL_GATE:-1}" = "1" ]; then\n\techo on\nfi`,
			requests: [
				{
					site: {
						file: "scripts/example.sh",
						symbol: "FLYWHEEL_SHELL_GATE",
						pattern: "process.env" as const,
						timing: "cli_invocation",
					},
					envVar: "FLYWHEEL_SHELL_GATE",
				},
			],
		});
		expect(issues).toEqual([null]);
		expect(driftScanParseStats()).toEqual({
			sourceFileParses: 0,
			sourceScans: 1,
			maxFileParses: 0,
			maxFileScans: 1,
			siteChecks: 1,
		});
	});

	it("returns exactly what the single-site entry point returns", () => {
		const requests = [
			...mixedRequests,
			{
				site: {
					file: FILE,
					symbol: "epsilon",
					pattern: "process.env" as const,
					timing: "call_time",
				},
				envVar: "FLYWHEEL_ABSENT",
			},
			{
				site: {
					file: FILE,
					symbol: "zeta",
					pattern: "config" as const,
					timing: "call_time",
					configAccess: "config.missing",
				},
			},
		];
		const batch = validateReadSitesForFile({
			file: FILE,
			text: mixedSource,
			requests,
		});
		const oneByOne = requests.map((request) =>
			validateReadSiteEvidence({
				file: FILE,
				text: mixedSource,
				site: request.site,
				envVar: (request as { envVar?: string }).envVar,
			}),
		);
		expect(batch).toEqual(oneByOne);
		expect(batch[4]).toMatch(/not found/i);
		expect(batch[5]).toMatch(/not found/i);
	});
});

// FLY-1852 (Codex review, Medium): the parse-count invariants above exercise
// the batch helper directly, so a revert of the GUARD ITSELF back to per-site
// calls slipped past them while the helper stayed optimized — verified: it
// really did stay green. The registry-wide pass therefore lives in
// validateDeclaredReadSites(), which the guard calls, and these fixtures pin
// its negative paths. On the real registry every site currently returns null
// and every file exists, so without these fixtures the "write an issue" and
// "file not scanned" branches would never execute in CI at all.
describe("FLY-1852 registry-wide readSite pass", () => {
	const alphaText = [
		"export function ok(config: { on: boolean }) {",
		"\treturn config.on;",
		"}",
		"export function bad(config: { other: boolean }) {",
		"\treturn config.other;",
		"}",
	].join("\n");
	const betaText = "export const x = process.env.FLYWHEEL_BETA === '1';";
	// gamma carries ONE anchor symbol reachable by three different patterns, so
	// the fixture can mirror the anchor collisions the real registry actually
	// has (Codex review R6, Medium).
	const gammaText = [
		"export function resolveGate(",
		"\tconfig: { on: boolean },",
		"\tenv: Record<string, string | undefined>,",
		") {",
		"\treturn config.on || env.FLYWHEEL_GAMMA_PRESENT === '1';",
		"}",
	].join("\n");

	const sourceByFile = new Map([
		["packages/a/src/alpha.ts", alphaText],
		["packages/b/src/beta.ts", betaText],
		["packages/c/src/gamma.ts", gammaText],
	]);

	const gammaSite = (
		pattern: "env-param" | "dynamic" | "config",
		extra: { configAccess?: string } = {},
	) => ({
		file: "packages/c/src/gamma.ts",
		symbol: "resolveGate",
		pattern,
		timing: "call_time",
		...extra,
	});

	const configSite = (symbol: string, access: string) => ({
		file: "packages/a/src/alpha.ts",
		symbol,
		pattern: "config" as const,
		timing: "call_time",
		configAccess: access,
	});
	const envSite = () => ({
		file: "packages/b/src/beta.ts",
		symbol: "x",
		pattern: "process.env" as const,
		timing: "call_time",
	});

	// Every site here fails, and fails DISTINGUISHABLY. That is deliberate
	// (Codex review R2, Medium): an earlier fixture put the passing sites first
	// in each file's bucket, so silently dropping a flag — `flags.slice(1)` — or
	// dropping each bucket's first entry left every assertion green. Passing
	// sites produce no message, and a later failing site in the same file still
	// triggers the same parse and scan, so neither the message list nor the work
	// counts moved. With every site failing, losing any one of them is visible.
	// Sites interleave across files (alpha, beta, alpha, MISSING, beta, alpha,
	// then five on gamma) so a grouped implementation that forgot to write
	// results back by slot would emit them in file order instead.
	// flag_one and flag_three deliberately declare the SAME (file, symbol) with
	// different configAccess — the shape the real registry has, e.g. the three
	// ConfigLoader.validate sites (Codex review R5, Medium). An earlier fixture
	// used two different symbols (`ok`, `bad`), so deduping config sites by
	// (file, symbol) dropped five real sites while every assertion stayed green.
	const failingFlags = [
		{ name: "flag_one", readSites: [configSite("ok", "config.absentOne")] },
		{
			name: "flag_two",
			envVar: "FLYWHEEL_MISSING_ONE",
			readSites: [envSite()],
		},
		{ name: "flag_three", readSites: [configSite("ok", "config.absentTwo")] },
		{
			name: "flag_four",
			envVar: "FLYWHEEL_GONE",
			readSites: [
				{
					file: "packages/zz/src/missing.ts",
					symbol: "y",
					pattern: "process.env" as const,
					timing: "call_time",
				},
			],
		},
		{
			name: "flag_five",
			envVar: "FLYWHEEL_MISSING_TWO",
			readSites: [envSite()],
		},
		{ name: "flag_six", readSites: [configSite("bad", "config.absentThree")] },
		// The remaining anchor collisions the real registry has, all sharing
		// gamma.ts / resolveGate (Codex review R6, Medium). Deduping by
		// (file, symbol) drops one of every pair; keying by (pattern, symbol)
		// still drops one of each same-pattern pair, though not the cross-pattern
		// one. Each drop removes a distinct message. The shapes are:
		// env-param + env-param fixtures,
		// dynamic + dynamic (ship-eligibility.ts / resolveDefaultOnGate), and
		// env-param + config across patterns on one shared resolver symbol.
		{
			name: "flag_seven",
			envVar: "FLYWHEEL_ABSENT_ENVPARAM_ONE",
			readSites: [gammaSite("env-param")],
		},
		{
			name: "flag_eight",
			envVar: "FLYWHEEL_ABSENT_ENVPARAM_TWO",
			readSites: [gammaSite("env-param")],
		},
		{
			name: "flag_nine",
			envVar: "FLYWHEEL_ABSENT_DYNAMIC_ONE",
			readSites: [gammaSite("dynamic")],
		},
		{
			name: "flag_ten",
			envVar: "FLYWHEEL_ABSENT_DYNAMIC_TWO",
			readSites: [gammaSite("dynamic")],
		},
		{
			name: "flag_eleven",
			readSites: [gammaSite("config", { configAccess: "config.absentGamma" })],
		},
	];

	it("reports every failure and missing file in declaration order", () => {
		expect(
			validateDeclaredReadSites({ flags: failingFlags, sourceByFile }),
		).toEqual([
			"flag_one @ packages/a/src/alpha.ts: config access config.absentOne not found in ok",
			"flag_two @ packages/b/src/beta.ts: FLYWHEEL_MISSING_ONE not found as code in packages/b/src/beta.ts",
			"flag_three @ packages/a/src/alpha.ts: config access config.absentTwo not found in ok",
			"flag_four @ packages/zz/src/missing.ts: production file not scanned",
			"flag_five @ packages/b/src/beta.ts: FLYWHEEL_MISSING_TWO not found as code in packages/b/src/beta.ts",
			"flag_six @ packages/a/src/alpha.ts: config access config.absentThree not found in bad",
			"flag_seven @ packages/c/src/gamma.ts: FLYWHEEL_ABSENT_ENVPARAM_ONE not found as code in packages/c/src/gamma.ts",
			"flag_eight @ packages/c/src/gamma.ts: FLYWHEEL_ABSENT_ENVPARAM_TWO not found as code in packages/c/src/gamma.ts",
			"flag_nine @ packages/c/src/gamma.ts: FLYWHEEL_ABSENT_DYNAMIC_ONE not found as code in packages/c/src/gamma.ts",
			"flag_ten @ packages/c/src/gamma.ts: FLYWHEEL_ABSENT_DYNAMIC_TWO not found as code in packages/c/src/gamma.ts",
			"flag_eleven @ packages/c/src/gamma.ts: config access config.absentGamma not found in resolveGate",
		]);
	});

	// This pins that grouping AGGREGATES the same way a site-by-site loop does.
	// It is not an independent re-derivation of the evidence rules: the oracle
	// calls validateReadSiteEvidence(), which itself delegates to the batch
	// helper (Codex review R2, Low). The mix of passing and failing sites is
	// what it adds over the exact-message test above.
	it("aggregates a mix of passing and failing sites like a site-by-site loop", () => {
		const mixedFlags = [
			{ name: "pass_config", readSites: [configSite("ok", "config.on")] },
			{ name: "fail_config", readSites: [configSite("bad", "config.absent")] },
			{ name: "pass_env", envVar: "FLYWHEEL_BETA", readSites: [envSite()] },
			{ name: "fail_env", envVar: "FLYWHEEL_ABSENT", readSites: [envSite()] },
		];
		const oneByOne: string[] = [];
		for (const flag of mixedFlags) {
			for (const site of flag.readSites) {
				const text = sourceByFile.get(site.file);
				if (text === undefined) {
					oneByOne.push(
						`${flag.name} @ ${site.file}: production file not scanned`,
					);
					continue;
				}
				const issue = validateReadSiteEvidence({
					file: site.file,
					text,
					site,
					envVar: (flag as { envVar?: string }).envVar,
				});
				if (issue) oneByOne.push(`${flag.name} @ ${site.file}: ${issue}`);
			}
		}
		expect(oneByOne).toHaveLength(2);
		expect(
			validateDeclaredReadSites({ flags: mixedFlags, sourceByFile }),
		).toEqual(oneByOne);
	});

	// Dropping a site is not the only way work sharing can go wrong: a site can
	// also be answered with a PREVIOUS site's verdict (Codex review R7, R8).
	// The all-failing collision fixture cannot see that class at all — reusing
	// one failure's answer for another failure leaves the message list intact.
	// The mixed fixture above does carry passing sites, but only for config and
	// process.env, and its two config sites use different symbols, so a verdict
	// cached per symbol does not leak there either.
	// These fixtures put a HIT before a MISS inside one file's bucket, for every
	// per-site evidence dimension that is shareable: the env-param hit, the
	// dynamic identifier, the config access on one symbol, and the config symbol
	// lookup across symbols.
	it("does not answer a site with the previous site's evidence", () => {
		const leakFlags = [
			// env-param: a real hit, then a miss on the same anchor.
			{
				name: "env_hit",
				envVar: "FLYWHEEL_GAMMA_PRESENT",
				readSites: [gammaSite("env-param")],
			},
			{
				name: "env_miss",
				envVar: "FLYWHEEL_GAMMA_ABSENT",
				readSites: [gammaSite("env-param")],
			},
			// dynamic: both envVars resolve, so both reach the identifier check —
			// the branch the all-failing fixture never gets to. One symbol exists,
			// the next does not. This mirrors ship-eligibility.ts, which carries
			// resolveDefaultOnGate and resolveDefaultOffGate in one file.
			{
				name: "dyn_hit",
				envVar: "FLYWHEEL_GAMMA_PRESENT",
				readSites: [gammaSite("dynamic")],
			},
			{
				name: "dyn_miss",
				envVar: "FLYWHEEL_GAMMA_PRESENT",
				readSites: [
					{
						file: "packages/c/src/gamma.ts",
						symbol: "resolveOtherGate",
						pattern: "dynamic" as const,
						timing: "call_time",
					},
				],
			},
			// config has TWO per-site dimensions, and both can leak (Codex review
			// R8). First: the configAccess check on the SAME symbol — the shape
			// all three multi-config files in the registry have
			// (Blueprint.runInner, loadWorkKindConfigStrict, ConfigLoader.validate
			// each carry several accesses on one symbol). A hit cached per symbol
			// would answer the following miss.
			{
				name: "cfg_access_hit",
				readSites: [gammaSite("config", { configAccess: "config.on" })],
			},
			{
				name: "cfg_access_miss",
				readSites: [gammaSite("config", { configAccess: "config.absentLeak" })],
			},
			// Second: the symbol lookup itself, across DIFFERENT symbols in one
			// file. `bad` does not contain config.on, so reusing `ok`'s resolved
			// node would wrongly report evidence.
			{ name: "cfg_symbol_hit", readSites: [configSite("ok", "config.on")] },
			{ name: "cfg_symbol_miss", readSites: [configSite("bad", "config.on")] },
		];
		expect(
			validateDeclaredReadSites({ flags: leakFlags, sourceByFile }),
		).toEqual([
			"env_miss @ packages/c/src/gamma.ts: FLYWHEEL_GAMMA_ABSENT not found as code in packages/c/src/gamma.ts",
			"dyn_miss @ packages/c/src/gamma.ts: dynamic identifier resolveOtherGate not found",
			"cfg_access_miss @ packages/c/src/gamma.ts: config access config.absentLeak not found in resolveGate",
			"cfg_symbol_miss @ packages/a/src/alpha.ts: config access config.on not found in bad",
		]);
	});

	it("parses and scans each distinct file once for the whole registry", () => {
		resetDriftScanParseStats();
		validateDeclaredReadSites({ flags: failingFlags, sourceByFile });
		// Derived, not fitted. alpha.ts is parsed by its three config sites and
		// never scanned. beta.ts is scanned by its two env sites, and that scan
		// owns beta's only parse. gamma.ts is reached by both kinds; its bucket
		// hits the env-param sites first, so the SCAN triggers gamma's parse and
		// the later config site reuses it — one of each either way. The missing
		// file costs nothing but still produces a verdict. Eleven sites, three
		// real files: three parses, two scans, eleven verdicts.
		expect(driftScanParseStats()).toEqual({
			sourceFileParses: 3,
			sourceScans: 2,
			maxFileParses: 1,
			maxFileScans: 1,
			siteChecks: 11,
		});
	});

	// A clean registry returning [] cannot by itself distinguish "every site was
	// verified" from "no site was looked at" (Codex review R2, Medium). Asserting
	// the work counts alongside it does: dropping the config flag loses a parse,
	// dropping the env flag loses the scan.
	it("actually visits passing sites instead of skipping them", () => {
		const passingFlags = [
			{ name: "pass_config", readSites: [configSite("ok", "config.on")] },
			{ name: "pass_env", envVar: "FLYWHEEL_BETA", readSites: [envSite()] },
		];
		resetDriftScanParseStats();
		expect(
			validateDeclaredReadSites({ flags: passingFlags, sourceByFile }),
		).toEqual([]);
		expect(driftScanParseStats()).toEqual({
			sourceFileParses: 2,
			sourceScans: 1,
			maxFileParses: 1,
			maxFileScans: 1,
			siteChecks: 2,
		});
	});
});
