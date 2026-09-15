import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetModelConfigCacheForTests } from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import {
	loadWorkflowMenuLibrary,
	resolveMenuOverrides,
	type WorkflowMenuValidationError,
} from "../workflow-menu.js";

const code = () =>
	loadWorkflowMenuLibrary().find((menu) => menu.shape === "code")!;
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function withRuntimeModelConfig(
	config: Record<string, unknown> | string,
	run: (configPath: string) => void,
): void {
	const root = mkdtempSync(join(tmpdir(), "fly2403-runtime-split-"));
	const configPath = join(root, "models.json");
	const previousPath = process.env.FLYWHEEL_MODELS_CONFIG;
	writeFileSync(
		configPath,
		typeof config === "string"
			? config
			: JSON.stringify({ version: 1, ...config }),
		{ mode: 0o600 },
	);
	process.env.FLYWHEEL_MODELS_CONFIG = configPath;
	resetModelConfigCacheForTests();
	try {
		run(configPath);
	} finally {
		if (previousPath === undefined) {
			delete process.env.FLYWHEEL_MODELS_CONFIG;
		} else {
			process.env.FLYWHEEL_MODELS_CONFIG = previousPath;
		}
		resetModelConfigCacheForTests();
		rmSync(root, { recursive: true, force: true });
	}
}

describe("FLY-2403 automatic design model split", () => {
	it("removes the retired Lead-side allocator and documents the configured mapping in the report header", () => {
		expect(existsSync(join(REPO_ROOT, "scripts/fly2403-design-arm.mjs"))).toBe(
			false,
		);
		const identity = readFileSync(
			join(REPO_ROOT, ".lead/flywheel-eng-lead/identity.md"),
			"utf8",
		);
		expect(identity).not.toContain("fly2403-design-arm.mjs");
		expect(identity).not.toContain("A/B dispatch");
		const report = readFileSync(
			join(REPO_ROOT, "scripts/fly2403-design-model-comparison.sql"),
			"utf8",
		);
		expect(report.split("WITH", 1)[0]).toContain(
			"fly2403-v1: odd issue = A/Astra; even issue = B/Fable",
		);
	});

	it("maps odd issues to A/Astra and even issues to B/Fable from registry config", () => {
		const odd = resolveMenuOverrides(code(), undefined, {
			issueIdentifier: "FLY-2403",
		});
		const even = resolveMenuOverrides(code(), undefined, {
			issueIdentifier: "FLY-2404",
		});

		expect(odd.assignments).toEqual({
			eng_design: {
				arm: "A",
				modelAlias: "astra",
				model: "gpt-6-astra",
				basis: {
					issueIdentifier: "FLY-2403",
					issueNumber: 2403,
					parity: "odd",
					rule: "issue_number_parity",
					ruleVersion: "fly2403-v1",
				},
			},
		});
		expect(odd.templateOverride.nodes?.eng_design).toEqual({
			vendor: "codex",
			model: "gpt-6-astra",
			effort: "xhigh",
		});
		expect(even.assignments.eng_design).toMatchObject({
			arm: "B",
			modelAlias: "fable",
			model: "claude-fable-5-1",
			basis: { issueNumber: 2404, parity: "even" },
		});
		expect(even.templateOverride.nodes?.eng_design).toEqual({
			vendor: "claude",
			model: "claude-fable-5-1",
			effort: "high",
		});
	});

	it("reads the current models.json split policy for every dispatch decision", () => {
		withRuntimeModelConfig(
			{
				modelSplit: {
					enabled: true,
					rule: "issue_number_parity",
					version: "runtime-v2",
					odd: { arm: "B", model: "fable" },
					even: { arm: "A", model: "astra" },
				},
			},
			(configPath) => {
				const before = resolveMenuOverrides(code(), undefined, {
					issueIdentifier: "FLY-2403",
				});
				expect(before.assignments.eng_design).toMatchObject({
					arm: "B",
					modelAlias: "fable",
					basis: { ruleVersion: "runtime-v2" },
				});

				const replacement = join(configPath, "..", "models.next");
				writeFileSync(
					replacement,
					JSON.stringify({
						version: 1,
						modelSplit: {
							enabled: false,
							rule: "issue_number_parity",
							version: "runtime-v3",
							odd: { arm: "B", model: "fable" },
							even: { arm: "A", model: "astra" },
						},
					}),
				);
				renameSync(replacement, configPath);
				const stat = statSync(configPath);
				utimesSync(configPath, stat.atime, new Date(stat.mtimeMs + 5));

				const after = resolveMenuOverrides(code(), undefined, {
					issueIdentifier: "FLY-2403",
				});
				expect(after.assignments).toEqual({});
				expect(after.receipts.eng_design).toMatchObject({
					model: "fable (= claude-fable-5-1)",
					overridden: false,
				});
			},
		);
	});

	it("uses the registry default when modelSplit is absent and fail-closes malformed config", () => {
		withRuntimeModelConfig({}, () => {
			const absent = resolveMenuOverrides(code(), undefined, {
				issueIdentifier: "FLY-2403",
			});
			expect(absent.assignments.eng_design).toMatchObject({
				arm: "A",
				modelAlias: "astra",
				basis: { ruleVersion: "fly2403-v1" },
			});
		});

		withRuntimeModelConfig(
			{
				modelSplit: {
					enabled: "false",
					rule: "issue_number_parity",
					version: "runtime-broken",
					odd: { arm: "A", model: "astra" },
					even: { arm: "B", model: "fable" },
				},
			},
			() => {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				expect(() =>
					resolveMenuOverrides(code(), undefined, {
						issueIdentifier: "FLY-2403",
					}),
				).toThrow(/invalid.*model split/i);
				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining(
						"modelSplit segment ignored: enabled must be boolean",
					),
				);
				warn.mockRestore();
			},
		);

		withRuntimeModelConfig("{", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			expect(() =>
				resolveMenuOverrides(code(), undefined, {
					issueIdentifier: "FLY-2403",
				}),
			).toThrow(/invalid.*model split/i);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("using built-in model policy:"),
			);
			warn.mockRestore();
		});
	});

	it("accepts a runtime constant-A mapping for ledger provenance checks", () => {
		withRuntimeModelConfig(
			{
				modelSplit: {
					enabled: true,
					rule: "issue_number_parity",
					version: "runtime-constant-a",
					odd: { arm: "A", model: "astra" },
					even: { arm: "A", model: "astra" },
				},
			},
			() => {
				for (const issueIdentifier of ["FLY-2403", "FLY-2404"]) {
					const resolved = resolveMenuOverrides(code(), undefined, {
						issueIdentifier,
					});
					expect(resolved.assignments.eng_design).toMatchObject({
						arm: "A",
						modelAlias: "astra",
						model: "gpt-6-astra",
						basis: { ruleVersion: "runtime-constant-a" },
					});
				}
			},
		);
	});

	it("returns the same arm for repeated resolution of one issue", () => {
		const first = resolveMenuOverrides(code(), undefined, {
			issueIdentifier: "FLY-2403",
		});
		const repeated = resolveMenuOverrides(code(), undefined, {
			issueIdentifier: "FLY-2403",
		});

		expect(repeated.assignments).toEqual(first.assignments);
		expect(repeated.templateOverride).toEqual(first.templateOverride);
	});

	it("falls back to the fixed template model with zero assignment when disabled", () => {
		const menu = code();
		menu.nodes.find((node) => node.id === "eng_design")!.modelSplit!.enabled =
			false;

		const resolved = resolveMenuOverrides(menu, undefined, {
			issueIdentifier: "FLY-2403",
		});

		expect(resolved.assignments).toEqual({});
		expect(resolved.templateOverride).toEqual({
			reason: "menu_api_override",
		});
		expect(resolved.receipts.eng_design).toEqual({
			model: "fable (= claude-fable-5-1)",
			effort: "high",
			overridden: false,
		});
	});

	it("rejects a caller model that conflicts with the enabled engine rule", () => {
		expect(() =>
			resolveMenuOverrides(
				code(),
				{ eng_design: { model: "fable" } },
				{ issueIdentifier: "FLY-2403" },
			),
		).toThrowError(
			expect.objectContaining<Partial<WorkflowMenuValidationError>>({
				code: "MODEL_SPLIT_OVERRIDE_CONFLICT",
				legal: ["astra"],
			}),
		);
	});

	it("does not split simple_code because it has no design node", () => {
		const menu = loadWorkflowMenuLibrary().find(
			(candidate) => candidate.shape === "simple_code",
		)!;
		const resolved = resolveMenuOverrides(menu, undefined, {
			issueIdentifier: "FLY-2403",
		});

		expect(resolved.assignments).toEqual({});
		expect(resolved.receipts).not.toHaveProperty("eng_design");
	});
});

const percentagePolicy = (codexPercent: number) => ({
	enabled: true,
	rule: "issue_number_percentage",
	codexPercent,
	codex: { arm: "A", model: "astra" },
	fable: { arm: "B", model: "fable" },
});
describe("FLY-2570 hot design percentage", () => {
	it("sees an atomic ratio change on the next decision with the same loaded menu", () => {
		withRuntimeModelConfig({ modelSplit: percentagePolicy(0) }, (path) => {
			const menu = code();
			const before = resolveMenuOverrides(menu, undefined, {
				issueIdentifier: "FLY-2571",
			});
			expect(before.assignments.eng_design).toMatchObject({
				arm: "B",
				modelAlias: "fable",
				basis: { codexPercent: 0, rule: "issue_number_percentage" },
			});
			const output = JSON.parse(
				execFileSync(
					process.execPath,
					[
						join(REPO_ROOT, "scripts/design-model-split.mjs"),
						"set",
						"--codex-percent",
						"100",
						"--config",
						path,
					],
					{ encoding: "utf8" },
				),
			);
			expect(output.codexPercent).toBe(100);
			const after = resolveMenuOverrides(menu, undefined, {
				issueIdentifier: "FLY-2571",
			});
			expect(after.assignments.eng_design).toMatchObject({
				arm: "A",
				modelAlias: "astra",
				basis: { codexPercent: 100 },
			});
			expect(after.assignments.eng_design.basis.ruleVersion).toBe(
				output.ruleVersion,
			);
			expect(after.assignments.eng_design.basis.ruleVersion).not.toBe(
				before.assignments.eng_design.basis.ruleVersion,
			);
			expect(after.assignments).toEqual(
				resolveMenuOverrides(menu, undefined, { issueIdentifier: "FLY-2571" })
					.assignments,
			);
			expect(after.receipts.implement).toEqual(before.receipts.implement);
			expect(after.receipts.qa).toEqual(before.receipts.qa);
		});
	});
	it("rejects a conflicting explicit override with reproducible assignment details", () => {
		withRuntimeModelConfig({ modelSplit: percentagePolicy(0) }, () => {
			expect(() =>
				resolveMenuOverrides(
					code(),
					{ eng_design: { model: "astra" } },
					{ issueIdentifier: "FLY-2571" },
				),
			).toThrow(/FLY-2571.*bucket.*0.*B.*fable/);
			expect(
				resolveMenuOverrides(
					code(),
					{ eng_design: { model: "fable" } },
					{ issueIdentifier: "FLY-2571" },
				).assignments.eng_design.arm,
			).toBe("B");
		});
	});
	it("only the code design node declares a split in the bundled registry", () => {
		expect(
			loadWorkflowMenuLibrary().flatMap((menu) =>
				menu.nodes
					.filter((n) => n.modelSplit)
					.map((n) => `${menu.shape}.${n.id}`),
			),
		).toEqual(["code.eng_design"]);
	});
});
