import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MODEL_SPLIT_ARM_EFFORTS,
	type ModelSplitArmEffort,
	parseWeightedModelSplit,
	resetModelConfigCacheForTests,
	resolveWeightedModelSplit,
	type WeightedModelSplitArm,
	type WeightedModelSplitNodeId,
} from "flywheel-config";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { StateStore } from "../StateStore.js";
import { resolveNodeDispatchAtLaunch } from "../workflow-dispatch-resolution.js";
import {
	loadWorkflowMenuLibrary,
	loadWorkflowMenuSeeds,
	resolveMenuOverrides,
	type WorkflowMenuValidationError,
} from "../workflow-menu.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import {
	applyWorkflowOverride,
	type WorkflowEffort,
} from "../workflow-template.js";
import { resolveWorkflowTemplateSelection } from "../workflow-template-selection.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const code = () =>
	loadWorkflowMenuLibrary().find((menu) => menu.shape === "code")!;

function withRuntimeModelConfig(
	config: Record<string, unknown>,
	run: (configPath: string) => void,
): void {
	const root = mkdtempSync(join(tmpdir(), "fly2891-arm-effort-"));
	const configPath = join(root, "models.json");
	const previousPath = process.env.FLYWHEEL_MODELS_CONFIG;
	writeFileSync(configPath, JSON.stringify({ version: 1, ...config }), {
		mode: 0o600,
	});
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

type ArmSpec = {
	arm: string;
	model: string;
	weight: number;
	effort?: ModelSplitArmEffort;
};

/** Every arm carries an effort so the assertion holds whichever bucket wins. */
const allArmsPinned = () => ({
	enabled: true,
	rule: "issue_node_weighted",
	nodes: {
		eng_design: [
			{ arm: "design_astra", model: "astra", weight: 1, effort: "medium" },
			{ arm: "design_opus", model: "opus", weight: 1, effort: "low" },
			{ arm: "design_fable", model: "fable", weight: 1, effort: "max" },
		],
		implement: [
			{ arm: "impl_opus", model: "opus", weight: 2, effort: "low" },
			{ arm: "impl_sol56", model: "codex", weight: 1, effort: "medium" },
			{ arm: "impl_sol6", model: "sol", weight: 1, effort: "max" },
		],
		qa: [
			{ arm: "qa_sol56", model: "codex", weight: 2, effort: "low" },
			{ arm: "qa_sol6", model: "sol", weight: 1, effort: "medium" },
			{ arm: "qa_opus", model: "opus", weight: 1, effort: "max" },
		],
	} satisfies Record<WeightedModelSplitNodeId, ArmSpec[]>,
});

/** Only one arm per node pins an effort; the rest inherit the template default. */
const mixedArms = () => ({
	enabled: true,
	rule: "issue_node_weighted",
	nodes: {
		eng_design: [
			{ arm: "design_astra", model: "astra", weight: 1 },
			{ arm: "design_opus", model: "opus", weight: 1, effort: "low" },
			{ arm: "design_fable", model: "fable", weight: 1 },
		],
		implement: [
			{ arm: "impl_opus", model: "opus", weight: 2 },
			{ arm: "impl_sol56", model: "codex", weight: 1, effort: "medium" },
			{ arm: "impl_sol6", model: "sol", weight: 1 },
		],
		qa: [
			{ arm: "qa_sol56", model: "codex", weight: 2, effort: "low" },
			{ arm: "qa_sol6", model: "sol", weight: 1 },
			{ arm: "qa_opus", model: "opus", weight: 1 },
		],
	} satisfies Record<WeightedModelSplitNodeId, ArmSpec[]>,
});

const PRODUCTION_SHAPE = {
	enabled: true,
	rule: "issue_node_weighted",
	balance: { enabled: false },
	nodes: {
		eng_design: [
			{ arm: "design_astra", model: "astra", weight: 1 },
			{ arm: "design_opus", model: "opus", weight: 1 },
			{ arm: "design_fable", model: "fable", weight: 1 },
		],
		implement: [
			{ arm: "impl_opus", model: "opus", weight: 2 },
			{ arm: "impl_sol56", model: "codex", weight: 2 },
		],
		qa: [
			{ arm: "qa_sol56", model: "codex", weight: 3 },
			{ arm: "qa_opus", model: "opus", weight: 1 },
		],
	},
};

const WEIGHTED_NODES = ["eng_design", "implement", "qa"] as const;

function expectedArm(
	policy: Parameters<typeof parseWeightedModelSplit>[0],
	issueKey: string,
	nodeId: WeightedModelSplitNodeId,
): WeightedModelSplitArm {
	return resolveWeightedModelSplit(
		parseWeightedModelSplit(policy),
		issueKey,
		nodeId,
	).arm;
}

function menuDefaultEffort(nodeId: string, modelAlias: string): WorkflowEffort {
	const node = code().nodes.find((candidate) => candidate.id === nodeId)!;
	return node.models!.find((candidate) => candidate.model === modelAlias)!
		.defaultEffort;
}

describe("FLY-2891 weighted split arm effort — menu resolution", () => {
	it("keeps the config arm effort ladder identical to WorkflowEffort", () => {
		expectTypeOf<ModelSplitArmEffort>().toEqualTypeOf<WorkflowEffort>();
		expectTypeOf<
			NonNullable<WeightedModelSplitArm["effort"]>
		>().toEqualTypeOf<WorkflowEffort>();
		expect([...MODEL_SPLIT_ARM_EFFORTS]).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		// Runtime half of the same contract: every ladder value is accepted by
		// the template override validator that the arm effort flows through.
		const seed = loadWorkflowMenuSeeds().find(
			(candidate) => candidate.templateId === "tpl_code",
		)!;
		for (const effort of MODEL_SPLIT_ARM_EFFORTS) {
			const applied = applyWorkflowOverride(seed.manifest, {
				reason: "automatic_model_split",
				nodes: { implement: { effort } },
			});
			expect(
				applied.manifest.nodes.find((node) => node.id === "implement")?.effort,
			).toBe(effort);
		}
	});

	it("applies the selected arm's effort to receipts, override nodes and the frozen basis", () => {
		withRuntimeModelConfig({ modelSplit: allArmsPinned() }, () => {
			for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
				const issueKey = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
				const resolved = resolveMenuOverrides(code(), undefined, {
					issueIdentifier: `FLY-${n}`,
					issueKey,
				});
				for (const nodeId of WEIGHTED_NODES) {
					const arm = expectedArm(allArmsPinned(), issueKey, nodeId);
					expect(arm.effort).toBeDefined();
					expect(resolved.assignments[nodeId]).toMatchObject({
						arm: arm.arm,
						modelAlias: arm.model,
					});
					expect(resolved.receipts[nodeId]).toMatchObject({
						effort: arm.effort,
						overridden: true,
					});
					expect(resolved.templateOverride.nodes?.[nodeId]?.effort).toBe(
						arm.effort,
					);
					const basis = resolved.assignments[nodeId]!.basis;
					if (basis.rule !== "issue_node_weighted")
						throw new Error("expected weighted basis");
					expect(basis.nodes[nodeId]).toEqual(allArmsPinned().nodes[nodeId]);
				}
				expect(resolved.templateOverride.reason).toBe("automatic_model_split");
			}
		});
	});

	it("inherits the template default when the selected arm declares no effort", () => {
		withRuntimeModelConfig({ modelSplit: mixedArms() }, () => {
			const seen = { pinned: 0, inherited: 0 };
			for (let n = 1; n <= 24; n++) {
				const issueKey = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
				const resolved = resolveMenuOverrides(code(), undefined, {
					issueIdentifier: `FLY-${n}`,
					issueKey,
				});
				for (const nodeId of WEIGHTED_NODES) {
					const arm = expectedArm(mixedArms(), issueKey, nodeId);
					const expected = arm.effort ?? menuDefaultEffort(nodeId, arm.model);
					if (arm.effort) seen.pinned++;
					else seen.inherited++;
					expect(resolved.receipts[nodeId]?.effort).toBe(expected);
					expect(resolved.templateOverride.nodes?.[nodeId]?.effort).toBe(
						expected,
					);
				}
			}
			expect(seen.pinned).toBeGreaterThan(0);
			expect(seen.inherited).toBeGreaterThan(0);
		});
		// Effort-less arms are byte-identical to the pre-FLY-2891 shape.
		withRuntimeModelConfig({ modelSplit: PRODUCTION_SHAPE }, () => {
			const issueKey = "00000000-0000-4000-8000-000000000001";
			const resolved = resolveMenuOverrides(code(), undefined, {
				issueIdentifier: "FLY-1",
				issueKey,
			});
			for (const nodeId of WEIGHTED_NODES) {
				const arm = expectedArm(PRODUCTION_SHAPE, issueKey, nodeId);
				expect(resolved.receipts[nodeId]?.effort).toBe(
					menuDefaultEffort(nodeId, arm.model),
				);
				const basis = resolved.assignments[nodeId]!.basis;
				if (basis.rule !== "issue_node_weighted")
					throw new Error("expected weighted basis");
				for (const frozen of basis.nodes[nodeId]) {
					expect(Object.keys(frozen)).toEqual(["arm", "model", "weight"]);
				}
				expect(basis.ruleVersion).toBe(
					"fly2788-v1:f427633f6186f59dccaef1e474d009891f4daa54a0ec19bb8f545357d4481618",
				);
			}
		});
	});

	it("keeps an explicit caller effort ahead of the arm effort", () => {
		withRuntimeModelConfig({ modelSplit: allArmsPinned() }, () => {
			const issueKey = "00000000-0000-4000-8000-000000000001";
			const arm = expectedArm(allArmsPinned(), issueKey, "implement");
			expect(arm.effort).not.toBe("high");
			const resolved = resolveMenuOverrides(
				code(),
				{ implement: { effort: "high" } },
				{ issueIdentifier: "FLY-1", issueKey },
			);
			expect(resolved.assignments.implement).toMatchObject({ arm: arm.arm });
			expect(resolved.receipts.implement).toMatchObject({
				effort: "high",
				overridden: true,
			});
			expect(resolved.templateOverride.nodes?.implement?.effort).toBe("high");
			expect(resolved.requestedTemplateOverride?.nodes?.implement).toEqual({
				effort: "high",
			});
			// Sibling nodes without a caller effort still take their arm effort.
			expect(resolved.receipts.qa?.effort).toBe(
				expectedArm(allArmsPinned(), issueKey, "qa").effort,
			);
		});
	});

	it("rejects an arm effort the node candidates do not allow and names the arm", () => {
		const policy = {
			...allArmsPinned(),
			nodes: {
				...allArmsPinned().nodes,
				implement: [
					{ arm: "impl_opus", model: "opus", weight: 2, effort: "high" },
					{ arm: "impl_sol56", model: "codex", weight: 1, effort: "high" },
					{ arm: "impl_sol6", model: "sol", weight: 1, effort: "high" },
				],
			},
		};
		withRuntimeModelConfig({ modelSplit: policy }, () => {
			const menu = code();
			for (const model of menu.nodes.find((node) => node.id === "implement")!
				.models!) {
				model.allowedEfforts = ["xhigh"];
				model.defaultEffort = "xhigh";
			}
			const issueKey = "00000000-0000-4000-8000-000000000001";
			const arm = expectedArm(policy, issueKey, "implement");
			expect(() =>
				resolveMenuOverrides(menu, undefined, {
					issueIdentifier: "FLY-1",
					issueKey,
				}),
			).toThrowError(
				expect.objectContaining<Partial<WorkflowMenuValidationError>>({
					code: "EFFORT_NOT_ALLOWED_FOR_MODEL",
					legal: ["xhigh"],
					message: expect.stringContaining(`from model split arm ${arm.arm}`),
				}),
			);
			// An explicit caller effort still resolves against the node policy.
			expect(
				resolveMenuOverrides(
					menu,
					{ implement: { effort: "xhigh" } },
					{ issueIdentifier: "FLY-1", issueKey },
				).receipts.implement?.effort,
			).toBe("xhigh");
		});
	});

	it("fails closed at dispatch when the config layer rejects an arm effort", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const qa of [
			// Valid ladder value the arm model does not support on workflow.
			[
				{ arm: "qa_opus46", model: "opus-4-6", weight: 1, effort: "xhigh" },
				{ arm: "qa_sol56", model: "codex", weight: 1 },
			],
			// Outside the ladder entirely.
			[
				{ arm: "qa_sol56", model: "codex", weight: 1, effort: "ultra" },
				{ arm: "qa_opus", model: "opus", weight: 1 },
			],
		]) {
			withRuntimeModelConfig(
				{
					modelSplit: {
						...allArmsPinned(),
						nodes: { ...allArmsPinned().nodes, qa },
					},
				},
				() => {
					expect(() =>
						resolveMenuOverrides(code(), undefined, {
							issueIdentifier: "FLY-1",
							issueKey: "00000000-0000-4000-8000-000000000001",
						}),
					).toThrowError(
						expect.objectContaining<Partial<WorkflowMenuValidationError>>({
							code: "MODEL_SPLIT_CONFIG_INVALID",
						}),
					);
				},
			);
		}
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(
				"modelSplit.nodes.qa[0].effort xhigh is not supported by claude-opus-4-6 on the workflow surface",
			),
		);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(
				"modelSplit.nodes.qa[0].effort must be one of low, medium, high, xhigh, max",
			),
		);
	});
});

describe("FLY-2891 weighted split arm effort — run snapshot and rollback", () => {
	it("pins the arm effort into the run snapshot dispatch and survives rolling the config back", async () => {
		const configRoot = mkdtempSync(join(tmpdir(), "fly2891-run-config-"));
		roots.push(configRoot);
		const configPath = join(configRoot, "models.json");
		const writeConfig = (modelSplit?: unknown) => {
			writeFileSync(
				configPath,
				JSON.stringify({
					version: 1,
					...(modelSplit === undefined ? {} : { modelSplit }),
				}),
			);
			resetModelConfigCacheForTests();
		};
		writeConfig(allArmsPinned());
		const previousPath = process.env.FLYWHEEL_MODELS_CONFIG;
		process.env.FLYWHEEL_MODELS_CONFIG = configPath;
		resetModelConfigCacheForTests();
		const store = await StateStore.create(":memory:");
		try {
			for (const templateId of ["tpl_code", "tpl_simple_code"]) {
				const seed = loadWorkflowMenuSeeds().find(
					(candidate) => candidate.templateId === templateId,
				)!;
				store.importWorkflowTemplateSeed(seed);
				store.bindWorkflowCategory({
					project: "flywheel",
					taskCategory: templateId === "tpl_code" ? "code" : "simple_code",
					templateId,
					updatedBy: "system:test",
				});
			}
			const issueKey = "00000000-0000-4000-8000-000000002891";
			const input = {
				project: "flywheel",
				issueId: "FLY-2891",
				issueIdentifier: "FLY-2891",
				issueKey,
				entryIssueAliases: ["FLY-2891", issueKey],
				entryRootKey: issueKey,
				taskCategory: "code",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master" as const,
				canonicalRoot: REPO_ROOT,
				idempotencyKey: "fly2891-arm-effort-start",
				workKindEnforced: false,
				requestedOverrideDigest: "a".repeat(64),
				now: "2026-09-25T10:00:00.000Z",
			};
			const selected = await resolveWorkflowTemplateSelection(store, input);
			const runId = selected!.runId;
			const snapshot = parseWorkflowRunSnapshot(
				store.getWorkflowRun(runId)!.snapshot!,
			);
			const arms = Object.fromEntries(
				WEIGHTED_NODES.map((nodeId) => [
					nodeId,
					expectedArm(allArmsPinned(), issueKey, nodeId),
				]),
			) as Record<WeightedModelSplitNodeId, WeightedModelSplitArm>;
			// The arm efforts differ from the template defaults, so an inherited
			// default cannot masquerade as an applied arm effort here.
			for (const nodeId of WEIGHTED_NODES) {
				expect(arms[nodeId].effort).not.toBe(
					menuDefaultEffort(nodeId, arms[nodeId].model),
				);
			}
			const receipts = store
				.listWorkflowRunEvents(runId)
				.filter((event) => event.kind === "model_arm_assigned");
			expect(receipts.map((event) => event.node_id).sort()).toEqual([
				"eng_design",
				"implement",
				"qa",
			]);
			for (const nodeId of WEIGHTED_NODES) {
				const arm = arms[nodeId];
				// 1. Frozen engine snapshot: the pinned dispatch the launch reads.
				const node = snapshot.resolved.nodes.find(
					(candidate) => candidate.id === nodeId,
				)!;
				expect(node.dispatchPinned).toBe(true);
				expect(node.dispatch?.effort).toBe(arm.effort);
				// 2. Model routing metadata.
				expect(
					snapshot.modelRouting?.selectionOverride.nodes?.[nodeId]?.effort,
				).toBe(arm.effort);
				// 3. Assignment receipt: basis.nodes carries the arm effort.
				const receipt = receipts.find((event) => event.node_id === nodeId)!;
				expect(receipt.payload).toMatchObject({
					arm: arm.arm,
					basis: { nodes: { [nodeId]: allArmsPinned().nodes[nodeId] } },
				});
				// 4. Launch-time resolution keeps the arm effort.
				const launch = resolveNodeDispatchAtLaunch(store, { runId, nodeId });
				expect(launch.source).toBe("pinned_snapshot");
				expect(launch.dispatch.effort).toBe(arm.effort);
				expect(launch.modelAssignment).toMatchObject({ arm: arm.arm });
			}

			// Rollback: the authority loses its arm efforts (production shape),
			// then loses the split entirely. The frozen run must keep launching
			// its remaining nodes at the recorded arm effort.
			for (const rolledBack of [PRODUCTION_SHAPE, undefined]) {
				writeConfig(rolledBack);
				for (const nodeId of WEIGHTED_NODES) {
					const launch = resolveNodeDispatchAtLaunch(store, {
						runId,
						nodeId,
					});
					expect(launch.dispatch.effort).toBe(arms[nodeId].effort);
					expect(launch.modelAssignment).toMatchObject({
						arm: arms[nodeId].arm,
						basis: { nodes: { [nodeId]: allArmsPinned().nodes[nodeId] } },
					});
				}
				const replay = await resolveWorkflowTemplateSelection(store, input);
				expect(replay?.runId).toBe(runId);
				expect(
					store
						.listWorkflowRunEvents(runId)
						.filter((event) => event.kind === "model_arm_assigned"),
				).toEqual(receipts);
			}
		} finally {
			store.close();
			if (previousPath === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
			else process.env.FLYWHEEL_MODELS_CONFIG = previousPath;
			resetModelConfigCacheForTests();
		}
	});

	// FLY-3018: a re-run of the same issue (terminate → start again, or code →
	// simple_code narrowing) is a fresh run and takes the arm effort in
	// today's config; the original run's replay keeps its frozen effort.
	it("takes today's arm effort on a fresh re-run while the original run replays frozen", async () => {
		const configRoot = mkdtempSync(join(tmpdir(), "fly2891-rerun-config-"));
		roots.push(configRoot);
		const configPath = join(configRoot, "models.json");
		writeFileSync(
			configPath,
			JSON.stringify({ version: 1, modelSplit: allArmsPinned() }),
		);
		const previousPath = process.env.FLYWHEEL_MODELS_CONFIG;
		process.env.FLYWHEEL_MODELS_CONFIG = configPath;
		resetModelConfigCacheForTests();
		const store = await StateStore.create(":memory:");
		try {
			for (const templateId of ["tpl_code", "tpl_simple_code"]) {
				const seed = loadWorkflowMenuSeeds().find(
					(candidate) => candidate.templateId === templateId,
				)!;
				store.importWorkflowTemplateSeed(seed);
				store.bindWorkflowCategory({
					project: "flywheel",
					taskCategory: templateId === "tpl_code" ? "code" : "simple_code",
					templateId,
					updatedBy: "system:test",
				});
			}
			const issueKey = "00000000-0000-4000-8000-000000002891";
			const input = {
				project: "flywheel",
				issueId: "FLY-2891",
				issueIdentifier: "FLY-2891",
				issueKey,
				entryIssueAliases: ["FLY-2891", issueKey],
				entryRootKey: issueKey,
				taskCategory: "code",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master" as const,
				canonicalRoot: REPO_ROOT,
				idempotencyKey: "fly2891-rerun-start",
				workKindEnforced: false,
				requestedOverrideDigest: "a".repeat(64),
				now: "2026-09-25T10:00:00.000Z",
			};
			const first = await resolveWorkflowTemplateSelection(store, input);
			const armEffort = expectedArm(
				allArmsPinned(),
				issueKey,
				"implement",
			).effort;
			expect(
				resolveNodeDispatchAtLaunch(store, {
					runId: first!.runId,
					nodeId: "implement",
				}).dispatch.effort,
			).toBe(armEffort);
			expect(
				store.terminateWorkflowRunByOperator({
					runId: first!.runId,
					reason: "test re-run",
					clientRequestId: "fly2891-rerun-terminate",
					principal: "test",
					evidence: [],
					now: "2026-09-25T10:01:00.000Z",
				}),
			).toMatchObject({ ok: true });
			// Edit only the arm efforts: every implement arm moves to `high`,
			// which differs from each arm's previous pin.
			const edited = allArmsPinned();
			for (const arm of edited.nodes.implement) arm.effort = "high";
			expect(armEffort).not.toBe("high");
			writeFileSync(
				configPath,
				JSON.stringify({ version: 1, modelSplit: edited }),
			);
			resetModelConfigCacheForTests();
			const second = await resolveWorkflowTemplateSelection(store, {
				...input,
				taskCategory: "simple_code",
				idempotencyKey: "fly2891-rerun-again",
				requestedOverrideDigest: "b".repeat(64),
				now: "2026-09-25T10:02:00.000Z",
			});
			expect(second?.runId).not.toBe(first?.runId);
			expect(
				resolveNodeDispatchAtLaunch(store, {
					runId: second!.runId,
					nodeId: "implement",
				}),
			).toMatchObject({
				dispatch: { effort: "high" },
				modelAssignment: {
					arm: expectedArm(edited, issueKey, "implement").arm,
				},
			});
			// The original reservation still replays its own frozen run.
			const replay = await resolveWorkflowTemplateSelection(store, input);
			expect(replay).toMatchObject({ runId: first!.runId, replayed: true });
			expect(
				resolveNodeDispatchAtLaunch(store, {
					runId: first!.runId,
					nodeId: "implement",
				}).dispatch.effort,
			).toBe(armEffort);
		} finally {
			store.close();
			if (previousPath === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
			else process.env.FLYWHEEL_MODELS_CONFIG = previousPath;
			resetModelConfigCacheForTests();
		}
	});
});
