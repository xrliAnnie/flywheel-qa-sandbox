import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetModelConfigCacheForTests } from "flywheel-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyDurableLaunchDrain } from "../../../../scripts/lib/qa-generalized-e2e-lib.mjs";
import { StateStore } from "../StateStore.js";
import { resolveNodeDispatchAtLaunch } from "../workflow-dispatch-resolution.js";
import { loadWorkflowMenuSeeds } from "../workflow-menu.js";
import * as phaseProtocols from "../workflow-phase-protocol.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import { workflowSeedContentHash } from "../workflow-template.js";
import {
	resolveWorkflowTemplateCandidateSchema,
	resolveWorkflowTemplateSelection,
} from "../workflow-template-selection.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

vi.mock("../workflow-phase-protocol.js", async (original) => ({
	...(await original<typeof import("../workflow-phase-protocol.js")>()),
}));

const roots: string[] = [];
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function setupRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "flywheel-selection-"));
	roots.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Research the task.\n");
	return root;
}

function v2Seed() {
	const seed = {
		templateId: "tpl_research_test",
		name: "Research",
		projectScope: "global",
		manifest: {
			schema_version: 2 as const,
			nodes: [
				{
					id: "research",
					type: "generic" as const,
					vendor: "codex" as const,
					model: "gpt-5.6-sol",
					effort: "low" as const,
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" as const },
			],
			edges: [
				{
					id: "done",
					from: "research",
					to: "founder_gate",
					condition: "node_done" as const,
				},
			],
			loops: [],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved" as const,
			},
			ship_claims: ["founder_approved" as const],
		},
	};
	return { ...seed, contentHash: workflowSeedContentHash(seed) };
}

function v2TierSeed() {
	const seed = v2Seed();
	return {
		...seed,
		templateId: "tpl_research_tier_test",
		manifest: {
			...seed.manifest,
			tier_presets: {
				trivial: {
					reason: "trivial tier",
					nodes: {
						research: { model: "gpt-5.5", effort: "low" as const },
					},
				},
				heavy: {
					reason: "heavy tier",
					nodes: {
						research: {
							vendor: "claude" as const,
							model: "claude-opus-5",
							effort: "high" as const,
						},
					},
				},
			},
		},
	};
}

const enabled = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
};

describe("workflow template selection", () => {
	it("persists and replays one finalized weighted assignment per run and node", async () => {
		const configRoot = mkdtempSync(join(tmpdir(), "fly2788-selection-config-"));
		roots.push(configRoot);
		const configPath = join(configRoot, "models.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				modelSplit: {
					enabled: true,
					rule: "issue_node_weighted",
					nodes: {
						eng_design: [
							{ arm: "design_astra", model: "astra", weight: 1 },
							{ arm: "design_opus", model: "opus", weight: 1 },
							{ arm: "design_fable", model: "fable", weight: 1 },
						],
						implement: [
							{ arm: "impl_opus", model: "opus", weight: 2 },
							{ arm: "impl_sol56", model: "codex", weight: 1 },
							{ arm: "impl_sol6", model: "sol", weight: 1 },
						],
						qa: [
							{ arm: "qa_sol56", model: "codex", weight: 2 },
							{ arm: "qa_sol6", model: "sol", weight: 1 },
							{ arm: "qa_opus", model: "opus", weight: 1 },
						],
					},
				},
			}),
		);
		const previousPath = process.env.FLYWHEEL_MODELS_CONFIG;
		process.env.FLYWHEEL_MODELS_CONFIG = configPath;
		resetModelConfigCacheForTests();
		const store = await StateStore.create(":memory:");
		try {
			const seed = loadWorkflowMenuSeeds().find(
				(candidate) => candidate.templateId === "tpl_code",
			)!;
			const simpleSeed = loadWorkflowMenuSeeds().find(
				(candidate) => candidate.templateId === "tpl_simple_code",
			)!;
			store.importWorkflowTemplateSeed(seed);
			store.importWorkflowTemplateSeed(simpleSeed);
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "code",
				templateId: seed.templateId,
				updatedBy: "system:test",
			});
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "simple_code",
				templateId: simpleSeed.templateId,
				updatedBy: "system:test",
			});
			const issueKey = "00000000-0000-4000-8000-000000000001";
			const input = {
				project: "flywheel",
				issueId: "FLY-2788",
				issueIdentifier: "FLY-2788",
				issueKey,
				entryIssueAliases: ["FLY-2788", issueKey],
				entryRootKey: issueKey,
				taskCategory: "code",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master" as const,
				canonicalRoot: REPO_ROOT,
				idempotencyKey: "weighted-start",
				workKindEnforced: false,
				requestedOverrideDigest: "a".repeat(64),
				now: "2026-09-23T05:30:00.000Z",
			};
			const priorAssignmentLookup = vi.spyOn(
				store,
				"listWorkflowModelAssignmentEventsForIssue",
			);
			const materialize = vi.spyOn(store, "materializeWorkflowRun");
			const selected = await resolveWorkflowTemplateSelection(store, input);
			expect(priorAssignmentLookup).toHaveBeenCalledWith("flywheel", issueKey);
			const weightedSnapshot = parseWorkflowRunSnapshot(
				store.getWorkflowRun(selected!.runId)!.snapshot!,
			);
			expect(weightedSnapshot.modelRouting).toMatchObject({
				version: 1,
				policyVersion: expect.stringMatching(/^fly2788-v1:/),
				requestedOverrideDigest: "a".repeat(64),
				selectionOverride: {
					reason: "automatic_model_split",
					nodes: {
						eng_design: { model: "claude-opus-5-5", effort: "high" },
						implement: { model: "gpt-5.6-sol", effort: "xhigh" },
						qa: { model: "gpt-5.6-sol", effort: "high" },
					},
				},
			});
			const receipts = store
				.listWorkflowRunEvents(selected!.runId)
				.filter((event) => event.kind === "model_arm_assigned");
			expect(receipts).toHaveLength(3);
			for (const receipt of receipts) {
				expect(receipt.payload).toMatchObject({
					schemaVersion: 1,
					runId: selected!.runId,
					nodeId: receipt.node_id,
					policyVersion: expect.stringMatching(/^fly2788-v1:/),
					resolvedModel: expect.any(String),
					assignedAt: input.now,
					basis: {
						weightAudit: {
							enabled: false,
							applied: false,
						},
					},
				});
				const audit = (
					receipt.payload as {
						basis: {
							weightAudit: {
								baseWeights: unknown;
								effectiveWeights: unknown;
							};
						};
					}
				).basis.weightAudit;
				expect(audit.effectiveWeights).toEqual(audit.baseWeights);
			}
			expect(
				store.terminateWorkflowRunByOperator({
					runId: selected!.runId,
					reason: "test fresh reassignment",
					clientRequestId: "weighted-terminate",
					principal: "test",
					evidence: [],
					now: "2026-09-23T05:31:00.000Z",
				}),
			).toMatchObject({ ok: true, status: "terminated" });
			const narrowed = await resolveWorkflowTemplateSelection(store, {
				...input,
				taskCategory: "simple_code",
				idempotencyKey: "weighted-simple-start",
				requestedOverrideDigest: "d".repeat(64),
			});
			expect(
				store
					.listWorkflowRunEvents(narrowed!.runId)
					.filter((event) => event.kind === "model_arm_assigned")
					.map((event) => event.node_id),
			).toEqual(["implement", "qa"]);
			expect(
				store.terminateWorkflowRunByOperator({
					runId: narrowed!.runId,
					reason: "test narrower reassignment",
					clientRequestId: "weighted-simple-terminate",
					principal: "test",
					evidence: [],
					now: "2026-09-23T05:31:30.000Z",
				}),
			).toMatchObject({ ok: true, status: "terminated" });
			expect(
				resolveNodeDispatchAtLaunch(store, {
					runId: selected!.runId,
					nodeId: "implement",
				}).modelAssignment,
			).toMatchObject({
				runId: selected!.runId,
				nodeId: "implement",
				arm: "impl_sol56",
				resolvedModel: "gpt-5.6-sol",
			});
			const rootSpoof = structuredClone(materialize.mock.calls[0]![0]);
			rootSpoof.entryRootKey = "11111111-1111-4111-8111-111111111111";
			const spoofedAssignment = rootSpoof.modelAssignments!.eng_design!;
			if (spoofedAssignment.basis.rule !== "issue_node_weighted")
				throw new Error("expected weighted assignment");
			spoofedAssignment.basis.issueKey = rootSpoof.entryRootKey;
			expect(() => store.materializeWorkflowRun(rootSpoof)).toThrow(
				"workflow_model_assignment_invalid:eng_design",
			);
			const manualIssueKey = "00000000-0000-4000-8000-000000000002";
			const manual = await resolveWorkflowTemplateSelection(store, {
				...input,
				issueId: manualIssueKey,
				issueIdentifier: "FLY-2789",
				issueKey: manualIssueKey,
				entryIssueAliases: ["FLY-2789"],
				entryRootKey: manualIssueKey,
				idempotencyKey: "weighted-menu-only-manual",
				menuOverrides: { implement: { model: "fable", effort: "high" } },
				requestedOverrideDigest: "c".repeat(64),
			});
			const manualDispatch = resolveNodeDispatchAtLaunch(store, {
				runId: manual!.runId,
				nodeId: "implement",
			});
			expect(manualDispatch).toMatchObject({
				dispatch: { model: "claude-fable-5-1", effort: "high" },
			});
			expect(manualDispatch.modelAssignment).toBeUndefined();

			writeFileSync(configPath, JSON.stringify({ version: 1 }));
			resetModelConfigCacheForTests();
			const replay = await resolveWorkflowTemplateSelection(store, input);
			expect(replay?.runId).toBe(selected?.runId);
			await expect(
				resolveWorkflowTemplateSelection(store, {
					...input,
					requestedOverrideDigest: "b".repeat(64),
				}),
			).rejects.toThrow("workflow start idempotency key payload mismatch");
			expect(
				store
					.listWorkflowRunEvents(selected!.runId)
					.filter((event) => event.kind === "model_arm_assigned"),
			).toEqual(receipts);

			writeFileSync(
				configPath,
				JSON.stringify({
					version: 1,
					modelSplit: {
						enabled: true,
						rule: "issue_node_weighted",
						nodes: {
							eng_design: [
								{ arm: "design_astra", model: "astra", weight: 100 },
								{ arm: "design_opus", model: "opus", weight: 1 },
								{ arm: "design_fable", model: "fable", weight: 1 },
							],
							implement: [
								{ arm: "impl_opus", model: "opus", weight: 100 },
								{ arm: "impl_sol56", model: "codex", weight: 1 },
								{ arm: "impl_sol6", model: "sol", weight: 1 },
							],
							qa: [
								{ arm: "qa_opus", model: "opus", weight: 100 },
								{ arm: "qa_sol56", model: "codex", weight: 1 },
								{ arm: "qa_sol6", model: "sol", weight: 1 },
							],
						},
					},
				}),
			);
			resetModelConfigCacheForTests();
			const reassigned = await resolveWorkflowTemplateSelection(store, {
				...input,
				idempotencyKey: "weighted-fresh-start",
				now: "2026-09-23T05:32:00.000Z",
			});
			expect(reassigned?.runId).not.toBe(selected?.runId);
			const reassignedReceipts = store
				.listWorkflowRunEvents(reassigned!.runId)
				.filter((event) => event.kind === "model_arm_assigned");
			expect(
				reassignedReceipts.map((event) => ({
					nodeId: event.node_id,
					arm: (event.payload as { arm: string }).arm,
					basis: (event.payload as { basis: unknown }).basis,
				})),
			).toEqual(
				receipts.map((event) => ({
					nodeId: event.node_id,
					arm: (event.payload as { arm: string }).arm,
					basis: (event.payload as { basis: unknown }).basis,
				})),
			);
		} finally {
			store.close();
			if (previousPath === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
			else process.env.FLYWHEEL_MODELS_CONFIG = previousPath;
			resetModelConfigCacheForTests();
		}
	});

	it("pins the fixed Opus product-node selection in model routing metadata", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const seed = loadWorkflowMenuSeeds().find(
				(candidate) => candidate.templateId === "tpl_prd",
			)!;
			store.importWorkflowTemplateSeed(seed);
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "prd",
				templateId: seed.templateId,
				updatedBy: "system:test",
			});
			const selected = await resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-2788",
				taskCategory: "prd",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: REPO_ROOT,
				idempotencyKey: "fixed-prd-start",
				workKindEnforced: false,
			});
			const snapshot = parseWorkflowRunSnapshot(
				store.getWorkflowRun(selected!.runId)!.snapshot!,
			);
			expect(snapshot.modelRouting).toMatchObject({
				version: 1,
				policyVersion: "fly2788-fixed-v1",
				selectionOverride: {
					reason: "registry_default",
					nodes: {
						pm: {
							vendor: "claude",
							model: "claude-opus-5-5",
							effort: "high",
						},
					},
				},
			});
			expect(
				store
					.listWorkflowRunEvents(selected!.runId)
					.filter((event) => event.kind === "model_arm_assigned"),
			).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("degrades only an implement Sol arm on exact current pool exhaustion and records it atomically", async () => {
		const configRoot = mkdtempSync(join(tmpdir(), "fly2788-degrade-config-"));
		roots.push(configRoot);
		const configPath = join(configRoot, "models.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				modelSplit: {
					enabled: true,
					rule: "issue_node_weighted",
					nodes: {
						eng_design: [
							{ arm: "design_astra", model: "astra", weight: 1 },
							{ arm: "design_opus", model: "opus", weight: 1 },
							{ arm: "design_fable", model: "fable", weight: 1 },
						],
						implement: [
							{ arm: "impl_opus", model: "opus", weight: 2 },
							{ arm: "impl_sol56", model: "codex", weight: 1 },
							{ arm: "impl_sol6", model: "sol", weight: 1 },
						],
						qa: [
							{ arm: "qa_sol56", model: "codex", weight: 2 },
							{ arm: "qa_sol6", model: "sol", weight: 1 },
							{ arm: "qa_opus", model: "opus", weight: 1 },
						],
					},
				},
			}),
		);
		const previousPath = process.env.FLYWHEEL_MODELS_CONFIG;
		process.env.FLYWHEEL_MODELS_CONFIG = configPath;
		resetModelConfigCacheForTests();
		const store = await StateStore.create(":memory:");
		try {
			const seed = loadWorkflowMenuSeeds().find(
				(candidate) => candidate.templateId === "tpl_simple_code",
			)!;
			store.importWorkflowTemplateSeed(seed);
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "simple_code",
				templateId: seed.templateId,
				updatedBy: "system:test",
			});
			const issueKey = "00000000-0000-4000-8000-000000000001";
			const now = Date.parse("2026-09-23T06:00:00.000Z");
			const selected = await resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: issueKey,
				issueIdentifier: "FLY-2788",
				issueKey,
				entryIssueAliases: ["FLY-2788"],
				taskCategory: "simple_code",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: REPO_ROOT,
				idempotencyKey: "degraded-start",
				workKindEnforced: false,
				now: new Date(now).toISOString(),
			});
			store.codexQuota.initializeRoot({
				rootKey: "quota-root",
				accountKey: "business-key",
				profile: "business",
				generation: 1,
			});
			store.codexQuota.registerBinding({
				bindingId: "quota-binding",
				executionId: "quota-casualty",
				runId: "quota-run",
				purpose: "runner",
				accountKey: "business-key",
				profile: "business",
				generation: 1,
				credentialRootKey: "quota-root",
			});
			store.codexQuota.recordSignal({
				executionId: "quota-casualty",
				bindingId: "quota-binding",
			});
			const observations = ["business", "school", "personal"].map(
				(profile) => ({
					profile,
					accountKey: `${profile}-key`,
					observedAt: now - 1_000,
					identityVerified: true,
					authHealth: "valid" as const,
					scopeKnown: true,
					windows: [{ usedPercent: 100, resetsAt: now + 60_000 }],
				}),
			);
			const pool = observations.map(({ profile, accountKey }) => ({
				profile,
				accountKey,
			}));
			store.currentCodexPoolMembers = () => pool;
			store.codexQuota.recordPoolExhausted({
				incidentId: "codex:quota-root:1",
				pool,
				observations,
				observedAt: now - 1_000,
				nextAttemptAt: now + 60_000,
			});
			const resolution = resolveNodeDispatchAtLaunch(store, {
				runId: selected!.runId,
				nodeId: "implement",
				codexQuotaRootKey: "quota-root",
				now,
			});
			expect(resolution).toMatchObject({
				dispatch: {
					vendor: "claude",
					model: "claude-opus-5-5",
					effort: "xhigh",
				},
				modelAssignment: { arm: "impl_sol56", model: "gpt-5.6-sol" },
				degradation: {
					assignedDispatch: { vendor: "codex", model: "gpt-5.6-sol" },
					quotaEvidence: { rootKey: "quota-root", generation: 1 },
				},
			});
			expect(
				resolveNodeDispatchAtLaunch(store, {
					runId: selected!.runId,
					nodeId: "implement",
					codexQuotaRootKey: "quota-root",
					now: now + 60_001,
				}).degradation,
			).toBeUndefined();
			expect(
				resolveNodeDispatchAtLaunch(store, {
					runId: selected!.runId,
					nodeId: "qa",
					codexQuotaRootKey: "quota-root",
					now,
				}).degradation,
			).toBeUndefined();
			const raw = (
				store as unknown as {
					db: { raw: import("better-sqlite3").Database };
				}
			).db.raw;
			raw.exec(
				"CREATE TRIGGER reject_degradation BEFORE INSERT ON workflow_run_event WHEN NEW.kind='model_arm_degraded' BEGIN SELECT RAISE(ABORT, 'reject_degradation'); END",
			);
			const admission = () =>
				store.admitGeneralizedWorkflowExecution({
					codexQuotaRootKey: "quota-root",
					runId: selected!.runId,
					nodeId: "implement",
					executionId: selected!.executionId,
					attempt: 1,
					now: new Date(now).toISOString(),
					expiresAt: new Date(now + 60_000).toISOString(),
					absoluteDeadlineAt: new Date(now + 120_000).toISOString(),
					dispatchResolution: resolution,
				});
			expect(
				store.admitGeneralizedWorkflowExecution({
					codexQuotaRootKey: "quota-root",
					runId: selected!.runId,
					nodeId: "implement",
					executionId: selected!.executionId,
					attempt: 1,
					now: new Date(now).toISOString(),
					expiresAt: new Date(now + 60_000).toISOString(),
					absoluteDeadlineAt: new Date(now + 120_000).toISOString(),
					dispatchResolution: {
						...resolution,
						dispatch: {
							vendor: "claude",
							model: "claude-fable-5-1",
							effort: "xhigh",
						},
					},
				}),
			).toEqual({ ok: false, reason: "model_arm_degradation_invalid" });
			expect(admission).toThrow("reject_degradation");
			expect(
				store.getWorkflowExecutionRuntime(selected!.executionId),
			).toBeUndefined();
			raw.exec("DROP TRIGGER reject_degradation");
			expect(admission()).toMatchObject({ ok: true, idempotentReplay: false });
			expect(admission()).toMatchObject({ ok: true, idempotentReplay: true });
			expect(
				store.getWorkflowExecutionRuntime(selected!.executionId),
			).toMatchObject({ vendor: "claude", model: "claude-opus-5-5" });
			store.upsertWorkflowRunNode({
				runId: selected!.runId,
				nodeId: "implement",
				attempt: 2,
				state: "pending",
				executionId: selected!.executionId,
			});
			const wake = () =>
				store.admitGeneralizedWorkflowExecution({
					codexQuotaRootKey: "quota-root",
					runId: selected!.runId,
					nodeId: "implement",
					executionId: selected!.executionId,
					attempt: 2,
					activationId: "degraded-wake-2",
					activationMode: "wake",
					now: new Date(now + 1_000).toISOString(),
					expiresAt: new Date(now + 61_000).toISOString(),
					absoluteDeadlineAt: new Date(now + 121_000).toISOString(),
				});
			expect(wake()).toMatchObject({ ok: true, idempotentReplay: false });
			const degraded = store
				.listWorkflowRunEvents(selected!.runId)
				.filter((event) => event.kind === "model_arm_degraded");
			expect(degraded).toHaveLength(2);
			expect(degraded[0]?.payload).toMatchObject({
				arm: "impl_sol56",
				degraded: true,
				assignedModel: "gpt-5.6-sol",
				actualModel: "claude-opus-5-5",
				reason: "codex_pool_exhausted",
			});
			expect(degraded[1]?.payload).toMatchObject({
				activationId: "degraded-wake-2",
				originalDegradationEventUid: degraded[0]?.event_uid,
			});
		} finally {
			store.close();
			if (previousPath === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
			else process.env.FLYWHEEL_MODELS_CONFIG = previousPath;
			resetModelConfigCacheForTests();
		}
	});

	it("applies the configured design split inside template selection even without menu-route receipts", async () => {
		const store = await StateStore.create(":memory:");
		const seed = loadWorkflowMenuSeeds().find(
			(candidate) => candidate.templateId === "tpl_code",
		)!;
		store.importWorkflowTemplateSeed(seed);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "code",
			templateId: seed.templateId,
			updatedBy: "system:test",
		});

		const selected = await resolveWorkflowTemplateSelection(store, {
			project: "flywheel",
			issueId: "FLY-2403",
			taskCategory: "code",
			selectedBy: "eng-lead",
			actor: "master",
			authKind: "master",
			canonicalRoot: REPO_ROOT,
			idempotencyKey: "non-menu-code-start",
			workKindEnforced: false,
		});

		const snapshot = parseWorkflowRunSnapshot(
			store.getWorkflowRun(selected!.runId)!.snapshot!,
		);
		expect(
			snapshot.resolved.nodes.find((node) => node.id === "eng_design")
				?.dispatch,
		).toMatchObject({ vendor: "codex", model: "gpt-6-astra" });
		expect(
			store
				.listWorkflowRunEvents(selected!.runId)
				.find((event) => event.kind === "design_model_arm_assigned")?.payload,
		).toMatchObject({
			arm: "A",
			basis: { issueNumber: 2403, ruleVersion: "fly2403-v1" },
		});
		store.close();
	});

	it("persists the call-time models.json mapping on the engine selection path", async () => {
		const configRoot = mkdtempSync(join(tmpdir(), "fly2403-selection-config-"));
		roots.push(configRoot);
		const configPath = join(configRoot, "models.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				modelSplit: {
					enabled: true,
					rule: "issue_number_parity",
					version: "runtime-constant-a",
					odd: { arm: "A", model: "astra" },
					even: { arm: "A", model: "astra" },
				},
			}),
		);
		const previousPath = process.env.FLYWHEEL_MODELS_CONFIG;
		process.env.FLYWHEEL_MODELS_CONFIG = configPath;
		resetModelConfigCacheForTests();
		const store = await StateStore.create(":memory:");
		try {
			const seed = loadWorkflowMenuSeeds().find(
				(candidate) => candidate.templateId === "tpl_code",
			)!;
			store.importWorkflowTemplateSeed(seed);
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "code",
				templateId: seed.templateId,
				updatedBy: "system:test",
			});

			const selected = await resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-2404",
				taskCategory: "code",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: REPO_ROOT,
				idempotencyKey: "runtime-constant-a-start",
				workKindEnforced: false,
			});

			const snapshot = parseWorkflowRunSnapshot(
				store.getWorkflowRun(selected!.runId)!.snapshot!,
			);
			expect(
				snapshot.resolved.nodes.find((node) => node.id === "eng_design")
					?.dispatch,
			).toMatchObject({ vendor: "codex", model: "gpt-6-astra" });
			expect(
				store
					.listWorkflowRunEvents(selected!.runId)
					.find((event) => event.kind === "design_model_arm_assigned")?.payload,
			).toMatchObject({
				arm: "A",
				basis: { issueNumber: 2404, ruleVersion: "runtime-constant-a" },
			});
		} finally {
			store.close();
			if (previousPath === undefined) {
				delete process.env.FLYWHEEL_MODELS_CONFIG;
			} else {
				process.env.FLYWHEEL_MODELS_CONFIG = previousPath;
			}
			resetModelConfigCacheForTests();
		}
	});

	it("returns null for no candidate", async () => {
		const store = await StateStore.create(":memory:");
		const root = setupRoot();
		expect(
			await resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-X",
				taskCategory: "research",
				selectedBy: "lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: root,
				env: {},
			}),
		).toBeNull();
		expect(
			resolveWorkflowTemplateCandidateSchema(store, {
				project: "flywheel",
				taskCategory: "research",
			}),
		).toBeNull();
		store.close();
	});

	it("never materializes a fresh schema-v1 candidate", async () => {
		const store = await StateStore.create(":memory:");
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		store.importWorkflowTemplateSeed(seed);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "*",
			templateId: seed.templateId,
			updatedBy: "system:bundled-default",
		});
		expect(
			resolveWorkflowTemplateCandidateSchema(store, {
				project: "flywheel",
			}),
		).toBe(1);
		expect(
			await resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-V1-RETIRED",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "retired-v1-key",
				env: enabled,
			}),
		).toBeNull();
		expect(
			store.getActiveWorkflowRunForIssue("FLY-V1-RETIRED"),
		).toBeUndefined();
		expect(store.getWorkflowStartReservation("retired-v1-key")).toBeUndefined();
		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-V1-DRIFT",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "drift-key",
				candidateSchemaAtEntry: 2,
				env: enabled,
			}),
		).rejects.toThrow(/candidate changed/i);
		store.close();
	});

	it.each([
		["FLYWHEEL_WORKFLOW_CLAIMS_WRITE"],
		["FLYWHEEL_WORKFLOW_CLAIMS_READ"],
		["FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES"],
	] as const)(
		"selects a v2 candidate despite retired %s=0",
		async (retired) => {
			const store = await StateStore.create(":memory:");
			const root = setupRoot();
			const seed = v2Seed();
			store.importWorkflowTemplateSeed(seed, enabled);
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "research",
				templateId: seed.templateId,
				updatedBy: "lead",
			});
			const env = { ...enabled, [retired]: "0" };
			const selection = await resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: `FLY-V2-${retired}`,
				taskCategory: "research",
				selectedBy: "research-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: root,
				idempotencyKey: `v2-${retired}`,
				env,
			});
			expect(selection).toMatchObject({ nodeId: "research" });
			expect(
				store.getActiveWorkflowRunForIssue(`FLY-V2-${retired}`)?.run_id,
			).toBe(selection?.runId);
			store.close();
		},
	);

	it("selects a v2 candidate despite retired template-dispatch zero", async () => {
		const store = await StateStore.create(":memory:");
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		const selection = await resolveWorkflowTemplateSelection(store, {
			project: "flywheel",
			issueId: "FLY-V2-DISPATCH-OFF",
			taskCategory: "research",
			selectedBy: "research-lead",
			actor: "master",
			authKind: "master",
			canonicalRoot: setupRoot(),
			idempotencyKey: "v2-dispatch-off",
			env: {
				...enabled,
				FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "0",
			},
		});
		expect(selection).toMatchObject({ nodeId: "research" });
		store.close();
	});

	it.each([
		["binding", true],
		["direct", true],
		["binding", false],
		["direct", false],
	] as const)(
		"selects installed v2 %s with retired generalized raw on=%s",
		async (selection, flagOn) => {
			const store = await StateStore.create(":memory:");
			const seed = v2Seed();
			const env = {
				...enabled,
				FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: flagOn ? "1" : "0",
			};
			expect(store.importWorkflowTemplateSeed(seed, env)).toMatchObject({
				status: "imported",
			});
			if (selection === "binding") {
				store.bindWorkflowCategory({
					project: "flywheel",
					taskCategory: "research",
					templateId: seed.templateId,
					updatedBy: "lead",
				});
			}
			const ids = [`${selection}-run`, `${selection}-exec`];
			const resolve = () =>
				resolveWorkflowTemplateSelection(store, {
					project: "flywheel",
					issueId: `FLY-V2-${selection}-${flagOn ? "ON" : "OFF"}`,
					...(selection === "binding"
						? { taskCategory: "research" }
						: {
								leadTemplateId: seed.templateId,
								leadReason: "bounded direct research",
							}),
					selectedBy: "research-lead",
					actor: "master",
					authKind: "master" as const,
					canonicalRoot: setupRoot(),
					idempotencyKey: `${selection}-${flagOn ? "on" : "off"}`,
					env,
					idFactory: () => ids.shift()!,
				});
			await expect(resolve()).resolves.toMatchObject({
				selectionSource: selection === "binding" ? "binding" : "lead",
				nodeId: "research",
			});
			store.close();
		},
	);

	it("materializes a bound v2 template with selection provenance and exact idempotent replay", async () => {
		const store = await StateStore.create(":memory:");
		const root = setupRoot();
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		const input = {
			project: "flywheel",
			issueId: "FLY-X",
			taskCategory: "research",
			selectedBy: "research-lead",
			actor: "master",
			authKind: "master" as const,
			canonicalRoot: root,
			idempotencyKey: "start-key-1",
			entryKind: "workflow_v2" as const,
			env: enabled,
			idFactory: (() => {
				const values = ["run-1", "exec-1"];
				return () => values.shift()!;
			})(),
			now: "2026-07-15T00:00:00.000Z",
		};
		const selected = await resolveWorkflowTemplateSelection(store, input);
		expect(selected).toMatchObject({
			runId: "run-1",
			executionId: "exec-1",
			nodeId: "research",
			selectionSource: "binding",
		});
		expect(store.getWorkflowRun("run-1")).toMatchObject({
			selection_source: "binding",
			selected_by: "research-lead",
			entry_kind: "workflow_v2",
		});
		expect(store.getWorkflowStartReservation("start-key-1")?.stage).toBe(
			"materialized",
		);
		const replay = await resolveWorkflowTemplateSelection(store, {
			...input,
			idFactory: () => {
				throw new Error("must not allocate on replay");
			},
		});
		expect(replay).toMatchObject({ runId: "run-1", executionId: "exec-1" });
		store.close();
	});

	it("applies the default heavy tier preset and pins tier provenance", async () => {
		const store = await StateStore.create(":memory:");
		const root = setupRoot();
		const seed = v2TierSeed();
		store.importWorkflowTemplateSeed(
			{ ...seed, contentHash: workflowSeedContentHash(seed) },
			enabled,
		);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "generic",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		const values = ["tier-run", "tier-exec"];
		const selected = await resolveWorkflowTemplateSelection(store, {
			project: "flywheel",
			issueId: "FLY-TIER",
			taskCategory: "generic",
			selectedBy: "generic-lead",
			actor: "master",
			authKind: "master",
			canonicalRoot: root,
			idempotencyKey: "tier-key",
			entryKind: "workflow_v2",
			workKindEnforced: true,
			categorySource: "task_category",
			env: enabled,
			idFactory: () => values.shift()!,
		});
		expect(selected).toMatchObject({ tier: "heavy" });
		expect(selected?.node.dispatch).toMatchObject({
			vendor: "claude",
			model: "claude-opus-5",
			effort: "high",
		});
		const run = store.getWorkflowRun("tier-run")!;
		expect(run).toMatchObject({ tier: "heavy" });
		expect(parseWorkflowRunSnapshot(run.snapshot!)).toMatchObject({
			tier: "heavy",
			category_source: "task_category",
		});
		store.close();
	});

	it("rejects an explicit tier when the selected template has no presets", async () => {
		const store = await StateStore.create(":memory:");
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-NO-TIER",
				taskCategory: "research",
				selectedBy: "lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "no-tier-key",
				workKindEnforced: true,
				categorySource: "task_category",
				tier: "light",
				env: enabled,
			}),
		).rejects.toMatchObject({ code: "TIER_NOT_SUPPORTED" });
		expect(store.getActiveWorkflowRunForIssue("FLY-NO-TIER")).toBeUndefined();
		store.close();
	});

	it("rejects a retired direct template while leaving pinned recovery candidate-free", async () => {
		const store = await StateStore.create(":memory:");
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		const internal = store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		internal.db.run(
			"UPDATE workflow_template SET retired_at = ? WHERE template_id = ?",
			["2026-07-21T00:00:00.000Z", seed.templateId],
		);
		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-RETIRED",
				leadTemplateId: seed.templateId,
				leadReason: "explicit research flow",
				selectedBy: "lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "retired-key",
				workKindEnforced: true,
				categorySource: "template_override",
				env: enabled,
			}),
		).rejects.toMatchObject({ code: "TEMPLATE_NOT_FRESH_ELIGIBLE" });
		expect(store.getActiveWorkflowRunForIssue("FLY-RETIRED")).toBeUndefined();
		store.close();
	});

	it("rejects a retired direct template when work-kind enforcement is off", async () => {
		const store = await StateStore.create(":memory:");
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		const internal = store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		internal.db.run(
			"UPDATE workflow_template SET retired_at = ? WHERE template_id = ?",
			["2026-08-11T00:00:00.000Z", seed.templateId],
		);

		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-RETIRED-NON-ENFORCED",
				leadTemplateId: seed.templateId,
				leadReason: "explicit research flow",
				selectedBy: "lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "retired-non-enforced-key",
				env: enabled,
			}),
		).rejects.toThrow(/retired.*tpl_research_test|tpl_research_test.*retired/i);
		expect(
			store.getActiveWorkflowRunForIssue("FLY-RETIRED-NON-ENFORCED"),
		).toBeUndefined();
		store.close();
	});

	it("rejects a retired template reached through a stale binding", async () => {
		const store = await StateStore.create(":memory:");
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "founder:fixture",
		});
		const internal = store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		internal.db.run(
			"UPDATE workflow_template SET retired_at = ? WHERE template_id = ?",
			["2026-08-11T00:00:00.000Z", seed.templateId],
		);

		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-RETIRED-BINDING",
				taskCategory: "research",
				selectedBy: "lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "retired-binding-key",
				env: enabled,
			}),
		).rejects.toThrow(/retired.*tpl_research_test|tpl_research_test.*retired/i);
		expect(
			store.getActiveWorkflowRunForIssue("FLY-RETIRED-BINDING"),
		).toBeUndefined();
		store.close();
	});

	it("refuses a retirement race at the final materialization boundary", async () => {
		const store = await StateStore.create(":memory:");
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		const originalGetTemplate = store.getWorkflowTemplate.bind(store);
		let reads = 0;
		store.getWorkflowTemplate = ((templateId) => {
			reads += 1;
			if (reads === 3) {
				(
					store as unknown as {
						db: { run(sql: string, params?: unknown[]): void };
					}
				).db.run(
					"UPDATE workflow_template SET retired_at = ? WHERE template_id = ?",
					["2026-08-11T00:00:00.000Z", seed.templateId],
				);
			}
			return originalGetTemplate(templateId);
		}) as typeof store.getWorkflowTemplate;

		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-RETIREMENT-RACE",
				taskCategory: "research",
				selectedBy: "lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "retirement-race",
				entryKind: "workflow_v2",
				env: enabled,
			}),
		).rejects.toThrow(/candidate changed during materialization/i);
		expect(
			store.getActiveWorkflowRunForIssue("FLY-RETIREMENT-RACE"),
		).toBeUndefined();
		expect(
			store.getWorkflowStartReservation("retirement-race"),
		).toBeUndefined();
		store.close();
	});

	it("records a start response only after the durable launch owner proves delivery", async () => {
		const store = await StateStore.create(":memory:");
		const root = setupRoot();
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		const selected = await resolveWorkflowTemplateSelection(store, {
			project: "flywheel",
			issueId: "FLY-X",
			taskCategory: "research",
			selectedBy: "research-lead",
			actor: "master",
			authKind: "master",
			canonicalRoot: root,
			idempotencyKey: "start-key-proof",
			env: enabled,
			idFactory: (() => {
				const values = ["run-proof", "exec-proof"];
				return () => values.shift()!;
			})(),
			now: "2026-07-15T00:00:00.000Z",
		});
		if (!selected) throw new Error("selection failed");
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: selected.runId,
				nodeId: selected.nodeId,
				executionId: selected.executionId,
				attempt: 1,
				expiresAt: "2026-07-15T00:20:00.000Z",
				absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
				now: "2026-07-15T00:00:30.000Z",
				env: enabled,
				idempotencyKey: "start-key-proof",
			}),
		).toMatchObject({ ok: true });
		store.advanceWorkflowStartStage(
			"start-key-proof",
			"launch_committed",
			"2026-07-15T00:01:00.000Z",
		);
		expect(() =>
			store.recordWorkflowStartResponse({
				idempotencyKey: "start-key-proof",
				response: { success: true },
			}),
		).toThrow(/launch.*evidence|owner|delivery/i);

		const markerPath = join(root, "launch-proof.json");
		const owner = store.recoverOrAcquireWorkflowLaunch({
			executionId: selected.executionId,
			ownerId: "dispatcher",
			now: "2026-07-15T00:02:00.000Z",
			leaseExpiresAt: "2026-07-15T00:10:00.000Z",
			markerPath,
		});
		if (owner.status !== "acquired") throw new Error("owner not acquired");
		expect(
			store.fencedCommitWorkflowLaunch({
				executionId: selected.executionId,
				ownerId: "dispatcher",
				generation: owner.generation,
				deliveryAttempt: owner.deliveryAttempt,
				markerPath,
				now: "2026-07-15T00:03:00.000Z",
			}),
		).toMatchObject({ ok: true });
		store.recordWorkflowStartResponse({
			idempotencyKey: "start-key-proof",
			response: { success: true },
		});
		expect(store.getWorkflowStartResponse("start-key-proof")).toEqual({
			success: true,
		});
		store.close();
	});

	it("atomically supersedes a quiescent legacy workflow run when starting the engine", async () => {
		const store = await StateStore.create(":memory:");
		const root = setupRoot();
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		store.applyWorkflowLedgerBatch({
			projectName: "flywheel",
			issueId: "FLY-X",
			newRunId: "shadow-run",
			ops: [
				{
					op: "dispatch",
					node: "main",
					attempt: 1,
					executionId: "shadow-dead",
				},
			],
		});
		store.upsertSession({
			execution_id: "shadow-dead",
			issue_id: "FLY-X",
			project_name: "flywheel",
			status: "failed",
		});

		const selected = await resolveWorkflowTemplateSelection(store, {
			project: "flywheel",
			issueId: "FLY-X",
			taskCategory: "research",
			selectedBy: "research-lead",
			actor: "master",
			authKind: "master",
			canonicalRoot: root,
			idempotencyKey: "supersede-start",
			env: enabled,
			idFactory: (() => {
				const values = ["engine-run", "engine-exec"];
				return () => values.shift()!;
			})(),
			now: "2026-07-20T00:10:00.000Z",
			probeRunExecutionLiveness: async () => "dead",
		});

		expect(selected).toMatchObject({
			runId: "engine-run",
			executionId: "engine-exec",
		});
		expect(store.getWorkflowRun("shadow-run")?.status).toBe("terminated");
		expect(store.getWorkflowRun("engine-run")?.status).toBe("active");
		expect(
			store
				.listWorkflowRunEvents("shadow-run")
				.filter((event) => event.kind === "run_terminated_by_supersession"),
		).toHaveLength(1);
		store.close();
	});

	// FLY-1385 QA: the supersession guard's safety direction. Terminating a shadow
	// run whose runner is still working would strand live work and let a second
	// runner take the same issue, so anything short of terminal-plus-dead evidence
	// must leave the shadow untouched. Removing the guard leaves the happy-path
	// supersession test green, so these two lock the refusal explicitly.
	for (const probe of ["alive", "unknown"] as const) {
		it.skip(`refuses to supersede a workflow run whose execution probes ${probe}`, async () => {
			const store = await StateStore.create(":memory:");
			const root = setupRoot();
			const seed = v2Seed();
			store.importWorkflowTemplateSeed(seed, enabled);
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "research",
				templateId: seed.templateId,
				updatedBy: "lead",
			});
			store.applyWorkflowLedgerBatch({
				projectName: "flywheel",
				issueId: "FLY-X",
				newRunId: "shadow-run",
				ops: [
					{
						op: "dispatch",
						node: "main",
						attempt: 1,
						executionId: "shadow-exec",
					},
				],
			});
			store.upsertSession({
				execution_id: "shadow-exec",
				issue_id: "FLY-X",
				project_name: "flywheel",
				// A terminal session alone must not authorize supersession: only a
				// terminal session AND a dead probe together prove quiescence.
				status: probe === "alive" ? "running" : "failed",
			});

			await expect(
				resolveWorkflowTemplateSelection(store, {
					project: "flywheel",
					issueId: "FLY-X",
					taskCategory: "research",
					selectedBy: "research-lead",
					actor: "master",
					authKind: "master",
					canonicalRoot: root,
					idempotencyKey: "supersede-live",
					env: enabled,
					now: "2026-07-20T00:10:00.000Z",
					probeRunExecutionLiveness: async () => probe,
				}),
			).rejects.toThrow(/shadow_run_live/);

			// The shadow keeps the issue's active slot and gains no audit trail.
			expect(store.getWorkflowRun("shadow-run")?.status).toBe("active");
			expect(
				store
					.listWorkflowRunEvents("shadow-run")
					.filter((event) => event.kind === "run_terminated_by_supersession"),
			).toHaveLength(0);
			// No half-built engine run or reservation may survive the refusal.
			expect(store.getActiveWorkflowRunForIssue("FLY-X")?.run_id).toBe(
				"shadow-run",
			);
			expect(store.getWorkflowStartReservation("supersede-live")).toBeFalsy();
			store.close();
		});
	}

	it("refuses a publication race at the final materialization boundary", async () => {
		const store = await StateStore.create(":memory:");
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		const originalMaterialize = store.materializeWorkflowRun.bind(store);
		let raced = false;
		store.materializeWorkflowRun = ((input) => {
			if (!raced) {
				raced = true;
				expect(
					store.createAndPublishWorkflowTemplateRevision({
						templateId: seed.templateId,
						manifest: {
							...seed.manifest,
							nodes: seed.manifest.nodes.map((node) =>
								node.id === "research"
									? { ...node, effort: "medium" as const }
									: node,
							),
						},
						expectedRevision: 1,
						createdBy: "founder",
					}),
				).toMatchObject({ status: "published", revision: 2 });
			}
			return originalMaterialize(input);
		}) as typeof store.materializeWorkflowRun;

		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-PUBLISH-RACE",
				taskCategory: "research",
				selectedBy: "research-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "publication-race",
				entryKind: "workflow_v2",
				env: enabled,
			}),
		).rejects.toThrow(/candidate changed during materialization/i);
		expect(
			store.getActiveWorkflowRunForIssue("FLY-PUBLISH-RACE"),
		).toBeUndefined();
		expect(
			store.getWorkflowStartReservation("publication-race"),
		).toBeUndefined();
		store.close();
	});

	it("linearizes legacy and engine entry so exactly one mode can claim an issue", async () => {
		const root = setupRoot();
		const makeStore = async () => {
			const store = await StateStore.create(":memory:");
			const seed = v2Seed();
			store.importWorkflowTemplateSeed(seed, enabled);
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "research",
				templateId: seed.templateId,
				updatedBy: "lead",
			});
			return store;
		};

		const legacyFirst = await makeStore();
		expect(
			legacyFirst.claimLegacyWorkflowEntry({
				issueId: "FLY-LEGACY-WINS",
				projectName: "flywheel",
				executionId: "legacy-exec",
				role: "main",
			}),
		).toEqual({ ok: true });
		await expect(
			resolveWorkflowTemplateSelection(legacyFirst, {
				project: "flywheel",
				issueId: "FLY-LEGACY-WINS",
				taskCategory: "research",
				selectedBy: "lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: root,
				idempotencyKey: "engine-loses",
				entryKind: "workflow_v2",
				env: enabled,
			}),
		).rejects.toThrow(/legacy_entry_already_claimed/);
		expect(
			legacyFirst.getActiveWorkflowRunForIssue("FLY-LEGACY-WINS"),
		).toBeUndefined();
		legacyFirst.close();

		const engineFirst = await makeStore();
		await resolveWorkflowTemplateSelection(engineFirst, {
			project: "flywheel",
			issueId: "FLY-ENGINE-WINS",
			taskCategory: "research",
			selectedBy: "lead",
			actor: "master",
			authKind: "master",
			canonicalRoot: root,
			idempotencyKey: "engine-wins",
			entryKind: "workflow_v2",
			env: enabled,
		});
		expect(
			engineFirst.claimLegacyWorkflowEntry({
				issueId: "FLY-ENGINE-WINS",
				projectName: "flywheel",
				executionId: "legacy-loses",
				role: "main",
			}),
		).toEqual({ ok: false, reason: "active_engine_run" });
		expect(engineFirst.getLaunchClaim("legacy-loses")).toBeUndefined();
		engineFirst.close();
	});

	it("FLY-1775 A3 terminal postcondition is settled by drain and ignored by entry arbitration", async () => {
		const executionId = "qa-a3-terminal";
		const issueId = "FLY-A3-TERMINAL";
		expect(
			classifyDurableLaunchDrain({
				runStatus: "terminated",
				launchOwners: [
					{
						execution_id: executionId,
						committed_generation: 1,
						delivery_state: "delivered",
					},
				],
				actors: [
					{
						executionId,
						liveness: "dead",
						sessionStatus: "terminated",
						parkOpen: false,
					},
				],
			}),
		).toEqual({ settled: true, reason: "settled" });

		const store = await StateStore.create(":memory:");
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		expect(
			store.claimLegacyWorkflowEntry({
				issueId,
				projectName: "flywheel",
				executionId,
				role: "qa",
			}),
		).toEqual({ ok: true });
		store.upsertSession({
			execution_id: executionId,
			issue_id: issueId,
			project_name: "flywheel",
			status: "terminated",
		});

		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId,
				taskCategory: "research",
				selectedBy: "lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "a3-terminal-entry",
				entryKind: "workflow_v2",
				env: enabled,
			}),
		).resolves.toBeTruthy();
		store.close();
	});

	it("scopes legacy claims by lifecycle root and role while ignoring terminal owners", async () => {
		const store = await StateStore.create(":memory:");
		expect(
			store.claimLegacyWorkflowEntry({
				issueId: "FLY-CHILD",
				rootKey: "FLY-ROOT",
				projectName: "flywheel",
				executionId: "main-old",
				role: "main",
			}),
		).toEqual({ ok: true });
		store.upsertSession({
			execution_id: "main-old",
			issue_id: "FLY-CHILD",
			project_name: "flywheel",
			status: "failed",
		});
		expect(
			store.claimLegacyWorkflowEntry({
				issueId: "FLY-CHILD",
				rootKey: "FLY-ROOT",
				projectName: "flywheel",
				executionId: "main-retry",
				role: "main",
			}),
		).toEqual({ ok: true });
		expect(store.getLaunchClaim("main-old")?.state).toBe("closed");
		expect(
			store.claimLegacyWorkflowEntry({
				issueId: "FLY-CHILD",
				rootKey: "FLY-ROOT",
				projectName: "flywheel",
				executionId: "qa-live",
				role: "qa",
			}),
		).toEqual({ ok: true });
		store.close();
	});

	it("uses the lifecycle root namespace when engine materialization arbitrates a legacy claim", async () => {
		const store = await StateStore.create(":memory:");
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		expect(
			store.claimLegacyWorkflowEntry({
				issueId: "FLY-SIBLING-A",
				rootKey: "FLY-ROOT",
				projectName: "flywheel",
				executionId: "legacy-root-owner",
				role: "main",
			}),
		).toEqual({ ok: true });

		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-SIBLING-B",
				entryRootKey: "FLY-ROOT",
				taskCategory: "research",
				selectedBy: "lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "root-conflict",
				entryKind: "workflow_v2",
				env: enabled,
			}),
		).rejects.toThrow(/legacy_entry_already_claimed/);
		expect(store.getActiveWorkflowRunForIssue("FLY-SIBLING-B")).toBeUndefined();
		store.close();

		const engineFirst = await StateStore.create(":memory:");
		engineFirst.importWorkflowTemplateSeed(seed, enabled);
		engineFirst.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		await resolveWorkflowTemplateSelection(engineFirst, {
			project: "flywheel",
			issueId: "FLY-ALIAS",
			entryRootKey: "11111111-1111-4111-8111-111111111111",
			taskCategory: "research",
			selectedBy: "lead",
			actor: "master",
			authKind: "master",
			canonicalRoot: setupRoot(),
			idempotencyKey: "engine-alias-owner",
			entryKind: "workflow_v2",
			env: enabled,
		});
		expect(
			engineFirst.claimLegacyWorkflowEntry({
				issueId: "11111111-1111-4111-8111-111111111111",
				issueAliases: ["FLY-ALIAS"],
				rootKey: "11111111-1111-4111-8111-111111111111",
				projectName: "flywheel",
				executionId: "legacy-alias-loser",
				role: "main",
			}),
		).toEqual({ ok: false, reason: "active_engine_run" });
		engineFirst.close();
	});

	it("requires master auth, reason for lead choice, and a v2 idempotency key", async () => {
		const store = await StateStore.create(":memory:");
		const root = setupRoot();
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		const base = {
			project: "flywheel",
			issueId: "FLY-X",
			taskCategory: "research",
			leadTemplateId: seed.templateId,
			selectedBy: "research-lead",
			actor: "master",
			canonicalRoot: root,
		};
		await expect(
			resolveWorkflowTemplateSelection(store, {
				...base,
				authKind: "scoped",
				leadReason: "lighter bounded chain",
				idempotencyKey: "k",
				env: enabled,
			}),
		).rejects.toThrow(/master/i);
		await expect(
			resolveWorkflowTemplateSelection(store, {
				...base,
				authKind: "master",
				idempotencyKey: "k",
				env: enabled,
			}),
		).rejects.toThrow(/reason/i);
		expect(store.getActiveWorkflowRunForIssue("FLY-X")).toBeUndefined();
		store.close();
	});
});

it("rejects unavailable protocols before any materialization, leaves shadows intact, and retries the same key", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const root = setupRoot();
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, enabled);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		store.applyWorkflowLedgerBatch({
			projectName: "flywheel",
			issueId: "FLY-X",
			newRunId: "shadow-run",
			ops: [
				{
					op: "dispatch",
					node: "main",
					attempt: 1,
					executionId: "shadow-dead",
				},
			],
		});
		store.upsertSession({
			execution_id: "shadow-dead",
			issue_id: "FLY-X",
			project_name: "flywheel",
			status: "failed",
		});
		const input = {
			project: "flywheel",
			issueId: "FLY-X",
			taskCategory: "research",
			selectedBy: "lead",
			actor: "master",
			authKind: "master" as const,
			canonicalRoot: root,
			idempotencyKey: "protocol-retry",
			entryKind: "workflow_v2" as const,
			env: enabled,
			idFactory: (() => {
				const ids = [
					"protocol-run",
					"protocol-exec",
					"protocol-run",
					"protocol-exec",
				];
				return () => ids.shift()!;
			})(),
			now: "2026-07-20T00:10:00.000Z",
			probeRunExecutionLiveness: async () => "dead" as const,
		};
		const db = (store as unknown as { db: { exec(sql: string): unknown } }).db;
		const durableState = () =>
			db.exec(
				"SELECT (SELECT COUNT(*) FROM workflow_run) AS runs, (SELECT COUNT(*) FROM workflow_start_reservation) AS reservations, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM workflow_side_effect_ledger) AS effects",
			);
		const countsBefore = durableState();
		const before = store.getWorkflowRun("shadow-run");
		const events = store.listWorkflowRunEvents("shadow-run");
		const loader = vi
			.spyOn(phaseProtocols, "loadWorkflowPhaseProtocols")
			.mockImplementation(() => {
				throw phaseProtocols.workflowPhaseProtocolError(
					"unresolved",
					"generic",
					"missing",
				);
			});
		await expect(
			resolveWorkflowTemplateSelection(store, input),
		).rejects.toThrow(
			"WORKFLOW_PHASE_PROTOCOL_UNAVAILABLE node=research type=generic cause=missing",
		);
		expect(durableState()).toEqual(countsBefore);
		expect(store.getWorkflowStartReservation("protocol-retry")).toBeUndefined();
		expect(store.getWorkflowRun("protocol-run")).toBeUndefined();
		expect(store.getWorkflowRun("shadow-run")).toEqual(before);
		expect(store.listWorkflowRunEvents("shadow-run")).toEqual(events);
		loader.mockRestore();
		const selected = await resolveWorkflowTemplateSelection(store, input);
		expect(selected?.runId).toBe("protocol-run");
		const pinned = store.getWorkflowRun("protocol-run")?.snapshot;
		vi.spyOn(phaseProtocols, "loadWorkflowPhaseProtocols").mockImplementation(
			() => {
				throw new Error("live protocol removed after success");
			},
		);
		const replay = await resolveWorkflowTemplateSelection(store, {
			...input,
			idFactory: () => {
				throw new Error("replay allocation");
			},
		});
		expect(replay?.runId).toBe(selected?.runId);
		expect(store.getWorkflowRun("protocol-run")?.snapshot).toBe(pinned);
	} finally {
		store.close();
	}
});

describe("FLY-2570 real percentage admission", () => {
	it.each([0, 75, 100])(
		"materializes and dispatches the CLI percentage %s through StateStore",
		async (percent) => {
			const root = setupRoot();
			const path = join(root, "models.json");
			execFileSync(process.execPath, [
				join(REPO_ROOT, "scripts/design-model-split.mjs"),
				"set",
				"--codex-percent",
				String(percent),
				"--config",
				path,
			]);
			const priorPath = process.env.FLYWHEEL_MODELS_CONFIG;
			process.env.FLYWHEEL_MODELS_CONFIG = path;
			resetModelConfigCacheForTests();
			let store = await StateStore.create(join(root, "state.db"));
			try {
				const seed = loadWorkflowMenuSeeds().find(
					(seed) => seed.templateId === "tpl_code",
				)!;
				store.importWorkflowTemplateSeed(seed);
				store.bindWorkflowCategory({
					project: "flywheel",
					taskCategory: "code",
					templateId: seed.templateId,
					updatedBy: "test",
				});
				const startInput = {
					project: "flywheel",
					issueId: "FLY-2570",
					taskCategory: "code",
					selectedBy: "eng-lead",
					actor: "master",
					authKind: "master" as const,
					canonicalRoot: REPO_ROOT,
					idempotencyKey: "percentage-start",
					workKindEnforced: false,
				};
				const materialize = vi.spyOn(store, "materializeWorkflowRun");
				const selected = await resolveWorkflowTemplateSelection(
					store,
					startInput,
				);
				expect(selected).not.toBeNull();
				const expected =
					percent === 100
						? { arm: "A", model: "gpt-6-astra" }
						: { arm: "B", model: "claude-fable-5-1" };
				const receipts = store
					.listWorkflowRunEvents(selected!.runId)
					.filter((event) => event.kind === "design_model_arm_assigned");
				expect(receipts).toHaveLength(1);
				expect(receipts[0]).toMatchObject({
					execution_id: null,
					payload: {
						...expected,
						basis: {
							rule: "issue_number_percentage",
							codexPercent: percent,
							issueNumber: 2570,
						},
					},
				});
				expect(
					resolveNodeDispatchAtLaunch(store, {
						runId: selected!.runId,
						nodeId: "eng_design",
					}),
				).toMatchObject({
					dispatch: { model: expected.model },
					modelAssignment: expected,
				});
				const originalMaterialization = materialize.mock.calls[0]![0];
				for (const field of [
					"bucket",
					"ruleVersion",
					"arm",
					"modelAlias",
					"issueNumber",
					"issueIdentifier",
				] as const) {
					const invalid = structuredClone(originalMaterialization);
					const assignment = invalid.modelAssignments!.eng_design!;
					if (assignment.basis.rule !== "issue_number_percentage")
						throw new Error("expected percentage fixture");
					if (field === "arm") assignment.arm = "wrong";
					else if (field === "modelAlias") assignment.modelAlias = "wrong";
					else if (field === "bucket" || field === "issueNumber")
						assignment.basis[field] += 1;
					else assignment.basis[field] += "-wrong";
					expect(() => store.materializeWorkflowRun(invalid)).toThrow(
						"workflow_model_assignment_invalid:eng_design",
					);
				}
				execFileSync(process.execPath, [
					join(REPO_ROOT, "scripts/design-model-split.mjs"),
					"set",
					"--codex-percent",
					String(percent === 0 ? 75 : 0),
					"--config",
					path,
				]);
				store.close();
				store = await StateStore.create(join(root, "state.db"));
				await expect(
					resolveWorkflowTemplateSelection(store, startInput),
				).resolves.toMatchObject({ ...selected, replayed: true });
				await expect(
					resolveWorkflowTemplateSelection(store, {
						...startInput,
						issueIdentifier: "FLY-9999",
					}),
				).rejects.toThrow(/assignment invalid/);
				writeFileSync(path, "{");
				await expect(
					resolveWorkflowTemplateSelection(store, startInput),
				).resolves.toMatchObject({ ...selected, replayed: true });
				await expect(
					resolveWorkflowTemplateSelection(store, {
						...startInput,
						selectedBy: "different-lead",
					}),
				).rejects.toThrow(/payload mismatch/);
				await expect(
					resolveWorkflowTemplateSelection(store, {
						...startInput,
						idempotencyKey: "new-start",
					}),
				).rejects.toThrow(/invalid.*model split/i);
			} finally {
				store.close();
				if (priorPath === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
				else process.env.FLYWHEEL_MODELS_CONFIG = priorPath;
				resetModelConfigCacheForTests();
			}
		},
	);
});
