import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { expect } from "vitest";
import type { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../../workflow-run-snapshot.js";

/** FLY-2900: shared fixture for an engine-owned Codex node that can hit a quota wall. */
export const standbyWorkflowEnv = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

export function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

export function createCodexStandbyRun(
	store: StateStore,
	options: {
		runId?: string;
		executionId?: string;
		issueId?: string;
		projectName?: string;
		vendor?: "codex" | "claude";
		engineOwned?: boolean;
		cleanups?: string[];
	} = {},
) {
	const runId = options.runId ?? "run-fly2900";
	const executionId = options.executionId ?? "exec-fly2900";
	const issueId = options.issueId ?? "FLY-2900";
	const projectName = options.projectName ?? "flywheel";
	const root = mkdtempSync(join(tmpdir(), "fly2900-run-"));
	options.cleanups?.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
	const vendor = options.vendor ?? "codex";
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: `tpl-${runId}`, revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "implement",
					type: "generic",
					vendor,
					model: vendor === "codex" ? "gpt-5.6-sol" : "opus",
					effort: vendor === "codex" ? "low" : "high",
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "done",
					from: "implement",
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
	});
	store.createWorkflowRun({
		runId,
		issueId,
		projectName,
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	if (options.engineOwned !== false)
		rawDb(store)
			.prepare("UPDATE workflow_run SET engine_owned=1 WHERE run_id=?")
			.run(runId);
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId,
			nodeId: "implement",
			executionId,
			attempt: 1,
			now: "2026-09-25T00:00:00.000Z",
			expiresAt: "2026-09-25T01:00:00.000Z",
			absoluteDeadlineAt: "2026-09-26T00:00:00.000Z",
			env: standbyWorkflowEnv,
		}),
	).toMatchObject({ ok: true });
	store.upsertSession({
		execution_id: executionId,
		issue_id: issueId,
		project_name: projectName,
		status: "running",
	});
	return { runId, executionId, issueId };
}

export function quotaWall(
	executionId: string,
	sourceEventId = "wall-1",
	overrides: Record<string, unknown> = {},
) {
	return {
		executionId,
		sourceEventId,
		signal: "failed" as const,
		failureKind: "goal_usage_limited",
		lastError: "goal ended non-complete: usageLimited",
		source: "direct-event-sink",
		now: "2026-09-25T00:10:00.000Z",
		...overrides,
	};
}
