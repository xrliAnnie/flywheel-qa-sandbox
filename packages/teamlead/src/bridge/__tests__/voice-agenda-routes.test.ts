/**
 * FLY-2863 plan §3-§4 Bridge face: lease-bound snapshot/state/turn/request
 * routes and the Lead result route used by `flywheel-comm voice agenda`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import express from "express";
import type {
	AgendaItem,
	AgendaSnapshot,
	AgendaState,
} from "flywheel-voice-core";
import {
	type VoiceHandoffRequest,
	voiceHandoffRequestDigest,
} from "flywheel-voice-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createVoiceAgendaRouter,
	renderAgendaBriefText,
} from "../voice-agenda-routes.js";
import { VoiceAgendaStore } from "../voice-agenda-store.js";
import { createVoiceHandoffRouter } from "../voice-handoff-routes.js";
import { VoiceHandoffStore } from "../voice-handoff-store.js";
import { VoiceReplyNotifier } from "../voice-reply-notifier.js";
import { voiceSessionAuthMiddleware } from "../voice-session-auth.js";

const MASTER = "master-token";
const INGEST = "ingest-token";
const SESSION_ID = "10000000-0000-4000-8000-000000000101";
const LEASE = "lease-token";
const NOW = "2026-09-24T20:00:01.000Z";
let server: Server | undefined;
let db: Database.Database | undefined;

afterEach(
	() =>
		new Promise<void>((resolve) => {
			const done = () => {
				db?.close();
				db = undefined;
				resolve();
			};
			if (!server) return done();
			server.close(() => {
				server = undefined;
				done();
			});
		}),
);

function item(key: string, cls: AgendaItem["class"]): AgendaItem {
	return {
		itemKey: key,
		class: cls,
		projectName: "raya",
		leadId: "raya",
		leadName: "raya",
		issueIdentifier: cls === "lead_said" ? null : "FLY-2796",
		issueTitle: cls === "lead_said" ? null : "耳机",
		threadUrl: null,
		since: "2026-09-24T19:00:00.000Z",
		urgent: null,
		pointers: { messageIds: [] },
		sourceKey: "titles:raya",
		...(cls === "lead_said" ? { sourceText: "我这边想跟你说一件事" } : {}),
	};
}

function snapshot(items: AgendaItem[]): AgendaSnapshot {
	return {
		snapshotId: "snap",
		asOf: NOW,
		items,
		sourceStatus: { "titles:raya": { status: "complete", asOf: NOW } },
		complete: true,
		olderUnspokenCount: 2,
	};
}

async function start(
	options: { items?: AgendaItem[]; state?: string; generation?: number } = {},
) {
	db = new Database(":memory:");
	db.exec(
		"CREATE TABLE chat_threads (thread_id TEXT, channel_id TEXT, issue_id TEXT, lead_id TEXT, archived_at TEXT, discord_missing_at TEXT)",
	);
	const handoffs = new VoiceHandoffStore(db);
	handoffs.migrate();
	const agenda = new VoiceAgendaStore(db);
	agenda.migrate(NOW);
	const notifier = new VoiceReplyNotifier();
	const notify = vi.spyOn(notifier, "notify");
	const dispatchBrief = vi.fn(async () => "committed" as const);
	const items = options.items ?? [
		item("blocked:I1:t", "blocked"),
		item("approve:I2:t", "awaiting_approval"),
	];
	const sessionRow = {
		sessionId: SESSION_ID,
		mode: "rg" as const,
		projectName: "raya",
		leadId: "raya",
		sessionGeneration: options.generation ?? 3,
		leaseToken: LEASE,
		leaseExpiresAt: "2026-09-24T20:10:00.000Z",
		state: options.state ?? "live",
	};
	const routes = createVoiceAgendaRouter({
		agenda,
		handoffs,
		replyNotifier: notifier,
		founderUserId: "founder-1",
		getSession: (id) => (id === SESSION_ID ? sessionRow : undefined),
		buildSnapshot: () => snapshot(items),
		dispatchBrief,
		recordLeadResult: (_record, input) => `audit:${input.resultEventId}`,
		briefAuthorId: () => "400000000000000001",
		now: () => new Date(NOW),
	});
	const app = express();
	app.use(express.json());
	app.use(
		"/api/voice/agenda/lead",
		voiceSessionAuthMiddleware(MASTER, INGEST),
		routes.leadRouter,
	);
	app.use(
		"/api/voice/agenda",
		voiceSessionAuthMiddleware(MASTER),
		routes.sessionRouter,
	);
	app.use(
		"/api/voice/handoffs",
		voiceSessionAuthMiddleware(MASTER),
		createVoiceHandoffRouter({
			store: handoffs,
			replyNotifier: notifier,
			founderUserId: "founder-1",
			now: () => new Date(NOW),
			getSession: (id) => (id === SESSION_ID ? sessionRow : undefined),
			isTargetLead: (project, lead) => project === "raya" && lead === "raya",
			verifyTranscript: async () => true,
			dispatch: async () => "committed",
			verifyResultSource: async () => false,
			agendaTurn: ({ sessionId, generation, utteranceId }) => {
				const turn = agenda.getTurn(sessionId, generation, utteranceId);
				if (!turn) return undefined;
				const state = agenda.getState(sessionId);
				return {
					kind: "turn",
					turnId: turn.turnId,
					itemKey: turn.itemKey,
					itemState: state?.active === turn.itemKey ? "active" : "closed",
				};
			},
		}),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	return {
		base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice`,
		agenda,
		handoffs,
		dispatchBrief,
		notify,
		generation: sessionRow.sessionGeneration,
	};
}

async function call(
	base: string,
	path: string,
	options: {
		token?: string;
		lease?: string;
		method?: string;
		body?: unknown;
	} = {},
) {
	const response = await fetch(`${base}${path}`, {
		method: options.method ?? "GET",
		headers: {
			Authorization: `Bearer ${options.token ?? MASTER}`,
			...(options.lease === undefined
				? { "X-Voice-Lease": LEASE }
				: options.lease
					? { "X-Voice-Lease": options.lease }
					: {}),
			...(options.body === undefined
				? {}
				: { "Content-Type": "application/json" }),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	return { status: response.status, body: await response.json() };
}

function freshState(
	generation: number,
	extra: Partial<AgendaState> = {},
): AgendaState {
	return {
		version: 1,
		sessionId: SESSION_ID,
		generation,
		stateVersion: 1,
		opened: true,
		queue: ["approve:I2:t"],
		active: "blocked:I1:t",
		urgentQueue: [],
		activeUrgent: null,
		items: {},
		outstanding: null,
		applied: {},
		lastActivityAt: NOW,
		...extra,
	};
}

describe("GET /api/voice/agenda", () => {
	it("serves the snapshot to the lease holder and records what it served", async () => {
		const { base, agenda } = await start();
		const denied = await call(
			base,
			`/agenda?sessionId=${SESSION_ID}&generation=3`,
			{
				lease: "wrong",
			},
		);
		expect(denied.status).toBe(403);
		const stale = await call(
			base,
			`/agenda?sessionId=${SESSION_ID}&generation=2`,
		);
		expect(stale.status).toBe(403);
		const ok = await call(base, `/agenda?sessionId=${SESSION_ID}&generation=3`);
		expect(ok.status).toBe(200);
		expect(ok.body.items).toHaveLength(2);
		expect(agenda.getServedItem(SESSION_ID, "blocked:I1:t")?.class).toBe(
			"blocked",
		);
	});

	it("refuses an ended session", async () => {
		const { base } = await start({ state: "ended" });
		expect(
			(await call(base, `/agenda?sessionId=${SESSION_ID}&generation=3`)).status,
		).toBe(403);
	});
});

describe("PUT /api/voice/agenda/state (CAS)", () => {
	it("creates, conflicts on a stale version, and only accepts served keys", async () => {
		const { base } = await start();
		await call(base, `/agenda?sessionId=${SESSION_ID}&generation=3`);
		const put = (body: unknown) =>
			call(base, "/agenda/state", { method: "PUT", body });
		const created = await put({
			sessionId: SESSION_ID,
			generation: 3,
			expectedVersion: 0,
			state: freshState(3),
			dispositions: [],
		});
		expect(created).toMatchObject({ status: 200, body: { ok: true } });
		const conflict = await put({
			sessionId: SESSION_ID,
			generation: 3,
			expectedVersion: 0,
			state: freshState(3),
			dispositions: [],
		});
		expect(conflict.status).toBe(409);
		expect(conflict.body.current.stateVersion).toBe(1);
		const forged = await put({
			sessionId: SESSION_ID,
			generation: 3,
			expectedVersion: 1,
			state: freshState(3, {
				stateVersion: 2,
				queue: ["approve:NOT-SERVED:t"],
			}),
			dispositions: [],
		});
		expect(forged.status).toBe(400);
		const noEvidence = await put({
			sessionId: SESSION_ID,
			generation: 3,
			expectedVersion: 1,
			state: freshState(3, { stateVersion: 2 }),
			dispositions: [
				{
					itemKey: "blocked:I1:t",
					disposition: "resolved",
					evidence: null,
					reason: "done",
					requestId: "r",
					createdAt: NOW,
				},
			],
		});
		expect(noEvidence.status).toBe(400);
		const read = await call(
			base,
			`/agenda/state?sessionId=${SESSION_ID}&generation=3`,
		);
		expect(read.body.state.stateVersion).toBe(1);
	});
});

describe("POST /api/voice/agenda/turns", () => {
	it("binds one item per utterance and refuses a rebind", async () => {
		const { base } = await start();
		await call(base, `/agenda?sessionId=${SESSION_ID}&generation=3`);
		const bind = (itemKey: string) =>
			call(base, "/agenda/turns", {
				method: "POST",
				body: {
					sessionId: SESSION_ID,
					generation: 3,
					utteranceId: "utt-1",
					turnId: "utt-1",
					itemKey,
				},
			});
		expect((await bind("blocked:I1:t")).body).toEqual({ outcome: "bound" });
		expect((await bind("blocked:I1:t")).body).toEqual({ outcome: "same" });
		expect((await bind("approve:I2:t")).status).toBe(409);
		expect(
			(
				await call(base, "/agenda/turns", {
					method: "POST",
					body: {
						sessionId: SESSION_ID,
						generation: 3,
						utteranceId: "utt-2",
						turnId: "utt-2",
						itemKey: "approve:NOT-SERVED:t",
					},
				})
			).status,
		).toBe(400);
	});
});

async function openRequest(base: string, clientRequestId = "c-1") {
	return call(base, "/agenda/requests", {
		method: "POST",
		body: {
			sessionId: SESSION_ID,
			generation: 3,
			purpose: "open",
			itemKey: null,
			clientRequestId,
		},
	});
}

describe("POST /api/voice/agenda/requests", () => {
	it("delivers a server-authored brief to the session Lead, idempotently", async () => {
		const { base, handoffs, dispatchBrief } = await start();
		const first = await openRequest(base);
		expect(first.status).toBe(200);
		expect(first.body.state).toBe("committed");
		const record = handoffs.get(first.body.requestId)!;
		expect(record).toMatchObject({
			requestKind: "agenda_brief",
			targetLeadId: "raya",
			generation: 3,
		});
		expect(record.agenda).toMatchObject({ kind: "brief", purpose: "open" });
		const text = record.agenda?.kind === "brief" ? record.agenda.text : "";
		expect(text).toContain("不是 founder");
		expect(text).toContain(
			`flywheel-comm voice agenda say --request ${record.handoffId}`,
		);
		expect(dispatchBrief).toHaveBeenCalledOnce();
		const retry = await openRequest(base);
		expect(retry.body.requestId).toBe(first.body.requestId);
		expect(dispatchBrief).toHaveBeenCalledOnce();
	});

	it("only references items the Bridge served to this session", async () => {
		const { base } = await start();
		const bad = await call(base, "/agenda/requests", {
			method: "POST",
			body: {
				sessionId: SESSION_ID,
				generation: 3,
				purpose: "item",
				itemKey: "blocked:I1:t",
				clientRequestId: "c-2",
			},
		});
		expect(bad.status).toBe(400);
		await call(base, `/agenda?sessionId=${SESSION_ID}&generation=3`);
		const good = await call(base, "/agenda/requests", {
			method: "POST",
			body: {
				sessionId: SESSION_ID,
				generation: 3,
				purpose: "item",
				itemKey: "blocked:I1:t",
				clientRequestId: "c-3",
			},
		});
		expect(good.status).toBe(200);
		const openWithItem = await call(base, "/agenda/requests", {
			method: "POST",
			body: {
				sessionId: SESSION_ID,
				generation: 3,
				purpose: "open",
				itemKey: "blocked:I1:t",
				clientRequestId: "c-4",
			},
		});
		expect(openWithItem.status).toBe(400);
	});

	it("never lets the client pick the Lead or the scope", async () => {
		const { base } = await start();
		const smuggled = await call(base, "/agenda/requests", {
			method: "POST",
			body: {
				sessionId: SESSION_ID,
				generation: 3,
				purpose: "open",
				itemKey: null,
				clientRequestId: "c-5",
				targetLeadId: "someone-else",
			},
		});
		expect(smuggled.status).toBe(403);
	});
});

describe("POST /api/voice/agenda/results (voice agenda say|close)", () => {
	async function opened() {
		const harness = await start();
		const open = await openRequest(harness.base);
		const requestId = open.body.requestId as string;
		const record = harness.handoffs.get(requestId);
		const answerKey =
			record?.agenda?.kind === "brief" ? record.agenda.answerKey : "";
		return { ...harness, requestId, answerKey };
	}
	const result = (base: string, body: unknown, token = INGEST) =>
		call(base, "/agenda/lead/results", {
			method: "POST",
			token,
			body,
			lease: "",
		});

	it("appends a say bound to the delivered Lead and wakes the session", async () => {
		const { base, requestId, notify, handoffs, answerKey } = await opened();
		const say = await result(base, {
			requestId,
			leadId: "raya",
			answerKey,
			clientResultId: "r-1",
			kind: "say",
			itemKey: "blocked:I1:t",
			order: ["blocked:I1:t", "approve:I2:t"],
			text: "两件事，先说受阻那张。",
		});
		expect(say.status).toBe(200);
		expect(say.body).toMatchObject({
			resultKind: "agenda_say",
			agenda: {
				kind: "say",
				itemKey: "blocked:I1:t",
				order: ["blocked:I1:t", "approve:I2:t"],
			},
		});
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ handoffId: requestId, generation: 3 }),
		);
		const again = await result(base, {
			requestId,
			leadId: "raya",
			answerKey,
			clientResultId: "r-1",
			kind: "say",
			itemKey: "blocked:I1:t",
			order: ["blocked:I1:t", "approve:I2:t"],
			text: "两件事，先说受阻那张。",
		});
		expect(again.body.seq).toBe(say.body.seq);
		expect(handoffs.listResults(requestId, 0, 10).events).toHaveLength(1);
	});

	it("refuses a missing or wrong answer key even with the right Lead id", async () => {
		const { base, requestId, answerKey } = await opened();
		expect(answerKey).toMatch(/^[A-Za-z0-9_-]{24}$/u);
		for (const key of [undefined, "", `${answerKey.slice(1)}x`])
			expect(
				(
					await result(base, {
						requestId,
						leadId: "raya",
						...(key === undefined ? {} : { answerKey: key }),
						clientResultId: `r-key-${key}`,
						kind: "say",
						itemKey: null,
						text: "hi",
					})
				).status,
			).toBe(403);
	});

	it("an opening order must be a full permutation of the frozen brief", async () => {
		const { base, requestId, answerKey } = await opened();
		const partial = await result(base, {
			requestId,
			leadId: "raya",
			answerKey,
			clientResultId: "r-partial",
			kind: "say",
			itemKey: null,
			order: ["blocked:I1:t"],
			text: "hi",
		});
		expect(partial.status).toBe(400);
	});

	it("refuses another Lead, a foreign order, a resolved close without evidence", async () => {
		const { base, requestId, answerKey } = await opened();
		expect(
			(
				await result(base, {
					requestId,
					leadId: "flywheel-eng-lead",
					answerKey,
					clientResultId: "r-2",
					kind: "say",
					itemKey: null,
					text: "hi",
				})
			).status,
		).toBe(403);
		expect(
			(
				await result(base, {
					requestId,
					leadId: "raya",
					answerKey,
					clientResultId: "r-3",
					kind: "say",
					itemKey: null,
					order: ["approve:OTHER:t"],
					text: "hi",
				})
			).status,
		).toBe(400);
		expect(
			(
				await result(base, {
					requestId,
					leadId: "raya",
					answerKey,
					clientResultId: "r-4",
					kind: "close",
					itemKey: "blocked:I1:t",
					disposition: "resolved",
					reason: "done",
				})
			).status,
		).toBe(400);
		expect(
			(
				await result(
					base,
					{
						requestId,
						leadId: "raya",
						answerKey,
						clientResultId: "r-5",
						kind: "say",
						itemKey: null,
						text: "hi",
					},
					"wrong",
				)
			).status,
		).toBe(401);
	});

	it("accepts results on a founder handoff only when the server bound it to an agenda turn", async () => {
		const { base, handoffs, agenda } = await opened();
		const handoff = (
			utteranceId: string,
			handoffId: string,
		): VoiceHandoffRequest => {
			const transcriptId = `t-${utteranceId}`;
			const input = {
				handoffId,
				idempotencyKey: `${transcriptId}:raya:query`,
				intentKind: "query" as const,
				payload: { targetLeadId: "raya", text: "好，授权", quotes: ["授权"] },
				sessionId: SESSION_ID,
				generation: 3,
				transcriptId,
				utteranceId,
				originalText: "好，授权",
				authorityBinding: {
					projectName: "raya",
					founderUserId: "founder-1",
					targetLeadId: "raya",
					sessionId: SESSION_ID,
					generation: 3,
					transcriptId,
					transcriptDigest: "c".repeat(64),
				},
				transcriptDurabilityReceipt: {
					version: 1 as const,
					durable: true as const,
					sessionId: SESSION_ID,
					transcriptId,
					contentDigest: "c".repeat(64),
					persistedAt: NOW,
				},
			};
			return { ...input, requestDigest: voiceHandoffRequestDigest(input) };
		};
		// Idle turn: plain handoff, no agenda binding, agenda results refused.
		const idle = handoff("utt-idle", "018f47d2-7b64-7b42-a3df-000000000001");
		expect(
			(await call(base, "/handoffs", { method: "POST", body: idle })).status,
		).toBe(200);
		expect(handoffs.get(idle.handoffId)?.agenda).toBeNull();
		expect(
			(
				await result(base, {
					requestId: idle.handoffId,
					leadId: "raya",
					answerKey: "a".repeat(24),
					clientResultId: "r-6",
					kind: "say",
					itemKey: null,
					text: "hi",
				})
			).status,
		).toBe(403);
		// Agenda turn: the binding is derived by the server from the turn table.
		await call(base, `/agenda?sessionId=${SESSION_ID}&generation=3`);
		agenda.saveState({
			state: freshState(3),
			expectedVersion: 0,
			dispositions: [],
			now: NOW,
		});
		await call(base, "/agenda/turns", {
			method: "POST",
			body: {
				sessionId: SESSION_ID,
				generation: 3,
				utteranceId: "utt-agenda",
				turnId: "utt-agenda",
				itemKey: "blocked:I1:t",
			},
		});
		const bound = handoff("utt-agenda", "018f47d2-7b64-7b42-a3df-000000000002");
		const posted = await call(base, "/handoffs", {
			method: "POST",
			body: bound,
		});
		expect(posted.status).toBe(200);
		const boundAgenda = handoffs.get(bound.handoffId)?.agenda;
		expect(boundAgenda).toMatchObject({
			kind: "turn",
			turnId: "utt-agenda",
			itemKey: "blocked:I1:t",
			itemState: "active",
			answerKey: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/u),
		});
		const turnKey = boundAgenda?.kind === "turn" ? boundAgenda.answerKey : "";
		// The brief's key does not answer the founder's handoff.
		expect(
			(
				await result(base, {
					requestId: bound.handoffId,
					leadId: "raya",
					answerKey: (
						handoffs.get(
							(
								await openRequest(base, "c-other")
							).body.requestId as string,
						)?.agenda as { answerKey: string }
					).answerKey,
					clientResultId: "r-wrong",
					kind: "say",
					itemKey: null,
					text: "hi",
				})
			).status,
		).toBe(403);
		const close = await result(base, {
			requestId: bound.handoffId,
			leadId: "raya",
			answerKey: turnKey,
			clientResultId: "r-7",
			kind: "close",
			itemKey: "blocked:I1:t",
			disposition: "resolved",
			evidence: "cmd:resume",
			reason: "她授权了",
			say: "好，我已经放行了。",
		});
		expect(close.status).toBe(200);
		expect(close.body.agenda).toMatchObject({
			kind: "close",
			disposition: "resolved",
			say: "好，我已经放行了。",
		});
		expect(close.body.text).toBe("好，我已经放行了。");
	});
});

describe("QA@1: the Bridge refuses at say time what the mode layer would drop (B2, B3)", () => {
	async function opened() {
		const harness = await start();
		const open = await openRequest(harness.base);
		const requestId = open.body.requestId as string;
		const record = harness.handoffs.get(requestId);
		const answerKey =
			record?.agenda?.kind === "brief" ? record.agenda.answerKey : "";
		return { ...harness, requestId, answerKey };
	}
	const result = (base: string, body: Record<string, unknown>) =>
		call(base, "/agenda/lead/results", {
			method: "POST",
			token: INGEST,
			body: { leadId: "raya", ...body },
			lease: "",
		});
	async function itemRequest(base: string, handoffs: VoiceHandoffStore) {
		await call(base, `/agenda?sessionId=${SESSION_ID}&generation=3`);
		const response = await call(base, "/agenda/requests", {
			method: "POST",
			body: {
				sessionId: SESSION_ID,
				generation: 3,
				purpose: "item",
				itemKey: "approve:I2:t",
				clientRequestId: "c-item",
			},
		});
		const requestId = response.body.requestId as string;
		const record = handoffs.get(requestId);
		return {
			requestId,
			answerKey:
				record?.agenda?.kind === "brief" ? record.agenda.answerKey : "",
		};
	}

	it("an opening may lead with any item of its brief, without --order", async () => {
		const { base, requestId, answerKey } = await opened();
		const say = await result(base, {
			requestId,
			answerKey,
			clientResultId: "r-open",
			kind: "say",
			itemKey: "approve:I2:t",
			text: "两件事，先从登录页改版说起。",
		});
		expect(say.status).toBe(200);
	});

	it("an opening item outside its brief is refused with a reason the Lead can read", async () => {
		const { base, requestId, answerKey } = await opened();
		const say = await result(base, {
			requestId,
			answerKey,
			clientResultId: "r-foreign",
			kind: "say",
			itemKey: "approve:OTHER:t",
			text: "先说另一件。",
		});
		expect(say.status).toBe(400);
		expect(say.body).toMatchObject({
			error: "voice_agenda_say_invalid",
			reason: "item_not_in_request",
		});
		expect(String(say.body.hint)).toContain("approve:I2:t");
	});

	it("mechanical checks run at say time: a URL is refused, not silently dropped", async () => {
		const { base, requestId, answerKey } = await opened();
		const say = await result(base, {
			requestId,
			answerKey,
			clientResultId: "r-url",
			kind: "say",
			itemKey: null,
			text: "看这里 https://example.com/qa",
		});
		expect(say.status).toBe(400);
		expect(say.body).toMatchObject({
			error: "voice_agenda_say_invalid",
			reason: "url",
		});
	});

	it("an item brief takes exactly its own item; an opening takes no close", async () => {
		const { base, handoffs, requestId, answerKey } = await opened();
		const closeOnOpen = await result(base, {
			requestId,
			answerKey,
			clientResultId: "r-close-open",
			kind: "close",
			itemKey: "blocked:I1:t",
			disposition: "deferred",
			reason: "她说回头看",
			say: "好，回头再看。",
		});
		expect(closeOnOpen.status).toBe(400);
		expect(closeOnOpen.body.reason).toBe("close_not_allowed");
		const item = await itemRequest(base, handoffs);
		const wrongItem = await result(base, {
			requestId: item.requestId,
			answerKey: item.answerKey,
			clientResultId: "r-wrong-item",
			kind: "say",
			itemKey: "blocked:I1:t",
			text: "说另一件。",
		});
		expect(wrongItem.status).toBe(400);
		expect(wrongItem.body.reason).toBe("item_not_in_request");
		const ok = await result(base, {
			requestId: item.requestId,
			answerKey: item.answerKey,
			clientResultId: "r-right-item",
			kind: "say",
			itemKey: "approve:I2:t",
			text: "二七九六等你批。",
		});
		expect(ok.status).toBe(200);
	});

	it("the voice client never receives material; the opening carries it compact, the item brief in full (B4)", async () => {
		const material = {
			question: "问".repeat(600),
			qa: {
				verdict: "pass" as const,
				summary: "很长".repeat(400),
				reportUrl: "https://reports.example/r/xyz/",
			},
			prNumber: 1314,
		};
		const { base, handoffs } = await start({
			items: [
				{ ...item("approve:I2:t", "awaiting_approval"), material },
				item("blocked:I1:t", "blocked"),
			],
		});
		const served = await call(
			base,
			`/agenda?sessionId=${SESSION_ID}&generation=3`,
		);
		expect(served.status).toBe(200);
		for (const entry of served.body.items)
			expect(entry.material).toBeUndefined();
		const open = await openRequest(base);
		const openAgenda = handoffs.get(open.body.requestId)?.agenda;
		const openItem = (
			openAgenda?.kind === "brief"
				? (openAgenda.brief.items as Array<Record<string, unknown>>)
				: []
		).find((entry) => entry.itemKey === "approve:I2:t");
		const compact = openItem?.material as typeof material;
		expect(Array.from(compact.question)).toHaveLength(200);
		expect(Array.from(compact.qa.summary)).toHaveLength(300);
		expect(compact.qa.reportUrl).toBe("https://reports.example/r/xyz/");
		expect(compact.prNumber).toBe(1314);
		const response = await call(base, "/agenda/requests", {
			method: "POST",
			body: {
				sessionId: SESSION_ID,
				generation: 3,
				purpose: "item",
				itemKey: "approve:I2:t",
				clientRequestId: "c-item-full",
			},
		});
		const itemAgenda = handoffs.get(response.body.requestId)?.agenda;
		const full =
			itemAgenda?.kind === "brief"
				? ((itemAgenda.brief.item as Record<string, unknown>)
						.material as typeof material)
				: undefined;
		expect(full).toEqual(material);
		expect(itemAgenda?.kind === "brief" ? itemAgenda.text : "").toContain(
			"很长很长",
		);
	});

	it("a close must carry the line she hears; it is the result text, the reason stays a record", async () => {
		const { base, handoffs } = await opened();
		const item = await itemRequest(base, handoffs);
		const bare = await result(base, {
			requestId: item.requestId,
			answerKey: item.answerKey,
			clientResultId: "r-bare",
			kind: "close",
			itemKey: "approve:I2:t",
			disposition: "decision_recorded",
			reason: "记下你同意了；我不能代点发布审批",
		});
		expect(bare.status).toBe(400);
		expect(bare.body.reason).toBe("say_required");
		const badSay = await result(base, {
			requestId: item.requestId,
			answerKey: item.answerKey,
			clientResultId: "r-bad-say",
			kind: "close",
			itemKey: "approve:I2:t",
			disposition: "decision_recorded",
			reason: "记下了",
			say: "**记下了**",
		});
		expect(badSay.status).toBe(400);
		expect(badSay.body.reason).toBe("markdown");
		const close = await result(base, {
			requestId: item.requestId,
			answerKey: item.answerKey,
			clientResultId: "r-close",
			kind: "close",
			itemKey: "approve:I2:t",
			disposition: "decision_recorded",
			reason: "记下你同意了；我不能代点发布审批",
			say: "记下你批了，你在这件的讨论串里点一下发布审批就行。",
		});
		expect(close.status).toBe(200);
		expect(close.body).toMatchObject({
			resultKind: "agenda_close",
			text: "记下你批了，你在这件的讨论串里点一下发布审批就行。",
			agenda: {
				kind: "close",
				disposition: "decision_recorded",
				reason: "记下你同意了；我不能代点发布审批",
				say: "记下你批了，你在这件的讨论串里点一下发布审批就行。",
			},
		});
	});
});

describe("renderAgendaBriefText", () => {
	it("tells the Lead it is a request, gives the exact command and no raw reading order", () => {
		const text = renderAgendaBriefText({
			requestId: "req-1",
			purpose: "item",
			itemKey: "approve:I2:t",
			brief: { item: { issue: "FLY-2796" } },
		});
		expect(text).toContain("--item approve:I2:t");
		expect(text).toContain("voice agenda close");
		expect(text).toContain("不要原样念给她");
	});
});
