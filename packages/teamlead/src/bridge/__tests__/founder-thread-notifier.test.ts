import { describe, expect, it, vi } from "vitest";
import type { StateStore } from "../../StateStore.js";
import {
	emitFounderMilestoneNotification,
	emitFounderStuckNotification,
	emitFounderThreadNotification,
	type FounderMilestoneNotifyOpts,
	type FounderStuckNotifyOpts,
	type FounderThreadNotifyOpts,
	scanFounderThreadForGateCard,
} from "../founder-thread-notifier.js";

const OWNER = "123456789012345678";

describe("FLY-1832 gate-card reconciliation", () => {
	it("finds exactly one bot-authored correlation marker", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify([
						{
							id: "human-copy",
							content: "gate:0123456789ab",
							timestamp: "2026-08-17T00:00:02.000Z",
							author: { bot: false },
						},
						{
							id: "card-1",
							content: "ship card\ngate:0123456789ab",
							timestamp: "2026-08-17T00:00:01.000Z",
							author: { bot: true },
						},
					]),
					{ status: 200 },
				),
		);
		expect(
			await scanFounderThreadForGateCard({
				threadId: "thread-1",
				botToken: "token",
				postedAt: "2026-08-17T00:00:00.000Z",
				correlationMarker: "gate:0123456789ab",
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).toEqual({ kind: "found", messageId: "card-1", frontier: "human-copy" });
	});

	it("keeps multiple matches and incomplete pagination ambiguous", async () => {
		const duplicateFetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify(
						["card-1", "card-2"].map((id) => ({
							id,
							content: "gate:0123456789ab",
							timestamp: "2026-08-17T00:00:01.000Z",
							author: { bot: true },
						})),
					),
					{ status: 200 },
				),
		);
		expect(
			await scanFounderThreadForGateCard({
				threadId: "thread-1",
				botToken: "token",
				postedAt: "2026-08-17T00:00:00.000Z",
				correlationMarker: "gate:0123456789ab",
				fetchImpl: duplicateFetch as unknown as typeof fetch,
			}),
		).toMatchObject({ kind: "ambiguous", reason: "multiple_matches" });

		const cappedFetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify(
						Array.from({ length: 100 }, (_, index) => ({
							id: `newer-${index}`,
							content: "other",
							timestamp: "2026-08-17T00:01:00.000Z",
							author: { bot: true },
						})),
					),
					{ status: 200 },
				),
		);
		expect(
			await scanFounderThreadForGateCard({
				threadId: "thread-1",
				botToken: "token",
				postedAt: "2026-08-17T00:00:00.000Z",
				correlationMarker: "gate:0123456789ab",
				pageCap: 1,
				fetchImpl: cappedFetch as unknown as typeof fetch,
			}),
		).toMatchObject({ kind: "ambiguous", reason: "scan_page_cap" });
	});

	it("returns none only after a complete scan", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify([
						{
							id: "other",
							content: "unrelated",
							timestamp: "2026-08-17T00:00:01.000Z",
							author: { bot: true },
						},
					]),
					{ status: 200 },
				),
		);
		expect(
			await scanFounderThreadForGateCard({
				threadId: "thread-1",
				botToken: "token",
				postedAt: "2026-08-17T00:00:00.000Z",
				correlationMarker: "gate:0123456789ab",
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).toEqual({ kind: "none", frontier: "other" });
	});
});

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
		expect(body.content).toMatch(/^🤖\[自动\] /);
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
		expect(r.deliveryRejected).toBe(true);
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

	it("2xx whose response body never settles is bounded and classified posted_ambiguous", async () => {
		vi.useFakeTimers();
		try {
			const { store, events } = makeStore();
			const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => ({
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: () =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () =>
							reject(new Error("body aborted")),
						);
					}),
			})) as unknown as typeof fetch;
			const pending = emitFounderThreadNotification(
				baseOpts({
					checkpoint: "approve_to_ship",
					correlationMarker: "gate:0123456789ab",
					deferSuccessAudit: true,
				}),
				{ store, fetchImpl },
			);

			await vi.advanceTimersByTimeAsync(5_000);
			await expect(pending).resolves.toMatchObject({
				kind: "posted_ambiguous",
			});
			expect(
				events.some((event) => event.event_type === "founder_thread_notified"),
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders a gate correlation marker outside the truncated summary", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => okJson());
		await emitFounderThreadNotification(
			baseOpts({
				checkpoint: "approve_to_ship",
				summary: "x".repeat(2_000),
				correlationMarker: "gate:0123456789ab",
			}),
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		const body = JSON.parse(
			(fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
				.body as string,
		);
		expect(body.content).toContain("x".repeat(1_499));
		expect(body.content).toContain("gate:0123456789ab");
		expect(body.content.endsWith("gate:0123456789ab")).toBe(true);
	});

	it("body gives founder_review separate paths for feedback, approval, and discussion", async () => {
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
		await emitFounderThreadNotification(
			baseOpts({
				checkpoint: "founder_review",
				summary: JSON.stringify({
					version: 1,
					round: 2,
					runId: "run-1",
					artifactDigest: "a".repeat(64),
					hostedUrl: "https://reports.example/prd-v2",
					paths: ["prd-v2.html"],
				}),
			}),
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(captured[0]).toContain("Brainstorm gate");
		expect(captured[1]).toContain("Ship gate");
		expect(captured[2]).toContain("阶段产出 review · 第 2 轮");
		expect(captured[2]).toContain("https://reports.example/prd-v2");
		expect(captured[2]).toContain("评论 / 提问");
		expect(captured[2]).toContain("一键汇总复制");
		expect(captured[2]).toContain("直接发在本 thread");
		expect(captured[2]).toContain("我才收得到");
		expect(captured[2]).toContain("批准 →");
		expect(captured[2]).toContain("reply-to 这张卡只回「approve」");
		expect(captured[2]).toContain("打回 →");
		expect(captured[2]).toContain("thread 里的自由发言不会写入 verdict");
		expect(captured[2]).not.toContain("直接回复这条卡片 = 打回");
		expect(captured[2]).not.toContain("不会自动同步给 runner");
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

// ─────────────────────────────────────────────────────────────────────────
// FLY-927 (Task 1.5): emitIssueThreadInfraNotification — the Router's
// issue-thread delivery leg.
// ─────────────────────────────────────────────────────────────────────────

import { emitIssueThreadInfraNotification } from "../founder-thread-notifier.js";

function infraOpts(over: Record<string, unknown> = {}) {
	return {
		executionId: "exec-9",
		issueId: "issue-uuid-9",
		issueIdentifier: "FLY-9",
		projectName: "flywheel",
		kind: "three_stage_stuck",
		content: "🔧 [FLY-9] DAG workflow stuck — reason",
		thread: {
			thread_id: "T9",
			channel_id: "C9",
			lead_id: null,
			archived_at: null,
		},
		botToken: "bot-token",
		onUndeliverable: vi.fn(),
		...over,
	};
}

function okJson(status = 200): Response {
	return {
		ok: true,
		status,
		headers: { get: () => null },
		json: async () => ({ id: "m-1" }),
		text: async () => "",
	} as unknown as Response;
}

describe("FLY-927 emitIssueThreadInfraNotification", () => {
	it("FLY-1995: rate-limits only repeated skipped audits and reports the best-effort suppressed count", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-22T20:00:00.000Z"));
		try {
			const { store, events } = makeStore();
			const opts = infraOpts({
				executionId: "fly1995-rate-limit",
				thread: undefined,
			});
			for (let index = 0; index < 5; index += 1) {
				await emitIssueThreadInfraNotification(
					opts as Parameters<typeof emitIssueThreadInfraNotification>[0],
					{ store },
				);
			}
			expect(
				events.filter(
					(event) => event.event_type === "issue_thread_infra_notify_skipped",
				),
			).toHaveLength(1);

			vi.advanceTimersByTime(10 * 60_000);
			await emitIssueThreadInfraNotification(
				opts as Parameters<typeof emitIssueThreadInfraNotification>[0],
				{ store },
			);
			const skipped = events.filter(
				(event) => event.event_type === "issue_thread_infra_notify_skipped",
			);
			expect(skipped).toHaveLength(2);
			expect(skipped[1]?.payload).toMatchObject({ suppressed_count: 4 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("FLY-1995: skipped-audit keys are independent by reason", async () => {
		const { store, events } = makeStore();
		const base = {
			executionId: `fly1995-reasons-${Date.now()}`,
			thread: undefined,
		};
		await emitIssueThreadInfraNotification(
			infraOpts(base) as Parameters<typeof emitIssueThreadInfraNotification>[0],
			{ store },
		);
		await emitIssueThreadInfraNotification(
			infraOpts({
				...base,
				thread: {
					thread_id: "T9",
					channel_id: "C9",
					lead_id: null,
					archived_at: null,
				},
				botToken: undefined,
			}) as Parameters<typeof emitIssueThreadInfraNotification>[0],
			{ store },
		);
		expect(
			events.filter(
				(event) => event.event_type === "issue_thread_infra_notify_skipped",
			),
		).toHaveLength(2);
	});

	it("FLY-1995: bounds skipped-audit key memory with LRU eviction", async () => {
		const { store, events } = makeStore();
		for (let index = 0; index < 1_001; index += 1) {
			await emitIssueThreadInfraNotification(
				infraOpts({
					executionId: `fly1995-lru-${index}`,
					thread: undefined,
				}) as Parameters<typeof emitIssueThreadInfraNotification>[0],
				{ store },
			);
		}
		await emitIssueThreadInfraNotification(
			infraOpts({
				executionId: "fly1995-lru-0",
				thread: undefined,
			}) as Parameters<typeof emitIssueThreadInfraNotification>[0],
			{ store },
		);
		expect(
			events.filter(
				(event) => event.event_type === "issue_thread_infra_notify_skipped",
			),
		).toHaveLength(1_002);
	});

	it("2xx → posted + audit, mentions fully suppressed when no mentionUserId", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn(async () => okJson());
		const opts = infraOpts();
		const r = await emitIssueThreadInfraNotification(
			opts as Parameters<typeof emitIssueThreadInfraNotification>[0],
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(r.kind).toBe("posted");
		const body = JSON.parse(
			(fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
				.body as string,
		);
		expect(body.allowed_mentions).toEqual({ parse: [] });
		expect(events.map((e) => e.event_type)).toEqual([
			"issue_thread_infra_notified",
		]);
		expect(opts.onUndeliverable).not.toHaveBeenCalled();
	});

	it("validated mentionUserId → single-user allowed_mentions", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => okJson());
		await emitIssueThreadInfraNotification(
			infraOpts({ mentionUserId: OWNER }) as Parameters<
				typeof emitIssueThreadInfraNotification
			>[0],
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		const body = JSON.parse(
			(fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
				.body as string,
		);
		expect(body.allowed_mentions).toEqual({ users: [OWNER] });
	});

	it("transient failures retry within budget, then onUndeliverable fires", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn(async () => res(503));
		const opts = infraOpts();
		const r = await emitIssueThreadInfraNotification(
			opts as Parameters<typeof emitIssueThreadInfraNotification>[0],
			{
				store,
				fetchImpl: fetchImpl as unknown as typeof fetch,
				maxAttempts: 3,
				sleepFn: async () => {},
			},
		);
		expect(r.kind).toBe("transient_failed");
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(opts.onUndeliverable).toHaveBeenCalledExactlyOnceWith(
			"transient-503-budget-exhausted",
		);
		expect(
			events.filter((e) => e.event_type === "issue_thread_infra_notify_failed")
				.length,
		).toBe(3);
	});

	it("transient then success within budget → posted, NO onUndeliverable", async () => {
		const { store } = makeStore();
		let n = 0;
		const fetchImpl = vi.fn(async () => (++n === 1 ? res(503) : okJson()));
		const opts = infraOpts();
		const r = await emitIssueThreadInfraNotification(
			opts as Parameters<typeof emitIssueThreadInfraNotification>[0],
			{
				store,
				fetchImpl: fetchImpl as unknown as typeof fetch,
				sleepFn: async () => {},
			},
		);
		expect(r.kind).toBe("posted");
		expect(opts.onUndeliverable).not.toHaveBeenCalled();
	});

	it("2xx with an unreadable body is an accepted effect and is never retried", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			json: async () => {
				throw new Error("body unavailable");
			},
		})) as unknown as typeof fetch;
		const opts = infraOpts();
		const result = await emitIssueThreadInfraNotification(
			opts as Parameters<typeof emitIssueThreadInfraNotification>[0],
			{ store, fetchImpl },
		);

		expect(result.kind).toBe("posted");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(opts.onUndeliverable).not.toHaveBeenCalled();
	});

	it("bounds a never-settling 2xx body and still posts infra exactly once", async () => {
		vi.useFakeTimers();
		try {
			const { store } = makeStore();
			const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => ({
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: () =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () =>
							reject(new Error("body aborted")),
						);
					}),
			})) as unknown as typeof fetch;
			const opts = infraOpts();
			const pending = emitIssueThreadInfraNotification(
				opts as Parameters<typeof emitIssueThreadInfraNotification>[0],
				{ store, fetchImpl },
			);

			await vi.advanceTimersByTimeAsync(5_000);
			await expect(pending).resolves.toMatchObject({ kind: "posted" });
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(opts.onUndeliverable).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("permanent 4xx → NO retry, onUndeliverable fires once", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => res(403));
		const opts = infraOpts();
		const r = await emitIssueThreadInfraNotification(
			opts as Parameters<typeof emitIssueThreadInfraNotification>[0],
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(r.kind).toBe("permanent_failed");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(opts.onUndeliverable).toHaveBeenCalledExactlyOnceWith(
			"permanent-403",
		);
	});

	it("DEFENSIVE: no thread binding → skipped + onUndeliverable (Router should have fail-safed)", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn();
		const opts = infraOpts({ thread: undefined });
		const r = await emitIssueThreadInfraNotification(
			opts as Parameters<typeof emitIssueThreadInfraNotification>[0],
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(r.kind).toBe("skipped");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(opts.onUndeliverable).toHaveBeenCalledExactlyOnceWith(
			"no_chat_thread",
		);
		expect(events[0]?.event_type).toBe("issue_thread_infra_notify_skipped");
	});

	it("onUndeliverable throwing never breaks the alert path", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => res(403));
		const opts = infraOpts({
			onUndeliverable: vi.fn(() => {
				throw new Error("seam broke");
			}),
		});
		const r = await emitIssueThreadInfraNotification(
			opts as Parameters<typeof emitIssueThreadInfraNotification>[0],
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(r.kind).toBe("permanent_failed");
	});
});

describe("FLY-1041 Chunk 6: ship card carries the binding guidance line", () => {
	it("approve_to_ship copy separates approval, kickback, and discussion", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => res(200));
		await emitFounderThreadNotification(
			baseOpts({ checkpoint: "approve_to_ship" }),
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const content = JSON.parse(init.body as string).content as string;
		expect(content).toContain(
			"reply-to 这张卡只回「approve」或「look good to me」",
		);
		expect(content).toContain("✅");
		expect(content).toContain("reply-to 这张卡回复「打回」");
		expect(content).toContain("提问和讨论 → 直接发在本 thread，由 Lead 接");
		expect(content).toContain("不会写入 verdict");
	});

	it("brainstorm copy is unchanged (no ship guidance line)", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => res(200));
		await emitFounderThreadNotification(baseOpts(), {
			store,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const content = JSON.parse(init.body as string).content as string;
		expect(content).not.toContain("回复这条消息");
	});
});

describe("FLY-1424 ship-ready card", () => {
	it("renders PR and QA evidence while making notification non-authoritative", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn(async () => res(200));
		await emitFounderThreadNotification(
			baseOpts({
				checkpoint: "ship_ready",
				summary:
					"PR #1424 (head aaaaaaaa) · QA passed\n引擎已走完 tpl_eng_heavy 流程，停在 founder gate 等 ship。",
			}),
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const content = JSON.parse(init.body as string).content as string;
		expect(content).toBe(
			[
				"🤖[自动] 🚀 **Ship 就绪** — FLY-605",
				`<@${OWNER}>`,
				"",
				"PR #1424 (head aaaaaaaa) · QA passed",
				"引擎已走完 tpl_eng_heavy 流程，停在 founder gate 等 ship。",
				"",
				"Lead 已同步收到。要 ship 请在本 thread 表态，由 Lead 执行合并；此卡为通知，回复/✅ 不会自动记为批准。",
			].join("\n"),
		);
		expect(
			events.some(
				(event) =>
					event.event_type === "founder_thread_notified" &&
					(event.payload as { checkpoint?: string }).checkpoint ===
						"ship_ready",
			),
		).toBe(true);
	});

	it("renders the explicit missing-evidence warning without implying approval", async () => {
		const { store } = makeStore();
		const fetchImpl = vi.fn(async () => res(200));
		await emitFounderThreadNotification(
			baseOpts({
				checkpoint: "ship_ready",
				summary:
					"⚠️ 证据缺失（无 qa_passed claim）\n引擎已走完 tpl_eng_heavy 流程，停在 founder gate 等 ship。",
			}),
			{ store, fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const content = JSON.parse(init.body as string).content as string;
		expect(content).toContain("⚠️ 证据缺失（无 qa_passed claim）");
		expect(content).toContain("此卡为通知");
		expect(content).toContain("不会自动记为批准");
	});

	it("keeps brainstorm stable and renders the tri-state approval body", async () => {
		const captured: string[] = [];
		const { store } = makeStore();
		const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
			captured.push(JSON.parse(init.body as string).content as string);
			return res(200);
		});
		for (const checkpoint of ["brainstorm", "approve_to_ship"] as const) {
			await emitFounderThreadNotification(baseOpts({ checkpoint }), {
				store,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			});
		}
		expect(captured).toEqual([
			[
				"🤖[自动] 🧠 **Brainstorm gate 等你确认** — FLY-605",
				`<@${OWNER}>`,
				"",
				"my understanding…",
				"",
				"已等 12 分钟没人答（Lead 可能漏转）。在本 thread 回复确认/纠正。",
			].join("\n"),
			[
				"🤖[自动] 🚀 **Ship gate 等你批准** — FLY-605",
				`<@${OWNER}>`,
				"",
				"my understanding…",
				"",
				"…实现 + code-review 完成、等你 ship。",
				"批准 → 在这张卡点 ✅，或 reply-to 这张卡只回「approve」或「look good to me」。打回 → reply-to 这张卡回复「打回」，或用 design: / implement: / qa: 前缀说明返工对象。提问和讨论 → 直接发在本 thread，由 Lead 接；不会写入 verdict，本轮保持开放。批准绑定后我会在你的消息上点 ✅ 确认。",
			].join("\n"),
		]);
	});
});
