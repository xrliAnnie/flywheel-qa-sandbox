/**
 * FLY-175 Track 2 — Surface A integration test (§12.2 / §12.5).
 *
 * Real StateStore (sql.js) + real context resolver + real evaluator + real
 * audit store (temp better-sqlite3), with the Discord fetch + LLM injected.
 * Drives a real Express server through the founder-consent middleware mounted
 * exactly as plugin.ts mounts it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAuditStore } from "../bridge/founder-consent/audit.js";
import {
	type DecisionMode,
	parseFounderConsentConfig,
} from "../bridge/founder-consent/config.js";
import type { FetchImpl } from "../bridge/founder-consent/discord-fetch.js";
import type { LLMChat } from "../bridge/founder-consent/evaluator.js";
import { buildFounderConsentWiring } from "../bridge/founder-consent/wiring.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const FOUNDER = "founder-123";
const PROJECT = "Flywheel";
const project: ProjectEntry = {
	projectName: PROJECT,
	projectRoot: "/tmp/x",
	leads: [
		{
			agentId: "lead-x",
			chatChannel: "chan-1",
			botToken: "bot-tok",
			match: { labels: ["x"] },
		},
	],
};

let store: StateStore;
let dir: string;
let server: Server | undefined;
let llmDecision: unknown;
const founderMessages: Array<{
	id: string;
	content: string;
	authorId: string;
}> = [{ id: "m-f", content: "approve FLY-175", authorId: FOUNDER }];

const mockFetch: FetchImpl = async () => ({
	ok: true,
	status: 200,
	json: async () =>
		founderMessages.map((m) => ({
			id: m.id,
			content: m.content,
			timestamp: "2026-05-28T10:00:00Z",
			author: { id: m.authorId, bot: false },
		})),
});
const mockLLM: LLMChat = {
	chat: async () => ({ content: JSON.stringify(llmDecision) }),
};

async function request(method: string, path: string, body?: unknown) {
	const addr = server?.address();
	if (!addr || typeof addr === "string") throw new Error("not bound");
	const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	let json: unknown;
	try {
		json = await res.json();
	} catch {
		json = undefined;
	}
	return { status: res.status, body: json };
}

function mkConfig(mode: string): BridgeConfig {
	const parsed = parseFounderConsentConfig(
		{
			FLYWHEEL_FOUNDER_USER_ID: FOUNDER,
			FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH: join(dir, "audit.db"),
		} as NodeJS.ProcessEnv,
		() => {},
	);
	return {
		founderConsent: { ...parsed, decisionMode: mode as DecisionMode },
	} as unknown as BridgeConfig;
}

function mountServer(mode: string) {
	const config = mkConfig(mode);
	const auditStore = openAuditStore(join(dir, "audit.db"));
	const wiring = buildFounderConsentWiring(store, [project], config, {
		llm: mockLLM,
		fetchImpl: mockFetch,
		auditStore,
		now: () => 0,
		nowIso: () => "2026-05-28T10:00:01Z",
	});

	const app = express();
	app.use(express.json());
	const noop: express.RequestHandler = (_q, _s, n) => n();
	const fcMw = (m: "action_router" | "close_tmux") =>
		wiring ? wiring.middlewareFor(m) : noop;

	const actionRouter = express.Router();
	actionRouter.post("/:action", (_req, res) => res.json({ ran: true }));
	app.use("/api/actions", fcMw("action_router"), actionRouter);
	app.post(
		"/api/sessions/:executionId/close-tmux",
		fcMw("close_tmux"),
		(_req, res) => res.json({ ran: true }),
	);

	server = createServer(app);
	server.listen(0);
	return { wiring, auditStore };
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "fc-int-"));
	store = await StateStore.create(":memory:");
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: "i1",
		issue_identifier: "FLY-175",
		project_name: PROJECT,
		status: "needs_review",
		session_role: "main",
		issue_labels: JSON.stringify([]),
	});
	store.upsertChatThread("thread-1", "chan-1", "i1", "lead-x");
	llmDecision = { allowed: false, confidence: 0 };
});
afterEach(() => {
	server?.close();
	server = undefined;
	rmSync(dir, { recursive: true, force: true });
});

describe("Surface A integration", () => {
	it("enforce ALLOW: founder approval → middleware passes to handler (200)", async () => {
		llmDecision = {
			allowed: true,
			confidence: 0.95,
			evidence_message_id: "m-f",
			evidence_excerpt: "approve FLY-175",
			reason: "explicit approve",
		};
		const { auditStore } = mountServer("enforce");
		const res = await request("POST", "/api/actions/approve", {
			execution_id: "exec-1",
			leadId: "lead-x",
		});
		expect(res.status).toBe(200);
		expect((res.body as { ran: boolean }).ran).toBe(true);
		expect(auditStore.queryRecent(10)[0]).toMatchObject({ decision: "allow" });
	});

	it("enforce DENY: status question → 403, handler not reached", async () => {
		founderMessages[0] = {
			id: "m-f",
			content: "QA 通过了吗",
			authorId: FOUNDER,
		};
		llmDecision = {
			allowed: false,
			confidence: 0,
			evidence_message_id: null,
			evidence_excerpt: null,
			reason: "status question",
		};
		mountServer("enforce");
		const res = await request("POST", "/api/sessions/exec-1/close-tmux", {
			leadId: "lead-x",
		});
		expect(res.status).toBe(403);
		expect((res.body as { code: string }).code).toBe(
			"FOUNDER_CONSENT_REQUIRED",
		);
	});

	it("audit_only: writes audit row but always passes (200)", async () => {
		llmDecision = { allowed: false, confidence: 0, reason: "no" };
		const { auditStore } = mountServer("audit_only");
		const res = await request("POST", "/api/actions/approve", {
			execution_id: "exec-1",
			leadId: "lead-x",
		});
		expect(res.status).toBe(200);
		const rows = auditStore.queryRecent(10);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			decision: "deny",
			decision_mode: "audit_only",
		});
	});

	it("reverse-compat: decisionMode=off → no-op middleware, handler always runs (§12.5)", async () => {
		mountServer("off"); // wiring is null → noop
		const res = await request("POST", "/api/actions/approve", {
			execution_id: "exec-1",
			leadId: "lead-x",
		});
		expect(res.status).toBe(200);
		expect((res.body as { ran: boolean }).ran).toBe(true);
	});
});
