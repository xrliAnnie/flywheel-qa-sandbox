import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
	canonicalSubmissionDigest,
	resetModelConfigCacheForTests,
} from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { resolveNodeDispatchAtLaunch } from "../workflow-dispatch-resolution.js";
import { workflowSeedContentHash } from "../workflow-template.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function v1Run() {
	const store = await StateStore.create(":memory:");
	cleanups.push(() => store.close());
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	)!;
	store.importWorkflowTemplateSeed(seed, WORKFLOW_ON);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "engineering",
		templateId: seed.templateId,
		updatedBy: "test",
	});
	store.materializeWorkflowRun({
		runId: "run-v1",
		issueId: "FLY-V1",
		projectName: "flywheel",
		taskCategory: "engineering",
		claimsReadEnrolled: true,
		actor: "test",
		entryKind: "pipeline_dag_v1",
		startReservation: {
			idempotencyKey: "start-v1",
			selectionDigest: "selection-v1",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-07-20T00:00:00.000Z",
		},
		env: WORKFLOW_ON,
	});
	return store;
}

function v2Seed() {
	const seed = {
		templateId: "tpl_dispatch_live_v2",
		name: "Dispatch live v2",
		projectScope: "global",
		manifest: {
			schema_version: 2 as const,
			nodes: [
				{
					id: "work",
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
					from: "work",
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

async function v2Run(options: { legacyMutable?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "fly1385-dispatch-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Do the work.\n");
	const dbPath = join(root, "state.db");
	const store = await StateStore.create(dbPath);
	cleanups.push(() => store.close());
	const seed = v2Seed();
	store.importWorkflowTemplateSeed(seed, WORKFLOW_ON);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "research",
		templateId: seed.templateId,
		updatedBy: "test",
	});
	store.materializeWorkflowRun({
		runId: "run-v2",
		issueId: "FLY-V2",
		projectName: "flywheel",
		taskCategory: "research",
		claimsReadEnrolled: true,
		actor: "test",
		canonicalRoot: root,
		entryKind: "workflow_v2",
		startReservation: {
			idempotencyKey: "start-v2",
			selectionDigest: "selection-v2",
			nodeId: "work",
			attempt: 1,
			executionId: "work-1",
			createdAt: "2026-07-20T00:00:00.000Z",
		},
		env: WORKFLOW_ON,
	});
	if (options.legacyMutable !== false) {
		// Historical v2 snapshots predate dispatchPinned. Rebuild that exact
		// fixture shape so compatibility tests keep exercising live-template
		// resolution and its cause-driven snapshot fallback.
		const snapshot = JSON.parse(store.getWorkflowRun("run-v2")!.snapshot!) as {
			resolved: { nodes: Array<Record<string, unknown>> };
			snapshot_digest: string;
		};
		for (const node of snapshot.resolved.nodes) delete node.dispatchPinned;
		const { snapshot_digest: _digest, ...body } = snapshot;
		snapshot.snapshot_digest = canonicalSubmissionDigest(body);
		const raw = new BetterSqlite3(dbPath);
		raw
			.prepare("UPDATE workflow_run SET snapshot = ? WHERE run_id = ?")
			.run(JSON.stringify(snapshot), "run-v2");
		raw.close();
	}
	return { store, seed };
}

describe("workflow dispatch resolution at launch", () => {
	// FLY-1650 (Codex R2 HIGH): admission writes the IMMUTABLE row the audit
	// trail reports. Narrowing an unsupported effort only at the launch seam
	// would leave that row claiming an effort the run never used. Opus 4.6 has
	// no `xhigh` (it arrived with 4.7), so the pair must be settled here.
	it("drops an effort the resolved model does not support before admission records it", async () => {
		const { store, seed } = await v2Run();
		const liveManifest = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "work"
					? {
							...node,
							vendor: "claude" as const,
							model: "claude-opus-4-6[1m]",
							effort: "xhigh" as const,
						}
					: node,
			),
		};
		expect(
			store.createAndPublishWorkflowTemplateRevision({
				templateId: seed.templateId,
				manifest: liveManifest,
				expectedRevision: 1,
				createdBy: "test",
			}),
		).toMatchObject({ status: "published", revision: 2 });

		const resolved = resolveNodeDispatchAtLaunch(store, {
			runId: "run-v2",
			nodeId: "work",
			env: WORKFLOW_ON,
		});
		expect(resolved.dispatch).toEqual({
			vendor: "claude",
			model: "claude-opus-4-6[1m]",
		});
		expect(resolved.dispatch).not.toHaveProperty("effort");
	});

	it("keeps an effort the resolved model does support", async () => {
		const { store, seed } = await v2Run();
		const liveManifest = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "work"
					? {
							...node,
							vendor: "claude" as const,
							model: "claude-opus-4-6[1m]",
							effort: "high" as const,
						}
					: node,
			),
		};
		store.createAndPublishWorkflowTemplateRevision({
			templateId: seed.templateId,
			manifest: liveManifest,
			expectedRevision: 1,
			createdBy: "test",
		});

		expect(
			resolveNodeDispatchAtLaunch(store, {
				runId: "run-v2",
				nodeId: "work",
				env: WORKFLOW_ON,
			}).dispatch,
		).toEqual({
			vendor: "claude",
			model: "claude-opus-4-6[1m]",
			effort: "high",
		});
	});

	// FLY-1650 (Codex R3 LOW): the assertions above stop at the resolver's
	// return value. What actually has to be truthful is the row admission
	// PERSISTS — `dispatch_vendor_resolved` is the immutable audit record, and
	// a narrowing that never reached it would leave the ledger claiming an
	// effort the run did not use. Read it back.
	it("persists the narrowed dispatch into the immutable audit event", async () => {
		const { store, seed } = await v2Run();
		const liveManifest = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "work"
					? {
							...node,
							vendor: "claude" as const,
							model: "claude-opus-4-6[1m]",
							effort: "xhigh" as const,
						}
					: node,
			),
		};
		store.createAndPublishWorkflowTemplateRevision({
			templateId: seed.templateId,
			manifest: liveManifest,
			expectedRevision: 1,
			createdBy: "test",
		});

		const dispatchResolution = resolveNodeDispatchAtLaunch(store, {
			runId: "run-v2",
			nodeId: "work",
			env: WORKFLOW_ON,
		});
		expect(dispatchResolution.audit).toBe(true);

		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-v2",
			nodeId: "work",
			executionId: "work-1",
			attempt: 1,
			now: "2026-07-20T00:05:00.000Z",
			expiresAt: "2026-07-20T06:05:00.000Z",
			absoluteDeadlineAt: "2026-07-21T00:05:00.000Z",
			env: WORKFLOW_ON,
			dispatchResolution,
		});
		expect(admitted.ok).toBe(true);

		const audit = store
			.listWorkflowRunEvents("run-v2")
			.filter((event) => event.kind === "dispatch_vendor_resolved");
		expect(audit).toHaveLength(1);
		const payload = audit[0]!.payload as unknown as {
			dispatch: { vendor: string; model: string; effort?: string };
		};
		expect(payload.dispatch).toEqual({
			vendor: "claude",
			model: "claude-opus-4-6[1m]",
		});
		expect(payload.dispatch).not.toHaveProperty("effort");
	});

	it("keeps an old v2 snapshot without the pin bit on live-template resolution and cause-driven fallback", async () => {
		const { store, seed } = await v2Run();
		const liveManifest = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "work" ? { ...node, effort: "xhigh" as const } : node,
			),
		};
		expect(
			store.createAndPublishWorkflowTemplateRevision({
				templateId: seed.templateId,
				manifest: liveManifest,
				expectedRevision: 1,
				createdBy: "test",
			}),
		).toMatchObject({ status: "published", revision: 2 });
		expect(
			resolveNodeDispatchAtLaunch(store, {
				runId: "run-v2",
				nodeId: "work",
				env: WORKFLOW_ON,
			}),
		).toMatchObject({
			dispatch: { vendor: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
			source: "live_template",
			audit: true,
		});

		const missingNodeManifest = {
			...seed.manifest,
			nodes: [
				{
					...seed.manifest.nodes[0],
					id: "replacement",
				},
				seed.manifest.nodes[1],
			],
			edges: [
				{
					...seed.manifest.edges[0],
					from: "replacement",
				},
			],
		};
		expect(
			store.createAndPublishWorkflowTemplateRevision({
				templateId: seed.templateId,
				manifest: missingNodeManifest,
				expectedRevision: 2,
				createdBy: "test",
			}),
		).toMatchObject({ status: "published", revision: 3 });
		expect(
			resolveNodeDispatchAtLaunch(store, {
				runId: "run-v2",
				nodeId: "work",
				env: WORKFLOW_ON,
			}),
		).toEqual({
			dispatch: { vendor: "codex", model: "gpt-5.6-sol", effort: "low" },
			source: "snapshot_fallback",
			audit: true,
		});
	});

	it("pins a newly materialized v2 dispatch instead of following a later template publication", async () => {
		const { store, seed } = await v2Run({ legacyMutable: false });
		const changed = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "work" ? { ...node, effort: "xhigh" as const } : node,
			),
		};
		expect(
			store.createAndPublishWorkflowTemplateRevision({
				templateId: seed.templateId,
				manifest: changed,
				expectedRevision: 1,
				createdBy: "test",
			}),
		).toMatchObject({ status: "published", revision: 2 });

		const dispatchResolution = resolveNodeDispatchAtLaunch(store, {
			runId: "run-v2",
			nodeId: "work",
		});
		expect(dispatchResolution).toEqual({
			dispatch: { vendor: "codex", model: "gpt-5.6-sol", effort: "low" },
			source: "pinned_snapshot",
			audit: true,
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-v2",
				nodeId: "work",
				executionId: "work-1",
				attempt: 1,
				now: "2026-07-20T00:05:00.000Z",
				expiresAt: "2026-07-20T06:05:00.000Z",
				absoluteDeadlineAt: "2026-07-21T00:05:00.000Z",
				dispatchResolution,
			}).ok,
		).toBe(true);
		expect(
			store
				.listWorkflowRunEvents("run-v2")
				.find((event) => event.kind === "dispatch_vendor_resolved")?.payload,
		).toMatchObject({ source: "pinned_snapshot" });
	});

	it("canonicalizes a Fable alias once per run while an older run stays on its pinned authority", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2238-fable-run-authority-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, "agents"));
		writeFileSync(join(root, "agents", "generic.md"), "Do the work.\n");
		const modelsPath = join(root, "models.json");
		const previousModelsPath = process.env.FLYWHEEL_MODELS_CONFIG;
		process.env.FLYWHEEL_MODELS_CONFIG = modelsPath;
		writeFileSync(modelsPath, JSON.stringify({ version: 1 }));
		resetModelConfigCacheForTests();
		const store = await StateStore.create(":memory:");
		cleanups.push(() => store.close());
		try {
			const base = v2Seed();
			const canonicalSeed = {
				...base,
				manifest: {
					...base.manifest,
					nodes: base.manifest.nodes.map((node) =>
						node.id === "work"
							? {
									...node,
									vendor: "claude" as const,
									model: "claude-fable-5-1",
									effort: "high" as const,
								}
							: node,
					),
				},
			};
			canonicalSeed.contentHash = workflowSeedContentHash(canonicalSeed);
			store.importWorkflowTemplateSeed(canonicalSeed, WORKFLOW_ON);
			const aliasManifest = {
				...canonicalSeed.manifest,
				nodes: canonicalSeed.manifest.nodes.map((node) =>
					node.id === "work" ? { ...node, model: "fable" } : node,
				),
			};
			expect(
				store.createAndPublishWorkflowTemplateRevision({
					templateId: canonicalSeed.templateId,
					manifest: aliasManifest,
					expectedRevision: 1,
					createdBy: "founder",
					allowUnsupportedModels: true,
				}),
			).toEqual({ status: "published", revision: 2 });

			const materialize = (runId: string) =>
				store.materializeWorkflowRun({
					runId,
					issueId: `FLY-${runId}`,
					projectName: "flywheel",
					templateId: canonicalSeed.templateId,
					claimsReadEnrolled: true,
					actor: "test",
					canonicalRoot: root,
					entryKind: "workflow_v2",
				});

			const runA = materialize("run-a");
			const snapshotA = JSON.parse(runA.snapshot!);
			expect(snapshotA.manifest.nodes[0].model).toBe("claude-fable-5-1");
			expect(snapshotA.resolved.nodes[0]).toMatchObject({
				dispatchPinned: true,
				dispatch: { model: "claude-fable-5-1" },
			});

			writeFileSync(
				modelsPath,
				JSON.stringify({
					version: 1,
					models: [
						{
							id: "claude-fable-5-2",
							provider: "anthropic",
							runtimeVendor: "claude",
							label: "Fable 5.2",
							aliases: ["fable-5-2"],
							dispatch: true,
						},
						{
							id: "claude-fable-5-2[1m]",
							provider: "anthropic",
							runtimeVendor: "claude",
							label: "Fable 5.2 (1M)",
							aliases: ["fable-5-2-1m"],
							dispatch: true,
							contextWindowTokens: 1_000_000,
						},
					],
					bindings: { fable: "claude-fable-5-2" },
					tiers: { heavy: "fable" },
				}),
			);
			resetModelConfigCacheForTests();

			expect(
				resolveNodeDispatchAtLaunch(store, {
					runId: "run-a",
					nodeId: "work",
				}),
			).toMatchObject({
				dispatch: { model: "claude-fable-5-1" },
				source: "pinned_snapshot",
			});
			const runB = materialize("run-b");
			const snapshotB = JSON.parse(runB.snapshot!);
			expect(snapshotB.manifest.nodes[0].model).toBe("claude-fable-5-2");
			expect(snapshotB.resolved.nodes[0]).toMatchObject({
				dispatchPinned: true,
				dispatch: { model: "claude-fable-5-2" },
			});
		} finally {
			if (previousModelsPath === undefined) {
				delete process.env.FLYWHEEL_MODELS_CONFIG;
			} else {
				process.env.FLYWHEEL_MODELS_CONFIG = previousModelsPath;
			}
			resetModelConfigCacheForTests();
		}
	});

	it("pins the snapshot behind the escape switch without a cause-driven fallback", async () => {
		await v1Run();
	});
});
