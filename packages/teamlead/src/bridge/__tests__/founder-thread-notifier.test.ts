import { describe, expect, it, vi } from "vitest";
import type { StateStore } from "../../StateStore.js";
import {
	emitFounderMilestoneNotification,
	emitFounderStuckNotification,
	emitFounderThreadNotification,
	type FounderMilestoneNotifyOpts,
	type FounderStuckNotifyOpts,
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

function milestoneOpts(
	over: Partial<FounderMilestoneNotifyOpts> = {},
): FounderMilestoneNotifyOpts {
	return {
		executionId: "exec-m",
		issueId: "FLY-725",
		issueIdentifier: "FLY-725",
		issueTitle: "founder milestone report",
		projectName: "flywheel",
		milestone: "completed",
		route: "merged",
		prNumber: 400,
		summary: "shipped it",
		thread: {
			thread_id: "T9",
			channel_id: "C9",
			lead_id: null,
			archived_at: null,
		},
		botToken: "bot-token",
		ownerUserId: OWNER,
		...over,
	};
}

describe("FLY-725 emitFounderMilestoneNotification", () => {
	it("2xx → posts an @founder-pinged milestone report, returns posted", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn(async () => res(200));
		const r = await emitFounderMilestoneNotification(milestoneOpts(), {
			store,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r.kind).toBe("posted");
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/channels/T9/messages");
		const body = JSON.parse(init.body as string);
		// The founder is pinged (this is the whole point of FLY-725).
		expect(body.content).toContain(`<@${OWNER}>`);
		expect(body.allowed_mentions).toEqual({ users: [OWNER] });
		expect(body.content).toContain("FLY-725");
		expect(body.content).toContain("完成");
		expect(body.content).toContain("PR #400");
		expect(
			events.some((e) => e.event_type === "founder_milestone_notified"),
		).toBe(true);
	});

	it("failed milestone → 🔴 失败 body carries the error reason", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => res(200));
		await emitFounderMilestoneNotification(
			milestoneOpts({
				milestone: "failed",
				lastError: "npm build exploded",
				prNumber: undefined,
				summary: undefined,
			}),
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.content).toContain("失败");
		expect(body.content).toContain("npm build exploded");
	});

	it("blocked milestone → ⛔ 受阻, reason from summary/decisionReasoning when no last_error (Codex code R1)", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => res(200));
		await emitFounderMilestoneNotification(
			milestoneOpts({
				milestone: "blocked",
				lastError: undefined,
				prNumber: undefined,
				summary: "等一个产品决定",
				decisionReasoning: "blocked on Annie's call",
			}),
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.content).toContain("受阻");
		// summary is the real reason (preferred over decisionReasoning).
		expect(body.content).toContain("原因：等一个产品决定");
	});

	it("pr_handoff completed → hints 待你手动 ship", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => res(200));
		await emitFounderMilestoneNotification(
			milestoneOpts({ route: "pr_handoff" }),
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.content).toContain("待你手动 ship");
	});

	it("missing thread / token / owner / bad snowflake → skipped, no POST", async () => {
		for (const over of [
			{ thread: undefined },
			{ botToken: undefined },
			{ ownerUserId: undefined },
			{ ownerUserId: "not-a-snowflake" },
		] as Array<Partial<FounderMilestoneNotifyOpts>>) {
			const { store, events } = makeStore();
			const fetchImpl = vi.fn(async () => res(200));
			const r = await emitFounderMilestoneNotification(milestoneOpts(over), {
				store,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			});
			expect(r.kind).toBe("skipped");
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(
				events.some((e) => e.event_type === "founder_milestone_notify_skipped"),
			).toBe(true);
		}
	});

	it("429 → transient_failed with retryAfterMs", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () =>
			res(429, { headers: { "retry-after": "2" } }),
		);
		const r = await emitFounderMilestoneNotification(milestoneOpts(), {
			store,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r.kind).toBe("transient_failed");
		expect(r.retryAfterMs).toBe(2000);
	});

	it("4xx → permanent_failed (retry won't help)", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => res(403));
		const r = await emitFounderMilestoneNotification(milestoneOpts(), {
			store,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r.kind).toBe("permanent_failed");
	});
});

function stuckOpts(
	over: Partial<FounderStuckNotifyOpts> = {},
): FounderStuckNotifyOpts {
	return {
		executionId: "exec1",
		issueId: "uuid-FLY-818",
		issueIdentifier: "FLY-818",
		projectName: "flywheel",
		leadAgentId: "tadashi-eng-lead",
		stuckMinutes: 47,
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

describe("FLY-818 M3 emitFounderStuckNotification (issue-thread page)", () => {
	it("2xx → posts an @founder-pinged stuck page to the ISSUE thread, returns posted", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn(async () => res(200));
		const r = await emitFounderStuckNotification(stuckOpts(), {
			store,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r.kind).toBe("posted");
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/channels/T1/messages");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bot bot-token",
		);
		const body = JSON.parse(init.body as string);
		expect(body.content).toContain(`<@${OWNER}>`);
		expect(body.content).toContain("FLY-818"); // the stuck issue
		// Founder-only ping — @everyone/roles inert.
		expect(body.allowed_mentions).toEqual({ users: [OWNER] });
		expect(events.some((e) => e.event_type === "founder_stuck_notified")).toBe(
			true,
		);
	});

	it("no chat thread (transient) / no owner / bad owner id ⇒ skipped without a POST", async () => {
		for (const over of [
			{ thread: undefined },
			{ ownerUserId: undefined },
			{ ownerUserId: "not-a-snowflake" },
		] as Partial<FounderStuckNotifyOpts>[]) {
			const { store } = makeStore();
			const fetchImpl = vi.fn(async () => res(200));
			const r = await emitFounderStuckNotification(stuckOpts(over), {
				store,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			});
			expect(r.kind).toBe("skipped");
			expect(fetchImpl).not.toHaveBeenCalled();
		}
	});

	it("429 → transient_failed with retryAfterMs (caller retries)", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () =>
			res(429, { headers: { "retry-after": "2" } }),
		);
		const r = await emitFounderStuckNotification(stuckOpts(), {
			store,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r.kind).toBe("transient_failed");
		expect(r.retryAfterMs).toBe(2000);
	});

	it("4xx → permanent_failed", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => res(403));
		const r = await emitFounderStuckNotification(stuckOpts(), {
			store,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r.kind).toBe("permanent_failed");
	});
});
