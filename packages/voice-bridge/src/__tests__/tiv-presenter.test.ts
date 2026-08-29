/**
 * FLY-1065 P4 — TivPresenter: the text-panel renderer for /gemini.
 *   - caption(role, text): one new Discord message per turn, role-prefixed,
 *     scrubbed (defense in depth), truncated past the cap;
 *   - status(line): ONE message, edited in place — single-flight async state
 *     machine (status() is sync/void over async send/edit, so throttle alone
 *     cannot stop promise-timing double-sends);
 *   - card / error: independent new messages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TivPresenter, type TivSendDeps } from "../discord/TivPresenter.js";

function makeDeps() {
	const sent: string[] = [];
	const edits: { id: string; text: string }[] = [];
	let nextId = 0;
	let sendForIdImpl: (text: string) => Promise<{ messageId: string }>;
	let editImpl: (id: string, text: string) => Promise<void>;
	const deps: TivSendDeps = {
		send: vi.fn(async (text: string) => {
			sent.push(text);
		}),
		sendForId: vi.fn((text: string) => sendForIdImpl(text)),
		edit: vi.fn((id: string, text: string) => editImpl(id, text)),
	};
	// default happy implementations (overridable per test)
	sendForIdImpl = async (text: string) => {
		sent.push(`#id:${text}`);
		return { messageId: `m${nextId++}` };
	};
	editImpl = async (id: string, text: string) => {
		edits.push({ id, text });
	};
	return {
		deps,
		sent,
		edits,
		setSendForId: (fn: typeof sendForIdImpl) => {
			sendForIdImpl = fn;
		},
		setEdit: (fn: typeof editImpl) => {
			editImpl = fn;
		},
	};
}

function makePresenter(over: Record<string, unknown> = {}) {
	const d = makeDeps();
	const p = new TivPresenter({ deps: d.deps, ...over });
	return { p, ...d };
}

describe("TivPresenter caption", () => {
	it("emits one new message per turn with role prefix + founder/assistant names", async () => {
		const { p, deps } = makePresenter({
			founderName: "Annie",
			assistantName: "助理",
		});
		p.caption("user", "今天聊转写面板");
		p.caption("assistant", "好的,我们来看看");
		await vi.waitFor(() =>
			expect((deps.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2),
		);
		const calls = (deps.send as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0][0]).toBe("🗣️ **Annie**:今天聊转写面板");
		expect(calls[1][0]).toBe("💬 **助理**:好的,我们来看看");
	});

	it("scrubs at the caption exit (defense in depth — shared path for 545/1018)", async () => {
		const { p, deps } = makePresenter();
		p.caption("assistant", "key 是 sk-ABCDEFGHIJKLMNOP1234 别外传");
		await vi.waitFor(() =>
			expect((deps.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1),
		);
		const text = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(text).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
		expect(text).toContain("[redacted]");
	});

	it("truncates past captionMaxChars with a pointer to the after-meeting record", async () => {
		const { p, deps } = makePresenter({ captionMaxChars: 20 });
		p.caption("user", "一二三四五六七八九十一二三四五六七八九十一二三四五");
		await vi.waitFor(() =>
			expect((deps.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1),
		);
		const text = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(text).toContain("…(截断,完整见会后记录)");
		expect(text.length).toBeLessThan(80);
	});

	it("captions:false degrades to log (967 v1 behavior) — nothing sent", async () => {
		const logs: string[] = [];
		const { p, deps } = makePresenter({
			captions: false,
			log: (l: string) => logs.push(l),
		});
		p.caption("user", "只进日志");
		await Promise.resolve();
		expect((deps.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
		expect(logs.some((l) => l.includes("只进日志"))).toBe(true);
	});

	it("a failing caption send is logged, never thrown", async () => {
		const logs: string[] = [];
		const { p, deps } = makePresenter({ log: (l: string) => logs.push(l) });
		(deps.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("discord 500"),
		);
		expect(() => p.caption("user", "会失败")).not.toThrow();
		await vi.waitFor(() =>
			expect(logs.some((l) => l.includes("discord 500"))).toBe(true),
		);
	});
});

describe("TivPresenter status — single-flight edit-in-place", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("many rapid status() calls before the first send resolves → exactly ONE anchor message", async () => {
		const { p, deps } = makePresenter({ statusThrottleMs: 1000 });
		p.status("🎙 进场");
		p.status("💬 speaking");
		p.status("🎙 listening");
		await vi.advanceTimersByTimeAsync(2000);
		expect((deps.sendForId as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
			1,
		);
		// the anchor carries the LATEST line, later ones edit
		const editCalls = (deps.edit as ReturnType<typeof vi.fn>).mock.calls;
		const lastText =
			editCalls.length > 0
				? editCalls[editCalls.length - 1][1]
				: (deps.sendForId as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(lastText).toBe("🎙 listening");
	});

	it("a new line arriving while an edit is in flight is not lost and not reordered", async () => {
		const { p, setEdit, deps } = makePresenter({ statusThrottleMs: 100 });
		let releaseEdit: (() => void) | null = null;
		const editOrder: string[] = [];
		setEdit(async (_id: string, text: string) => {
			editOrder.push(text);
			if (text === "second") {
				await new Promise<void>((r) => {
					releaseEdit = r;
				});
			}
		});
		p.status("first"); // becomes the anchor via sendForId
		await vi.advanceTimersByTimeAsync(150);
		p.status("second"); // first edit — will block
		await vi.advanceTimersByTimeAsync(150);
		p.status("third"); // arrives while "second" edit in flight
		await vi.advanceTimersByTimeAsync(150);
		expect(releaseEdit).not.toBeNull();
		(releaseEdit as unknown as () => void)();
		await vi.advanceTimersByTimeAsync(300);
		expect((deps.sendForId as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
			1,
		);
		expect(editOrder[editOrder.length - 1]).toBe("third"); // latest wins, in order
	});

	it("edit failure self-heals: re-send a fresh anchor with the latest line", async () => {
		const { p, setEdit, deps } = makePresenter({ statusThrottleMs: 50 });
		let firstEdit = true;
		setEdit(async () => {
			if (firstEdit) {
				firstEdit = false;
				throw new Error("message deleted");
			}
		});
		p.status("anchor");
		await vi.advanceTimersByTimeAsync(100);
		p.status("after-delete");
		await vi.advanceTimersByTimeAsync(200);
		// one original anchor + one re-sent anchor after the edit failed
		expect(
			(deps.sendForId as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBeGreaterThanOrEqual(2);
		const reSent = (deps.sendForId as ReturnType<typeof vi.fn>).mock.calls.at(
			-1,
		);
		expect(reSent?.[0]).toBe("after-delete");
	});

	it("throttle window collapses bursts to the latest line only", async () => {
		const { p, deps } = makePresenter({ statusThrottleMs: 1000 });
		p.status("a");
		await vi.advanceTimersByTimeAsync(1200); // first flush
		p.status("b");
		p.status("c");
		p.status("d");
		await vi.advanceTimersByTimeAsync(1200);
		// a → anchor; then within one throttle window b/c/d collapse to one edit=d
		const edits = (deps.edit as ReturnType<typeof vi.fn>).mock.calls;
		expect(edits.length).toBe(1);
		expect(edits[0][1]).toBe("d");
	});

	it("a fully failing status chain logs but never throws", async () => {
		const logs: string[] = [];
		const { p, setSendForId } = makePresenter({
			statusThrottleMs: 10,
			log: (l: string) => logs.push(l),
		});
		setSendForId(async () => {
			throw new Error("send down");
		});
		expect(() => p.status("boom")).not.toThrow();
		await vi.advanceTimersByTimeAsync(50);
		expect(logs.some((l) => l.includes("send down"))).toBe(true);
	});
});

describe("TivPresenter card / error", () => {
	it("card and error are independent new messages; error is ⚠️-prefixed", async () => {
		const { p, deps } = makePresenter();
		p.card("✅ 会议纪要已落 FLY-1");
		p.error("语音会话错误");
		await vi.waitFor(() =>
			expect((deps.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2),
		);
		const calls = (deps.send as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0][0]).toBe("✅ 会议纪要已落 FLY-1");
		expect(calls[1][0]).toBe("⚠️ 语音会话错误");
	});
});
