import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildWorkflowRunSnapshotV2,
	parseWorkflowRunSnapshot,
} from "../workflow-run-snapshot.js";

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

describe("typed generalized workflow snapshot", () => {
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
				shared_branch_writer: false,
				produces_output: false,
				completion_route: "no_code",
			},
		});
		expect(execute?.agent?.content).toBe("Do the bounded task.\n");
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
});
