import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import {
	importBundledWorkflowSeeds,
	loadBundledWorkflowSeeds,
	workflowSeedContentHash,
} from "../workflow-template.js";
import {
	resolveWorkflowTemplateCandidateSchema,
	resolveWorkflowTemplateSelection,
} from "../workflow-template-selection.js";

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
							model: "claude-opus-4-8",
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
	it("returns null for no candidate and for schema-v1 candidates while dispatch is off", async () => {
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
		const v1 = loadBundledWorkflowSeeds()[0]!;
		store.importWorkflowTemplateSeed(v1);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: v1.templateId,
			updatedBy: "lead",
		});
		expect(
			resolveWorkflowTemplateCandidateSchema(store, {
				project: "flywheel",
				taskCategory: "research",
			}),
		).toBe(1);
		expect(
			await resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-X",
				taskCategory: "research",
				selectedBy: "lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: root,
				env: {
					...enabled,
					FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "0",
				},
			}),
		).toBeNull();
		expect(store.getActiveWorkflowRunForIssue("FLY-X")).toBeUndefined();
		store.close();
	});

	it("keeps an enabled v1 candidate on the incumbent path without entry authority or a stable key", async () => {
		const store = await StateStore.create(":memory:");
		const seed = loadBundledWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		store.importWorkflowTemplateSeed(seed);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "*",
			templateId: seed.templateId,
			updatedBy: "system:bundled-default",
		});
		const root = setupRoot();

		expect(
			await resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-V1-POLICY-OFF",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: root,
				idempotencyKey: "policy-off-key",
				allowSchemaV1Dispatch: false,
				env: enabled,
			}),
		).toBeNull();
		expect(
			await resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-V1-NO-KEY",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: root,
				allowSchemaV1Dispatch: true,
				env: enabled,
			}),
		).toBeNull();
		expect(
			store.getActiveWorkflowRunForIssue("FLY-V1-POLICY-OFF"),
		).toBeUndefined();
		expect(store.getActiveWorkflowRunForIssue("FLY-V1-NO-KEY")).toBeUndefined();
		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-V1-DRIFT",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: root,
				idempotencyKey: "drift-key",
				allowSchemaV1Dispatch: true,
				candidateSchemaAtEntry: 2,
				env: enabled,
			}),
		).rejects.toThrow(/candidate changed/i);
		store.close();
	});

	it("keeps wildcard v1 selection unchanged with dormant bundled v2 seeds installed and generalized routing off", async () => {
		const store = await StateStore.create(":memory:");
		const off = {
			...enabled,
			FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "0",
		};
		importBundledWorkflowSeeds(store, off);
		expect(
			store.getWorkflowTemplate("tpl_generic")?.current_published_revision,
		).toBe(1);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "*",
			templateId: "tpl_eng_heavy",
			updatedBy: "system:bundled-default",
		});
		const ids = ["wildcard-v1-run", "wildcard-v1-exec"];
		expect(
			await resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-WILDCARD-V1-OFF",
				taskCategory: "engineering",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "wildcard-v1-off",
				allowSchemaV1Dispatch: true,
				env: off,
				idFactory: () => ids.shift()!,
			}),
		).toMatchObject({
			runId: "wildcard-v1-run",
			executionId: "wildcard-v1-exec",
			selectionSource: "default",
			nodeId: "design",
		});
		store.close();
	});

	it("rejects an explicitly requested v1 dispatch when either claims flag is missing", async () => {
		const root = setupRoot();
		for (const missing of [
			"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
			"FLYWHEEL_WORKFLOW_CLAIMS_READ",
		] as const) {
			const store = await StateStore.create(":memory:");
			const v1 = loadBundledWorkflowSeeds().find(
				(seed) => seed.manifest.schema_version === 1,
			)!;
			store.importWorkflowTemplateSeed(v1);
			store.bindWorkflowCategory({
				project: "flywheel",
				taskCategory: "engineering",
				templateId: v1.templateId,
				updatedBy: "lead",
			});
			const env = { ...enabled };
			delete env[missing];
			await expect(
				resolveWorkflowTemplateSelection(store, {
					project: "flywheel",
					issueId: `FLY-V1-${missing}`,
					taskCategory: "engineering",
					selectedBy: "eng-lead",
					actor: "master",
					authKind: "master",
					canonicalRoot: root,
					idempotencyKey: `v1-${missing}`,
					allowSchemaV1Dispatch: true,
					env,
				}),
			).rejects.toThrow(
				new RegExp(
					missing.includes("WRITE") ? "claims write" : "claims read",
					"i",
				),
			);
			expect(
				store.getActiveWorkflowRunForIssue(`FLY-V1-${missing}`),
			).toBeUndefined();
			expect(store.countWorkflowClaims(`FLY-V1-${missing}`)).toBe(0);
			expect(store.listWorkflowSideEffects(`FLY-V1-${missing}`)).toEqual([]);
			store.close();
		}
	});

	it("materializes an enabled engineering v1 candidate as an enrolled typed engine run", async () => {
		const store = await StateStore.create(":memory:");
		const seed = loadBundledWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		store.importWorkflowTemplateSeed(seed);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "engineering",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		const values = ["run-v1", "exec-design"];
		const selected = await resolveWorkflowTemplateSelection(store, {
			project: "flywheel",
			issueId: "FLY-V1-ON",
			taskCategory: "engineering",
			selectedBy: "eng-lead",
			actor: "master",
			authKind: "master",
			canonicalRoot: setupRoot(),
			idempotencyKey: "v1-enabled",
			allowSchemaV1Dispatch: true,
			env: enabled,
			idFactory: () => values.shift()!,
			now: "2026-07-16T00:00:00.000Z",
		});
		expect(selected).toMatchObject({
			runId: "run-v1",
			executionId: "exec-design",
			nodeId: "design",
			node: {
				type: "design",
				dispatch: { vendor: "claude", model: "claude-fable-5" },
			},
		});
		const run = store.getWorkflowRun("run-v1")!;
		expect(run).toMatchObject({ engine_owned: 1, claims_read_enrolled: 1 });
		expect(parseWorkflowRunSnapshot(run.snapshot!).schema_version).toBe(1);
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-v1",
				nodeId: "design",
				executionId: "exec-design",
				attempt: 1,
				now: "2026-07-16T00:00:01.000Z",
				expiresAt: "2026-07-16T01:00:00.000Z",
				absoluteDeadlineAt: "2026-07-17T00:00:00.000Z",
				env: enabled,
				idempotencyKey: "v1-enabled",
			}),
		).toMatchObject({ ok: true });
		store.close();
	});

	it("falls back from an unbound engineering category to the project default binding", async () => {
		const store = await StateStore.create(":memory:");
		const seed = loadBundledWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		store.importWorkflowTemplateSeed(seed);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "*",
			templateId: seed.templateId,
			updatedBy: "system:bundled-default",
		});
		const values = ["run-default", "exec-default"];
		expect(
			await resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-V1-DEFAULT",
				taskCategory: "engineering",
				selectedBy: "eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: setupRoot(),
				idempotencyKey: "v1-default",
				allowSchemaV1Dispatch: true,
				env: enabled,
				idFactory: () => values.shift()!,
				now: "2026-07-16T00:00:00.000Z",
			}),
		).toMatchObject({
			runId: "run-default",
			executionId: "exec-default",
			selectionSource: "default",
		});
		store.close();
	});

	it.each([
		["FLYWHEEL_WORKFLOW_CLAIMS_WRITE", /claims write/i],
		["FLYWHEEL_WORKFLOW_CLAIMS_READ", /claims read/i],
		["FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES", /generalized.*disabled/i],
	] as const)(
		"fails closed for a v2 candidate when %s is missing",
		async (missing, expected) => {
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
			const env = { ...enabled };
			delete env[missing];
			await expect(
				resolveWorkflowTemplateSelection(store, {
					project: "flywheel",
					issueId: `FLY-V2-${missing}`,
					taskCategory: "research",
					selectedBy: "research-lead",
					actor: "master",
					authKind: "master",
					canonicalRoot: root,
					idempotencyKey: `v2-${missing}`,
					env,
				}),
			).rejects.toThrow(expected);
			expect(
				store.getActiveWorkflowRunForIssue(`FLY-V2-${missing}`),
			).toBeUndefined();
			expect(
				store.getWorkflowStartReservation(`v2-${missing}`),
			).toBeUndefined();
			expect(store.countWorkflowClaims(`FLY-V2-${missing}`)).toBe(0);
			expect(store.listWorkflowSideEffects(`FLY-V2-${missing}`)).toEqual([]);
			store.close();
		},
	);

	it("returns null for a v2 candidate when the primary dispatch flag is off", async () => {
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
			await resolveWorkflowTemplateSelection(store, {
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
			}),
		).toBeNull();
		expect(
			store.getActiveWorkflowRunForIssue("FLY-V2-DISPATCH-OFF"),
		).toBeUndefined();
		store.close();
	});

	it.each([
		["binding", true],
		["direct", true],
		["binding", false],
		["direct", false],
	] as const)(
		"keeps installed v2 %s selection dormant=%s until the generalized flag is enabled",
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
			if (flagOn) {
				await expect(resolve()).resolves.toMatchObject({
					selectionSource: selection === "binding" ? "binding" : "lead",
					nodeId: "research",
				});
			} else {
				await expect(resolve()).rejects.toThrow(/generalized.*disabled/i);
				expect(
					store.getActiveWorkflowRunForIssue(
						`FLY-V2-${selection}-${flagOn ? "ON" : "OFF"}`,
					),
				).toBeUndefined();
			}
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
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
		const values = ["tier-run", "tier-exec"];
		const selected = await resolveWorkflowTemplateSelection(store, {
			project: "flywheel",
			issueId: "FLY-TIER",
			taskCategory: "research",
			selectedBy: "research-lead",
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
			model: "claude-opus-4-8",
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

	it("atomically supersedes a quiescent legacy shadow run when starting the engine", async () => {
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
		store.applyWorkflowShadowBatch({
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
		it(`refuses to supersede a shadow run whose execution probes ${probe}`, async () => {
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
			store.applyWorkflowShadowBatch({
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
