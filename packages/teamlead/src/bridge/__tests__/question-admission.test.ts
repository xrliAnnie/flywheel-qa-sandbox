import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeadConfig, ProjectEntry } from "../../ProjectConfig.js";
import {
	StateStore,
	WorkflowAdmissionClassificationError,
} from "../../StateStore.js";
import { importWorkflowMenuSeeds } from "../../workflow-menu.js";
import { buildWorkflowRunSnapshotV2 } from "../../workflow-run-snapshot.js";
import type { LeadRuntime } from "../lead-runtime.js";
import { QuestionAdmission } from "../question-admission.js";
import { RuntimeRegistry } from "../runtime-registry.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const HEAD = "a".repeat(40);
const menuEngineFlags = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GATE_CARRIER: "1",
};

const resources: Array<{ close(): void }> = [];
afterEach(() => {
	for (const resource of resources.splice(0)) resource.close();
});

const lead: LeadConfig = {
	agentId: "lead-a",
	chatChannel: "chat-a",
	match: { labels: ["Engineering"] },
};
const projects: ProjectEntry[] = [
	{
		projectName: "project-a",
		projectRoot: "/tmp/project-a",
		leads: [
			lead,
			{
				agentId: "lead-b",
				chatChannel: "chat-b",
				match: { labels: ["Operations"] },
			},
		],
	},
];

function harness(
	labels = ["Engineering"],
	status = "running",
	gatePresentation: { allow: boolean; reason: string } = {
		allow: true,
		reason: "legacy",
	},
	now?: () => Date,
) {
	const dbPath = join(
		mkdtempSync(join(tmpdir(), "fly1572-admission-")),
		"comm.db",
	);
	const db = new CommDB(dbPath);
	const queue = new MailboxQueue(dbPath);
	resources.push(db, queue);
	queue.acquireOrRenewOwner({
		ownerEpoch: "owner-1",
		now: "2026-08-05T12:00:00.000Z",
		leaseTtlMs: 60_000,
	});
	const session = {
		execution_id: "exec-1",
		issue_id: "issue-1",
		issue_identifier: "FLY-1",
		project_name: "project-a",
		status,
		session_role: "main",
		issue_labels: JSON.stringify(labels),
	};
	const store = {
		getSession: vi.fn(() => session),
		getGeneralizedWorkflowNodeForExecution: vi.fn(() => undefined),
		resolveCurrentWorkflowActivation: vi.fn(() => ({ kind: "none" })),
		appendLeadEvent: vi.fn(() => 41),
		workflowGatePresentationDisposition: vi.fn(() => gatePresentation),
	};
	const registry = new RuntimeRegistry();
	registry.register(lead, {
		type: "test",
		deliver: vi.fn(),
		renderEnvelope: (envelope) => `rendered:${envelope.event.summary}`,
		sendBootstrap: vi.fn(),
		health: vi.fn(),
		shutdown: vi.fn(),
	} as unknown as LeadRuntime);
	const admission = new QuestionAdmission({
		queue,
		dbPath,
		lead,
		projects,
		store: store as never,
		runtimeRegistry: registry,
		now,
	});
	resources.push(admission);
	return { admission, db, queue, store };
}

function claim(queue: MailboxQueue) {
	return queue.claimLeadBatch({
		toAgent: "lead-a",
		msgClass: "model",
		ownerEpoch: "owner-1",
		batchId: "batch-1",
		now: "2026-08-05T12:00:00.000Z",
		claimTtlMs: 60_000,
	})[0]!;
}

describe("QuestionAdmission mailbox claim service", () => {
	it("materializes an eligible gate on its existing mailbox row", async () => {
		const h = harness();
		const deadline = "2026-08-06T12:00:00.000Z";
		const id = h.db.insertQuestion("exec-1", "lead-a", "need approval", {
			checkpoint: "question",
			deadlineAt: deadline,
		});
		expect(await h.admission.revalidate(claim(h.queue))).toEqual({
			deliver: true,
		});
		expect(h.queue.getById(id)).toMatchObject({
			id,
			delivery_id: `question:lead-a:${id}`,
			type: "question",
			source_kind: "question",
			source_ref: "41",
			delivery_content: "rendered:need approval",
			relay_state: "protected",
			deadline_at: deadline,
		});
		expect(h.store.appendLeadEvent).toHaveBeenCalledTimes(1);
	});

	it("preserves report kind in the materialized runner event", async () => {
		const h = harness();
		const id = h.db.insertQuestion(
			"exec-1",
			"lead-a",
			"RUNNER-STOPPED kind=runner_stopped reason=done issue=FLY-1 exec=exec-1 route=- detail=parked",
			{ id: `rstop-${"c".repeat(32)}`, kind: "report" },
		);
		expect(await h.admission.revalidate(claim(h.queue))).toEqual({
			deliver: true,
		});
		const payload = JSON.parse(
			h.store.appendLeadEvent.mock.calls[0]![3] as string,
		);
		expect(payload).toMatchObject({
			event_type: "runner_question",
			question_id: id,
			question_kind: "report",
		});
	});

	it("permanently rejects a Lead-scope mismatch", async () => {
		const h = harness(["Operations"]);
		h.db.insertQuestion("exec-1", "lead-a", "misrouted", {
			checkpoint: "question",
		});
		expect(await h.admission.revalidate(claim(h.queue))).toEqual({
			deliver: false,
			disposition: "revoked_lead_scope",
			retry: false,
		});
		expect(h.store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("admits founder_review only from the exact sealed capable run", async () => {
		const h = harness();
		h.store.resolveCurrentWorkflowActivation.mockReturnValue({
			kind: "current",
			run: { run_id: "run-1" },
			node: { id: "produce" },
			snapshot: {
				manifest: { nodes: [{ id: "produce", founder_review: true }] },
			},
		} as never);
		h.db.insertQuestion(
			"exec-1",
			"lead-a",
			JSON.stringify({
				version: 1,
				round: 1,
				runId: "run-1",
				artifactDigest: "a".repeat(64),
				hostedUrl: "https://reports.example/prd",
				paths: ["review.html"],
			}),
			{ checkpoint: "founder_review" },
		);
		expect(await h.admission.revalidate(claim(h.queue))).toEqual({
			deliver: true,
		});
	});

	it.each([
		["missing sealed capability", false, "run-1"],
		["self-asserted foreign run", true, "run-forged"],
	] as const)(
		"rejects founder_review with %s",
		async (_label, capable, runId) => {
			const h = harness();
			h.store.resolveCurrentWorkflowActivation.mockReturnValue({
				kind: "current",
				run: { run_id: "run-1" },
				node: { id: "produce" },
				snapshot: {
					manifest: { nodes: [{ id: "produce", founder_review: capable }] },
				},
			} as never);
			h.db.insertQuestion(
				"exec-1",
				"lead-a",
				JSON.stringify({
					version: 1,
					round: 1,
					runId,
					artifactDigest: "a".repeat(64),
					hostedUrl: "https://reports.example/prd",
					paths: ["review.html"],
				}),
				{ checkpoint: "founder_review" },
			);
			expect(await h.admission.revalidate(claim(h.queue))).toEqual({
				deliver: false,
				disposition: "revoked_founder_review_authority",
				retry: false,
			});
		},
	);

	it.each([
		["none", { kind: "none" }],
		[
			"ambiguous",
			{ kind: "ambiguous", activationIds: ["activation-1", "activation-2"] },
		],
	] as const)(
		"retries founder_review while current activation authority is %s",
		async (_label, activation) => {
			const h = harness();
			h.store.resolveCurrentWorkflowActivation.mockReturnValue(
				activation as never,
			);
			h.db.insertQuestion(
				"exec-1",
				"lead-a",
				JSON.stringify({
					version: 1,
					round: 1,
					runId: "run-1",
					artifactDigest: "a".repeat(64),
					hostedUrl: "https://reports.example/prd",
					paths: ["review.html"],
				}),
				{ checkpoint: "founder_review" },
			);

			expect(await h.admission.revalidate(claim(h.queue))).toEqual({
				deliver: false,
				disposition: "revoked_founder_review_authority",
				retry: true,
			});
		},
	);

	it("FLY-1788: admits founder_review from the current activation when one exec has two bindings", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1788-question-admission-"));
		mkdirSync(join(root, ".flywheel", "agents", "nodes"), {
			recursive: true,
		});
		mkdirSync(join(root, ".flywheel", "menus"), { recursive: true });
		writeFileSync(
			join(root, ".flywheel", "agents", "nodes", "pm.md"),
			"Write the PRD.\n",
		);
		writeFileSync(
			join(root, ".flywheel", "agents", "registry.yaml"),
			"nodes:\n  pm: { file: nodes/pm.md, department: engineering }\n",
		);
		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			"project: project-a\n",
		);
		writeFileSync(
			join(root, ".flywheel", "menus", "adoption.yaml"),
			"lead-a:\n  - prd\n",
		);
		const dbPath = join(root, "comm.db");
		const db = new CommDB(dbPath);
		const queue = new MailboxQueue(dbPath);
		const store = await StateStore.create(":memory:");
		resources.push(db, queue, store, {
			close: () => rmSync(root, { recursive: true, force: true }),
		});
		queue.acquireOrRenewOwner({
			ownerEpoch: "owner-1",
			now: "2026-08-16T08:00:00.000Z",
			leaseTtlMs: 60_000,
		});
		importWorkflowMenuSeeds(store, menuEngineFlags);
		store.materializeWorkflowRun({
			runId: "run-fly1788",
			issueId: "FLY-1788",
			projectName: "project-a",
			taskCategory: "prd",
			templateId: "tpl_prd",
			claimsReadEnrolled: true,
			actor: "lead-a",
			canonicalRoot: root,
			env: menuEngineFlags,
			startReservation: {
				idempotencyKey: "start-fly1788",
				selectionDigest: "selection-fly1788",
				nodeId: "pm",
				attempt: 1,
				executionId: "exec-1",
				createdAt: "2026-08-16T08:00:00.000Z",
			},
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-fly1788",
				nodeId: "pm",
				executionId: "exec-1",
				attempt: 1,
				activationId: "activation-fly1788-1",
				expiresAt: "2026-08-16T10:00:00.000Z",
				absoluteDeadlineAt: "2026-08-17T08:00:00.000Z",
				now: "2026-08-16T08:01:00.000Z",
				env: menuEngineFlags,
			}),
		).toMatchObject({ ok: true });
		store.upsertWorkflowRunNode({
			runId: "run-fly1788",
			nodeId: "pm",
			attempt: 2,
			state: "pending",
			executionId: "exec-1",
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-fly1788",
				nodeId: "pm",
				executionId: "exec-1",
				attempt: 2,
				activationId: "activation-fly1788-2",
				activationMode: "wake",
				expiresAt: "2026-08-16T10:00:00.000Z",
				absoluteDeadlineAt: "2026-08-17T08:00:00.000Z",
				now: "2026-08-16T08:02:00.000Z",
				env: menuEngineFlags,
			}),
		).toMatchObject({ ok: true });
		expect(store.listWorkflowActivationsForActor("exec-1")).toHaveLength(2);
		expect(store.resolveCurrentWorkflowActivation("exec-1")).toMatchObject({
			kind: "current",
			binding: { activation_id: "activation-fly1788-2", attempt: 2 },
		});
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-1788",
			issue_identifier: "FLY-1788",
			project_name: "project-a",
			status: "running",
			issue_labels: JSON.stringify(["Engineering"]),
		});
		db.insertQuestion(
			"exec-1",
			"lead-a",
			JSON.stringify({
				version: 1,
				round: 2,
				runId: "run-fly1788",
				artifactDigest: "a".repeat(64),
				hostedUrl: "https://reports.example/prd-r2",
				paths: ["review.html"],
			}),
			{ checkpoint: "founder_review" },
		);
		const admission = new QuestionAdmission({
			queue,
			dbPath,
			lead,
			projects,
			store,
			runtimeRegistry: new RuntimeRegistry(),
		});
		resources.push(admission);

		expect(await admission.revalidate(claim(queue))).toEqual({ deliver: true });
	});

	it.each(["completed", "ship_parked", "blocked"])(
		"materializes the current workflow gate for a %s source session",
		async (status) => {
			const h = harness(["Engineering"], status, {
				allow: true,
				reason: "holder_authoritative",
			});
			h.db.insertQuestion("exec-1", "lead-a", "ready to ship", {
				checkpoint: "approve_to_ship",
			});
			expect(await h.admission.revalidate(claim(h.queue))).toEqual({
				deliver: true,
			});
			expect(h.store.appendLeadEvent).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps legacy gates fenced by terminal session status", async () => {
		const h = harness(["Engineering"], "completed");
		h.db.insertQuestion("exec-1", "lead-a", "legacy ship gate", {
			checkpoint: "approve_to_ship",
		});
		expect(await h.admission.revalidate(claim(h.queue))).toEqual({
			deliver: false,
			disposition: "revoked_terminal_session",
			retry: false,
		});
		expect(h.store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("keeps Lead scope fencing for a holder-authoritative gate", async () => {
		const h = harness(["Operations"], "completed", {
			allow: true,
			reason: "holder_authoritative",
		});
		h.db.insertQuestion("exec-1", "lead-a", "misrouted workflow gate", {
			checkpoint: "approve_to_ship",
		});
		expect(await h.admission.revalidate(claim(h.queue))).toEqual({
			deliver: false,
			disposition: "revoked_lead_scope",
			retry: false,
		});
		expect(h.store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it.each([
		["pending", true],
		["ship_parked", true],
		["design_done", true],
		["failed", true],
		["rejected", true],
		["deferred", true],
		["approved", false],
		["completed", false],
		["shelved", false],
		["terminated", false],
	] as const)(
		"classifies a %s terminal-session fence from FSM reachability",
		async (status, retry) => {
			const h = harness(["Engineering"], status);
			h.db.insertQuestion("exec-1", "lead-a", `gate:${status}`, {
				checkpoint: "approve_to_ship",
			});
			expect(await h.admission.revalidate(claim(h.queue))).toEqual({
				deliver: false,
				disposition: "revoked_terminal_session",
				retry,
			});
		},
	);

	it("stops a retryable verdict at the inclusive 24-hour horizon", async () => {
		const nowMs = Date.parse("2026-08-12T12:00:00.000Z");
		const h = harness(
			["Engineering"],
			"failed",
			{ allow: true, reason: "legacy" },
			() => new Date(nowMs),
		);
		h.db.insertQuestion("exec-1", "lead-a", "horizon", {
			checkpoint: "approve_to_ship",
		});
		const row = claim(h.queue);
		row.expires_at = new Date(nowMs + 24 * 60 * 60_000).toISOString();
		expect(await h.admission.revalidate(row)).toEqual({
			deliver: false,
			disposition: "revoked_terminal_session",
			retry: false,
		});
	});

	it.each([null, "not-a-timestamp"])(
		"rejects an invalid expiry before reading session state (%s)",
		async (expiresAt) => {
			const h = harness();
			h.db.insertQuestion("exec-1", "lead-a", "bad expiry");
			const row = claim(h.queue);
			row.expires_at = expiresAt;
			expect(await h.admission.revalidate(row)).toEqual({
				deliver: false,
				disposition: "expiry_integrity",
				retry: false,
			});
			expect(h.store.getSession).not.toHaveBeenCalled();
		},
	);

	it("converts only typed snapshot classification failures into verdicts", async () => {
		const h = harness();
		h.db.insertQuestion("exec-1", "lead-a", "corrupt snapshot", {
			checkpoint: "approve_to_ship",
		});
		h.store.workflowGatePresentationDisposition.mockImplementation(() => {
			throw new WorkflowAdmissionClassificationError("corrupt snapshot");
		});
		expect(await h.admission.revalidate(claim(h.queue))).toEqual({
			deliver: false,
			disposition: "admission_error",
			retry: true,
		});
	});

	it("rethrows infrastructure errors without consuming the row", async () => {
		const h = harness();
		h.db.insertQuestion("exec-1", "lead-a", "busy", {
			checkpoint: "approve_to_ship",
		});
		const row = claim(h.queue);
		h.store.workflowGatePresentationDisposition.mockImplementation(() => {
			throw new Error("SQLITE_BUSY");
		});
		await expect(h.admission.revalidate(row)).rejects.toThrow("SQLITE_BUSY");
		expect(h.queue.getById(row.id)?.state).toBe("LEASED");
	});

	it("delivers a generic land gate while its source remains durably parked", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "fly1731-land-admission-")),
			"comm.db",
		);
		const db = new CommDB(dbPath);
		const queue = new MailboxQueue(dbPath);
		const store = await StateStore.create(":memory:");
		resources.push(db, queue, store);
		queue.acquireOrRenewOwner({
			ownerEpoch: "owner-1",
			now: "2026-08-12T14:33:40.000Z",
			leaseTtlMs: 60_000,
		});
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "tpl_fly1731_land", revision: 1 },
			canonicalRoot: REPO_ROOT,
			manifest: {
				schema_version: 2,
				nodes: [
					{
						id: "produce",
						type: "generic",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "low",
						agent_file: ".flywheel/agents/nodes/general.md",
					},
					{ id: "founder_gate", type: "gate" },
					{ id: "land", type: "land", execution: "engine" },
				],
				edges: [
					{
						id: "produced",
						from: "produce",
						to: "founder_gate",
						condition: "node_done",
					},
					{
						id: "approved",
						from: "founder_gate",
						to: "land",
						condition: "founder_approved",
					},
				],
				loops: [],
				approval_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				terminal_node: { node: "land" },
				ship_claims: ["founder_approved"],
			},
		});
		store.createWorkflowRun({
			runId: "run-fly1731",
			issueId: "FLY-1704",
			projectName: "project-a",
			snapshotJson: JSON.stringify(snapshot),
			claimsReadEnrolled: true,
		});
		const stateDb = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		stateDb.run(
			"UPDATE workflow_run SET engine_owned = 1, gate_carrier_epoch = 1 WHERE run_id = 'run-fly1731'",
		);
		stateDb.run(
			`INSERT INTO workflow_side_effect_ledger
			   (run_id, node_id, attempt, kind, launch_ordinal, execution_id, state, created_at, updated_at)
			 VALUES ('run-fly1731', 'produce', 1, 'dispatch', 1, 'exec-1', 'intent_recorded',
			         '2026-08-12T14:30:00.000Z', '2026-08-12T14:30:00.000Z')`,
		);
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-fly1731",
				nodeId: "produce",
				executionId: "exec-1",
				attempt: 1,
				expiresAt: "2026-08-13T14:30:00.000Z",
				absoluteDeadlineAt: "2026-08-15T14:30:00.000Z",
				now: "2026-08-12T14:30:00.000Z",
				env: {
					FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
					FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
				},
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-1704",
			issue_identifier: "FLY-1704",
			project_name: "project-a",
			status: "running",
			issue_labels: JSON.stringify(["Engineering"]),
		});
		expect(
			store.commitEnrolledCompletion({
				nodeReuseEnabled: false,
				executionId: "exec-1",
				route: "needs_review",
				sourceEventId: "complete-fly1731",
				completionSubmission: { decision: { route: "needs_review" } },
				subjectDigest: HEAD,
				prBinding: {
					prNumber: 813,
					headSha: HEAD,
					targetRepoIdentity: "__main__",
					probeRepoSlug: "geoforge3d/flywheel",
					targetRepoPath: REPO_ROOT,
					worktreeBindingGeneration: "generation-1",
				},
				now: "2026-08-12T14:33:29.000Z",
			}),
		).toMatchObject({
			ok: true,
			completionDisposition: "engine_gate_handoff",
		});
		expect(store.getSession("exec-1")?.status).toBe("ship_parked");
		expect(store.getCurrentWorkflowEngineParkEvidence("exec-1")).toMatchObject({
			event: "park_opened",
			reason: "rework_reachable_wait",
		});
		const holder = store.getCurrentWorkflowGateHolder(
			"run-fly1731",
			"founder_gate",
		)!;
		db.insertQuestion("exec-1", "lead-a", "ready to ship", {
			id: holder.question_id,
			checkpoint: "approve_to_ship",
		});
		const admission = new QuestionAdmission({
			queue,
			dbPath,
			lead,
			projects,
			store,
			runtimeRegistry: new RuntimeRegistry(),
		});
		resources.push(admission);
		expect(await admission.revalidate(claim(queue))).toEqual({ deliver: true });
		const delivered = queue.getById(holder.question_id)!;
		expect(delivered.source_ref).not.toBeNull();
		expect(JSON.parse(delivered.delivery_content!)).toMatchObject({
			event_type: "gate_question",
			checkpoint: "approve_to_ship",
			execution_id: "exec-1",
		});
	});

	it("delivers the tpl_code founder gate while its implement remains parked for QA rework", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "fly1765-code-land-admission-")),
			"comm.db",
		);
		const db = new CommDB(dbPath);
		const queue = new MailboxQueue(dbPath);
		const store = await StateStore.create(":memory:");
		resources.push(db, queue, store);
		queue.acquireOrRenewOwner({
			ownerEpoch: "owner-1",
			now: "2026-08-14T10:00:00.000Z",
			leaseTtlMs: 60_000,
		});

		importWorkflowMenuSeeds(store, menuEngineFlags);
		store.bindWorkflowCategory({
			project: "project-a",
			taskCategory: "code",
			templateId: "tpl_code",
			updatedBy: "lead-a",
		});
		store.materializeWorkflowRun({
			runId: "run-fly1765",
			issueId: "FLY-1765",
			projectName: "project-a",
			taskCategory: "code",
			claimsReadEnrolled: true,
			actor: "lead-a",
			canonicalRoot: REPO_ROOT,
			env: menuEngineFlags,
			startReservation: {
				idempotencyKey: "start-fly1765",
				selectionDigest: "selection-fly1765",
				nodeId: "eng_design",
				attempt: 1,
				executionId: "design-fly1765",
				createdAt: "2026-08-14T09:30:00.000Z",
			},
		});
		store.upsertWorkflowRunNode({
			runId: "run-fly1765",
			nodeId: "eng_design",
			attempt: 1,
			state: "running",
			executionId: "design-fly1765",
		});
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "run-fly1765",
				nodeId: "eng_design",
				attempt: 1,
				executionId: "design-fly1765",
				outcome: "design_done",
				successorExecutionId: "implement-fly1765",
				now: "2026-08-14T09:35:00.000Z",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-fly1765",
				nodeId: "implement",
				executionId: "implement-fly1765",
				attempt: 1,
				expiresAt: "2026-08-14T12:00:00.000Z",
				absoluteDeadlineAt: "2026-08-15T10:00:00.000Z",
				now: "2026-08-14T09:36:00.000Z",
				env: menuEngineFlags,
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: "implement-fly1765",
			issue_id: "FLY-1765",
			issue_identifier: "FLY-1765",
			project_name: "project-a",
			status: "running",
			session_role: "implement",
			issue_labels: JSON.stringify(["Engineering"]),
			workflow_node_id: "implement",
		});
		expect(
			store.commitEnrolledCompletion({
				nodeReuseEnabled: false,
				executionId: "implement-fly1765",
				route: "needs_review",
				sourceEventId: "complete-implement-fly1765",
				completionSubmission: { decision: { route: "needs_review" } },
				subjectDigest: HEAD,
				prBinding: {
					prNumber: 837,
					headSha: HEAD,
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					targetRepoPath: REPO_ROOT,
					worktreeBindingGeneration: "generation-fly1765",
				},
				now: "2026-08-14T09:40:00.000Z",
			}),
		).toMatchObject({ ok: true, completionDisposition: "terminal_no_gate" });
		expect(store.getSession("implement-fly1765")?.status).toBe("ship_parked");

		const qaExecutionId = store
			.listWorkflowSideEffects("run-fly1765")
			.find((effect) => effect.node_id === "qa")!.execution_id;
		const qaAdmission = store.admitGeneralizedWorkflowExecution({
			runId: "run-fly1765",
			nodeId: "qa",
			executionId: qaExecutionId,
			attempt: 1,
			expiresAt: "2026-08-14T12:00:00.000Z",
			absoluteDeadlineAt: "2026-08-15T10:00:00.000Z",
			now: "2026-08-14T09:41:00.000Z",
			env: menuEngineFlags,
		});
		if (!qaAdmission.ok || !qaAdmission.submissionCredential) {
			throw new Error("QA admission failed");
		}
		store.upsertSession({
			execution_id: qaExecutionId,
			issue_id: "FLY-1765",
			issue_identifier: "FLY-1765",
			project_name: "project-a",
			status: "running",
			session_role: "qa",
			issue_labels: JSON.stringify(["Engineering"]),
			workflow_node_id: "qa",
		});
		expect(
			store.submitWorkflowDecisionByCredential({
				nodeReuseEnabled: false,
				credential: qaAdmission.submissionCredential,
				clientRequestId: "qa-pass-fly1765",
				predicate: "qa_passed",
				subjectDigest: HEAD,
				issuerVendor: "claude",
				issuerModel: "claude-opus-4-8",
				subjectProducerExecutionId: "implement-fly1765",
				subjectProducerVendor: "codex",
				claimExpiresAt: "2026-08-14T12:00:00.000Z",
				gateEntryBinding: {
					kind: "worktree",
					prNumber: 837,
					headSha: HEAD,
					targetRepoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					targetRepoPath: REPO_ROOT,
					worktreeBindingGeneration: "generation-fly1765",
					expectedProducerMirrorHead: HEAD,
				},
				alertIdentity: {
					leadId: "lead-a",
					projectName: "project-a",
					leadResolution: "resolved",
				},
				now: "2026-08-14T09:45:00.000Z",
			}),
		).toMatchObject({ ok: true });
		const holder = store.getCurrentWorkflowGateHolder(
			"run-fly1765",
			"founder_gate",
		)!;
		expect(holder).toMatchObject({
			authority_mode: "land",
			source_execution_id: qaExecutionId,
		});
		db.insertQuestion(qaExecutionId, "lead-a", "ready to ship", {
			id: holder.question_id,
			checkpoint: "approve_to_ship",
		});
		const admission = new QuestionAdmission({
			queue,
			dbPath,
			lead,
			projects,
			store,
			runtimeRegistry: new RuntimeRegistry(),
		});
		resources.push(admission);
		expect(await admission.revalidate(claim(queue))).toEqual({ deliver: true });
		const delivered = queue.getById(holder.question_id)!;
		expect(JSON.parse(delivered.delivery_content!)).toMatchObject({
			event_type: "gate_question",
			checkpoint: "approve_to_ship",
			execution_id: qaExecutionId,
		});
		expect(store.getSession("implement-fly1765")?.status).toBe("ship_parked");
	});

	it("terminally revokes an answered question", async () => {
		const h = harness();
		const id = h.db.insertQuestion("exec-1", "lead-a", "answer me");
		expect(h.db.insertResponse(id, "lead-a", "answered")).toMatchObject({
			written: true,
		});
		expect(await h.admission.revalidate(claim(h.queue))).toEqual({
			deliver: false,
			disposition: "revoked_answered",
			retry: false,
		});
	});

	it("reuses one CommDB connection across revalidation calls", async () => {
		const h = harness();
		h.db.insertQuestion("exec-1", "lead-a", "question");
		const row = claim(h.queue);
		const accessor = vi.spyOn(
			h.admission as unknown as { commDb: () => CommDB },
			"commDb",
		);
		await h.admission.revalidate(row);
		await h.admission.revalidate(h.queue.getById(row.id)!);
		expect(accessor.mock.results[1]?.value).toBe(
			accessor.mock.results[0]?.value,
		);
	});
});
