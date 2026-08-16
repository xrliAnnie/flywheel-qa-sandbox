import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function v2Run() {
	const root = mkdtempSync(join(tmpdir(), "fly1385-dispatch-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Do the work.\n");
	const store = await StateStore.create(":memory:");
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

	it("uses the current published v2 node and falls back to the snapshot on lookup drift", async () => {
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

	it("pins the snapshot behind the escape switch without a cause-driven fallback", async () => {
		await v1Run();
	});
});
