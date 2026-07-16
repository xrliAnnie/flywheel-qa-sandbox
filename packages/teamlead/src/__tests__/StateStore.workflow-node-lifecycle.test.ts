import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function snapshot(nodeId = "execute"): string {
	const root = mkdtempSync(join(tmpdir(), "flywheel-node-life-"));
	roots.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute.\n");
	return JSON.stringify(
		buildWorkflowRunSnapshotV2({
			template: { id: "test", revision: 1 },
			canonicalRoot: root,
			manifest: {
				schema_version: 2,
				nodes: [
					{
						id: nodeId,
						type: "generic",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "low",
						agent_file: "agents/generic.md",
					},
					{ id: "founder_gate", type: "gate" },
				],
				edges: [
					{
						id: "done",
						from: nodeId,
						to: "founder_gate",
						condition: "node_done",
					},
				],
				loops: [],
				terminal_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				ship_claims: ["founder_approved"],
			},
		}),
	);
}

function bind(store: StateStore, executionId: string, nodeId = "execute") {
	store.createWorkflowRun({
		runId: `run-${executionId}`,
		issueId: "FLY-X",
		projectName: "flywheel",
		snapshotJson: snapshot("execute"),
		claimsReadEnrolled: false,
	});
	const admitted = store.admitWorkflowExecution({
		runId: `run-${executionId}`,
		nodeId,
		executionId,
		attempt: 1,
		family: "review_verdict",
		now: "2026-07-15T00:00:00.000Z",
		expiresAt: "2026-07-15T00:05:00.000Z",
		absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
	});
	expect(admitted.ok).toBe(true);
}

describe("workflow node id lifecycle", () => {
	it("adds the nullable sessions column and persists it set-once across both write paths", async () => {
		const store = await StateStore.create(":memory:");
		expect(store.getSession("exec")).toBeUndefined();
		store.upsertSession({
			execution_id: "exec",
			issue_id: "FLY-X",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "execute",
		});
		expect(store.getSession("exec")?.workflow_node_id).toBe("execute");
		store.persistTransition("exec", "completed", {
			issue_id: "FLY-X",
			project_name: "flywheel",
			workflow_node_id: "execute",
		});
		expect(store.getSession("exec")?.workflow_node_id).toBe("execute");
		expect(() =>
			store.upsertSession({
				execution_id: "exec",
				issue_id: "FLY-X",
				project_name: "flywheel",
				status: "completed",
				workflow_node_id: "other",
			}),
		).toThrow(/workflow_node_id.*set-once|conflict/i);
		expect(store.getSession("exec")?.workflow_node_id).toBe("execute");
		store.close();
	});

	it("derives generalized node identity from the immutable execution binding, never a payload", async () => {
		const store = await StateStore.create(":memory:");
		bind(store, "bound");
		expect(store.resolveWorkflowNodeIdForExecution("bound")).toBe("execute");
		expect(store.resolveWorkflowNodeIdForExecution("bound", "execute")).toBe(
			"execute",
		);
		expect(() =>
			store.resolveWorkflowNodeIdForExecution("bound", "payload-forgery"),
		).toThrow(/workflow node.*conflict|set-once/i);
		expect(store.resolveWorkflowNodeIdForExecution("legacy")).toBeUndefined();
		store.close();
	});

	it.each([
		["shadow run without a snapshot", undefined],
		[
			"schema-v1 run",
			JSON.stringify({
				schema_version: 1,
				nodes: [],
				edges: [],
				loops: [],
				terminal_gate: { node: "founder_gate", predicate: "founder_approved" },
				ship_claims: ["founder_approved"],
			}),
		],
	] as const)(
		"keeps legacy bindings out of v2 identity: %s",
		async (_label, snapshotJson) => {
			const store = await StateStore.create(":memory:");
			store.createWorkflowRun({
				runId: "legacy-run",
				issueId: "FLY-LEGACY",
				projectName: "flywheel",
				...(snapshotJson ? { snapshotJson } : {}),
				claimsReadEnrolled: false,
			});
			expect(
				store.admitWorkflowExecution({
					runId: "legacy-run",
					nodeId: "qa",
					executionId: "legacy-exec",
					attempt: 1,
					family: "qa_verdict",
					now: "2026-07-15T00:00:00.000Z",
					expiresAt: "2026-07-15T00:05:00.000Z",
					absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
				}),
			).toMatchObject({ ok: true });
			expect(store.getWorkflowExecutionBinding("legacy-exec")).toBeDefined();
			expect(
				store.getGeneralizedWorkflowNodeForExecution("legacy-exec"),
			).toBeUndefined();
			expect(
				store.resolveWorkflowNodeIdForExecution("legacy-exec"),
			).toBeUndefined();
			store.close();
		},
	);

	it("fails closed when a generalized binding names a node outside its snapshot", async () => {
		const store = await StateStore.create(":memory:");
		bind(store, "corrupt", "mystery");
		expect(() => store.resolveWorkflowNodeIdForExecution("corrupt")).toThrow(
			/unknown workflow node|snapshot/i,
		);
		store.close();
	});
});
