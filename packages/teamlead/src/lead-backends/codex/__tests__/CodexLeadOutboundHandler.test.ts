import { describe, expect, it, vi } from "vitest";
import {
	CodexLeadOutboundHandler,
	type DiscordSendFn,
	InMemoryOutboundDedupStore,
	type OutboundSendBody,
} from "../CodexLeadOutboundHandler.js";

const TOKEN = "api-secret";

function goodBody(over: Partial<OutboundSendBody> = {}): OutboundSendBody {
	return {
		projectName: "proj-a",
		leadId: "lead-a",
		channelId: "chan-1",
		text: "hello",
		idempotencyKey: "e1:out",
		nonce: "nonce-1",
		...over,
	};
}

function make(opts: { send?: DiscordSendFn } = {}) {
	const store = new InMemoryOutboundDedupStore();
	const sendCalls: Array<{
		projectName: string;
		leadId: string;
		channelId: string;
		text: string;
		nonce: string;
	}> = [];
	let seq = 0;
	const send: DiscordSendFn =
		opts.send ??
		(async (a) => {
			sendCalls.push(a);
			return `msg-${++seq}`;
		});
	const handler = new CodexLeadOutboundHandler({
		store,
		send,
		expectedApiToken: TOKEN,
		logger: { warn: vi.fn() },
	});
	return { store, sendCalls, handler };
}

describe("CodexLeadOutboundHandler — auth (reserved endpoint, fail-closed)", () => {
	it("requires expectedApiToken at construction", () => {
		expect(
			() =>
				new CodexLeadOutboundHandler({
					store: new InMemoryOutboundDedupStore(),
					send: async () => "m",
					expectedApiToken: "",
				}),
		).toThrow(/expectedApiToken/);
	});

	it("401 when token missing or wrong; never sends", async () => {
		const { handler, sendCalls } = make();
		expect(
			(await handler.handle({ body: goodBody(), providedToken: undefined }))
				.httpStatus,
		).toBe(401);
		expect(
			(await handler.handle({ body: goodBody(), providedToken: "wrong" }))
				.httpStatus,
		).toBe(401);
		expect(sendCalls).toHaveLength(0);
	});
});

describe("CodexLeadOutboundHandler — body validation", () => {
	const missing: Array<[string, OutboundSendBody]> = [
		["leadId", goodBody({ leadId: "" })],
		["channelId", goodBody({ channelId: undefined })],
		["text", goodBody({ text: "" })],
		["idempotencyKey", goodBody({ idempotencyKey: "" })],
		["nonce", goodBody({ nonce: undefined })],
	];
	for (const [field, body] of missing) {
		it(`400 when ${field} is missing/empty`, async () => {
			const { handler, sendCalls } = make();
			const r = await handler.handle({ body, providedToken: TOKEN });
			expect(r.httpStatus).toBe(400);
			expect(r.reason).toMatch(new RegExp(field));
			expect(sendCalls).toHaveLength(0);
		});
	}
});

describe("CodexLeadOutboundHandler — exactly-once via durable dedup", () => {
	it("fresh request sends once, marks sent, returns messageId + nonce passed", async () => {
		const { handler, sendCalls } = make();
		const r = await handler.handle({ body: goodBody(), providedToken: TOKEN });
		expect(r).toMatchObject({
			httpStatus: 200,
			status: "sent",
			messageId: "msg-1",
		});
		expect(sendCalls).toEqual([
			{
				projectName: "proj-a",
				leadId: "lead-a",
				channelId: "chan-1",
				text: "hello",
				nonce: "nonce-1",
			},
		]);
	});

	it("a repeat of an already-SENT key returns the prior messageId WITHOUT re-sending", async () => {
		const { handler, sendCalls } = make();
		await handler.handle({ body: goodBody(), providedToken: TOKEN });
		const r2 = await handler.handle({
			body: goodBody({ text: "changed" }),
			providedToken: TOKEN,
		});
		expect(r2).toMatchObject({ status: "deduped", messageId: "msg-1" });
		expect(sendCalls).toHaveLength(1); // NOT re-sent
	});

	it("an IN_FLIGHT key (crash mid-send) → ambiguous, never blind re-sends", async () => {
		const { handler, store, sendCalls } = make();
		store.setInFlight("e1:out"); // simulate a prior attempt that crashed mid-send
		const r = await handler.handle({ body: goodBody(), providedToken: TOKEN });
		expect(r).toMatchObject({
			httpStatus: 409,
			status: "ambiguous",
			reason: "prior_attempt_unproven",
		});
		expect(sendCalls).toHaveLength(0);
	});
});

describe("CodexLeadOutboundHandler — thrown send is AMBIGUOUS, never blind-resends (HIGH-3)", () => {
	it("a thrown send → 409 ambiguous, KEEPS the in_flight marker (a retry is ambiguous, not a double-post)", async () => {
		let attempt = 0;
		const send: DiscordSendFn = async () => {
			attempt += 1;
			throw new Error("discord 503 after the message may have posted");
		};
		const { handler, store } = make({ send });
		const r1 = await handler.handle({ body: goodBody(), providedToken: TOKEN });
		expect(r1).toMatchObject({
			httpStatus: 409,
			status: "ambiguous",
			reason: "send_threw_unproven",
		});
		// marker KEPT (not deleted) → the message is not blind re-sent
		expect(store.get("e1:out")).toMatchObject({ status: "in_flight" });
		// a retry sees in_flight → ambiguous, and does NOT call send again
		const r2 = await handler.handle({ body: goodBody(), providedToken: TOKEN });
		expect(r2).toMatchObject({ httpStatus: 409, status: "ambiguous" });
		expect(attempt).toBe(1); // exactly one send attempt — never a double-post
	});
});

describe("CodexLeadOutboundHandler — atomic claim closes the TOCTOU (HIGH-2)", () => {
	it("a racer that LOSES the atomic claim is ambiguous, not a second send", async () => {
		// Model two concurrent requests that both passed the get() fast-path: the first
		// claims, the second's setInFlight returns false (lost) → must not send again.
		const { handler, store, sendCalls } = make();
		// pre-claim the key (as if racer #1 already won + is mid-send)
		expect(store.setInFlight("e1:out")).toBe(true);
		expect(store.setInFlight("e1:out")).toBe(false); // racer #2 cannot also win
		const r = await handler.handle({ body: goodBody(), providedToken: TOKEN });
		// handler sees the existing in_flight (fast path) → ambiguous, never sends
		expect(r).toMatchObject({ httpStatus: 409, status: "ambiguous" });
		expect(sendCalls).toHaveLength(0);
	});
});

describe("CodexLeadOutboundHandler — anti-impersonation (review HIGH)", () => {
	function impersonationHandler() {
		const store = new InMemoryOutboundDedupStore();
		const sendCalls: unknown[] = [];
		const handler = new CodexLeadOutboundHandler({
			store,
			send: async (a) => {
				sendCalls.push(a);
				return "m";
			},
			expectedApiToken: TOKEN,
			// lead-a in proj-a may only post to chan-1 (keyed by project + lead)
			authorizeLeadChannel: (projectName, leadId, channelId) =>
				projectName === "proj-a" &&
				leadId === "lead-a" &&
				channelId === "chan-1",
			logger: { warn: vi.fn() },
		});
		return { handler, sendCalls };
	}

	it("rejects 403 when the (project, lead, channel) is not authorized; never sends", async () => {
		const { handler, sendCalls } = impersonationHandler();
		// impersonation: posting to someone else's channel
		const r = await handler.handle({
			body: goodBody({ channelId: "chan-other" }),
			providedToken: TOKEN,
		});
		expect(r).toMatchObject({
			httpStatus: 403,
			status: "rejected",
			reason: "lead_channel_unauthorized",
		});
		expect(sendCalls).toHaveLength(0);
		// the authorized triple still works
		const ok = await handler.handle({ body: goodBody(), providedToken: TOKEN });
		expect(ok).toMatchObject({ status: "sent" });
	});

	it("a REUSED agentId in ANOTHER project cannot post to this project's channel (403)", async () => {
		const { handler, sendCalls } = impersonationHandler();
		// same agentId lead-a + same channel chan-1, but a DIFFERENT project → denied
		const r = await handler.handle({
			body: goodBody({ projectName: "proj-b" }),
			providedToken: TOKEN,
		});
		expect(r).toMatchObject({
			httpStatus: 403,
			reason: "lead_channel_unauthorized",
		});
		expect(sendCalls).toHaveLength(0);
	});
});
