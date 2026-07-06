import { describe, expect, it } from "vitest";
import { LinearGraphBuilder } from "../LinearGraphBuilder.js";
import type { LinearIssueData } from "../types.js";

describe("LinearGraphBuilder", () => {
	// Uses state.type (Linear SDK enum) not state.name (user-customizable)
	const mockIssues: LinearIssueData[] = [
		{
			id: "issue-1",
			state: { type: "unstarted" },
			relations: { nodes: [] },
		},
		{
			id: "issue-2",
			state: { type: "started" },
			relations: {
				nodes: [{ type: "blocks", relatedIssue: { id: "issue-3" } }],
			},
		},
		{
			id: "issue-3",
			state: { type: "unstarted" },
			relations: {
				nodes: [{ type: "blocks", relatedIssue: { id: "issue-2" } }],
			},
		},
	];

	it("builds DagNodes from Linear issues", () => {
		const nodes = new LinearGraphBuilder().build(mockIssues);
		expect(nodes).toHaveLength(3);
	});

	it("maps issue IDs correctly", () => {
		const nodes = new LinearGraphBuilder().build(mockIssues);
		const ids = nodes.map((n) => n.id).sort();
		expect(ids).toEqual(["issue-1", "issue-2", "issue-3"]);
	});

	it("extracts blockedBy from 'blocks' relations", () => {
		const nodes = new LinearGraphBuilder().build(mockIssues);
		const node2 = nodes.find((n) => n.id === "issue-2");
		const node3 = nodes.find((n) => n.id === "issue-3");
		// issue-2 has relation: issue-3 blocks issue-2 → issue-2.blockedBy should NOT include issue-3
		// Actually: relation type "blocks" means relatedIssue blocks THIS issue
		// So issue-2's relation says issue-3 blocks issue-2 → issue-2.blockedBy = ["issue-3"]
		expect(node2?.blockedBy).toEqual(["issue-3"]);
		// issue-3's relation says issue-2 blocks issue-3 → issue-3.blockedBy = ["issue-2"]
		expect(node3?.blockedBy).toEqual(["issue-2"]);
	});

	it("node with no relations has empty blockedBy", () => {
		const nodes = new LinearGraphBuilder().build(mockIssues);
		const node1 = nodes.find((n) => n.id === "issue-1");
		expect(node1?.blockedBy).toEqual([]);
	});

	it("filters out completed issues (by state.type, not state.name)", () => {
		const withDone: LinearIssueData[] = [
			...mockIssues,
			{
				id: "issue-4",
				state: { type: "completed" },
				relations: { nodes: [] },
			},
		];
		expect(new LinearGraphBuilder().build(withDone)).toHaveLength(3);
	});

	it("filters out canceled issues", () => {
		const cancelled: LinearIssueData[] = [
			{
				id: "issue-1",
				state: { type: "canceled" },
				relations: { nodes: [] },
			},
		];
		expect(new LinearGraphBuilder().build(cancelled)).toHaveLength(0);
	});

	it("supports custom terminal types", () => {
		const custom = new LinearGraphBuilder(
			new Set(["completed", "canceled", "triage"]),
		);
		const withTriage: LinearIssueData[] = [
			{
				id: "issue-1",
				state: { type: "triage" },
				relations: { nodes: [] },
			},
		];
		expect(custom.build(withTriage)).toHaveLength(0);
	});

	it("ignores non-blocks relation types", () => {
		const issues: LinearIssueData[] = [
			{
				id: "issue-1",
				state: { type: "unstarted" },
				relations: {
					nodes: [{ type: "related", relatedIssue: { id: "issue-2" } }],
				},
			},
			{
				id: "issue-2",
				state: { type: "unstarted" },
				relations: { nodes: [] },
			},
		];
		const nodes = new LinearGraphBuilder().build(issues);
		const node1 = nodes.find((n) => n.id === "issue-1");
		expect(node1?.blockedBy).toEqual([]);
	});

	it("only includes blockers that are in the active set", () => {
		const issues: LinearIssueData[] = [
			{
				id: "issue-1",
				state: { type: "unstarted" },
				relations: {
					nodes: [
						{
							type: "blocks",
							relatedIssue: { id: "external-issue" },
						},
					],
				},
			},
		];
		const nodes = new LinearGraphBuilder().build(issues);
		// external-issue is not in the input set, so it's excluded from blockedBy
		expect(nodes[0].blockedBy).toEqual([]);
	});

	it("handles issues with null state", () => {
		const issues: LinearIssueData[] = [
			{ id: "issue-1", state: null, relations: { nodes: [] } },
		];
		// null state → treated as non-terminal → included
		const nodes = new LinearGraphBuilder().build(issues);
		expect(nodes).toHaveLength(1);
	});

	it("handles issues with null relations", () => {
		const issues: LinearIssueData[] = [
			{
				id: "issue-1",
				state: { type: "unstarted" },
				relations: null,
			},
		];
		const nodes = new LinearGraphBuilder().build(issues);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].blockedBy).toEqual([]);
	});

	it("excludes blockedBy references to filtered-out issues", () => {
		const issues: LinearIssueData[] = [
			{
				id: "issue-1",
				state: { type: "unstarted" },
				relations: {
					nodes: [{ type: "blocks", relatedIssue: { id: "issue-2" } }],
				},
			},
			{
				id: "issue-2",
				// completed → will be filtered out
				state: { type: "completed" },
				relations: { nodes: [] },
			},
		];
		const nodes = new LinearGraphBuilder().build(issues);
		expect(nodes).toHaveLength(1);
		// issue-2 is filtered (completed), so even though issue-1 says issue-2 blocks it,
		// the blockedBy should be empty since issue-2 is not in the active set
		expect(nodes[0].blockedBy).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(new LinearGraphBuilder().build([])).toEqual([]);
	});
});
