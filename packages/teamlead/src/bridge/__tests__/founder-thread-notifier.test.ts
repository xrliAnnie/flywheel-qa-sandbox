import { describe, expect, it, vi } from "vitest";
import type { StateStore } from "../../StateStore.js";
import {
	emitFounderThreadNotification,
	type FounderThreadNotifyOpts,
} from "../founder-thread-notifier.js";

const OWNER = "123456789012345678";

function makeStore() {
	const events: Array<{ event_type: string; payload: unknown }> = [];
	const store = {
		insertEvent: vi.fn((e: { event_type: string; payload: unknown }) => {
			events.push({ event_type: e.event_type, payload: e.payload });
			return true;
		}),
	} as unknown as StateStore;
	return { store, events };
}

function res(
	status: number,
	{ headers = {} as Record<string, string> } = {},
): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
		text: async () => "",
	} as unknown as Response;
}

function baseOpts(
	over: Partial<FounderThreadNotifyOpts> = {},
): FounderThreadNotifyOpts {
	return {
		questionId: "q1",
		checkpoint: "brainstorm",
		executionId: "exec1",
		issueId: "FLY-605",
		issueIdentifier: "FLY-605",
		projectName: "flywheel",
		summary: "my understanding…",
		ageMinutes: 12,
		thread: {
			thread_id: "T1",
			channel_id: "C1",
			lead_id: null,
			archived_at: null,
		},
		botToken: "bot-token",
		ownerUserId: OWNER,
		...over,
	};
}

describe("FLY-605 emitFounderThreadNotification (Part A)", () => {
	it("2xx → posts to the thread with @owner + allowed_mentions.users, returns posted", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn(async () => res(200));
		const r = await emitFounderThreadNotification(baseOpts(), {
			store,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r.kind).toBe("posted");
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/channels/T1/messages");
		const body = JSON.parse(init.body as string);
		expect(body.content).toContain(`<@${OWNER}>`);
		expect(body.allowed_mentions).toEqual({ users: [OWNER] });
		expect(events.some((e) => e.event_type === "founder_thread_notified")).toBe(
			true,
		);
	});

	it("missing thread / token / owner / bad snowflake → skipped + audit, no POST", async () => {
		for (const [over, reason] of [
			[{ thread: undefined }, "no_chat_thread"],
			[{ botToken: undefined }, "no_bot_token"],
			[{ ownerUserId: undefined }, "no_owner"],
			[{ ownerUserId: "not-a-snowflake" }, "bad_owner_id"],
		] as Array<[Partial<FounderThreadNotifyOpts>, string]>) {
			const { store, events } = makeStore();
			const fetchImpl = vi.fn(async () => res(200));
			const r = await emitFounderThreadNotification(baseOpts(over), {
				store,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			});
			expect(r.kind).toBe("skipped");
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(
				events.some(
					(e) =>
						e.event_type === "founder_thread_notify_skipped" &&
						(e.payload as { reason: string }).reason === reason,
				),
			).toBe(true);
		}
	});

	it("400 / 401 / 403 / 404 → permanent_failed (non-429 4xx)", async () => {
		for (const status of [400, 401, 403, 404]) {
			const { store } = makeStore();
			const fetchImpl = vi.fn(async () => res(status));
			const r = await emitFounderThreadNotification(baseOpts(), {
				store,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			});
			expect(r.kind).toBe("permanent_failed");
		}
	});

	it("429 with Retry-After → transient_failed carrying retryAfterMs", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () =>
			res(429, { headers: { "retry-after": "2" } }),
		);
		const r = await emitFounderThreadNotification(baseOpts(), {
			store,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r.kind).toBe("transient_failed");
		expect(r.retryAfterMs).toBe(2000);
	});

	it("5xx / network throw → transient_failed, never throws", async () => {
		const { store } = makeStore();
		const r1 = await emitFounderThreadNotification(baseOpts(), {
			store,
			fetchImpl: (async () => res(503)) as unknown as typeof fetch,
		});
		expect(r1.kind).toBe("transient_failed");
		const r2 = await emitFounderThreadNotification(baseOpts(), {
			store,
			fetchImpl: (async () => {
				throw new Error("network down");
			}) as unknown as typeof fetch,
		});
		expect(r2.kind).toBe("transient_failed");
	});

	it("body differs by checkpoint (brainstorm vs approve_to_ship)", async () => {
		const captured: string[] = [];
		const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
			captured.push(JSON.parse(init.body as string).content);
			return res(200);
		});
		const { store } = makeStore();
		await emitFounderThreadNotification(
			baseOpts({ checkpoint: "brainstorm" }),
			{
				store,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			},
		);
		await emitFounderThreadNotification(
			baseOpts({ checkpoint: "approve_to_ship" }),
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(captured[0]).toContain("Brainstorm gate");
		expect(captured[1]).toContain("Ship gate");
	});
});
