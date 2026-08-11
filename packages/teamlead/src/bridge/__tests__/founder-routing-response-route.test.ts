import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFounderRoutingResponseRouter } from "../founder-routing-response-route.js";

let root: string;
let dbPath: string;
let server: Server;

async function request(body: unknown) {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("not bound");
	const response = await fetch(
		`http://127.0.0.1:${address.port}/api/founder-routing/runner-response`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return { status: response.status, body: await response.json() };
}

function seedQuestion(input?: {
	issueId?: string;
	leadId?: string;
	checkpoint?: string;
}): string {
	const db = new CommDB(dbPath, true);
	const issueId = input?.issueId ?? "issue-1";
	const leadId = input?.leadId ?? "lead-1";
	db.registerSession("exec-1", "runner", "flywheel", issueId, leadId);
	const questionId = db.insertQuestion(
		"exec-1",
		leadId,
		"What should I do?",
		input?.checkpoint ? { checkpoint: input.checkpoint } : undefined,
	);
	db.close();
	return questionId;
}

function mount(
	overrides: Partial<
		Parameters<typeof createFounderRoutingResponseRouter>[0]
	> = {},
): void {
	const app = express();
	app.use(express.json());
	app.use(
		"/api/founder-routing/runner-response",
		createFounderRoutingResponseRouter({
			getThreadById: (threadId) =>
				threadId === "thread-1"
					? {
							thread_id: threadId,
							issue_id: "issue-1",
							lead_id: "lead-1",
							session_role: "main",
						}
					: undefined,
			getSessionsByIssue: (issueId) =>
				issueId === "issue-1" ? [{ project_name: "flywheel" }] : [],
			commDbPathForProject: () => dbPath,
			authorizeLeadRequest: vi.fn(() => undefined),
			now: () => "2026-08-11T12:00:00.000Z",
			logger: { warn: vi.fn() },
			...overrides,
		}),
	);
	server = createServer(app);
	server.listen(0);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fly1645-founder-route-"));
	dbPath = join(root, "comm.db");
});

afterEach(() => {
	server?.close();
	rmSync(root, { recursive: true, force: true });
});

describe("founder routing runner response", () => {
	it("derives scope from the source thread and writes through the guarded transaction", async () => {
		const questionId = seedQuestion();
		mount();

		const result = await request({
			questionId,
			leadId: "lead-1",
			answer: "Use the existing path.",
			sourceThread: "thread-1",
			expectedOwner: "exec-1",
			expectedCheckpoint: null,
		});

		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({
			ok: true,
			responseId: expect.any(String),
		});
		const db = new CommDB(dbPath, false);
		expect(db.getResponse(questionId)).toMatchObject({
			from_agent: "lead-1",
			content: "Use the existing path.",
		});
		db.close();
	});

	it("is idempotent only for the same Lead and answer", async () => {
		const questionId = seedQuestion();
		mount();
		const body = {
			questionId,
			leadId: "lead-1",
			answer: "same",
			sourceThread: "thread-1",
			expectedOwner: "exec-1",
			expectedCheckpoint: null,
		};

		const first = await request(body);
		const retry = await request(body);
		const conflict = await request({ ...body, answer: "different" });

		expect(retry).toEqual(first);
		expect(conflict.status).toBe(409);
	});

	it.each([
		["unknown thread", { sourceThread: "unknown" }, 404],
		["cross Lead", { leadId: "lead-2" }, 409],
		["wrong issue", {}, 409],
		["wrong owner", { expectedOwner: "exec-other" }, 409],
	])("rejects %s without writing", async (_label, patch, expectedStatus) => {
		const questionId = seedQuestion({
			issueId: _label === "wrong issue" ? "issue-other" : undefined,
		});
		mount();
		const result = await request({
			questionId,
			leadId: "lead-1",
			answer: "must not write",
			sourceThread: "thread-1",
			expectedOwner: "exec-1",
			expectedCheckpoint: null,
			...patch,
		});

		expect(result.status).toBe(expectedStatus);
		const db = new CommDB(dbPath, false);
		expect(db.getResponse(questionId)).toBeUndefined();
		db.close();
	});

	it("fails closed when Lead lease or carrier authorization rejects", async () => {
		const questionId = seedQuestion();
		mount({
			authorizeLeadRequest: () => {
				throw new Error("lead_lease_denied");
			},
		});
		const result = await request({
			questionId,
			leadId: "lead-1",
			answer: "must not write",
			sourceThread: "thread-1",
			expectedOwner: "exec-1",
			expectedCheckpoint: null,
		});
		expect(result.status).toBe(403);
	});
});
