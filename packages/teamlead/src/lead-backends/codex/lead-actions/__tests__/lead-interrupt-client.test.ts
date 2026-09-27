import { describe, expect, it, vi } from "vitest";
import { createLeadInterruptClient } from "../lead-interrupt-client.js";

const ID = "li_00000000-0000-4000-8000-000000000001";

function harness(
	responses: Array<{ status: number; body: unknown }> = [],
	overrides: Partial<Parameters<typeof createLeadInterruptClient>[0]> = {},
) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const queue = [...responses];
	const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const next = queue.shift() ?? { status: 200, body: {} };
		return new Response(JSON.stringify(next.body), {
			status: next.status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	const client = createLeadInterruptClient({
		bridgeUrl: "http://127.0.0.1:9876/",
		apiToken: "master-token",
		projectName: "flywheel",
		leadId: "codex-lead",
		identityDigest: "d".repeat(64),
		carrierClaim: "carrier-secret",
		fetchImpl,
		...overrides,
	});
	return { client, calls };
}

function body(init: RequestInit): Record<string, unknown> {
	return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("FLY-2883 Codex lead_interrupt client", () => {
	it("pending posts the carrier-bound identity and returns the letters", async () => {
		const payload = {
			interrupts: [
				{
					interruptId: ID,
					founderMessageId: "300000000000000001",
					body: "你现在在做什么?",
					createdAt: "2026-09-25T20:00:00.000Z",
					relayedBy: "voice_session",
					notFounderTyped: true,
				},
			],
		};
		const { client, calls } = harness([{ status: 200, body: payload }]);
		const result = await client.pending();
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual(payload);
		expect(calls[0]!.url).toBe(
			"http://127.0.0.1:9876/api/lead-interrupts/pending/query",
		);
		expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
		expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
			"Bearer master-token",
		);
		expect(body(calls[0]!.init)).toEqual({
			project: "flywheel",
			leadId: "codex-lead",
			identityDigest: "d".repeat(64),
			carrierClaim: "carrier-secret",
		});
	});

	it("reply posts the text by interrupt id", async () => {
		const { client, calls } = harness([
			{
				status: 200,
				body: { interruptId: ID, state: "replied", replayed: false },
			},
		]);
		const result = await client.reply(ID, "在跑测试,十分钟后好");
		expect(result.isError).toBeUndefined();
		expect(calls[0]!.url).toBe(
			`http://127.0.0.1:9876/api/lead-interrupts/${ID}/reply`,
		);
		expect(body(calls[0]!.init)).toMatchObject({
			text: "在跑测试,十分钟后好",
			leadId: "codex-lead",
		});
	});

	it("returns the Bridge error code as a tool error", async () => {
		const { client } = harness([
			{ status: 409, body: { error: "already_replied" } },
		]);
		const result = await client.reply(ID, "x");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("already_replied");
	});

	it("refuses a malformed interrupt id without calling the Bridge", async () => {
		const { client, calls } = harness();
		const result = await client.reply("li_bogus", "x");
		expect(result.isError).toBe(true);
		expect(calls).toHaveLength(0);
	});

	it.each([
		["bridgeUrl", { bridgeUrl: undefined }],
		["apiToken", { apiToken: undefined }],
		["identityDigest", { identityDigest: undefined }],
		["carrierClaim", { carrierClaim: undefined }],
	])("is unavailable without %s (fail-closed)", async (_label, overrides) => {
		const { client, calls } = harness([], overrides);
		expect((await client.pending()).isError).toBe(true);
		expect(calls).toHaveLength(0);
	});

	it("reports a transport failure as a tool error", async () => {
		const client = createLeadInterruptClient({
			bridgeUrl: "http://127.0.0.1:9876",
			apiToken: "master-token",
			projectName: "flywheel",
			leadId: "codex-lead",
			identityDigest: "d".repeat(64),
			carrierClaim: "carrier-secret",
			fetchImpl: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		const result = await client.pending();
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("unavailable");
	});
});
