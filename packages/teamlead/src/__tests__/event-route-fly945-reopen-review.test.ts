/**
 * FLY-945 Fix C — approved_to_ship → awaiting_review recovery lap (HTTP sink).
 *
 * An approval expires when the head moves after it (verify-approval
 * pr_head_sha mismatch). The runner's recovery is a NEW `gate approve_to_ship
 * --no-block` + `complete --route needs_review --question-id <new>`. The
 * /events sink maps `approved_to_ship + needs_review + NEW questionId + no
 * merged landing` back to awaiting_review with the fresh binding; the SAME
 * combination WITHOUT a new questionId stays on the FLY-208 5a evidence-gap
 * completion (byte-compat).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { applyTransition } from "../applyTransition.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { setHistoricalQaRequiredSnapshot } from "./helpers/historical-qa.js";

const runPostShipSpy = vi.fn(async () => {});
vi.mock("../bridge/post-ship-finalization.js", async () => {
	const actual = await vi.importActual<
		typeof import("../bridge/post-ship-finalization.js")
	>("../bridge/post-ship-finalization.js");
	return {
		...actual,
		runPostShipFinalization: (...args: unknown[]) => runPostShipSpy(...args),
	};
});

const H1 = "a".repeat(40);
const H2 = execFileSync("git", ["rev-parse", "HEAD"], {
	encoding: "utf8",
}).trim();
const Q1 = "11111111-1111-1111-1111-111111111111";
const Q2 = "22222222-2222-2222-2222-222222222222";

const testProjects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		projectRepo: "xrliAnnie/flywheel",
		leads: [
			{
				agentId: "eng-lead",
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
		defaultLeadAgentId: "eng-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	};
}

describe("FLY-945 Fix C: re-open review from approved_to_ship (HTTP /events)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let transitionOpts: ApplyTransitionOpts;
	let stateRoot: string;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	beforeEach(async () => {
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0";
		process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ = "0"; // retired input is ignored
		runPostShipSpy.mockClear();
		stateRoot = mkdtempSync(join(tmpdir(), "fly945-reopen-"));
		store = await StateStore.create(join(stateRoot, "teamlead.db"));
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
	});

	afterEach(async () => {
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
		rmSync(stateRoot, { recursive: true, force: true });
	});

	async function postEvent(body: Record<string, unknown>) {
		const response = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(body),
		});
		if (body.event_type === "session_started") {
			const executionId = String(body.execution_id);
			const session = store.getSession(executionId);
			store.upsertSession({
				execution_id: executionId,
				issue_id: session?.issue_id ?? String(body.issue_id),
				project_name: session?.project_name ?? String(body.project_name),
				status: session?.status ?? "running",
				worktree_path: process.cwd(),
			});
			setHistoricalQaRequiredSnapshot(store, {
				executionId,
				required: 0,
				reason: "re-open review fixture",
			});
		}
		return response;
	}

	/** running → awaiting_review(Q1,H1) → approved_to_ship. */
	async function driveToApproved(execId: string, head = H1) {
		await postEvent({
			event_id: `${execId}-start`,
			execution_id: execId,
			issue_id: `issue-${execId}`,
			project_name: "flywheel",
			event_type: "session_started",
			payload: { issueIdentifier: "FLY-945", issueTitle: "test" },
		});
		await postEvent({
			event_id: `${execId}-review1`,
			execution_id: execId,
			issue_id: `issue-${execId}`,
			project_name: "flywheel",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: { headSha: head },
				reviewQuestionId: Q1,
			},
		});
		expect(store.getSession(execId)?.status).toBe("awaiting_review");
		expect(store.getSession(execId)?.review_question_id).toBe(Q1);
		expect(store.getSession(execId)?.pr_head_sha).toBe(head);
		const approved = applyTransition(
			transitionOpts,
			execId,
			"approved_to_ship",
			{
				executionId: execId,
				issueId: `issue-${execId}`,
				projectName: "flywheel",
				trigger: "action:approve",
			},
		);
		expect(approved.ok).toBe(true);
	}

	it("NEW questionId + no merged landing → awaiting_review with the FRESH binding (recovery lap)", async () => {
		const execId = "exec-recovery";
		await driveToApproved(execId);

		const res = await postEvent({
			event_id: `${execId}-review2`,
			execution_id: execId,
			issue_id: `issue-${execId}`,
			project_name: "flywheel",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: { headSha: H2 },
				reviewQuestionId: Q2,
			},
		});
		expect(res.status).toBe(200);

		const session = store.getSession(execId);
		expect(session?.status).toBe("awaiting_review");
		expect(session?.review_question_id).toBe(Q2);
		expect(session?.pr_head_sha).toBe(H2);
		// A recovery lap is NOT a ship — finalization must not fire.
		expect(runPostShipSpy).not.toHaveBeenCalled();
		// Not an evidence-gap completion either.
		const params = JSON.parse(session?.session_params ?? "{}") as Record<
			string,
			unknown
		>;
		expect(params.fly208_evidence_gap).toBeUndefined();
	});

	it("SAME questionId (re-emission, not a re-review) → FLY-208 5a evidence-gap completion (byte-compat)", async () => {
		const execId = "exec-same-qid";
		await driveToApproved(execId);

		await postEvent({
			event_id: `${execId}-review2`,
			execution_id: execId,
			issue_id: `issue-${execId}`,
			project_name: "flywheel",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: { headSha: H1 },
				reviewQuestionId: Q1,
			},
		});
		const session = store.getSession(execId);
		expect(session?.status).toBe("completed");
		const params = JSON.parse(session?.session_params ?? "{}") as Record<
			string,
			unknown
		>;
		expect(params.fly208_evidence_gap).toBeTruthy();
		expect(runPostShipSpy).not.toHaveBeenCalled();
	});

	it("MISSING questionId → FLY-208 5a evidence-gap completion (byte-compat)", async () => {
		const execId = "exec-no-qid";
		await driveToApproved(execId);

		await postEvent({
			event_id: `${execId}-review2`,
			execution_id: execId,
			issue_id: `issue-${execId}`,
			project_name: "flywheel",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: { headSha: H2 },
			},
		});
		const session = store.getSession(execId);
		expect(session?.status).toBe("completed");
		const params = JSON.parse(session?.session_params ?? "{}") as Record<
			string,
			unknown
		>;
		expect(params.fly208_evidence_gap).toBeTruthy();
	});

	it("NEW questionId but MERGED landing → completed (ship wins; not a recovery lap)", async () => {
		const execId = "exec-merged";
		await driveToApproved(execId, H2);

		await postEvent({
			event_id: `${execId}-review2`,
			execution_id: execId,
			issue_id: `issue-${execId}`,
			project_name: "flywheel",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {
					headSha: H2,
					landingStatus: { status: "merged", prNumber: 9 },
				},
				reviewQuestionId: Q2,
			},
		});
		expect(store.getSession(execId)?.status).toBe("completed");
	});
});
