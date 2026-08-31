/**
 * FLY-1505 QA (independent verification phase).
 *
 * The implement phase proved the pieces (settle helper, per-sink deflection,
 * re-wake suppression) and proved `verifyApproval` stays green after calling
 * `settleShipAttemptFailed` directly. Three things were still unproven:
 *
 *   1. THE FULL CHAIN. Nothing drove a real `POST /events` completion through
 *      the real router and THEN ran the real `verifyApproval` against the
 *      resulting on-disk state. That chain — runner emits, Bridge deflects,
 *      approval is still spendable — IS the issue.
 *   2. A POSITIVE CONTROL. Without a case where `verifyApproval` REFUSES, an
 *      `approved: true` assertion cannot distinguish "the deflection worked"
 *      from "this assertion can never fail".
 *   3. THE RE-REVIEW SEAM against REAL params. The suppression parser was only
 *      exercised on hand-written JSON; a marker minted by the production write
 *      path must also stop suppressing once a fresh approval binding lands.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { verifyApproval } from "flywheel-comm/verify-approval";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { createBridgeApp } from "../bridge/plugin.js";
import {
	isRewakeCandidate,
	shipAttemptFailedSuppressedHead,
} from "../bridge/stale-approved-ship-reconciler.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const EXEC = "exec-fly1505-qa";
const ISSUE = "FLY-1505";
const HEAD = "c".repeat(40);
const PR = 715;

const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		projectRepo: "xrliAnnie/flywheel",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Flywheel"] },
			},
		],
	},
];

function makeConfig(dbPath: string): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath,
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "flywheel-eng-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	};
}

describe("FLY-1505 QA: a stalled ship attempt must not spend the founder approval", () => {
	let tmp: string;
	let stateDbPath: string;
	let commDbPath: string;
	let store: StateStore;
	let server: http.Server | undefined;
	let baseUrl: string;
	let transitionOpts: ApplyTransitionOpts;
	let questionId: string;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	async function postCompletion(
		route: string,
		eventId: string,
		attemptQuestionId: string | null = questionId,
	) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: eventId,
				execution_id: EXEC,
				issue_id: ISSUE,
				project_name: "flywheel",
				event_type: "session_completed",
				payload: {
					decision: { route },
					...(attemptQuestionId === null
						? {}
						: { reviewQuestionId: attemptQuestionId }),
					summary: "ship job still running at 25 minutes",
					evidence: { headSha: HEAD },
				},
			}),
		});
	}

	/** Close the HTTP server + flush the store so verifyApproval reads real files. */
	async function settleToDisk() {
		if (server) {
			await new Promise<void>((resolve, reject) => {
				server?.close((err) => (err ? reject(err) : resolve()));
			});
			server = undefined;
		}
		store.close();
	}

	function runVerifyApproval() {
		return verifyApproval({
			execId: EXEC,
			prHead: HEAD,
			dbPath: commDbPath,
			stateDbPath,
			codexDotenvPath: join(tmp, "missing.env"),
			ciProbe: () => ({ green: true, reason: "ci_green" }),
		});
	}

	beforeEach(async () => {
		// Same gate stubs the sibling FLY-108 integration suite uses: these are
		// legacy-session FSM paths, not the merge-approval gate under test here.
		vi.stubEnv("FLYWHEEL_WORKFLOW_CLAIMS_READ", "0");

		tmp = mkdtempSync(join(tmpdir(), "fly1505-qa-"));
		stateDbPath = join(tmp, "teamlead.db");
		commDbPath = join(tmp, "comm.db");

		// A REAL structured founder approval, bound to one question id.
		const comm = new CommDB(commDbPath);
		questionId = comm.insertQuestion(EXEC, "flywheel-eng-lead", "PR ready", {
			checkpoint: "approve_to_ship",
		});
		comm.insertResponse(
			questionId,
			"bridge",
			JSON.stringify({ approved: true }),
		);
		comm.close();

		store = await StateStore.create(stateDbPath);
		store.upsertSession({
			execution_id: EXEC,
			issue_id: ISSUE,
			project_name: "flywheel",
			status: "awaiting_review",
			pr_number: PR,
		});
		store.setReviewBinding(EXEC, { questionId, prHeadSha: HEAD });
		store.recordCodexReviewApproved({
			executionId: EXEC,
			targetPrHeadSha: HEAD,
			issueId: ISSUE,
			projectName: "flywheel",
			authorFamily: "claude",
			reviewerFamily: "codex",
		});
		expect(store.getCodexReviewRecord(EXEC, HEAD)).toMatchObject({
			author_family: "claude",
			reviewer_family: "codex",
		});
		store.persistTransition(EXEC, "approved_to_ship", {
			issue_id: ISSUE,
			project_name: "flywheel",
		});

		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		transitionOpts = { store, fsm, executor: new DirectiveExecutor(store) };
		const app = createBridgeApp(
			store,
			projects,
			makeConfig(stateDbPath),
			undefined,
			transitionOpts,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server?.once("listening", resolve));
		const addr = server.address();
		baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		if (server) {
			await new Promise<void>((resolve, reject) => {
				server?.close((err) => (err ? reject(err) : resolve()));
			});
			server = undefined;
		}
		try {
			store.close();
		} catch {
			/* already closed by settleToDisk */
		}
		rmSync(tmp, { recursive: true, force: true });
	});

	// The headline regression, end to end, for BOTH the new explicit route and
	// the legacy `blocked` route an already-in-flight old-protocol runner emits.
	it.each(["ship_attempt_failed", "blocked"])(
		"POST /events route=%s while the ship job is still running keeps the approval spendable",
		async (route) => {
			// The legacy `blocked` route intentionally carries NO approval
			// binding. A live sink must use the simultaneously-current row
			// binding; delayed marker replay remains event-only.
			const res = await postCompletion(
				route,
				`qa-${route}`,
				route === "blocked" ? null : questionId,
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				ok: true,
				warning: expect.stringContaining("approved_to_ship preserved"),
			});

			// The session never left the approved state...
			expect(store.getSession(EXEC)?.status).toBe("approved_to_ship");
			// ...and the failed attempt is durably recorded for Lead recovery.
			expect(store.getSessionParams(EXEC)).toMatchObject({
				fly1505_ship_attempt_failed: {
					head_sha: HEAD,
					attempt_count: 1,
					review_question_id: questionId,
				},
			});
			const row = store.getSession(EXEC);
			const suppressed = shipAttemptFailedSuppressedHead(
				row?.session_params,
				questionId,
			);
			expect(suppressed).toBe(HEAD);
			expect(
				isRewakeCandidate(
					{
						execution_id: EXEC,
						issue_id: ISSUE,
						project_name: "flywheel",
						status: row?.status,
						review_question_id: row?.review_question_id,
						pr_head_sha: row?.pr_head_sha,
						last_activity_at: new Date(Date.now() - 10 * 60_000)
							.toISOString()
							.replace("T", " ")
							.replace("Z", ""),
						shipAttemptFailedHead: suppressed,
					},
					{ nowMs: Date.now(), graceMs: 5 * 60_000 },
				),
			).toBe(false);

			await settleToDisk();

			// The actual thing FLY-1497 lost: the approval is still usable.
			expect(runVerifyApproval()).toMatchObject({
				approved: true,
				reason: "approved",
				questionId,
				exitCode: 0,
			});
		},
	);

	it("same-head completion from an older approval binding cannot suppress the current approval", async () => {
		const res = await postCompletion(
			"ship_attempt_failed",
			"qa-stale-binding",
			"11111111-1111-1111-1111-111111111111",
		);
		expect(res.status).toBe(200);
		expect(store.getSession(EXEC)?.status).toBe("approved_to_ship");
		expect(
			store.getSessionParams(EXEC)?.fly1505_ship_attempt_failed,
		).toBeUndefined();
	});

	// POSITIVE CONTROL. Proves the assertion above can fail: the very same
	// CommDB approval, same head, same binding — only the session status
	// differs — is refused for exactly the FLY-1497 reason.
	it("POSITIVE CONTROL: the identical approval is refused once the session really is blocked", async () => {
		store.persistTransition(EXEC, "blocked", {
			issue_id: ISSUE,
			project_name: "flywheel",
		});
		expect(store.getSession(EXEC)?.status).toBe("blocked");

		await settleToDisk();

		expect(runVerifyApproval()).toMatchObject({
			approved: false,
			reason: "status_not_approved_to_ship",
		});
	});

	// The deflection must be scoped to the post-approval ship phase only.
	it("byte-compat: route=blocked on a session that is NOT approved still terminalizes to blocked", async () => {
		store.persistTransition(EXEC, "running", {
			issue_id: ISSUE,
			project_name: "flywheel",
		});
		expect(store.getSession(EXEC)?.status).toBe("running");

		const res = await postCompletion("blocked", "qa-running-blocked");
		expect(res.status).toBe(200);
		expect(store.getSession(EXEC)?.status).toBe("blocked");
		expect(
			store.getSessionParams(EXEC)?.fly1505_ship_attempt_failed,
		).toBeUndefined();
	});

	// The explicit route is only meaningful after approval; it must not be a
	// backdoor that silently swallows a completion from any other state.
	it("route=ship_attempt_failed is refused (fail-loud, non-retryable) when the session is not approved", async () => {
		store.persistTransition(EXEC, "running", {
			issue_id: ISSUE,
			project_name: "flywheel",
		});
		const res = await postCompletion(
			"ship_attempt_failed",
			"qa-running-attempt",
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ ok: false, retryable: false });
		expect(store.getSession(EXEC)?.status).toBe("running");
	});

	// The re-wake suppressor must read a marker minted by the PRODUCTION write
	// path (not a hand-written fixture) and must let go the moment a fresh
	// approval binding replaces the one the failed attempt belonged to.
	it("suppresses automatic re-wake for the failed attempt's own approval, and releases on re-review", async () => {
		expect(
			(await postCompletion("ship_attempt_failed", "qa-rewake")).status,
		).toBe(200);

		const row = store.getSession(EXEC);
		const rawParams = row?.session_params;
		expect(rawParams).toBeTruthy();

		// Same approval binding + same head → automatic re-wake paused.
		const suppressed = shipAttemptFailedSuppressedHead(rawParams, questionId);
		expect(suppressed).toBe(HEAD);
		expect(
			isRewakeCandidate(
				{
					execution_id: EXEC,
					issue_id: ISSUE,
					project_name: "flywheel",
					status: "approved_to_ship",
					review_question_id: questionId,
					pr_head_sha: HEAD,
					last_activity_at: new Date(Date.now() - 10 * 60_000)
						.toISOString()
						.replace("T", " ")
						.replace("Z", ""),
					shipAttemptFailedHead: suppressed,
				},
				{ nowMs: Date.now(), graceMs: 5 * 60_000 },
			),
		).toBe(false);

		// A fresh review window (new question id) is a new approval lap — the
		// stale attempt marker must NOT keep the runner silent.
		expect(
			shipAttemptFailedSuppressedHead(rawParams, "Q-fresh"),
		).toBeUndefined();
	});
});
