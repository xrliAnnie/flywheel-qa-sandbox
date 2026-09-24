import { describe, expect, it } from "vitest";
import { BridgeVoiceClient } from "../bridge-client.js";

const SESSION = {
	sessionId: "voice-session",
	generation: 7,
	leaseToken: "lease-token",
};

type Call = { url: string; init?: RequestInit };

function fakeFetch(
	handler: (
		url: string,
		init?: RequestInit,
	) => { status: number; body: unknown },
) {
	const calls: Call[] = [];
	const fetchFn = async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		const res = handler(url, init);
		return {
			ok: res.status >= 200 && res.status < 300,
			status: res.status,
			json: async () => res.body,
			text: async () => JSON.stringify(res.body),
		} as Response;
	};
	return { calls, fetchFn };
}

const SCOPE_BODY = {
	leadBotIds: ["lead-1"],
	systemBotIds: ["sys-1"],
	scopeChannelIds: ["chan-1"],
	roundtableChannelIds: ["rt-1"],
	founderIdFingerprint: "annie-id",
};

describe("BridgeVoiceClient", () => {
	it("lists the durable headphone inbox with the live session binding", async () => {
		const { calls, fetchFn } = fakeFetch(() => ({
			status: 200,
			body: {
				items: [
					{
						id: "item-1",
						revision: 2,
						createdAt: "2026-09-23T00:00:00.000Z",
						needsDecision: true,
						text: "请决定。",
					},
				],
			},
		}));
		const client = new BridgeVoiceClient({
			bridgeUrl: "http://localhost:9876",
			token: "master",
			fetchFn,
		});

		await expect(client.listHeadphoneItems(SESSION)).resolves.toEqual([
			expect.objectContaining({ id: "item-1", revision: 2 }),
		]);
		expect(calls[0]?.url).toContain(
			"/api/voice/headphone?sessionId=voice-session&generation=7&limit=100",
		);
		expect(new Headers(calls[0]?.init?.headers).get("x-voice-lease")).toBe(
			"lease-token",
		);
	});

	it("claims and ACKs one item with every completed segment digest", async () => {
		const { calls, fetchFn } = fakeFetch((url) =>
			url.endsWith("/claim")
				? {
						status: 200,
						body: {
							item: {
								itemId: "item-1",
								revision: 2,
								sourceCreatedAt: "2026-09-23T00:00:00.000Z",
								needsDecision: false,
								text: "进展正常。",
							},
							claimToken: "claim-token",
						},
					}
				: { status: 200, body: { acked: true } },
		);
		const client = new BridgeVoiceClient({
			bridgeUrl: "http://localhost:9876",
			token: "master",
			fetchFn,
		});
		const item = {
			id: "item-1",
			revision: 2,
			createdAt: "2026-09-23T00:00:00.000Z",
			needsDecision: false,
			text: "进展正常。",
		};

		const claim = await client.claimHeadphoneItem(SESSION, item);
		expect(claim).toEqual(
			expect.objectContaining({ claimToken: "claim-token", item }),
		);
		await client.ackHeadphoneClaim(SESSION, claim!, [
			{
				outcome: "completed",
				pendingKey: "inbox:item-1:2:0",
				requestDigest: "a".repeat(64),
				transport: "submitted",
				contentProof: "deterministic_tts",
			},
			{
				outcome: "completed",
				pendingKey: "inbox:item-1:2:1",
				requestDigest: "b".repeat(64),
				transport: "playback_drained",
				contentProof: "transcript_equivalent",
			},
		]);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			sessionId: "voice-session",
			generation: 7,
			itemId: "item-1",
			revision: 2,
		});
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
			sessionId: "voice-session",
			generation: 7,
			itemId: "item-1",
			revision: 2,
			claimToken: "claim-token",
			requestDigests: ["a".repeat(64), "b".repeat(64)],
		});
	});

	it("reports source health without confusing rate limiting with a source gap", async () => {
		const { fetchFn } = fakeFetch(() => ({
			status: 200,
			body: {
				sources: [
					{ channelId: "c1", health: "rate_limited" },
					{ channelId: "c2", health: "healthy" },
				],
			},
		}));
		const client = new BridgeVoiceClient({
			bridgeUrl: "http://localhost:9876",
			token: "master",
			fetchFn,
		});

		const health = await client.getHeadphoneSourceHealth(SESSION);
		expect(health.healthy).toBe(false);
		expect(health.sourceGap).toBe(false);
	});

	it("submits one typed handoff and replays its results from the supplied cursor", async () => {
		const handoffId = "018f47d2-7b64-7b42-a3df-123456789abc";
		const { calls, fetchFn } = fakeFetch((url) =>
			url.includes("/results")
				? {
						status: 200,
						body: {
							events: [
								{
									resultEventId: "delivery-1:r1",
									seq: 3,
									handoffId,
									requestDigest: "a".repeat(64),
									sourceLeadId: "lead-1",
									sourceDeliveryId: "delivery-1",
									resultKind: "lead_reply",
									text: "checking",
									createdAt: "2026-09-23T20:00:05.000Z",
								},
							],
							highWatermark: 3,
							nextCursor: 3,
						},
					}
				: {
						status: 200,
						body: {
							handoffId,
							requestDigest: "a".repeat(64),
							state: "committed",
							providerOperationId: `chat:lead-1:voice-handoff:${handoffId}`,
						},
					},
		);
		const client = new BridgeVoiceClient({
			bridgeUrl: "http://localhost:9876",
			token: "master",
			fetchFn,
		});
		const request = {
			handoffId,
			requestDigest: "a".repeat(64),
			sessionId: SESSION.sessionId,
			generation: SESSION.generation,
		} as never;

		await expect(client.handoffToLead(SESSION, request)).resolves.toMatchObject(
			{
				state: "committed",
			},
		);
		await expect(
			client.listVoiceHandoffResults(SESSION, handoffId, 2),
		).resolves.toMatchObject({
			nextCursor: 3,
			events: [{ seq: 3, text: "checking" }],
		});
		expect(calls[1]?.url).toContain(
			`/api/voice/handoffs/${handoffId}/results?sessionId=voice-session&generation=7&after=2&limit=100`,
		);
	});

	it("getScope sends the Bearer token and parses the contract", async () => {
		const { calls, fetchFn } = fakeFetch(() => ({
			status: 200,
			body: SCOPE_BODY,
		}));
		const c = new BridgeVoiceClient({
			bridgeUrl: "http://localhost:9876",
			token: "tok",
			fetchFn,
		});
		const scope = await c.getScope();
		expect(scope.leadBotIds).toEqual(["lead-1"]);
		expect(calls[0]?.url).toBe("http://localhost:9876/api/voice/scope");
		expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
			"Bearer tok",
		);
	});

	it("getContext caches per channelId", async () => {
		const { calls, fetchFn } = fakeFetch(() => ({
			status: 200,
			body: {
				kind: "issue_thread",
				issueId: "id",
				issueIdentifier: "FLY-9",
				issueTitle: "t",
				agentId: "tadashi",
				stage: "implement",
			},
		}));
		const c = new BridgeVoiceClient({
			bridgeUrl: "http://localhost:9876",
			token: "tok",
			fetchFn,
		});
		const a = await c.getContext("thread-1");
		const b = await c.getContext("thread-1");
		expect(a).toEqual(b);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/api/voice/context?channelId=thread-1");
	});

	it("getContext degrades to {kind:unknown} on a failed lookup (still enqueueable)", async () => {
		const { fetchFn } = fakeFetch(() => ({ status: 500, body: {} }));
		const c = new BridgeVoiceClient({
			bridgeUrl: "http://x",
			token: "tok",
			fetchFn,
		});
		expect(await c.getContext("thread-9")).toEqual({ kind: "unknown" });
	});

	it("getGateBinding hits the endpoint and passes bound:false through", async () => {
		const { calls, fetchFn } = fakeFetch(() => ({
			status: 200,
			body: { bound: false },
		}));
		const c = new BridgeVoiceClient({
			bridgeUrl: "http://x",
			token: "tok",
			fetchFn,
		});
		expect(await c.getGateBinding("msg-1")).toEqual({ bound: false });
		expect(calls[0]?.url).toContain("/api/voice/gate-binding?messageId=msg-1");
	});

	it("gate-binding lookup failure returns bound:false (fail-closed toward NORMAL, never toward approval)", async () => {
		const { fetchFn } = fakeFetch(() => ({ status: 503, body: {} }));
		const c = new BridgeVoiceClient({
			bridgeUrl: "http://x",
			token: "tok",
			fetchFn,
		});
		expect(await c.getGateBinding("msg-1")).toEqual({ bound: false });
	});

	it("postShipApproval POSTs the body and returns the Bridge verdict verbatim", async () => {
		const { calls, fetchFn } = fakeFetch(() => ({
			status: 200,
			body: { written: true, kind: "approve" },
		}));
		const c = new BridgeVoiceClient({
			bridgeUrl: "http://x",
			token: "tok",
			fetchFn,
		});
		const res = await c.postShipApproval({
			gateMessageId: "g",
			questionId: "q",
			prHeadSha: "sha",
			transcript: { id: "t-1", text: "确认", atMs: 1 },
			receiptMessageId: "r-1",
		});
		expect(res).toEqual({ ok: true, written: true, kind: "approve" });
		expect(calls[0]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init?.body)).receiptMessageId).toBe(
			"r-1",
		);
	});

	it("postShipApproval surfaces HTTP rejections as ok:false with the status reason", async () => {
		const { fetchFn } = fakeFetch(() => ({
			status: 403,
			body: { error: "disabled_by_kill_switch" },
		}));
		const c = new BridgeVoiceClient({
			bridgeUrl: "http://x",
			token: "tok",
			fetchFn,
		});
		const res = await c.postShipApproval({
			gateMessageId: "g",
			questionId: "q",
			prHeadSha: "sha",
			transcript: { id: "t-1", text: "确认", atMs: 1 },
			receiptMessageId: "r-1",
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toContain("disabled_by_kill_switch");
	});
});
