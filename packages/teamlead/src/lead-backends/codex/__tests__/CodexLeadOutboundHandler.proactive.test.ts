import { expect, it, vi } from "vitest";
import {
	CodexLeadOutboundHandler,
	InMemoryOutboundDedupStore,
} from "../CodexLeadOutboundHandler.js";

const body = {
	projectName: "p",
	leadId: "l",
	channelId: "11111111111111111",
	text: "question",
	idempotencyKey: "e:out",
	nonce: "n",
	roundtableEngage: true,
};
it("requires a live host capability before posting, including a proactive probe", async () => {
	const send = vi.fn(async () => "22222222222222222");
	const h = new CodexLeadOutboundHandler({
		store: new InMemoryOutboundDedupStore(),
		send,
		expectedApiToken: "t",
	});
	expect(await h.handle({ body, providedToken: "t" })).toMatchObject({
		status: "rejected",
	});
	expect(
		await h.handle({ body: { ...body, probe: true }, providedToken: "t" }),
	).toMatchObject({ status: "rejected" });
	expect(send).not.toHaveBeenCalled();
});
it("retains sent plus pending and resumes engagement without a second post after handler restart", async () => {
	const store = new InMemoryOutboundDedupStore();
	const send = vi.fn(async () => "22222222222222222");
	const engage = vi
		.fn()
		.mockRejectedValueOnce(Error("owner lost"))
		.mockResolvedValue("ready");
	const opts = {
		store,
		send,
		expectedApiToken: "t",
		prepareProactiveEngagement: async () => engage,
	};
	const first = await new CodexLeadOutboundHandler(opts).handle({
		body,
		providedToken: "t",
	});
	expect(first).toMatchObject({
		status: "pending",
		sendStatus: "sent",
		engagement: "pending",
		messageId: "22222222222222222",
	});
	expect(store.get(body.idempotencyKey)).toMatchObject({
		status: "sent",
		engagement: "pending",
	});
	const second = await new CodexLeadOutboundHandler(opts).handle({
		body,
		providedToken: "t",
	});
	expect(second).toMatchObject({
		status: "sent",
		sendStatus: "sent",
		engagement: "ready",
		threadId: "22222222222222222",
	});
	expect(send).toHaveBeenCalledOnce();
	expect(engage).toHaveBeenCalledTimes(2);
});
it("rejects binding changes and legacy record adoption without re-posting", async () => {
	const store = new InMemoryOutboundDedupStore(),
		send = vi.fn(async () => "22222222222222222");
	const h = new CodexLeadOutboundHandler({
		store,
		send,
		expectedApiToken: "t",
		prepareProactiveEngagement: async () => async () => "ready",
	});
	await h.handle({ body, providedToken: "t" });
	for (const change of [
		{ text: "different" },
		{ leadId: "other" },
		{ roundtableEngage: false },
	])
		expect(
			await h.handle({ body: { ...body, ...change }, providedToken: "t" }),
		).toMatchObject({
			status: "rejected",
			reason: "outbound_binding_conflict",
		});
	store.markSent("old", "33333333333333333");
	expect(
		await h.handle({
			body: { ...body, idempotencyKey: "old" },
			providedToken: "t",
		}),
	).toMatchObject({ status: "rejected", reason: "outbound_binding_conflict" });
	expect(send).toHaveBeenCalledOnce();
});

it("claims a concurrent proactive key once and retains the receipt if capability later disappears", async () => {
	const store = new InMemoryOutboundDedupStore();
	let posted!: () => void, finish!: () => void;
	const started = new Promise<void>((r) => {
			posted = r;
		}),
		deferred = new Promise<void>((r) => {
			finish = r;
		});
	const send = vi.fn(async () => {
		posted();
		await deferred;
		return "22222222222222222";
	});
	const h = new CodexLeadOutboundHandler({
		store,
		send,
		expectedApiToken: "t",
		prepareProactiveEngagement: async () => async () => "ready",
	});
	const first = h.handle({ body, providedToken: "t" });
	await started;
	expect(await h.handle({ body, providedToken: "t" })).toMatchObject({
		status: "ambiguous",
	});
	finish();
	expect(await first).toMatchObject({ status: "sent", engagement: "ready" });
	expect(send).toHaveBeenCalledOnce();
	const oldHost = new CodexLeadOutboundHandler({
		store,
		send,
		expectedApiToken: "t",
	});
	expect(await oldHost.handle({ body, providedToken: "t" })).toMatchObject({
		status: "pending",
		sendStatus: "sent",
		messageId: "22222222222222222",
	});
	expect(send).toHaveBeenCalledOnce();
});
