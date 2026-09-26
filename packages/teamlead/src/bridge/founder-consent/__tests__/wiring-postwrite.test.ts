/**
 * FLY-191 Phase 2 — wiring `onResponseWritten` behavior, integration through
 * the REAL gateRouter in pass-through (DECISION_MODE=off) mode:
 *
 *  - structured {"approved": true} answer → FSM flips awaiting_review →
 *    approved_to_ship (Codex R2 MEDIUM-1 parity with /api/actions/approve)
 *    + an approval wake whose text mandates verify-approval;
 *  - any other answer (changes_requested feedback) → status UNCHANGED
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

const origCfg = process.env.CLAUDE_CONFIG_DIR;
const origBackend = process.env.FLYWHEEL_COMM_BACKEND;
const origAgent = process.env.FLYWHEEL_AGENT_BACKEND;

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
			body: JSON.stringify(body),
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
		vi.restoreAllMocks();
	});

	it("approval answer flips awaiting_review → approved_to_ship + approval wake", async () => {
		const qid = seedQuestion();
		const res = await post({
			questionId: qid,
			leadId: LEAD,
			answer: JSON.stringify({ approved: true }),
			executionId: EXEC,
		});
		expect(res.status).toBe(200);

		// R2 MEDIUM-1: status flipped — no "approved but Bridge shows
		// awaiting_review" split-brain.
		expect(store.getSession(EXEC)?.status).toBe("approved_to_ship");

		// Approval wake delivered, text mandates verify-approval and denies
		// its own authority.
		expect(existsSync(inboxPath())).toBe(true);
		const entries = readInbox();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.text).toContain("verify-approval");
		expect(entries[0]?.text).toContain("NOT authorization");
	});

	it("feedback answer keeps awaiting_review (NOT terminal) + feedback wake CARRIES the feedback", async () => {
		const qid = seedQuestion();
		const res = await post({
			questionId: qid,
			leadId: LEAD,
			answer: "changes requested: please add tests for the edge case",
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

	it("structured {approved:false} is treated as feedback, not approval", async () => {
		const qid = seedQuestion();
		await post({
			questionId: qid,
			leadId: LEAD,
			answer: JSON.stringify({ approved: false, feedback: "fix CI" }),
			executionId: EXEC,
		});
		expect(store.getSession(EXEC)?.status).toBe("awaiting_review");
	});

	it("idempotent approval retry through the FULL wiring: second respond converges (Codex R2 HIGH-2)", async () => {
		const qid = seedQuestion();
		const body = {
			questionId: qid,
			leadId: LEAD,
			answer: JSON.stringify({ approved: true }),
			executionId: EXEC,
		};
		const r1 = await post(body);
		expect(r1.status).toBe(200);
		expect(store.getSession(EXEC)?.status).toBe("approved_to_ship");

		// Retry after the transition already completed: 200 alreadyResponded,
		// status untouched, wake re-delivered (second inbox entry).
		const r2 = await post(body);
		expect(r2.status).toBe(200);
		expect((r2.body as { alreadyResponded?: boolean }).alreadyResponded).toBe(
			true,
		);
		expect(store.getSession(EXEC)?.status).toBe("approved_to_ship");
		expect(readInbox()).toHaveLength(2);
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
			answer: JSON.stringify({ approved: true }),
			executionId: EXEC,
		});
		expect(res.status).toBe(409);
		expect((res.body as { error?: string }).error).toBe(
			"stale_review_question",
		);
		expect(store.getSession(EXEC)?.status).toBe("awaiting_review");
	});
});
