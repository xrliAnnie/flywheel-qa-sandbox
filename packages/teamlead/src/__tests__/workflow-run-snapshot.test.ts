import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSubmissionDigest, NODE_TYPE_REGISTRY } from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildWorkflowRunSnapshotV1,
	buildWorkflowRunSnapshotV2,
	parseWorkflowRunSnapshot,
	resolveWorkflowGateAuthority,
	workflowNodeAgentContent,
} from "../workflow-run-snapshot.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "flywheel-snapshot-"));
	roots.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Do the bounded task.\n");
	return {
		root,
		manifest: {
			schema_version: 2 as const,
			nodes: [
				{
					id: "execute",
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
					from: "execute",
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
}

function terminalLandFixture() {
	const { root } = fixture();
	return {
		root,
		manifest: {
			schema_version: 2 as const,
			nodes: [
				{
					id: "craft",
					type: "generic" as const,
					vendor: "codex" as const,
					model: "gpt-5.6-sol",
					effort: "low" as const,
					agent_file: "agents/generic.md",
				},
				{ id: "decision", type: "gate" as const },
				{ id: "publish", type: "land" as const, execution: "engine" as const },
			],
			edges: [
				{
					id: "crafted",
					from: "craft",
					to: "decision",
					condition: "node_done" as const,
				},
				{
					id: "approved",
					from: "decision",
					to: "publish",
					condition: "founder_approved" as const,
				},
			],
			loops: [],
			approval_gate: {
				node: "decision",
				predicate: "founder_approved" as const,
			},
			terminal_node: { node: "publish" },
			ship_claims: ["founder_approved" as const],
		},
	};
}

describe("typed generalized workflow snapshot", () => {
	it("pins the engineering Gate-feedback topology digest", () => {
		const manifest = legacyWorkflowSeeds()[0]!.manifest;
		const snapshot = buildWorkflowRunSnapshotV1({
			template: { id: "tpl_eng_heavy", revision: 1 },
			manifest,
		});
		// FLY-1501: the heavy QA node reserves its 180-minute evidence window in
		// the pinned manifest, so both topology digests move with that authority.
		expect(snapshot.manifest_digest).toBe(
			"e30dc87efef5804b7a7cb741293b45cd85e5f71482bcdd1787e5bae25abc6444",
		);
		expect(snapshot.snapshot_digest).toBe(
			"3b165a2411bcdb0c81c61b971ec20f33ef8375edfa4bde01a3e1975f857ad253",
		);
		expect(
			snapshot.manifest.nodes.find((node) => node.id === "qa")
				?.submissionWindowMinutes,
		).toBe(180);
		expect(parseWorkflowRunSnapshot(JSON.stringify(snapshot))).toEqual(
			snapshot,
		);
	});

	it("pins a land_v1 engine node without dispatching an agent", () => {
		const snapshot = buildWorkflowRunSnapshotV1({
			template: { id: "tpl_eng_heavy_land_v1", revision: 1 },
			manifest: {
				schema_version: 1,
				manifest_variant: "land_v1",
				nodes: [
					{
						id: "design",
						type: "design",
						vendor: "claude",
						model: "claude-fable-5",
					},
					{
						id: "implement",
						type: "implement",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "xhigh",
					},
					{
						id: "qa",
						type: "qa",
						vendor: "claude",
						model: "claude-opus-5",
					},
					{ id: "founder_gate", type: "gate" },
					{ id: "land", type: "land", execution: "engine" },
				],
				edges: [
					{
						id: "design_done",
						from: "design",
						to: "implement",
						condition: "design_done",
					},
					{
						id: "implement_done",
						from: "implement",
						to: "qa",
						condition: "implement_done",
					},
					{
						id: "qa_pass",
						from: "qa",
						to: "founder_gate",
						condition: "qa_pass",
					},
					{
						id: "founder_approved",
						from: "founder_gate",
						to: "land",
						condition: "founder_approved",
					},
				],
				loops: [
					{
						id: "qa_retry",
						from: "qa",
						to: "implement",
						loop_when: "qa_fail",
						exit_when: "qa_pass",
						max_iterations: 3,
						on_limit: "escalate",
					},
					{
						id: "founder_feedback",
						from: "founder_gate",
						to: "implement",
						loop_when: "founder_feedback_kickback",
						exit_when: "founder_approved",
						max_iterations: 3,
						on_limit: "escalate",
					},
				],
				approval_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				terminal_node: { node: "land" },
				ship_claims: ["qa_passed", "founder_approved"],
			},
		});

		expect(
			snapshot.resolved.nodes.find((node) => node.id === "founder_gate"),
		).toMatchObject({
			capabilities: { can_request_ship_approval: true },
		});
		expect(
			snapshot.resolved.nodes.find((node) => node.id === "land"),
		).toMatchObject({
			type: "land",
			capabilities: { can_ship: true, can_land: true },
		});
		expect(
			snapshot.resolved.nodes.find((node) => node.id === "land"),
		).not.toHaveProperty("dispatch");
		expect(() =>
			parseWorkflowRunSnapshot(JSON.stringify(snapshot)),
		).not.toThrow();
	});

	it("builds and strictly parses a pinned schema-v1 engine snapshot", () => {
		const manifest = {
			schema_version: 1 as const,
			nodes: [
				{
					id: "design",
					type: "design" as const,
					vendor: "claude" as const,
					model: "claude-fable-5",
					handoff_pointer: { worktree: true, design_doc: true },
				},
				{
					id: "implement",
					type: "implement" as const,
					vendor: "codex" as const,
					model: "gpt-5.6-sol",
					effort: "xhigh" as const,
					handoff_pointer: { worktree: true, design_doc: true },
				},
				{
					id: "qa",
					type: "qa" as const,
					vendor: "claude" as const,
					model: "claude-opus-5",
					handoff_pointer: { worktree: true, design_doc: true },
				},
				{ id: "founder_gate", type: "gate" as const },
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "implement",
					condition: "design_done" as const,
				},
				{
					id: "implement_done",
					from: "implement",
					to: "qa",
					condition: "implement_done" as const,
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass" as const,
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail" as const,
					exit_when: "qa_pass" as const,
					max_iterations: 3,
					on_limit: "escalate" as const,
				},
			],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved" as const,
			},
			ship_claims: ["qa_passed" as const, "founder_approved" as const],
		};

		const snapshot = buildWorkflowRunSnapshotV1({
			template: { id: "tpl_eng_heavy", revision: 1 },
			manifest,
		});
		const parsed = parseWorkflowRunSnapshot(JSON.stringify(snapshot));
		expect(parsed.schema_version).toBe(1);
		expect(parsed.resolved.nodes).toMatchObject([
			{
				id: "design",
				type: "design",
				dispatch: { vendor: "claude", model: "claude-fable-5" },
			},
			{
				id: "implement",
				type: "implement",
				dispatch: {
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				},
			},
			{
				id: "qa",
				type: "qa",
				dispatch: { vendor: "claude", model: "claude-opus-5" },
			},
			{ id: "founder_gate", type: "gate" },
		]);
		expect(parsed.manifest.loops[0]).toMatchObject({
			loop_when: "qa_fail",
			max_iterations: 3,
			on_limit: "escalate",
		});
		expect(workflowNodeAgentContent(parsed.resolved.nodes[0]!)).toBeUndefined();

		const corrupted = { ...snapshot, schema_version: 99 };
		expect(() => parseWorkflowRunSnapshot(JSON.stringify(corrupted))).toThrow(
			/schema_version/i,
		);
	});

	it("pins normalized capabilities, dispatch, and agent content", () => {
		const { root, manifest } = fixture();
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "tpl_ops", revision: 1 },
			manifest,
			canonicalRoot: root,
		});
		const parsed = parseWorkflowRunSnapshot(JSON.stringify(snapshot));
		expect(parsed.schema_version).toBe(2);
		const execute = parsed.resolved.nodes.find((node) => node.id === "execute");
		expect(execute).toMatchObject({
			type: "generic",
			dispatch: { vendor: "codex", model: "gpt-5.6-sol", effort: "low" },
			capabilities: {
				shared_branch_writer: true,
				creates_pr: true,
				produces_output: false,
				completion_route: "needs_review",
			},
		});
		expect(execute?.agent?.content).toBe("Do the bounded task.\n");
	});

	it("assigns ship authority only to an arbitrary terminal land node", () => {
		const { root, manifest } = terminalLandFixture();
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "tpl_land", revision: 1 },
			manifest,
			canonicalRoot: root,
		});

		expect(resolveWorkflowGateAuthority(snapshot)).toEqual({
			mode: "land",
			subjectKind: "git_head",
		});
		expect(
			snapshot.resolved.nodes.find((node) => node.id === "craft")?.capabilities,
		).toMatchObject({
			creates_pr: true,
			can_ship: false,
			can_land: false,
			approval_gate_holder: false,
		});
		expect(
			snapshot.resolved.nodes.find((node) => node.id === "publish")
				?.capabilities,
		).toMatchObject({ can_ship: true, can_land: true });
		expect(parseWorkflowRunSnapshot(JSON.stringify(snapshot))).toEqual(
			snapshot,
		);
	});

	it("binds a founder-only generic ship carrier to git-head authority", () => {
		const { root, manifest } = fixture();
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "tpl_generic", revision: 1 },
			manifest,
			canonicalRoot: root,
		});

		expect(resolveWorkflowGateAuthority(snapshot)).toEqual({
			mode: "runner_ship",
			subjectKind: "git_head",
			carrierNodeId: "execute",
		});
	});

	it("rejects snapshots that still expose more than one ship-capable carrier", () => {
		const { root, manifest } = fixture();
		manifest.nodes.splice(1, 0, {
			id: "also_execute",
			type: "generic",
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "low",
			agent_file: "agents/generic.md",
		});
		manifest.edges.splice(0, 1, {
			id: "first_done",
			from: "execute",
			to: "also_execute",
			condition: "node_done",
		});
		manifest.edges.push({
			id: "second_done",
			from: "also_execute",
			to: "founder_gate",
			condition: "node_done",
		});
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "tpl_ambiguous", revision: 1 },
			manifest,
			canonicalRoot: root,
		});

		expect(() => resolveWorkflowGateAuthority(snapshot)).toThrow(
			"incoherent_ship_bundle",
		);
	});

	it("pins and parses work-kind provenance while old snapshots stay field-free", () => {
		const { root, manifest } = fixture();
		const legacy = buildWorkflowRunSnapshotV2({
			template: { id: "tpl_ops", revision: 1 },
			manifest,
			canonicalRoot: root,
		});
		expect(legacy).not.toHaveProperty("task_category");
		expect(parseWorkflowRunSnapshot(JSON.stringify(legacy))).toEqual(legacy);

		const withKind = buildWorkflowRunSnapshotV2({
			template: { id: "tpl_ops", revision: 1 },
			manifest,
			canonicalRoot: root,
			workKind: {
				taskCategory: "generic",
				categorySource: "task_category",
				tier: "heavy",
			},
		});
		expect(parseWorkflowRunSnapshot(JSON.stringify(withKind))).toMatchObject({
			task_category: "generic",
			category_source: "task_category",
			tier: "heavy",
		});
	});

	it("parses an active historical design snapshot without reopening design routing", () => {
		const { root, manifest } = fixture();
		const current = buildWorkflowRunSnapshotV2({
			template: { id: "tpl_design", revision: 1 },
			manifest,
			canonicalRoot: root,
		});
		const { snapshot_digest: _digest, ...body } = current;
		const historicalBody = {
			...body,
			task_category: "design",
			category_source: "task_category",
		};
		const activeRun = {
			status: "active",
			snapshot: JSON.stringify({
				...historicalBody,
				snapshot_digest: canonicalSubmissionDigest(historicalBody),
			}),
		};

		expect(activeRun.status).toBe("active");
		expect(parseWorkflowRunSnapshot(activeRun.snapshot)).toMatchObject({
			task_category: "design",
			category_source: "task_category",
		});
	});

	it("rejects review nodes without a pinned or registered agent", () => {
		const { root } = fixture();
		expect(() =>
			buildWorkflowRunSnapshotV2({
				template: { id: "tpl-product", revision: 1 },
				canonicalRoot: root,
				manifest: {
					schema_version: 2,
					nodes: [
						{
							id: "produce",
							type: "generic",
							vendor: "codex",
							model: "gpt-5.6-sol",
							effort: "high",
							agent_file: "agents/generic.md",
							produces_output: true,
							output: { schema: "json_v1", max_bytes: 128 },
						},
						{
							id: "review",
							type: "review",
							vendor: "claude",
							model: "claude-sonnet-4-5",
							effort: "high",
						},
						{ id: "founder_gate", type: "gate" },
					],
					edges: [
						{
							id: "produce_done",
							from: "produce",
							to: "review",
							condition: "node_done",
						},
						{
							id: "review_pass",
							from: "review",
							to: "founder_gate",
							condition: "review_pass",
						},
					],
					loops: [
						{
							id: "review_retry",
							from: "review",
							to: "produce",
							loop_when: "review_fail",
							exit_when: "review_pass",
							max_iterations: 3,
							on_limit: "escalate",
						},
					],
					terminal_gate: {
						node: "founder_gate",
						predicate: "founder_approved",
					},
					ship_claims: ["design_review_approved", "founder_approved"],
				},
			}),
		).toThrow(/requires a registered agent/);
	});

	it("fails closed on corruption, missing agents, and unknown capability words", () => {
		const { root, manifest } = fixture();
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "tpl_ops", revision: 1 },
			manifest,
			canonicalRoot: root,
		});
		expect(() =>
			parseWorkflowRunSnapshot(
				JSON.stringify({ ...snapshot, snapshot_digest: "corrupt" }),
			),
		).toThrow(/digest/i);

		const bad = structuredClone(snapshot) as unknown as {
			resolved: { nodes: Array<{ capabilities: Record<string, unknown> }> };
			snapshot_digest: string;
		};
		bad.resolved.nodes[0]!.capabilities.future_power = true;
		expect(() => parseWorkflowRunSnapshot(JSON.stringify(bad))).toThrow(
			/unknown.*capabilit|capabilit.*unknown/i,
		);

		rmSync(join(root, "agents", "generic.md"));
		expect(() =>
			buildWorkflowRunSnapshotV2({
				template: { id: "tpl_ops", revision: 1 },
				manifest,
				canonicalRoot: root,
			}),
		).toThrow(/agent/i);
	});

	it("parses a pinned run after the live node registry changes", () => {
		const { root, manifest } = fixture();
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "tpl_ops", revision: 1 },
			manifest,
			canonicalRoot: root,
		});
		const generic = NODE_TYPE_REGISTRY.generic.capabilities as {
			shared_branch_writer: boolean;
		};
		const original = generic.shared_branch_writer;
		try {
			generic.shared_branch_writer = true;
			expect(() =>
				parseWorkflowRunSnapshot(JSON.stringify(snapshot)),
			).not.toThrow();
		} finally {
			generic.shared_branch_writer = original;
		}
	});

	it("rejects an empty agent file before writing an unreadable snapshot", () => {
		const { root, manifest } = fixture();
		writeFileSync(join(root, "agents", "generic.md"), "  \n");
		expect(() =>
			buildWorkflowRunSnapshotV2({
				template: { id: "tpl_ops", revision: 1 },
				manifest,
				canonicalRoot: root,
			}),
		).toThrow(/agent.*non-empty|non-empty.*agent/i);
	});

	it("rejects design-node completion without a shared branch writer during build and parse", () => {
		const manifest = {
			schema_version: 1 as const,
			nodes: [
				{
					id: "design",
					type: "design" as const,
					vendor: "claude" as const,
					model: "claude-fable-5",
					handoff_pointer: { worktree: true, design_doc: true },
				},
				{
					id: "qa",
					type: "qa" as const,
					vendor: "claude" as const,
					model: "claude-opus-5",
					handoff_pointer: { worktree: true, design_doc: true },
				},
				{ id: "founder_gate", type: "gate" as const },
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "qa",
					condition: "design_done" as const,
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass" as const,
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "design",
					loop_when: "qa_fail" as const,
					exit_when: "qa_pass" as const,
					max_iterations: 3,
					on_limit: "escalate" as const,
				},
			],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved" as const,
			},
			ship_claims: ["qa_passed" as const, "founder_approved" as const],
		};

		const designCapabilities = NODE_TYPE_REGISTRY.design.capabilities as {
			shared_branch_writer: boolean;
		};
		const original = designCapabilities.shared_branch_writer;
		try {
			designCapabilities.shared_branch_writer = false;
			expect(() =>
				buildWorkflowRunSnapshotV1({
					template: { id: "tpl_two_stage", revision: 1 },
					manifest,
				}),
			).toThrow(/design-node.*shared branch writer/i);
		} finally {
			designCapabilities.shared_branch_writer = original;
		}

		const valid = buildWorkflowRunSnapshotV1({
			template: { id: "tpl_two_stage", revision: 1 },
			manifest,
		});
		const corrupt = structuredClone(valid);
		const design = corrupt.resolved.nodes.find((node) => node.id === "design")!;
		design.capabilities.shared_branch_writer = false;
		const { snapshot_digest: _oldDigest, ...body } = corrupt;
		corrupt.snapshot_digest = canonicalSubmissionDigest(body);
		expect(() => parseWorkflowRunSnapshot(JSON.stringify(corrupt))).toThrow(
			/design-node.*shared branch writer/i,
		);
	});
});
