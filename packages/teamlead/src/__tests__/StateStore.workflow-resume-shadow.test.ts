import { describe, expect, it } from "vitest";
import { runWorkflowResumeShadowTick } from "../bridge/workflow-resume-shadow.js";
import { StateStore } from "../StateStore.js";

const at = "2026-08-15T00:00:00.000Z";

type RawStore = StateStore & {
	db: { run(sql: string, params?: unknown[]): void };
};

function seedExecutable(
	store: StateStore,
	index: number,
	options: {
		checkpointState?: "intent" | "ready";
		delivery?: boolean;
		status?: string;
	} = {},
) {
	const runId = `run-${index}`;
	const executionId = `exec-${index}`;
	const attachmentId = `attachment-${index}`;
	store.createWorkflowRun({
		runId,
		issueId: `FLY-${index}`,
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	const db = (store as RawStore).db;
	db.run(
		"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'implement' WHERE run_id = ?",
		[runId],
	);
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "implement",
		attempt: 1,
		state: "running",
		executionId,
	});
	store.upsertSession({
		execution_id: executionId,
		issue_id: `FLY-${index}`,
		project_name: "flywheel",
		status: options.status ?? "failed",
	});
	store.appendWorkflowRunEvent({
		runId,
		eventUid: `start:${index}`,
		kind: "start_reservation",
		nodeId: "implement",
		executionId,
		payload: { targetNodeId: "implement", targetAttempt: 1 },
	});
	if (options.delivery !== false) {
		store.appendWorkflowRunEvent({
			runId,
			eventUid: `issue_delivery:${executionId}:1:0`,
			kind: "issue_delivery",
			nodeId: "implement",
			executionId,
			payload: { sourceKind: "authoritative" },
		});
	}
	db.run(
		`INSERT INTO workflow_resume_attachment
		   (attachment_id, run_id, target_node_id, target_attempt, transition_uid,
		    receipt_kind, receipt_digest, carrier_kind, anchor_ref, anchor_commit,
		    repo_identity, snapshot_digest, resolved_node_digest,
		    rework_authority_digest, envelope_json, created_at)
		 VALUES (?, ?, 'implement', 1, ?, 'start_reservation', ?, 'git_checkpoint',
		         ?, ?, 'flywheel', 'snapshot', 'node', 'none', '{}', ?)`,
		[
			attachmentId,
			runId,
			`start:${index}`,
			`receipt-${index}`,
			`refs/flywheel/checkpoints/${runId}/${attachmentId}`,
			"a".repeat(40),
			new Date(Date.parse(at) + index).toISOString(),
		],
	);
	const checkpointState = options.checkpointState ?? "ready";
	db.run(
		`INSERT INTO workflow_resume_attachment_state
		   (attachment_id, state, store_locator, envelope_stamped_json,
		    runtime_semantics_stamped, updated_at)
		 VALUES (?, ?, '{}', '{}', 'runtime', ?)`,
		[attachmentId, checkpointState, at],
	);
	return { runId, executionId, attachmentId };
}

function seedGate(store: StateStore) {
	store.createWorkflowRun({
		runId: "run-gate",
		issueId: "FLY-GATE",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	const db = (store as RawStore).db;
	db.run(
		"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'founder_gate' WHERE run_id = 'run-gate'",
	);
	store.upsertWorkflowRunNode({
		runId: "run-gate",
		nodeId: "founder_gate",
		attempt: 1,
		state: "review",
	});
	store.appendWorkflowRunEvent({
		runId: "run-gate",
		eventUid: "edge:gate",
		kind: "edge_traversed",
		nodeId: "qa",
		executionId: "qa-exec",
		payload: { targetNodeId: "founder_gate", targetAttempt: 1 },
	});
	store.appendWorkflowRunEvent({
		runId: "run-gate",
		eventUid: "gate_holder:question-gate",
		kind: "gate_holder_created",
		nodeId: "founder_gate",
		executionId: "qa-exec",
		payload: {
			attempt: 1,
			questionId: "question-gate",
			head: "b".repeat(40),
		},
	});
	db.run(
		`INSERT INTO workflow_gate_holder
		   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
		    question_id, state, materialization_stage, created_at, updated_at)
		 VALUES ('run-gate', 'founder_gate', 1, ?, 'qa-exec', 'question-gate',
		         'awaiting_review', 'completed', ?, ?)`,
		["b".repeat(40), at, at],
	);
	db.run(
		`INSERT INTO workflow_resume_attachment
		   (attachment_id, run_id, target_node_id, target_attempt, transition_uid,
		    receipt_kind, receipt_digest, carrier_kind, snapshot_digest,
		    resolved_node_digest, runtime_semantics_digest,
		    rework_authority_digest, envelope_json, created_at)
		 VALUES ('attachment-gate', 'run-gate', 'founder_gate', 1, 'edge:gate',
		         'edge_traversed', 'receipt', 'state_only_checkpoint', 'snapshot',
		         'node', 'runtime', 'none', '{}', ?)`,
		[at],
	);
	db.run(
		`INSERT INTO workflow_resume_attachment_state
		   (attachment_id, state, envelope_stamped_json, updated_at)
		 VALUES ('attachment-gate', 'ready', '{}', ?)`,
		[at],
	);
}

describe("workflow resume shadow opportunities", () => {
	it("does not consume early executable opportunities and re-probes a new checkpoint state", async () => {
		const store = await StateStore.create(":memory:");
		const seeded = seedExecutable(store, 1, {
			checkpointState: "intent",
			delivery: false,
		});
		expect(store.listWorkflowResumeShadowOpportunities()).toEqual([]);
		store.appendWorkflowRunEvent({
			runId: seeded.runId,
			eventUid: `issue_delivery:${seeded.executionId}:1:0`,
			kind: "issue_delivery",
			nodeId: "implement",
			executionId: seeded.executionId,
			payload: { sourceKind: "authoritative" },
		});
		expect(store.listWorkflowResumeShadowOpportunities()).toMatchObject([
			{ opportunityKey: `${seeded.attachmentId}:intent` },
		]);
		store.recordWorkflowResumeProbe({
			runId: seeded.runId,
			opportunityKey: `${seeded.attachmentId}:intent`,
			proposedNodeId: "implement",
			proposedAttempt: 1,
			verdict: "anchor_pending",
			detail: { state: "intent" },
			createdAt: at,
		});
		expect(store.listWorkflowResumeShadowOpportunities()).toEqual([]);
		(store as RawStore).db.run(
			`UPDATE workflow_resume_attachment_state
			    SET state = 'ready', updated_at = ?
			  WHERE attachment_id = ?`,
			[at, seeded.attachmentId],
		);
		expect(store.listWorkflowResumeShadowOpportunities()).toMatchObject([
			{ opportunityKey: `${seeded.attachmentId}:ready` },
		]);
		store.close();
	});

	it("waits for writer terminality and schedules more than three runs fairly", async () => {
		const store = await StateStore.create(":memory:");
		const first = seedExecutable(store, 1, { status: "running" });
		for (let index = 2; index <= 5; index += 1) seedExecutable(store, index);
		expect(
			store.listWorkflowResumeShadowOpportunities().map((entry) => entry.runId),
		).toEqual(["run-2", "run-3", "run-4"]);
		for (const opportunity of store.listWorkflowResumeShadowOpportunities()) {
			store.recordWorkflowResumeProbe({
				runId: opportunity.runId,
				opportunityKey: opportunity.opportunityKey,
				proposedNodeId: opportunity.attachment.target_node_id,
				proposedAttempt: opportunity.attachment.target_attempt,
				verdict: "proposed",
				detail: {},
				createdAt: at,
			});
		}
		expect(
			store.listWorkflowResumeShadowOpportunities().map((entry) => entry.runId),
		).toEqual(["run-5"]);
		(store as RawStore).db.run(
			"UPDATE sessions SET status = 'failed' WHERE execution_id = ?",
			[first.executionId],
		);
		expect(
			store.listWorkflowResumeShadowOpportunities().map((entry) => entry.runId),
		).toEqual(["run-1", "run-5"]);
		store.close();
	});

	it("schedules only an exact ready current gate holder", async () => {
		const store = await StateStore.create(":memory:");
		seedGate(store);
		expect(store.listWorkflowResumeShadowOpportunities()).toMatchObject([
			{
				runId: "run-gate",
				opportunityKey: "attachment-gate:ready",
			},
		]);
		(store as RawStore).db.run(
			"UPDATE workflow_gate_holder SET state = 'superseded' WHERE question_id = 'question-gate'",
		);
		expect(store.listWorkflowResumeShadowOpportunities()).toEqual([]);
		store.close();
	});

	it("isolates observer failures to one canonical T5 verdict", async () => {
		const store = await StateStore.create(":memory:");
		seedExecutable(store, 1);
		expect(
			await runWorkflowResumeShadowTick({
				store,
				observeEnvelope: async () => {
					throw new Error("Linear unavailable");
				},
				verifyAnchor: () => true,
				env: {},
				now: at,
			}),
		).toEqual({ processed: 1 });
		expect(store.listWorkflowResumeProbes("run-1")).toMatchObject([
			{
				opportunity_key: "attachment-1:ready",
				verdict: "external_drift",
			},
		]);
		store.close();
	});

	it("retains the newest twenty probes per run and no probes older than ninety days", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-retention",
			issueId: "FLY-R",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		for (let index = 0; index < 25; index += 1) {
			store.recordWorkflowResumeProbe({
				runId: "run-retention",
				opportunityKey: `attachment-${index}:ready`,
				proposedNodeId: "implement",
				proposedAttempt: index + 1,
				verdict: "proposed",
				detail: {},
				createdAt: new Date(Date.parse(at) + index).toISOString(),
			});
		}
		store.recordWorkflowResumeProbe({
			runId: "run-retention",
			opportunityKey: "old:ready",
			proposedNodeId: "implement",
			proposedAttempt: 99,
			verdict: "proposed",
			detail: {},
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		store.pruneWorkflowResumeProbes({ now: at });
		const probes = store.listWorkflowResumeProbes("run-retention");
		expect(probes).toHaveLength(20);
		expect(probes.some((probe) => probe.opportunity_key === "old:ready")).toBe(
			false,
		);
		expect(probes[0]?.opportunity_key).toBe("attachment-5:ready");
		store.close();
	});
});
