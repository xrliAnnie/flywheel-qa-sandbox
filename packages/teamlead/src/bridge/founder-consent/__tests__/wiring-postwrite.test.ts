/**
 * FLY-191 Phase 2 — wiring `onResponseWritten` behavior, integration through
 * the REAL gateRouter in pass-through (DECISION_MODE=off) mode:
 *
 *  - structured {"approved": true} from a Lead is rejected before write/FSM/wake;
 *  - changes_requested feedback → status UNCHANGED
 *    (NOT terminal, plan §3.2(ii)) + a feedback wake telling the runner to
 *    fix + re-request review.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import {
	ClaudeCodeAdapter,
	deriveRunnerMailboxIdentity,
} from "flywheel-agent-team-transport";
import { CommDB } from "flywheel-comm/db";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertHistoricalAutoQaRecord } from "../../../__tests__/helpers/historical-qa.js";
import { createLeadIdentityFixture } from "../../../__tests__/helpers/lead-identity-fixture.js";
import type { ApplyTransitionOpts } from "../../../applyTransition.js";
import type { ProjectEntry } from "../../../ProjectConfig.js";
import { StateStore } from "../../../StateStore.js";
import type { BridgeConfig } from "../../types.js";
import { buildFounderConsentWiring } from "../wiring.js";

const PROJECT = "TestProj";
const EXEC = "exec-fly191-wire";
const LEAD = "product-lead";

let dir: string;
let commDbPath: string;
let server: Server;
let store: StateStore;
let identityDigest: string;

const origCfg = process.env.CLAUDE_CONFIG_DIR;
const origBackend = process.env.FLYWHEEL_COMM_BACKEND;
const origAgent = process.env.FLYWHEEL_AGENT_BACKEND;
const origProjectsFile = process.env.FLYWHEEL_PROJECTS_FILE;
const origStateDir = process.env.FLYWHEEL_STATE_DIR;
const origLeaseMode = process.env.FLYWHEEL_LEAD_LEASE_MODE;
const origHome = process.env.HOME;

const inboxPath = () => {
	const { agentName, teamName } = deriveRunnerMailboxIdentity(EXEC, LEAD);
	return new ClaudeCodeAdapter().getInboxPath(teamName, agentName);
};
const readInbox = () =>
	JSON.parse(readFileSync(inboxPath(), "utf-8")) as Array<{ text: string }>;

async function post(body: unknown) {
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("not bound");
	const res = await fetch(
		`http://127.0.0.1:${addr.port}/api/founder-consent/runner-gate-response`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				body !== null &&
					typeof body === "object" &&
					"leadId" in body &&
					!("identityDigest" in body)
					? { ...body, identityDigest }
					: body,
			),
		},
	);
	return { status: res.status, body: await res.json().catch(() => undefined) };
}

function seedQuestion(): string {
	const db = new CommDB(commDbPath, true);
	db.registerSession(EXEC, "sess:win", PROJECT, "FLY-191", LEAD);
	const qid = db.insertQuestion(EXEC, LEAD, "PR ready", {
		checkpoint: "approve_to_ship",
	});
	db.close();
	return qid;
}

describe("wiring onResponseWritten (FLY-191 Phase 2)", () => {
	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly191-wiring-"));
		mkdirSync(join(dir, "comm", PROJECT), { recursive: true });
		commDbPath = join(dir, "comm", PROJECT, "comm.db");
		const identity = createLeadIdentityFixture({
			root: dir,
			projectName: PROJECT,
			leadId: LEAD,
		});
		identityDigest = identity.identityDigest;
		process.env.HOME = identity.env.HOME;
		process.env.FLYWHEEL_PROJECTS_FILE = identity.env.FLYWHEEL_PROJECTS_FILE;
		process.env.FLYWHEEL_STATE_DIR = identity.env.FLYWHEEL_STATE_DIR;
		process.env.FLYWHEEL_LEAD_LEASE_MODE = "off";
		process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
		delete process.env.FLYWHEEL_COMM_BACKEND;
		delete process.env.FLYWHEEL_AGENT_BACKEND;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "FLY-191",
			project_name: PROJECT,
			status: "running",
		});
		store.persistTransition(EXEC, "awaiting_review", {
			issue_id: "FLY-191",
			project_name: PROJECT,
		});
		// FLY-1251: the shared approval writer must see exact, server-owned
		// readiness evidence. These tests exercise post-write behavior, so seed
		// passing exact-head QA instead of bypassing the guard.
		const head = "a".repeat(40);
		store.patchSessionMetadata(EXEC, {
			pr_head_sha: head,
			pr_number: 191,
			codex_skip: 1,
		});
		insertHistoricalAutoQaRecord(store, {
			parentExecutionId: EXEC,
			targetPrHeadSha: head,
			issueId: "FLY-191",
			projectName: PROJECT,
			status: "passed",
			verdictEventId: "qa-pass-wiring",
		});

		const transitionOpts: ApplyTransitionOpts = {
			store,
			fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
		};
		const wiring = buildFounderConsentWiring(
			store,
			[{ projectName: PROJECT, leads: [] } as unknown as ProjectEntry],
			{ founderConsent: { decisionMode: "off" } } as unknown as BridgeConfig,
			{ gateCommRoot: join(dir, "comm") },
			transitionOpts,
		);
		if (!wiring) throw new Error("wiring unexpectedly null");

		const app = express();
		app.use(express.json());
		app.use("/api/founder-consent/runner-gate-response", wiring.gateRouter);
		server = createServer(app);
		server.listen(0);
		await new Promise((r) => server.once("listening", r));
	});

	afterEach(() => {
		server?.close();
		rmSync(dir, { recursive: true, force: true });
		if (origCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = origCfg;
		if (origBackend === undefined) delete process.env.FLYWHEEL_COMM_BACKEND;
		else process.env.FLYWHEEL_COMM_BACKEND = origBackend;
		if (origAgent === undefined) delete process.env.FLYWHEEL_AGENT_BACKEND;
		else process.env.FLYWHEEL_AGENT_BACKEND = origAgent;
		if (origProjectsFile === undefined)
			delete process.env.FLYWHEEL_PROJECTS_FILE;
		else process.env.FLYWHEEL_PROJECTS_FILE = origProjectsFile;
		if (origStateDir === undefined) delete process.env.FLYWHEEL_STATE_DIR;
		else process.env.FLYWHEEL_STATE_DIR = origStateDir;
		if (origLeaseMode === undefined)
			delete process.env.FLYWHEEL_LEAD_LEASE_MODE;
		else process.env.FLYWHEEL_LEAD_LEASE_MODE = origLeaseMode;
		if (origHome === undefined) delete process.env.HOME;
		else process.env.HOME = origHome;
		vi.restoreAllMocks();
	});

	it("Lead approval is rejected before FSM mutation or wake", async () => {
		const qid = seedQuestion();
		const res = await post({
			questionId: qid,
			leadId: LEAD,
			answer: JSON.stringify({ approved: true }),
			executionId: EXEC,
		});
		expect(res.status).toBe(403);
		expect((res.body as { error?: string }).error).toBe("lead_ack_rejected");
		expect(store.getSession(EXEC)?.status).toBe("awaiting_review");
		expect(existsSync(inboxPath())).toBe(false);
	});

	it("feedback answer keeps awaiting_review (NOT terminal) + feedback wake CARRIES the feedback", async () => {
		const qid = seedQuestion();
		const res = await post({
			questionId: qid,
			leadId: LEAD,
			answer: "changes requested: please add tests for the edge case",
			kickback: true,
			executionId: EXEC,
		});
		expect(res.status).toBe(200);

		// §3.2(ii): feedback is a wake-to-fix, never a state change.
		expect(store.getSession(EXEC)?.status).toBe("awaiting_review");

		const entries = readInbox();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.text).toContain("changes requested");
		expect(entries[0]?.text).toContain("re-request review");
		expect(entries[0]?.text).toContain("Do NOT ship");
		// Codex PR R1 MEDIUM-5: the actual feedback text + questionId travel in
		// the wake so the idle runner can act without hunting for context.
		expect(entries[0]?.text).toContain("please add tests for the edge case");
		expect(entries[0]?.text).toContain(qid);
	});

	it("structured {approved:false} without explicit kickback stays neutral", async () => {
		const qid = seedQuestion();
		const res = await post({
			questionId: qid,
			leadId: LEAD,
			answer: JSON.stringify({ approved: false, feedback: "fix CI" }),
			executionId: EXEC,
		});
		expect(res.status).toBe(409);
		expect((res.body as { error?: string }).error).toBe("neutral_not_written");
		expect(store.getSession(EXEC)?.status).toBe("awaiting_review");
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)).toBeUndefined();
		db.close();
		expect(existsSync(inboxPath())).toBe(false);
	});

	it("approval retries remain rejected with zero durable response or wake", async () => {
		const qid = seedQuestion();
		const body = {
			questionId: qid,
			leadId: LEAD,
			answer: JSON.stringify({ approved: true }),
			executionId: EXEC,
		};
		const r1 = await post(body);
		expect(r1.status).toBe(403);
		expect(store.getSession(EXEC)?.status).toBe("awaiting_review");

		const r2 = await post(body);
		expect(r2.status).toBe(403);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)).toBeUndefined();
		db.close();
		expect(existsSync(inboxPath())).toBe(false);
	});

	it("answers to a SUPERSEDED question are rejected once the binding moved (Codex PR R1 CRITICAL)", async () => {
		const staleQ = seedQuestion();
		// A re-review re-bound the session to a new question.
		store.setReviewBinding(EXEC, {
			questionId: "99999999-9999-9999-9999-999999999999",
			prHeadSha: "a".repeat(40),
		});
		const res = await post({
			questionId: staleQ,
			leadId: LEAD,
			answer: "changes requested: update the current review",
			executionId: EXEC,
		});
		expect(res.status).toBe(409);
		expect((res.body as { error?: string }).error).toBe(
			"stale_review_question",
		);
		expect(store.getSession(EXEC)?.status).toBe("awaiting_review");
	});
});
