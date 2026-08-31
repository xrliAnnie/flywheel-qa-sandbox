/**
 * FLY-1041 Fix A (main path) — retire-on-rebind at the /events sink.
 *
 * When a completion REBINDS the review to a NEW question (re-review while
 * awaiting_review, or the FLY-945 approved_to_ship→awaiting_review recovery
 * lap), the SUPERSEDED gate's CommDB row must be retired immediately (drops
 * out of getPendingQuestions) so only ONE approve_to_ship gate is
 * founder-bindable at a time — the FLY-910 multi-gate ambiguity killer.
 *
 * Order: rebind FIRST (authoritative), retire after; a retire failure is a
 * warn (the gate-poller sweeper converges it) and never fails the completion.
 */
import type http from "node:http";
import { CommDB } from "flywheel-comm/db";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { applyTransition } from "../applyTransition.js";
import { commDbPathForProject } from "../bridge/commdb-path.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const LEAD = "eng-lead";
const PROJECT = "flywheel";

const testProjects: ProjectEntry[] = [
	{
		projectName: PROJECT,
		projectRoot: "/tmp/flywheel",
		projectRepo: "xrliAnnie/flywheel",
		leads: [
			{
				agentId: LEAD,
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["engineer"] },
			},
		],
	},
];

function makeConfig(): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: LEAD,
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	};
}

describe("FLY-1041 Fix A: retire-on-rebind (HTTP /events)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let transitionOpts: ApplyTransitionOpts;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		transitionOpts = { store, fsm, executor };
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			transitionOpts,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
		vi.restoreAllMocks();
	});

	async function postEvent(body: Record<string, unknown>) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(body),
		});
	}

	/** Insert a pending approve_to_ship gate in the isolated per-project CommDB. */
	function insertShipGate(execId: string): string {
		const db = new CommDB(commDbPathForProject(PROJECT));
		try {
			return db.insertQuestion(execId, LEAD, "PR ready for review", {
				checkpoint: "approve_to_ship",
			});
		} finally {
			db.close();
		}
	}

	function pendingGateIds(): string[] {
		const db = new CommDB(commDbPathForProject(PROJECT));
		try {
			return db.getPendingQuestions(LEAD).map((q) => q.id);
		} finally {
			db.close();
		}
	}

	async function startRunning(execId: string) {
		const res = await postEvent({
			event_id: `${execId}-start`,
			execution_id: execId,
			issue_id: `issue-${execId}`,
			project_name: PROJECT,
			event_type: "session_started",
			payload: { issueIdentifier: "FLY-1041", issueTitle: "retire test" },
		});
		expect(res.status).toBe(200);
	}

	function completedBody(
		execId: string,
		eventId: string,
		headSha?: string,
		reviewQuestionId?: string,
	) {
		return {
			event_id: eventId,
			execution_id: execId,
			issue_id: `issue-${execId}`,
			project_name: PROJECT,
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: headSha ? { headSha } : {},
				sessionRole: "main",
				...(reviewQuestionId ? { reviewQuestionId } : {}),
			},
		};
	}

	it("re-review with a NEW qid retires the superseded gate + writes the ship_gate_superseded audit event", async () => {
		const execId = "exec-retire";
		await startRunning(execId);
		const q1 = insertShipGate(execId);
		await postEvent(completedBody(execId, "c1", H1, q1));
		expect(store.getSession(execId)?.review_question_id).toBe(q1);
		expect(pendingGateIds()).toContain(q1);

		const q2 = insertShipGate(execId);
		const res = await postEvent(completedBody(execId, "c2", H2, q2));
		expect(res.status).toBe(200);

		// Rebind is authoritative…
		expect(store.getSession(execId)?.review_question_id).toBe(q2);
		// …and the superseded gate is retired: only the NEW gate stays bindable.
		expect(pendingGateIds()).not.toContain(q1);
		expect(pendingGateIds()).toContain(q2);
		const commDb = new CommDB(commDbPathForProject(PROJECT));
		try {
			expect(commDb.getMessageById(q1)).toMatchObject({
				superseded_by: q2,
			});
		} finally {
			commDb.close();
		}

		const events = store.getEventsByExecution(execId);
		const audit = events.find(
			(e) => e.event_id === `ship-gate-superseded-${q1}`,
		);
		expect(audit).toBeDefined();
		expect(audit?.event_type).toBe("ship_gate_superseded");
		expect(audit?.payload).toMatchObject({
			supersededQid: q1,
			newQid: q2,
			by: "event-route",
		});
	});

	it("FLY-945 recovery lap (approved_to_ship → awaiting_review) retires the superseded gate too", async () => {
		const execId = "exec-recovery";
		await startRunning(execId);
		const q1 = insertShipGate(execId);
		await postEvent(completedBody(execId, "r1", H1, q1));
		const approved = applyTransition(
			transitionOpts,
			execId,
			"approved_to_ship",
			{
				executionId: execId,
				issueId: `issue-${execId}`,
				projectName: PROJECT,
				trigger: "action:approve",
			},
		);
		expect(approved.ok).toBe(true);

		const q2 = insertShipGate(execId);
		await postEvent(completedBody(execId, "r2", H2, q2));

		expect(store.getSession(execId)?.status).toBe("awaiting_review");
		expect(store.getSession(execId)?.review_question_id).toBe(q2);
		expect(pendingGateIds()).not.toContain(q1);
		expect(pendingGateIds()).toContain(q2);
	});

	it("SAME qid re-emission (dual-sink duplicate) does NOT retire the current gate", async () => {
		const execId = "exec-same";
		await startRunning(execId);
		const q1 = insertShipGate(execId);
		await postEvent(completedBody(execId, "s1", H1, q1));

		await postEvent(completedBody(execId, "s2", H1, q1));

		// The current gate must survive — it is the ONE bindable gate.
		expect(pendingGateIds()).toContain(q1);
		expect(
			store
				.getEventsByExecution(execId)
				.find((e) => e.event_type === "ship_gate_superseded"),
		).toBeUndefined();
	});

	it("qid-less re-review (protected binding) does NOT retire", async () => {
		const execId = "exec-qidless";
		await startRunning(execId);
		const q1 = insertShipGate(execId);
		await postEvent(completedBody(execId, "p1", H1, q1));

		// Dual-sink qid-less emission: binding preserved, nothing retired.
		await postEvent(completedBody(execId, "p2", H1, undefined));

		expect(store.getSession(execId)?.review_question_id).toBe(q1);
		expect(pendingGateIds()).toContain(q1);
	});

	it("retire failure (comm.db absent) never fails the completion — rebind still lands", async () => {
		const execId = "exec-nodb";
		await startRunning(execId);
		// Bind Q1/Q2 WITHOUT ever creating the comm.db file: the retire hook's
		// CommDB open (createIfMissing=false) throws, is caught, and the
		// completion still succeeds.
		const q1 = "11111111-1111-1111-1111-111111111111";
		const q2 = "22222222-2222-2222-2222-222222222222";
		await postEvent(completedBody(execId, "n1", H1, q1));
		const res = await postEvent(completedBody(execId, "n2", H2, q2));

		expect(res.status).toBe(200);
		expect(store.getSession(execId)?.review_question_id).toBe(q2);
	});
});
