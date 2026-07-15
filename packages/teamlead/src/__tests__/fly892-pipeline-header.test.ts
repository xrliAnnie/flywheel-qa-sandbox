/**
 * FLY-892 Step 4: the pinned three-stage pipeline header — render states +
 * content-keyed idempotency (absorbs the FLY-560 single-runner attach pin).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATED_MESSAGE_PREFIX } from "../bridge/automated-message.js";
import {
	buildPipelineHeaderContent,
	ChatThreadCreator,
	type PhaseHeaderRow,
} from "../bridge/ChatThreadCreator.js";
import { StateStore } from "../StateStore.js";

describe("buildPipelineHeaderContent (FLY-892 Step 4)", () => {
	const ctx = { issueId: "FLY-892", issueIdentifier: "FLY-892" };

	it("renders all three states: ✅+exec+cmd / ▶+exec+cmd / ◾ pending (FLY-907 vocabulary — grey ◾, not white ⬜)", () => {
		const phases: PhaseHeaderRow[] = [
			{
				label: "[设计·Fable]",
				status: "done",
				execId: "1a2b3c4d",
				attachCommand: "tmux attach -t runner-design",
			},
			{
				label: "[实现·Opus]",
				status: "active",
				execId: "8e5b4127",
				attachCommand: "tmux attach -t runner-impl",
			},
			{ label: "[QA·Sonnet]", status: "pending", plannedModel: "Sonnet" },
		];
		const out = buildPipelineHeaderContent(ctx, phases);
		expect(out).toContain("📌 **[FLY-892] 三段流水线**");
		expect(out).toContain("**[设计·Fable]** ✅ 完成 · exec `1a2b3c4d`");
		expect(out).toContain("`tmux attach -t runner-design`");
		expect(out).toContain("**[实现·Opus]** ▶ 进行中 · exec `8e5b4127`");
		expect(out).toContain("**[QA·Sonnet]** ◾ 未开始（计划模型 Sonnet）");
	});

	it("FLY-907: a blocked phase renders 🔴 受阻; an attach cross-wire renders the degraded 终端待解析 marker instead of a command", () => {
		const out = buildPipelineHeaderContent(ctx, [
			{
				label: "[实现·Opus]",
				status: "active",
				execId: "8e5b4127",
				attachUnresolved: true,
			},
			{ label: "[QA·Opus]", status: "blocked", execId: "9f6c5238" },
		]);
		expect(out).toContain("**[实现·Opus]** ▶ 进行中 · exec `8e5b4127`");
		expect(out).toContain("（终端待解析）");
		expect(out).not.toContain("tmux");
		expect(out).toContain("**[QA·Opus]** 🔴 受阻 · exec `9f6c5238`");
	});

	it("a DONE phase whose session is gone (pre-887) shows 已结束, no command", () => {
		const out = buildPipelineHeaderContent(ctx, [
			{
				label: "[设计·Fable]",
				status: "done",
				execId: "1a2b3c4d",
				sessionEnded: true,
			},
		]);
		expect(out).toContain("**[设计·Fable]** ✅ 完成 · exec `1a2b3c4d`");
		expect(out).toContain("（session 已结束）");
		expect(out).not.toContain("tmux");
	});
});

describe("ensureRunnerPipelineHeaderPin (FLY-892 Step 4)", () => {
	let store: StateStore;
	let creator: ChatThreadCreator;
	const mockFetch = vi.fn();
	const ISSUE = "FLY-892";
	const CH = "chan-1";
	const THREAD = "thread-1";
	const ctx = {
		chatChannelId: CH,
		issueId: ISSUE,
		issueIdentifier: "FLY-892",
		issueTitle: "One thread",
		botToken: "bot",
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.stubGlobal("fetch", mockFetch);
		store = await StateStore.create(":memory:");
		store.upsertChatThread(THREAD, CH, ISSUE);
		creator = new ChatThreadCreator(store);
	});
	afterEach(() => {
		store.close();
		vi.restoreAllMocks();
	});

	const pin = () => ({ outcome: "pinned" as const });

	it("FLY-907 (Codex R1 MED-1): a posted-but-UNPINNED header reports 'deferred' so the reconcile fingerprint is withheld and the sweep retries the pin", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "m-1" }),
		});
		// Fresh post, pin forbidden (bot lacks MANAGE_MESSAGES) → deferred.
		const first = await creator.ensureRunnerPipelineHeaderPinResult(
			ctx,
			THREAD,
			"📌 header v1",
			{ pinImpl: () => ({ outcome: "forbidden" as const }), now: () => "t1" },
		);
		expect(first).toBe("deferred");
		// Same content, pin retry still forbidden → still deferred (not noop).
		const retry = await creator.ensureRunnerPipelineHeaderPinResult(
			ctx,
			THREAD,
			"📌 header v1",
			{ pinImpl: () => ({ outcome: "forbidden" as const }), now: () => "t2" },
		);
		expect(retry).toBe("deferred");
		// Perms fixed → the retry pins and reports noop (content unchanged).
		const healed = await creator.ensureRunnerPipelineHeaderPinResult(
			ctx,
			THREAD,
			"📌 header v1",
			{ pinImpl: () => ({ outcome: "pinned" as const }), now: () => "t3" },
		);
		expect(healed).toBe("noop");
		expect(store.getChatThreadAttachPin(ISSUE, CH)?.pinnedAt).toBe("t3");
	});

	it("posts + pins the header content and stores it as the fingerprint", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "m-1" }),
		});
		const content = "📌 header v1";
		await creator.ensureRunnerPipelineHeaderPin(ctx, THREAD, content, {
			pinImpl: pin,
			now: () => "2026-07-05",
		});
		const rec = store.getChatThreadAttachPin(ISSUE, CH);
		expect(rec?.command).toBe(content); // fingerprint = rendered content
		expect(rec?.pinnedAt).toBe("2026-07-05");
		const [, opts] = mockFetch.mock.calls[0]!;
		expect(JSON.parse(opts.body).content).toBe(
			`${AUTOMATED_MESSAGE_PREFIX}${content}`,
		);
	});

	it("unchanged content → zero PATCH (idempotent)", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "m-1" }),
		});
		const content = "📌 header v1";
		await creator.ensureRunnerPipelineHeaderPin(ctx, THREAD, content, {
			pinImpl: pin,
			now: () => "t",
		});
		mockFetch.mockClear();
		await creator.ensureRunnerPipelineHeaderPin(ctx, THREAD, content, {
			pinImpl: pin,
			now: () => "t",
		});
		// same content + already pinned → no POST, no PATCH
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("FLY-892 Step 7: an edit 403 (announcer can't edit a Lead-bot pin) self-heals → clear + repost", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "m-lead" }),
		});
		await creator.ensureRunnerPipelineHeaderPin(ctx, THREAD, "📌 header v1", {
			pinImpl: pin,
			now: () => "t",
		});
		mockFetch.mockClear();
		// The announcer PATCH on a pin owned by the Lead bot → 403; then a fresh POST
		// under the announcer succeeds.
		mockFetch
			.mockResolvedValueOnce({
				ok: false,
				status: 403,
				text: () => Promise.resolve("forbidden"),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "m-announcer" }),
			});
		await creator.ensureRunnerPipelineHeaderPin(ctx, THREAD, "📌 header v2", {
			pinImpl: pin,
			now: () => "t",
		});
		// A fresh POST happened (repost) after the 403, and the new message id is stored.
		const postCall = mockFetch.mock.calls.find((c) => c[1]?.method === "POST");
		expect(postCall).toBeDefined();
		expect(store.getChatThreadAttachPin(ISSUE, CH)?.messageId).toBe(
			"m-announcer",
		);
		expect(store.getChatThreadAttachPin(ISSUE, CH)?.command).toBe(
			"📌 header v2",
		);
	});

	it("changed content → in-place EDIT (PATCH), not a second pin", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "m-1" }),
		});
		await creator.ensureRunnerPipelineHeaderPin(ctx, THREAD, "📌 header v1", {
			pinImpl: pin,
			now: () => "t",
		});
		mockFetch.mockClear();
		mockFetch.mockResolvedValueOnce({ ok: true, status: 200 }); // PATCH edit
		await creator.ensureRunnerPipelineHeaderPin(ctx, THREAD, "📌 header v2", {
			pinImpl: pin,
			now: () => "t",
		});
		const editCall = mockFetch.mock.calls.find((c) => c[1]?.method === "PATCH");
		expect(editCall).toBeDefined();
		expect(JSON.parse(editCall![1].body).content).toBe(
			`${AUTOMATED_MESSAGE_PREFIX}📌 header v2`,
		);
		expect(store.getChatThreadAttachPin(ISSUE, CH)?.command).toBe(
			"📌 header v2",
		);
	});
});
