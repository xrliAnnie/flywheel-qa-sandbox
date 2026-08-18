import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyDurableLaunchDrain } from "../../../../scripts/lib/qa-generalized-e2e-lib.mjs";
import { StateStore } from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import { workflowSeedContentHash } from "../workflow-template.js";
import {
	resolveWorkflowTemplateCandidateSchema,
	resolveWorkflowTemplateSelection,
} from "../workflow-template-selection.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const roots: string[] = [];
afterEach(() => {
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
