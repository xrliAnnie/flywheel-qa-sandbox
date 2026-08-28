import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { FLAG_EXEMPTIONS } from "../feature-flags/exemptions.js";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import {
	LEGACY_UNMANAGED_BASELINE,
	RETIRED_FLAG_STORE_ROWS,
	STORE_MANAGED_FLAGS,
} from "../feature-flags/store-policy.js";
import {
	NON_FLAG_ALLOWLIST,
	RETIRED_CONFIG_PATHS,
	RETIRED_FLAGS,
} from "../feature-flags/truth.js";
import {
	collectProductionSources,
	type ScanSource,
	scanSources,
} from "./drift-scan/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const RUNBOOK = join(
	REPO_ROOT,
	"doc/engineer/implementation/flag-authoring-runbook.md",
);
const sources = collectProductionSources(REPO_ROOT);
const sourceByFile = new Map(
	sources.map((source) => [source.file, source.text]),
);

const DELETED_SPECS = [
	"auto_qa_killswitch",
	"reports_ttl_days",
	"workflow_resume",
	"instruction_path_check",
	"design_html_gate",
	"ship_ci_guard",
	"qa_done_gate_killswitch",
	"codex_hard_gate_killswitch",
	"founder_attribution_gate",
	"founder_consent_decision_mode",
	"lead_core_mention_gated",
	"qa_auto",
	"founder_milestone_report_enabled",
] as const;

const FOUNDER_DECISION_SPEC_MAP = {
	FLYWHEEL_REPORTS_TTL_DAYS: ["reports_ttl_days"],
	FLYWHEEL_WORKFLOW_RESUME: ["workflow_resume"],
	FLYWHEEL_INSTRUCTION_PATH_CHECK: ["instruction_path_check"],
	"FLYWHEEL_AUTO_QA + qa.auto": ["auto_qa_killswitch", "qa_auto"],
	FLYWHEEL_CODEX_HARD_GATE: ["codex_hard_gate_killswitch"],
	FLYWHEEL_DESIGN_HTML_GATE: ["design_html_gate"],
	FLYWHEEL_SHIP_CI_GUARD: ["ship_ci_guard"],
	FLYWHEEL_QA_DONE_GATE: ["qa_done_gate_killswitch"],
	FLYWHEEL_LEAD_CORE_MENTION_GATED: ["lead_core_mention_gated"],
	FLYWHEEL_FOUNDER_ATTRIBUTION_GATE: ["founder_attribution_gate"],
	FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: ["founder_consent_decision_mode"],
	"founder_milestone_report.enabled": ["founder_milestone_report_enabled"],
} as const;

const FLY1981_MANAGED_SNAPSHOT = [
	"flag_retirement_scan",
	"workflow_rework_reentry",
	"skill_framework_mode",
	"workflow_turn_divergence_alerts",
] as const;

const FLY1981_TOMBSTONES = [
	"FLYWHEEL_AUTO_QA",
	"FLYWHEEL_CODEX_HARD_GATE",
	"FLYWHEEL_DESIGN_HTML_GATE",
	"FLYWHEEL_FOUNDER_ATTRIBUTION_GATE",
	"FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE",
	"FLYWHEEL_FOUNDER_CONSENT_ENABLED",
	"FLYWHEEL_INSTRUCTION_PATH_CHECK",
	"FLYWHEEL_QA_DONE_GATE",
	"FLYWHEEL_REPORTS_TTL_DAYS",
	"FLYWHEEL_SHIP_CI_GUARD",
	"FLYWHEEL_WORKFLOW_RESUME",
] as const;

const RETIRED_CONFIG = ["founder_milestone_report", "qa"] as const;

const AUXILIARY_TUNINGS = [
	"FLYWHEEL_QA_RECONCILE_EVERY_N_TICKS",
	"FLYWHEEL_FOUNDER_MILESTONE_PATROL_TICKS",
	"FLYWHEEL_FOUNDER_MILESTONE_LOOKBACK_HOURS",
	"FLYWHEEL_FOUNDER_MILESTONE_GRACE_MS",
] as const;

const HISTORICAL_STORE_ROW_TOKENS: ReadonlySet<string> = new Set([
	"workflow_resume",
	"auto_qa_killswitch",
]);

function scannedNames(input: readonly ScanSource[]): Set<string> {
	return new Set(scanSources(input).rawCodeHits.map((hit) => hit.name));
}

function exactRetiredTokens(text: string): string[] {
	return DELETED_SPECS.filter((token) =>
		new RegExp(`(?:^|[^A-Za-z0-9_])${token}(?=$|[^A-Za-z0-9_])`).test(text),
	);
}

function isHistoricalStoreRowLiteral(
	source: ScanSource,
	node: ts.Node,
	token: string,
): boolean {
	if (
		source.file !== "packages/config/src/feature-flags/store-policy.ts" ||
		!HISTORICAL_STORE_ROW_TOKENS.has(token)
	) {
		return false;
	}
	if (!ts.isStringLiteralLike(node)) return false;
	const array = node.parent;
	if (
		!ts.isArrayLiteralExpression(array) ||
		!array.elements.some((element) => element === node)
	) {
		return false;
	}
	const setArgument = ts.isAsExpression(array.parent) ? array.parent : array;
	const setConstruction = setArgument.parent;
	if (
		!ts.isNewExpression(setConstruction) ||
		!ts.isIdentifier(setConstruction.expression) ||
		setConstruction.expression.text !== "Set" ||
		setConstruction.arguments?.[0] !== setArgument
	) {
		return false;
	}
	const declaration = setConstruction.parent;
	return (
		ts.isVariableDeclaration(declaration) &&
		ts.isIdentifier(declaration.name) &&
		declaration.name.text === "RETIRED_FLAG_STORE_ROWS" &&
		declaration.initializer === setConstruction
	);
}

function shellCode(line: string): string {
	let singleQuoted = false;
	let doubleQuoted = false;
	let escaped = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && !singleQuoted) {
			escaped = true;
			continue;
		}
		if (char === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
		else if (char === '"' && !singleQuoted) doubleQuoted = !doubleQuoted;
		else if (
			char === "#" &&
			!singleQuoted &&
			!doubleQuoted &&
			(index === 0 || /\s/.test(line[index - 1] ?? ""))
		) {
			return line.slice(0, index);
		}
	}
	return line;
}

function retiredSpecTokenOccurrences(input: readonly ScanSource[]): string[] {
	const retired = new Set<string>(DELETED_SPECS);
	const hits = new Set<string>();
	for (const source of input) {
		if (source.file.endsWith(".sh")) {
			for (const line of source.text.split(/\r?\n/)) {
				for (const token of exactRetiredTokens(shellCode(line))) {
					hits.add(`${source.file}:${token}`);
				}
			}
			continue;
		}
		const file = ts.createSourceFile(
			source.file,
			source.text,
			ts.ScriptTarget.Latest,
			true,
			source.file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
		);
		const visit = (node: ts.Node): void => {
			if (ts.isRegularExpressionLiteral(node)) {
				for (const token of exactRetiredTokens(node.text)) {
					hits.add(`${source.file}:/${token}/`);
				}
			} else if (ts.isIdentifier(node) && retired.has(node.text)) {
				hits.add(`${source.file}:${node.text}`);
			} else if (
				ts.isStringLiteralLike(node) ||
				ts.isTemplateHead(node) ||
				ts.isTemplateMiddle(node) ||
				ts.isTemplateTail(node)
			) {
				for (const token of exactRetiredTokens(node.text)) {
					if (!isHistoricalStoreRowLiteral(source, node, token)) {
						hits.add(`${source.file}:${JSON.stringify(token)}`);
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
	}
	return [...hits].sort();
}

describe("FLY-1981 final governance ledgers", () => {
	it("pins the production collector census and keeps generated/test artifacts separate", () => {
		const files = new Set(sources.map((source) => source.file));
		for (const sentinel of [
			"packages/config/src/feature-flags/truth.ts",
			"packages/onboard-shell/bin/flywheel-onboard.js",
			"packages/payload-endpoint/src/worker.mjs",
			"packages/teamlead/scripts/codex-lead.sh",
			"scripts/check-flag-truth.ts",
			"scripts/cleanup-sweep-cli.mjs",
			"scripts/bridge-liveness-probe.sh",
		]) {
			expect(files.has(sentinel), sentinel).toBe(true);
		}
		expect([...files].some((file) => file.endsWith(".ts"))).toBe(true);
		expect([...files].some((file) => file.endsWith(".js"))).toBe(true);
		expect([...files].some((file) => file.endsWith(".mjs"))).toBe(true);
		expect([...files].some((file) => file.endsWith(".sh"))).toBe(true);
		for (const file of files) {
			expect(
				file,
				"dist is covered by the separate artifact guard",
			).not.toMatch(/(^|\/)dist\//);
			expect(file).not.toMatch(/(^|\/)__tests__\//);
			expect(file).not.toMatch(/[.](?:spec|test)[.]/);
		}
	});

	it("freezes the exact five Batch 6 retirement ledgers", () => {
		const productionNames = scannedNames(sources);
		expect(Object.keys(FOUNDER_DECISION_SPEC_MAP)).toHaveLength(12);
		expect(Object.values(FOUNDER_DECISION_SPEC_MAP).flat().sort()).toEqual(
			[...DELETED_SPECS].sort(),
		);
		expect(DELETED_SPECS).toHaveLength(13);
		for (const name of DELETED_SPECS) {
			expect(
				FEATURE_FLAGS.some((spec) => spec.name === name),
				name,
			).toBe(false);
		}
		expect(
			RETIRED_FLAGS.filter(({ retiredBy }) => retiredBy === "FLY-1981")
				.map(({ envVar }) => envVar)
				.sort(),
		).toEqual([...FLY1981_TOMBSTONES].sort());
		for (const envVar of FLY1981_TOMBSTONES) {
			expect(productionNames.has(envVar), `${envVar} production read`).toBe(
				false,
			);
		}
		expect(
			RETIRED_CONFIG_PATHS.filter(({ retiredBy }) => retiredBy === "FLY-1981")
				.map(({ path }) => path)
				.sort(),
		).toEqual([...RETIRED_CONFIG].sort());
	}, 15_000);

	it("keeps the post-verdict snapshot historical while allowing managed growth and legacy shrink", () => {
		// FLY-1981 landed at 31 legacy + 4 then-managed = 35. This equation is
		// historical evidence, not a permanent assertion on FEATURE_FLAGS.length.
		expect(LEGACY_UNMANAGED_BASELINE).toHaveLength(31);
		expect(FLY1981_MANAGED_SNAPSHOT).toHaveLength(4);
		expect(
			LEGACY_UNMANAGED_BASELINE.length + FLY1981_MANAGED_SNAPSHOT.length,
		).toBe(35);
		const currentNames = new Set(FEATURE_FLAGS.map((spec) => spec.name));
		const outsidePartition = FEATURE_FLAGS.filter(
			(spec) =>
				!LEGACY_UNMANAGED_BASELINE.includes(spec.name as never) &&
				!STORE_MANAGED_FLAGS.has(spec.name),
		).map((spec) => spec.name);
		expect(outsidePartition).toEqual([]);
		expect(
			[...STORE_MANAGED_FLAGS].filter((name) => !currentNames.has(name)),
		).toEqual([]);
	});

	it("finds no retired lowercase identity in production code tokens", () => {
		expect(retiredSpecTokenOccurrences(sources)).toEqual([]);
		expect(
			retiredSpecTokenOccurrences([
				{
					file: "packages/example/src/reintroduced.ts",
					text: [
						'const a = isEnabled("qa_auto");',
						'const b = registry.get("reports_ttl_days");',
						'const c = flags["instruction_path_check"];',
						'const d = state === "design_html_gate";',
						"const e = flags.qa_done_gate_killswitch;",
						"const f = `founder_consent_decision_mode`;",
						'// getFlag("founder_attribution_gate") is only a comment',
					].join("\n"),
				},
				{
					file: "scripts/reintroduced.sh",
					text: [
						"flag_enabled qa_auto",
						"flag_enabled 'ship_ci_guard'",
						"# flag_enabled founder_consent_decision_mode",
					].join("\n"),
				},
			]),
		).toEqual(
			expect.arrayContaining([
				'packages/example/src/reintroduced.ts:"qa_auto"',
				'packages/example/src/reintroduced.ts:"reports_ttl_days"',
				'packages/example/src/reintroduced.ts:"instruction_path_check"',
				'packages/example/src/reintroduced.ts:"design_html_gate"',
				"packages/example/src/reintroduced.ts:qa_done_gate_killswitch",
				'packages/example/src/reintroduced.ts:"founder_consent_decision_mode"',
				"scripts/reintroduced.sh:qa_auto",
				"scripts/reintroduced.sh:ship_ci_guard",
			]),
		);
		expect(
			retiredSpecTokenOccurrences([
				{
					file: "packages/example/src/comments.ts",
					text: '// isEnabled("qa_auto")',
				},
				{
					file: "scripts/comments.sh",
					text: "# flag_enabled qa_auto",
				},
			]),
		).toEqual([]);
		expect(
			retiredSpecTokenOccurrences([
				{
					file: "packages/example/src/regex.ts",
					text: "const matcher = /qa_auto/;",
				},
				{
					file: "packages/example/src/escaped-regex.ts",
					text: "const matcher = /reports_ttl_days\\\\b/;",
				},
			]),
		).toEqual([
			"packages/example/src/escaped-regex.ts:/reports_ttl_days/",
			"packages/example/src/regex.ts:/qa_auto/",
		]);
		expect(
			retiredSpecTokenOccurrences([
				{
					file: "packages/example/src/nonexact-regex.ts",
					text: [
						"const longer = /qa_auto_backup/;",
						"// const commented = /qa_auto/;",
					].join("\n"),
				},
			]),
		).toEqual([]);
		expect(
			retiredSpecTokenOccurrences([
				{
					file: "packages/config/src/feature-flags/store-policy.ts",
					text: 'const wrongLedger = ["workflow_resume"];',
				},
			]),
		).toEqual([
			'packages/config/src/feature-flags/store-policy.ts:"workflow_resume"',
		]);
		expect([...RETIRED_FLAG_STORE_ROWS]).toEqual([
			"workflow_resume",
			"auto_qa_killswitch",
		]);
	}, 15_000);

	it("allows retired store-row tokens only as direct Set array elements", () => {
		expect(
			retiredSpecTokenOccurrences([
				{
					file: "packages/config/src/feature-flags/store-policy.ts",
					text: [
						"export const RETIRED_FLAG_STORE_ROWS = new Set([",
						'  (() => isEnabled("workflow_resume"))(),',
						"]);",
					].join("\n"),
				},
			]),
		).toEqual([
			'packages/config/src/feature-flags/store-policy.ts:"workflow_resume"',
		]);
	});

	it("keeps auxiliary tunings outside every flag/config ledger and production source", () => {
		const productionNames = scannedNames(sources);
		for (const name of AUXILIARY_TUNINGS) {
			expect(
				FEATURE_FLAGS.some((spec) => spec.envVar === name),
				name,
			).toBe(false);
			expect(NON_FLAG_ALLOWLIST[name], name).toBeUndefined();
			expect(
				FLAG_EXEMPTIONS.some((exemption) => exemption.name === name),
				name,
			).toBe(false);
			expect(
				RETIRED_FLAGS.some(({ envVar }) => envVar === name),
				name,
			).toBe(false);
			expect(productionNames.has(name), `${name} runtime read`).toBe(false);
			expect(
				sources.some((source) => source.text.includes(name)),
				`${name} production reader/writer/string residue`,
			).toBe(false);
		}
	}, 15_000);

	it("uses the production matcher itself for retired TypeScript and shell positive controls", () => {
		const found = scannedNames([
			{
				file: "packages/example/src/retired.ts",
				text: 'const enabled = process.env.FLYWHEEL_AUTO_QA === "1";',
			},
			{
				file: "scripts/retired.sh",
				text: [
					'if [ "${',
					'FLYWHEEL_QA_RECONCILE_EVERY_N_TICKS:-0}" = "1" ]; then echo held; fi',
				].join(""),
			},
		]);
		expect(found.has("FLYWHEEL_AUTO_QA")).toBe(true);
		expect(found.has("FLYWHEEL_QA_RECONCILE_EVERY_N_TICKS")).toBe(true);
	});

	it("preserves the launcher-derived lead-core mention plumbing without reviving a flag", () => {
		expect(
			FEATURE_FLAGS.some((spec) => spec.name === "lead_core_mention_gated"),
		).toBe(false);
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_LEAD_CORE_MENTION_GATED).toMatch(
			/launcher.*projects\.json/i,
		);
		expect(
			RETIRED_FLAGS.some(
				({ envVar }) => envVar === "FLYWHEEL_LEAD_CORE_MENTION_GATED",
			),
		).toBe(false);

		const launcher = sourceByFile.get(
			"packages/teamlead/scripts/codex-lead.sh",
		);
		const runtime = sourceByFile.get(
			"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
		);
		const resolver = sourceByFile.get(
			"packages/teamlead/src/core-room-gate-cli.ts",
		);
		expect(launcher).toBeDefined();
		expect(runtime).toBeDefined();
		expect(resolver).toBeDefined();
		if (!launcher || !runtime || !resolver) return;
		const unset = launcher.indexOf("unset FLYWHEEL_LEAD_CORE_MENTION_GATED");
		const derive = launcher.indexOf("core-room-gate-cli.js", unset);
		const condition = launcher.indexOf('if [ "$_cg_gate" = "true" ]', derive);
		const exported = launcher.indexOf(
			"export FLYWHEEL_LEAD_CORE_MENTION_GATED=1",
			condition,
		);
		expect(unset).toBeGreaterThanOrEqual(0);
		expect(derive).toBeGreaterThan(unset);
		expect(condition).toBeGreaterThan(derive);
		expect(exported).toBeGreaterThan(condition);
		expect(runtime).toContain('env.FLYWHEEL_LEAD_CORE_MENTION_GATED === "1"');
		expect(resolver).toContain(
			'import { loadProjects, type ProjectEntry } from "./ProjectConfig.js"',
		);
		expect(resolver).toContain("const projects = loadProjects()");
		expect(resolver).toContain("~/.flywheel/projects.json");
	});

	it("ships the only supported authoring route and the seven-step deployment order", () => {
		expect(existsSync(RUNBOOK)).toBe(true);
		if (!existsSync(RUNBOOK)) return;
		const runbook = readFileSync(RUNBOOK, "utf8");
		for (const contract of [
			"registry → managed set + codec → store row policy → management route test → guard green",
			"PROJECT_STORE_MANAGED_FLAGS",
			"豁免名单只许缩小",
			"非产品 ledger",
			"已合并 / 已 staged ≠ 已部署",
			"no-old-binary-restart",
		]) {
			expect(runbook, contract).toContain(contract);
		}
		const deployment = runbook
			.split("## 生产 `.env` 移除与部署顺序")[1]
			?.split("\n## ")[0];
		expect(deployment).toBeDefined();
		if (!deployment) return;
		const steps = [...deployment.matchAll(/^(\d+)\. (.+)$/gm)].map((match) => ({
			number: Number(match[1]),
			text: match[2] ?? "",
		}));
		expect(steps.map(({ number }) => number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(steps[0]?.text).toMatch(/(?:merged|已合并).*staged.*不切换/i);
		expect(steps[1]?.text).toMatch(
			/staged.*(?:preflight|静态).*resume.*enabled.*consent.*audit_only/i,
		);
		expect(steps[2]?.text).toMatch(
			/(?:建立|设置).*no-old-binary-restart.*(?:验证|确认)/i,
		);
		expect(steps[3]?.text).toMatch(
			/(?:原子|atomic).*删除.*FLYWHEEL_WORKFLOW_RESUME.*FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE.*(?:验证|确认)/i,
		);
		expect(steps[4]?.text).toMatch(/部署.*新 Bridge/i);
		expect(steps[5]?.text).toMatch(/health\/live.*resume.*audit_only/i);
		expect(steps[6]?.text).toMatch(/rollback.*先恢复.*env.*后.*旧 Bridge/i);
	});
});
