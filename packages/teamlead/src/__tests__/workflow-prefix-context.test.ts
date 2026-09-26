import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateStore } from "../StateStore.js";
import {
	resolveExecutionWorkflowPrefixContext,
	resolveWorkflowPrefixContext,
} from "../workflow-prefix-context.js";
import { createWorkflowPrefixFixture } from "./fixtures/workflow-prefix.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture(version: 1 | 2 | 3 = 3, templateId = "tpl_code") {
	const root = mkdtempSync(join(tmpdir(), "fly2913-prefix-context-"));
	roots.push(root);
	return createWorkflowPrefixFixture(root, version, templateId);
}

describe("pinned workflow prefix provenance (FLY-2913)", () => {
	it.each([1, 2, 3] as const)(
		"validates schema %s and derives type rather than node name",
		(version) => {
			const { run, snapshot, nodeId } = fixture(version);
			const result = resolveWorkflowPrefixContext({ run, nodeId });
			expect(result).toMatchObject({
				workflow: {
					runId: run.run_id,
					templateId: "tpl_code",
					snapshotDigest: snapshot.snapshot_digest,
				},
				nodeId,
				phase: "implement",
			});
			expect(result?.agent).toEqual(
				snapshot.resolved.nodes.find((node) => node.id === nodeId)?.agent ??
					null,
			);
		},
	);
	it("recognizes simple-code using its persisted template", () => {
		const { run, nodeId } = fixture(3, "tpl_simple_code");
		expect(
			resolveWorkflowPrefixContext({ run, nodeId })?.workflow.templateId,
		).toBe("tpl_simple_code");
	});
	it.each(["tpl_generic", "meeting-notes", "xiaohongshu-learning"])(
		"leaves %s unmapped despite an implement node",
		(id) => {
			const { run, nodeId } = fixture(3, id);
			expect(resolveWorkflowPrefixContext({ run, nodeId })).toBeUndefined();
		},
	);
	it("does not rebuild absent snapshots or untemplated legacy runs", () => {
		const { run, nodeId } = fixture();
		expect(
			resolveWorkflowPrefixContext({ run: undefined, nodeId }),
		).toBeUndefined();
		expect(
			resolveWorkflowPrefixContext({ run: { ...run, snapshot: null }, nodeId }),
		).toBeUndefined();
		expect(
			resolveWorkflowPrefixContext({
				run: { ...run, template_id: null },
				nodeId,
			}),
		).toBeUndefined();
	});
	it("keeps a missing schema-1 agent unknown rather than reading current files", () => {
		const { run, nodeId } = fixture(1);
		expect(resolveWorkflowPrefixContext({ run, nodeId })?.agent).toBeNull();
	});
	it("keeps the pinned role body after its source file changes", () => {
		const { run, nodeId, root, snapshot } = fixture();
		writeFileSync(join(root, "agents/role.md"), "Unreviewed changed skills.");
		expect(resolveWorkflowPrefixContext({ run, nodeId })?.agent).toEqual(
			snapshot.resolved.nodes[0]?.agent,
		);
	});
	it("fails closed on corrupt or tampered snapshots without echoing source", () => {
		const { run, nodeId, snapshot } = fixture();
		for (const source of [
			"PRIVATE_BROKEN_JSON",
			JSON.stringify({
				...snapshot,
				template: { id: "tpl_simple_code", revision: 2 },
			}),
		]) {
			expect(() =>
				resolveWorkflowPrefixContext({
					run: { ...run, snapshot: source },
					nodeId,
				}),
			).toThrow("workflow_prefix_context: invalid snapshot");
		}
	});
	it("rejects row/template disagreement and the wrong expected digest", () => {
		const { run, nodeId } = fixture();
		for (const change of [
			{ template_id: "tpl_simple_code" },
			{ template_revision: 3 },
		]) {
			expect(() =>
				resolveWorkflowPrefixContext({ run: { ...run, ...change }, nodeId }),
			).toThrow(/template mismatch/);
		}
		expect(() =>
			resolveWorkflowPrefixContext({
				run,
				nodeId,
				expectedSnapshotDigest: "a".repeat(64),
			}),
		).toThrow(/digest mismatch/);
	});
	it("rejects absent nodes and does not turn a gate into an implement role", () => {
		const { run } = fixture();
		expect(() =>
			resolveWorkflowPrefixContext({ run, nodeId: "missing" }),
		).toThrow(/node missing/);
		expect(
			resolveWorkflowPrefixContext({ run, nodeId: "approval" }),
		).toBeUndefined();
	});
	it("projects only provenance and role fields, never row metadata or permissions", () => {
		const { run, nodeId } = fixture();
		const rowWithMetadata = { ...run, privateMetadata: "PRIVATE_VALUE" };
		const result = resolveWorkflowPrefixContext({
			run: rowWithMetadata,
			nodeId,
		});
		expect(Object.keys(result!).sort()).toEqual([
			"agent",
			"nodeId",
			"phase",
			"workflow",
		]);
		expect(JSON.stringify(result)).not.toContain("PRIVATE_VALUE");
		expect(result).not.toHaveProperty("capabilities");
	});
});

describe("execution-bound prefix source lookup", () => {
	function bound() {
		const pinned = fixture();
		const runtime = {
			execution_id: "execution-2913",
			run_id: pinned.run.run_id,
			node_id: pinned.nodeId,
		};
		const store = {
			getWorkflowExecutionRuntime: vi.fn(() => runtime),
			getWorkflowRun: vi.fn(() => pinned.run),
			getWorkflowExecutionBinding: vi.fn(() => {
				throw new Error("ambiguous after reentry");
			}),
		};
		const lookup = (expected?: {
			runId: string;
			nodeId: string;
			snapshotDigest: string;
		}) =>
			resolveExecutionWorkflowPrefixContext(
				store as unknown as Pick<
					StateStore,
					"getWorkflowExecutionRuntime" | "getWorkflowRun"
				>,
				{ executionId: runtime.execution_id, expected },
			);
		return { pinned, runtime, store, lookup };
	}
	it("uses immutable runtime after multiple activations instead of the single-activation lookup", () => {
		const { lookup, store, pinned } = bound();
		expect(lookup()).toMatchObject({
			workflow: { runId: pinned.run.run_id },
			phase: "implement",
		});
		expect(store.getWorkflowExecutionBinding).not.toHaveBeenCalled();
	});
	it.each(["runId", "nodeId", "snapshotDigest"] as const)(
		"rejects mismatched dispatcher %s",
		(key) => {
			const { lookup, pinned } = bound();
			const expected = {
				runId: pinned.run.run_id,
				nodeId: pinned.nodeId,
				snapshotDigest: pinned.snapshot.snapshot_digest,
			};
			expected[key] = "wrong";
			expect(() => lookup(expected)).toThrow(
				/workflow_prefix_context: (runtime identity|digest) mismatch/,
			);
		},
	);
	it("distinguishes an unbound legacy execution from a missing engine binding", () => {
		const { store, pinned } = bound();
		const lookupStore = {
			...store,
			getWorkflowExecutionRuntime: () => undefined,
		};
		const input = { executionId: "missing" };
		expect(
			resolveExecutionWorkflowPrefixContext(
				lookupStore as unknown as Pick<
					StateStore,
					"getWorkflowExecutionRuntime" | "getWorkflowRun"
				>,
				input,
			),
		).toBeUndefined();
		expect(() =>
			resolveExecutionWorkflowPrefixContext(
				lookupStore as unknown as Pick<
					StateStore,
					"getWorkflowExecutionRuntime" | "getWorkflowRun"
				>,
				{
					...input,
					expected: {
						runId: pinned.run.run_id,
						nodeId: pinned.nodeId,
						snapshotDigest: pinned.snapshot.snapshot_digest,
					},
				},
			),
		).toThrow(/runtime missing/);
		expect(store.getWorkflowRun).not.toHaveBeenCalled();
	});
	it("rejects a run row mismatched with its execution binding", () => {
		const { lookup, pinned } = bound();
		pinned.run.run_id = "different";
		expect(() => lookup()).toThrow(/run missing or mismatched/);
	});
});
