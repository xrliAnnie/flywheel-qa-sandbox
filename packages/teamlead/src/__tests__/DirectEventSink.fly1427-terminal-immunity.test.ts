import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import type { EventEnvelope } from "flywheel-edge-worker/dist/ExecutionEventEmitter.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTransition } from "../applyTransition.js";
import type { BridgeConfig } from "../bridge/plugin.js";
import { DirectEventSink } from "../DirectEventSink.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const root of cleanups.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

const workflowEnv = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel-fly1427",
		leads: [],
	},
] as unknown as ProjectEntry[];

const config = {
	host: "127.0.0.1",
	port: 0,
	dbPath: ":memory:",
	ingestToken: "ingest-secret",
	notificationChannel: "test-channel",
	defaultLeadAgentId: "flywheel-eng-lead",
	stuckThresholdMinutes: 15,
	stuckCheckIntervalMs: 300000,
	orphanThresholdMinutes: 60,
} as unknown as BridgeConfig;

async function harness(executionId = "exec-fly1427") {
	const store = await StateStore.create(":memory:");
	const root = mkdtempSync(join(tmpdir(), "fly1427-sink-"));
	cleanups.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: `tpl-${executionId}`, revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "execute",
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
					from: "execute",
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
		runId: `run-${executionId}`,
		issueId: "FLY-1427",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: `run-${executionId}`,
			nodeId: "execute",
			executionId,
			attempt: 1,
			now: "2026-07-22T00:00:00.000Z",
			expiresAt: "2026-07-22T01:00:00.000Z",
			absoluteDeadlineAt: "2026-07-23T00:00:00.000Z",
			env: workflowEnv,
		}),
	).toMatchObject({ ok: true });
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-1427",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "execute",
	});
	const transition = applyTransition(
		{
			store,
			fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
			executor: new DirectiveExecutor(store),
		},
		executionId,
		"terminated",
		{
			executionId,
			issueId: "FLY-1427",
			projectName: "flywheel",
			trigger: "terminate",
		},
	);
	expect(transition.ok).toBe(true);
	const sink = new DirectEventSink(store, config, projects);
	const envelope: EventEnvelope = {
		executionId,
		issueId: "FLY-1427",
		projectName: "flywheel",
	};
	return { store, sink, envelope };
}

describe("FLY-1427 DirectEventSink DAG closeout guard", () => {
	it.each([
		"88d06933-5795-4d21-aea0-db51930d7171",
		"57e09567-68ba-49de-9448-9bcbc143c1d5",
		"a955657f-010b-4527-99c4-5c0ef6714e8d",
		"7b76d2a0-5a0a-45f1-9d29-09f14b57846c",
		"c80fad41-998b-4843-b756-8886547049a8",
	])(
		"keeps FSM terminate authoritative for incident execution %s",
		async (executionId) => {
			const { store, sink, envelope } = await harness(executionId);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const beforeRevision = store.getLifecycleRevision(envelope.executionId);

			await sink.emitCompleted(envelope, {
				success: true,
				decision: { route: "needs_review", reasoning: "runner exited" },
			});

			expect(store.getSession(envelope.executionId)?.status).toBe("terminated");
			expect(store.getLifecycleRevision(envelope.executionId)).toBe(
				beforeRevision,
			);
			// PR #748: generic now has `creates_pr`, so DirectEventSink's
			// PR-routing guard refuses this in-process completion BEFORE the
			// FLY-1427 terminal-immunity guard is reached — a PR-producing
			// generalized node must complete through flywheel-comm's HTTP /events
			// path so the Bridge re-derives repository/head authority. The
			// terminal fact this test guards is unchanged and still asserted
			// above (status stays `terminated`, lifecycle revision frozen); only
			// the refusing guard moved. Terminal immunity itself keeps its
			// dedicated coverage in StateStore.fly1427-terminal-immunity.test.ts.
			expect(warn).toHaveBeenCalledWith(
				expect.stringMatching(
					/FLY-1427.*terminal-immune|generalized PR completion rejected/i,
				),
			);
			store.close();
		},
	);

	it("does not enqueue a false failed or blocked CommDB terminal after terminate", async () => {
		const { store, sink, envelope } = await harness("exec-fly1427-failed");
		const enqueue = vi.fn();
		sink.terminalCommDbSync = { enqueue };

		await sink.emitFailed(envelope, "runner killed by terminate");
		await sink.emitFailed(envelope, "runner killed by terminate", undefined, {
			failureKind: "goal_blocked",
			failureReason: "runner reported blocked while closing",
		});

		expect(store.getSession(envelope.executionId)?.status).toBe("terminated");
		expect(enqueue).not.toHaveBeenCalled();
		store.close();
	});

	it("FLY-2018: direct generalized failure persists the normalized environment pair", async () => {
		const { store, sink, envelope } = await harness("exec-fly2018-direct");

		await sink.emitFailed(envelope, "legacy", undefined, {
			failureKind: "goal_blocked",
			failureReason: "refresh token revoked",
			failureClass: "environment",
			failureCode: "codex:unauthorized",
		});

		const event = store
			.getEventsByExecution(envelope.executionId)
			.find((candidate) => candidate.event_type === "session_failed");
		expect(event?.payload).toEqual({
			failureKind: "goal_blocked",
			lastError: "refresh token revoked",
			failureClass: "environment",
			failureCode: "codex:unauthorized",
		});
		store.close();
	});
});
