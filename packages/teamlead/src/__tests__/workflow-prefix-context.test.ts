import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkflowPrefixContext } from "../workflow-prefix-context.js";
import {
	buildWorkflowRunSnapshotV1,
	buildWorkflowRunSnapshotV2,
	buildWorkflowRunSnapshotV3,
} from "../workflow-run-snapshot.js";
import { legacyEngineeringManifest } from "./fixtures/legacy-workflow-manifests.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture(version: 1 | 2 | 3 = 3, templateId = "tpl_code") {
	const root = mkdtempSync(join(tmpdir(), "fly2913-prefix-context-"));
	roots.push(root);
	mkdirSync(join(root, "agents"));
	mkdirSync(join(root, ".flywheel/menus"), { recursive: true });
	writeFileSync(
		join(root, ".flywheel/menus/ic-roster.yaml"),
		"implement: agents/role.md\nqa: agents/qa.md\n",
	);
	writeFileSync(
		join(root, "agents/role.md"),
		"---\nskills: [implement]\n---\nPinned role.\n",
	);
	writeFileSync(join(root, "agents/qa.md"), "Independent QA.\n");
	const authorId = version === 2 ? "author" : "implement";
	writeFileSync(
		join(root, ".flywheel/config.yaml"),
		"project: fly2913-fixture\n",
	);
	const template = { id: templateId, revision: 2 };
	const manifest = {
		schema_version: version,
		nodes: [
			{
				id: authorId,
				type: "implement",
				vendor: "claude",
				model: "claude-fable-5",
				...(version === 2 ? { role: "implement" } : {}),
				effort: "high",
				...(version === 3 ? { handbook_ref: authorId } : {}),
			},
			{
				id: "qa",
				type: "qa",
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "low",
				...(version === 3 ? { handbook_ref: "qa" } : {}),
			},
			{ id: "approval", type: "gate" },
		],
		edges: [
			{ id: "done", from: authorId, to: "qa", condition: "implement_done" },
			{ id: "pass", from: "qa", to: "approval", condition: "qa_pass" },
		],
		loops: [
			{
				id: "retry",
				from: "qa",
				to: authorId,
				loop_when: "qa_fail",
				exit_when: "qa_pass",
				max_iterations: 3,
				on_limit: "escalate",
			},
		],
		terminal_gate: { node: "approval", predicate: "founder_approved" },
		ship_claims: ["qa_passed", "founder_approved"],
	};
	const snapshot =
		version === 1
			? buildWorkflowRunSnapshotV1({
					template,
					manifest: legacyEngineeringManifest(),
				})
			: (version === 2
					? buildWorkflowRunSnapshotV2
					: buildWorkflowRunSnapshotV3)({
					template,
					manifest,
					canonicalRoot: root,
				});
	return {
		root,
		snapshot,
		run: {
			run_id: "run-2913",
			template_id: templateId,
			template_revision: 2,
			snapshot: JSON.stringify(snapshot),
		},
		nodeId: authorId,
	};
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
