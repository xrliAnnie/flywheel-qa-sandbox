import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { resolveNodeDispatchAtLaunch } from "../workflow-dispatch-resolution.js";
import {
	loadBundledWorkflowSeeds,
	workflowSeedContentHash,
} from "../workflow-template.js";

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
	const seed = loadBundledWorkflowSeeds().find(
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
	it("uses the current phase dispatch config for schema v1", async () => {
		const store = await v1Run();
		expect(
			resolveNodeDispatchAtLaunch(store, {
				runId: "run-v1",
				nodeId: "design",
				env: {
					...WORKFLOW_ON,
					FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1",
				},
			}),
		).toEqual({
			dispatch: {
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
			},
			source: "current_config",
			audit: true,
		});
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

	it("pins the snapshot behind the escape switch and allows only design Fable to GPT-5.6 fallback", async () => {
		const store = await v1Run();
		expect(
			resolveNodeDispatchAtLaunch(store, {
				runId: "run-v1",
				nodeId: "design",
				env: { ...WORKFLOW_ON, FLYWHEEL_VENDOR_AT_DISPATCH: "0" },
			}),
		).toEqual({
			dispatch: { vendor: "claude", model: "claude-fable-5" },
			source: "snapshot_fallback",
			audit: false,
		});
		expect(
			resolveNodeDispatchAtLaunch(store, {
				runId: "run-v1",
				nodeId: "design",
				approvedDesignFallback: true,
			}),
		).toEqual({
			dispatch: {
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
			},
			source: "approved_design_fallback",
			audit: true,
		});
		expect(() =>
			resolveNodeDispatchAtLaunch(store, {
				runId: "run-v1",
				nodeId: "implement",
				approvedDesignFallback: true,
			}),
		).toThrow("workflow_dispatch_fallback_not_allowlisted");
	});
});
