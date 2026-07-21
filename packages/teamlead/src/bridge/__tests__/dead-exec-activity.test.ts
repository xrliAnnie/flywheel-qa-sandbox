import { describe, expect, it } from "vitest";
import type { WorkflowDeadExecutionWatchRow } from "../../StateStore.js";
import {
	captureDeadExecutionActivityBaseline,
	type DeadExecutionActivityProbeDeps,
	probeDeadExecutionActivity,
} from "../dead-exec-activity.js";

const BASE_DEPS: DeadExecutionActivityProbeDeps = {
	statCommitMarker: () => ({ state: "present", mtimeMs: 100 }),
	countCommDbMessages: () => 4,
	resolveTmuxTarget: () => ({ kind: "found", target: "runner:@17" }),
	captureTmuxOutput: async () => "pane-before",
};

function watch(): WorkflowDeadExecutionWatchRow {
	return {
		dead_execution_id: "dead-1",
		run_id: "run-1",
		node_id: "implement",
		attempt: 1,
		new_execution_id: "replacement-1",
		project_name: "flywheel",
		issue_id: "FLY-1385",
		observed_at: "2026-07-21T18:00:00.000Z",
		baseline: {
			commitMarker: { state: "present", mtimeMs: 100 },
			commDbMessageCount: 4,
			tmuxTarget: "runner:@17",
			tmuxOutputDigest:
				"eeb9372a1ef24db5b662feecdcd097393d9b210102d127f899a78091db7905bb",
			sessionCommitCount: 1,
		},
		state: "active",
		tripped_at: null,
		evidence: null,
	};
}

describe("dead execution activity tripwire", () => {
	it("captures identity-bound marker, CommDB, tmux, and session commit cursors", async () => {
		expect(
			await captureDeadExecutionActivityBaseline(
				{
					executionId: "dead-1",
					projectName: "flywheel",
					markerPath: "/markers/dead-1",
					sessionCommitCount: 1,
				},
				BASE_DEPS,
			),
		).toEqual(watch().baseline);
	});

	it.each([
		{
			name: "launch commit marker mtime",
			deps: {
				statCommitMarker: () => ({ state: "present" as const, mtimeMs: 101 }),
			},
			commitCount: 1,
			kind: "commit_marker",
		},
		{
			name: "identity-bound session commit count",
			deps: {},
			commitCount: 2,
			kind: "session_commit",
		},
		{
			name: "CommDB write cursor",
			deps: { countCommDbMessages: () => 5 },
			commitCount: 1,
			kind: "commdb_write",
		},
		{
			name: "tmux output digest",
			deps: { captureTmuxOutput: async () => "pane-after" },
			commitCount: 1,
			kind: "tmux_output",
		},
	])("trips on later $name activity", async ({ deps, commitCount, kind }) => {
		const evidence = await probeDeadExecutionActivity(
			{
				watch: watch(),
				markerPath: "/markers/dead-1",
				sessionCommitCount: commitCount,
			},
			{ ...BASE_DEPS, ...deps },
		);
		expect(evidence).toMatchObject({ kind });
	});

	it("keeps watching when every cursor is unchanged or unreadable", async () => {
		expect(
			await probeDeadExecutionActivity(
				{
					watch: watch(),
					markerPath: "/markers/dead-1",
					sessionCommitCount: 1,
				},
				{
					statCommitMarker: () => ({ state: "unknown" }),
					countCommDbMessages: () => null,
					resolveTmuxTarget: () => ({ kind: "error" }),
					captureTmuxOutput: async () => null,
				},
			),
		).toBeNull();
	});

	it("follows the old execution identity when its tmux target moves", async () => {
		const evidence = await probeDeadExecutionActivity(
			{
				watch: watch(),
				markerPath: "/markers/dead-1",
				sessionCommitCount: 1,
			},
			{
				...BASE_DEPS,
				resolveTmuxTarget: () => ({
					kind: "found",
					target: "runner:@29",
				}),
				captureTmuxOutput: async (target) =>
					target === "runner:@29" ? "resurrected output" : null,
			},
		);
		expect(evidence).toMatchObject({
			kind: "tmux_output",
			detail: expect.stringContaining("runner:@29"),
		});
	});
});
