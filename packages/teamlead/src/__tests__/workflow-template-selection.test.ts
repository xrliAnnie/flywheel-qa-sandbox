import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import {
	loadBundledWorkflowSeeds,
	workflowSeedContentHash,
} from "../workflow-template.js";
import { resolveWorkflowTemplateSelection } from "../workflow-template-selection.js";

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

const enabled = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
};

describe("workflow template selection", () => {
	it("returns null for no candidate and for schema-v1 candidates without side effects", async () => {
		const store = await StateStore.create(":memory:");
		const root = setupRoot();
		expect(
			resolveWorkflowTemplateSelection(store, {
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
		const v1 = loadBundledWorkflowSeeds()[0]!;
		store.importWorkflowTemplateSeed(v1);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "research",
			templateId: v1.templateId,
			updatedBy: "lead",
		});
		expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-X",
				taskCategory: "research",
				selectedBy: "lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: root,
				env: enabled,
			}),
		).toBeNull();
		expect(store.getActiveWorkflowRunForIssue("FLY-X")).toBeUndefined();
		store.close();
	});

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
			env: enabled,
			idFactory: (() => {
				const values = ["run-1", "exec-1"];
				return () => values.shift()!;
			})(),
			now: "2026-07-15T00:00:00.000Z",
		};
		const selected = resolveWorkflowTemplateSelection(store, input);
		expect(selected).toMatchObject({
			runId: "run-1",
			executionId: "exec-1",
			nodeId: "research",
			selectionSource: "binding",
		});
		expect(store.getWorkflowRun("run-1")).toMatchObject({
			selection_source: "binding",
			selected_by: "research-lead",
		});
		expect(store.getWorkflowStartReservation("start-key-1")?.stage).toBe(
			"materialized",
		);
		const replay = resolveWorkflowTemplateSelection(store, {
			...input,
			idFactory: () => {
				throw new Error("must not allocate on replay");
			},
		});
		expect(replay).toMatchObject({ runId: "run-1", executionId: "exec-1" });
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
		const selected = resolveWorkflowTemplateSelection(store, {
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

	it("requires master auth, reason for lead choice, flags, and a v2 idempotency key", async () => {
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
		expect(() =>
			resolveWorkflowTemplateSelection(store, {
				...base,
				authKind: "scoped",
				leadReason: "lighter bounded chain",
				idempotencyKey: "k",
				env: enabled,
			}),
		).toThrow(/master/i);
		expect(() =>
			resolveWorkflowTemplateSelection(store, {
				...base,
				authKind: "master",
				idempotencyKey: "k",
				env: enabled,
			}),
		).toThrow(/reason/i);
		expect(() =>
			resolveWorkflowTemplateSelection(store, {
				...base,
				authKind: "master",
				leadReason: "lighter bounded chain",
				idempotencyKey: "k",
				env: {},
			}),
		).toThrow(/disabled|flag/i);
		expect(store.getActiveWorkflowRunForIssue("FLY-X")).toBeUndefined();
		store.close();
	});
});
