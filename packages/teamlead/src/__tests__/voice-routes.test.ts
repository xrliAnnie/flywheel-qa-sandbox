/**
 * FLY-546 B3-2 — /api/voice/* routes: scope contract, context lookup,
 * gate-binding reverse lookup (fail-closed), and the voice ship-approval
 * write with its guard ladder (503 api-token → 403 kill-switch → 400
 * receipt-first → 409 binding mismatch → 403 founder identity → source).
 */
import express from "express";
import { describe, expect, it, vi } from "vitest";
import {
	botUserIdFromToken,
	createVoiceRouter,
	type VoiceRouterDeps,
	type VoiceSessionLike,
} from "../bridge/voice-routes.js";

function httpRequest(
	app: express.Application,
	method: "GET" | "POST",
	path: string,
	body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
	return new Promise((done) => {
		const http = require("node:http");
		const server = http.createServer(app);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			const data = body ? JSON.stringify(body) : undefined;
			const req = http.request(
				{
					host: "127.0.0.1",
					port,
					path,
					method,
					headers: data
						? {
								"Content-Type": "application/json",
								"Content-Length": Buffer.byteLength(data),
							}
						: {},
				},
				(res: {
					statusCode: number;
					on: (e: string, cb: (c?: Buffer) => void) => void;
				}) => {
					let out = "";
					res.on("data", (c) => {
						out += c;
					});
					res.on("end", () => {
						server.close();
						done({ status: res.statusCode, body: out ? JSON.parse(out) : {} });
					});
				},
			);
			if (data) req.write(data);
			req.end();
		});
	});
}

const fakeToken = (botId: string) =>
	`${Buffer.from(botId, "utf8").toString("base64")}.x.y`;

const SESSION: VoiceSessionLike = {
	status: "awaiting_review",
	review_question_id: "q-1",
	pr_head_sha: "sha-1",
	pr_number: 42,
	issue_identifier: "FLY-901",
	issue_title: "feature-flag 注册",
	session_stage: "approve",
	agent_name: "flywheel-eng-lead",
	project_name: "flywheel",
	issue_id: "issue-901",
};

const BINDING = {
	questionId: "q-1",
	executionId: "exec-1",
	issueId: "issue-901",
	prHeadSha: "sha-1",
	threadId: "thread-901",
	gateMessageId: "gate-msg-1",
	checkpoint: "approve_to_ship",
	postedAt: "2026-07-07T00:00:00.000Z",
};

function makeStore(over: { session?: Partial<VoiceSessionLike> | null } = {}) {
	const session =
		over.session === null ? undefined : { ...SESSION, ...over.session };
	const insertedEvents: Array<Record<string, unknown>> = [];
	return {
		insertedEvents,
		store: {
			getSession: (id: string) => (id === "exec-1" ? session : undefined),
			getSessionByIssue: (issueId: string) =>
				issueId === "issue-901" ? session : undefined,
			getChatThreadByThreadId: (threadId: string) =>
				threadId === "thread-901"
					? {
							thread_id: "thread-901",
							channel_id: "chan-1",
							issue_id: "issue-901",
							session_role: "main" as const,
						}
					: undefined,
			getEventsByType: (type: string) =>
				type === "ship_gate_msg_binding"
					? [
							{
								event_id: "e-1",
								execution_id: "exec-1",
								issue_id: "issue-901",
								project_name: "flywheel",
								event_type: "ship_gate_msg_binding",
								source: "test",
								payload: BINDING,
							},
						]
					: [],
			getAllChatThreadIds: () => ["thread-901", "thread-880"],
			insertEvent: (ev: Record<string, unknown>) => {
				insertedEvents.push(ev);
				return true;
			},
		},
	};
}

function makeCommDb() {
	const responses = new Map<string, { content: string; from_agent: string }>();
	return {
		responses,
		db: {
			getMessageById: (id: string) =>
				id === "q-1"
					? { checkpoint: "approve_to_ship", from_agent: "exec-1" }
					: undefined,
			getResponse: (id: string) => responses.get(id),
			insertResponse: (id: string, fromAgent: string, content: string) => {
				responses.set(id, { content, from_agent: fromAgent });
			},
		},
	};
}

function makeApp(over: Partial<VoiceRouterDeps> = {}) {
	const { store, insertedEvents } = makeStore();
	const { db, responses } = makeCommDb();
	const deps: VoiceRouterDeps = {
		store,
		projects: [
			{
				projectName: "flywheel",
				generalChannel: "core-1",
				leads: [
					{
						agentId: "flywheel-eng-lead",
						chatChannel: "chan-1",
						botToken: fakeToken("111111111111111111"),
					},
					{ agentId: "flywheel-cos-lead", chatChannel: "chan-2" },
				],
			},
		],
		apiTokenConfigured: true,
		discordOwnerUserId: "annie-id",
		founderConsentUserId: "annie-id",
		roundtableChannelIds: ["rt-1"],
		globalBotToken: fakeToken("222222222222222222"),
		openCommDb: () => db,
		env: {},
		...over,
	};
	const app = express();
	app.use(express.json());
	app.use("/api/voice", createVoiceRouter(deps));
	return { app, insertedEvents, responses };
}

const SHIP_BODY = {
	gateMessageId: "gate-msg-1",
	questionId: "q-1",
	prHeadSha: "sha-1",
	transcript: {
		id: "t-1",
		text: "确认",
		atMs: 1,
		founderUserId: "annie-id",
	},
	receiptMessageId: "receipt-1",
};

describe("botUserIdFromToken", () => {
	it("decodes the bot user id from the token's first segment", () => {
		expect(botUserIdFromToken(fakeToken("123456789012345678"))).toBe(
			"123456789012345678",
		);
	});
	it("returns null for garbage / missing tokens", () => {
		expect(botUserIdFromToken(undefined)).toBeNull();
		expect(botUserIdFromToken("not-a-token")).toBeNull();
	});
});

describe("GET /api/voice/scope", () => {
	it("derives the scope contract from projects + store + env", async () => {
		const { app } = makeApp();
		const res = await httpRequest(app, "GET", "/api/voice/scope");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			leadBotIds: ["111111111111111111"],
			systemBotIds: ["222222222222222222"],
			scopeChannelIds: expect.arrayContaining([
				"chan-1",
				"chan-2",
				"core-1",
				"thread-901",
				"thread-880",
			]),
			roundtableChannelIds: ["rt-1"],
			founderIdFingerprint: "annie-id",
		});
	});

	it("503s fail-closed when the canonical founder id cannot be resolved", async () => {
		const { app } = makeApp({
			discordOwnerUserId: "annie-id",
			founderConsentUserId: "different-id",
		});
		const res = await httpRequest(app, "GET", "/api/voice/scope");
		expect(res.status).toBe(503);
		expect(res.body.error).toContain("canonical_founder_id");
	});
});

describe("GET /api/voice/context", () => {
	it("typed issue_thread context (not 404-overloaded)", async () => {
		const { app } = makeApp();
		const res = await httpRequest(
			app,
			"GET",
			"/api/voice/context?channelId=thread-901",
		);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			kind: "issue_thread",
			issueId: "issue-901",
			issueIdentifier: "FLY-901",
			issueTitle: "feature-flag 注册",
			agentId: "flywheel-eng-lead",
			stage: "approve",
		});
	});

	it("top-level lead chat channel resolves lead identity only", async () => {
		const { app } = makeApp();
		const res = await httpRequest(
			app,
			"GET",
			"/api/voice/context?channelId=chan-2",
		);
		expect(res.body).toEqual({
			kind: "lead_channel",
			agentId: "flywheel-cos-lead",
		});
	});

	it("unknown channel → {kind:unknown} with 200", async () => {
		const { app } = makeApp();
		const res = await httpRequest(
			app,
			"GET",
			"/api/voice/context?channelId=nope",
		);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ kind: "unknown" });
	});

	it("missing channelId → 400", async () => {
		const { app } = makeApp();
		const res = await httpRequest(app, "GET", "/api/voice/context");
		expect(res.status).toBe(400);
	});
});

describe("GET /api/voice/gate-binding", () => {
	it("resolves the ONE current binding for a live awaiting_review gate", async () => {
		const { app } = makeApp();
		const res = await httpRequest(
			app,
			"GET",
			"/api/voice/gate-binding?messageId=gate-msg-1",
		);
		expect(res.body).toEqual({
			bound: true,
			questionId: "q-1",
			prHeadSha: "sha-1",
			issueId: "issue-901",
			prNumber: 42,
		});
	});

	it("non-binding message → bound:false", async () => {
		const { app } = makeApp();
		const res = await httpRequest(
			app,
			"GET",
			"/api/voice/gate-binding?messageId=random-msg",
		);
		expect(res.body).toEqual({ bound: false });
	});

	it("a stale binding (session no longer awaiting_review) → bound:false (fail-closed)", async () => {
		const { store } = makeStore({ session: { status: "approved_to_ship" } });
		const { app } = makeApp({ store });
		const res = await httpRequest(
			app,
			"GET",
			"/api/voice/gate-binding?messageId=gate-msg-1",
		);
		expect(res.body).toEqual({ bound: false });
	});
});

describe("POST /api/voice/ship-approval — guard ladder", () => {
	it("⓪ apiToken unconfigured → 503 BEFORE any body field is used", async () => {
		const { app } = makeApp({ apiTokenConfigured: false });
		const res = await httpRequest(app, "POST", "/api/voice/ship-approval", {
			complete: "garbage",
		});
		expect(res.status).toBe(503);
		expect(res.body.error).toBe("api_token_required");
	});

	it("⓪ wins over the kill-switch (503 before 403)", async () => {
		const { app } = makeApp({
			apiTokenConfigured: false,
			env: { FLYWHEEL_VOICE_APPROVAL: "0" },
		});
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			SHIP_BODY,
		);
		expect(res.status).toBe(503);
	});

	it("① FLYWHEEL_VOICE_APPROVAL=0 → 403 disabled_by_kill_switch (route registered, not 404 — FLY-175 lesson)", async () => {
		const { app } = makeApp({ env: { FLYWHEEL_VOICE_APPROVAL: "0" } });
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			SHIP_BODY,
		);
		expect(res.status).toBe(403);
		expect(res.body.error).toBe("disabled_by_kill_switch");
	});

	it("flag absent = ENABLED (kill-switch semantics, Annie ②) — reverse-compat sentinel", async () => {
		const { app } = makeApp({ env: {} });
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			SHIP_BODY,
		);
		expect(res.status).toBe(200); // reaches the source, not 403
	});

	it("② respects the master FLYWHEEL_FOUNDER_AUTO_APPROVE=0 switch", async () => {
		const { app } = makeApp({ env: { FLYWHEEL_FOUNDER_AUTO_APPROVE: "0" } });
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			SHIP_BODY,
		);
		expect(res.status).toBe(403);
		expect(res.body.error).toBe("founder_auto_approve_disabled");
	});

	it("⑤ receipt-first: missing receiptMessageId → 400, nothing written", async () => {
		const { app, responses } = makeApp();
		const { receiptMessageId: _omit, ...noReceipt } = SHIP_BODY;
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			noReceipt,
		);
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("receipt_required");
		expect(responses.size).toBe(0);
	});

	it("③ binding mismatch (question/head don't cross-verify) → 409", async () => {
		const { app } = makeApp();
		const res = await httpRequest(app, "POST", "/api/voice/ship-approval", {
			...SHIP_BODY,
			prHeadSha: "different-sha",
		});
		expect(res.status).toBe(409);
		expect(res.body.error).toBe("binding_mismatch");
	});

	// QA·FLY-546 (Opus): the questionId leg of the binding cross-check was
	// untested — a caller with the right gateMessageId + prHeadSha but a
	// stale/wrong questionId must still fail closed, writing nothing.
	it("binding mismatch (questionId doesn't cross-verify) → 409, nothing written", async () => {
		const { app, responses } = makeApp();
		const res = await httpRequest(app, "POST", "/api/voice/ship-approval", {
			...SHIP_BODY,
			questionId: "stale-question",
		});
		expect(res.status).toBe(409);
		expect(res.body.error).toBe("binding_mismatch");
		expect(responses.size).toBe(0);
	});

	// QA·FLY-546 (Opus): receipt-first passes but a core body field is missing
	// → the input-validation boundary must 400, not fall through to a binding
	// lookup with undefined fields.
	it("receipt present but a required field missing → 400 missing_required_fields", async () => {
		const { app, responses } = makeApp();
		const { gateMessageId: _omit, ...noGate } = SHIP_BODY;
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			noGate,
		);
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("missing_required_fields");
		expect(responses.size).toBe(0);
	});

	// QA·FLY-546 (Opus): every guard passes but the server-derived CommDB
	// cannot open → 503, audited as an error, and NOTHING is written. A
	// founder-authority write must never proceed on a half-open db.
	it("approve but CommDB unavailable → 503 commdb_unavailable, audited, nothing written", async () => {
		const { app, responses, insertedEvents } = makeApp({
			openCommDb: () => null,
		});
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			SHIP_BODY,
		);
		expect(res.status).toBe(503);
		expect(res.body.error).toBe("commdb_unavailable");
		expect(responses.size).toBe(0);
		const audit = insertedEvents.find(
			(e) => e.event_type === "voice_approval_attempt",
		) as { payload?: Record<string, unknown> } | undefined;
		expect(audit?.payload).toMatchObject({
			modality: "voice",
			outcome: "error",
			reason: "commdb_unavailable",
		});
	});

	it("④ unresolved canonical founder id → 403", async () => {
		const { app } = makeApp({
			discordOwnerUserId: "annie-id",
			founderConsentUserId: "other-id",
		});
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			SHIP_BODY,
		);
		expect(res.status).toBe(403);
		expect(res.body.error).toBe("canonical_founder_id_unresolved");
	});

	it("⑥ approve writes {approved:true} attributed to the founder + audits", async () => {
		const writeGateResponseImpl = vi
			.fn()
			.mockResolvedValue({ written: true, retrySafe: true });
		const cardAuthority = vi.fn().mockReturnValue({ ok: true });
		const { app, insertedEvents } = makeApp({
			writeGateResponseImpl,
			cardAuthority,
		} as never);
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			SHIP_BODY,
		);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ written: true, kind: "approve" });
		const [writeArgs] = writeGateResponseImpl.mock.calls[0];
		expect(writeArgs.actor).toBe("annie-id");
		expect(JSON.parse(writeArgs.answer)).toEqual({ approved: true });
		expect(writeArgs).toMatchObject({ source: "voice", cardAuthority });
		// ⑦ audit row with modality + receipt + transcript
		const audit = insertedEvents.find(
			(e) => e.event_type === "voice_approval_attempt",
		) as { payload?: Record<string, unknown> } | undefined;
		expect(audit?.payload).toMatchObject({
			modality: "voice",
			receiptMessageId: "receipt-1",
			outcome: "approve",
		});
	});

	it("⑥ surfaces retrySafe=false verbatim (post-write hook unconfirmed — daemon narrates honestly)", async () => {
		const { app } = makeApp({
			writeGateResponseImpl: async () => ({ written: true, retrySafe: false }),
		});
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			SHIP_BODY,
		);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			written: true,
			kind: "approve",
			retrySafe: false,
		});
	});

	it("⑥ reject/unclear return written:false and never touch the CommDB", async () => {
		const { app, responses, insertedEvents } = makeApp();
		const rej = await httpRequest(app, "POST", "/api/voice/ship-approval", {
			...SHIP_BODY,
			transcript: { ...SHIP_BODY.transcript, text: "不批" },
		});
		expect(rej.status).toBe(200);
		expect(rej.body).toMatchObject({ written: false, kind: "reject" });
		const unclear = await httpRequest(app, "POST", "/api/voice/ship-approval", {
			...SHIP_BODY,
			transcript: { ...SHIP_BODY.transcript, text: "再想想" },
		});
		expect(unclear.body).toMatchObject({ written: false, kind: "unclear" });
		expect(responses.size).toBe(0);
		// ⑦ rejections audit too
		expect(
			insertedEvents.filter((e) => e.event_type === "voice_approval_attempt"),
		).toHaveLength(2);
	});

	it("a speaker other than the founder → 403, nothing written", async () => {
		const { app, responses } = makeApp();
		const res = await httpRequest(app, "POST", "/api/voice/ship-approval", {
			...SHIP_BODY,
			transcript: { ...SHIP_BODY.transcript, founderUserId: "impostor" },
		});
		expect(res.status).toBe(403);
		expect(res.body.error).toBe("speaker_not_founder");
		expect(responses.size).toBe(0);
	});
});

describe("POST /api/voice/ship-approval — review-hold alignment (FLY-1041 Chunk 5)", () => {
	it("held session → approval NOT written, kind 'held' with an explicit reason, audited held_declined", async () => {
		const { app, responses, insertedEvents } = makeApp({
			isHeld: () => true,
		});
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			SHIP_BODY,
		);
		expect(res.status).toBe(200);
		expect(res.body.written).toBe(false);
		expect(res.body.kind).toBe("held");
		expect(responses.size).toBe(0);
		const audit = insertedEvents.find(
			(e) =>
				e.event_type === "voice_approval_attempt" &&
				(e.payload as Record<string, unknown>)?.outcome === "held_declined",
		);
		expect(audit).toBeDefined();
	});

	it("un-held session → write proceeds (byte-compat)", async () => {
		const { app, responses } = makeApp({ isHeld: () => false });
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			SHIP_BODY,
		);
		expect(res.status).toBe(200);
		expect(res.body.written).toBe(true);
		expect(responses.size).toBe(1);
	});

	it("isHeld not wired (absent dep) → write proceeds exactly as before", async () => {
		const { app, responses } = makeApp();
		const res = await httpRequest(
			app,
			"POST",
			"/api/voice/ship-approval",
			SHIP_BODY,
		);
		expect(res.status).toBe(200);
		expect(responses.size).toBe(1);
	});
});
