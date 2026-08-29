/**
 * FLY-967 round-5 QA kickback — session never entered live while everyone
 * was in the VC.
 *
 * Annie's round-2 re-verification (instrumented venue): the round-4
 * connection fix held (orchestrator stable 75s+, zero supervisor FATAL),
 * but caption:user=0, caption:assistant=0, zero state transitions — the
 * session sat in `invoked` forever. Root cause candidate confirmed by code
 * audit: start() awaited createConversation (the Gemini Live connect)
 * UNBOUNDED and BEFORE the presence subscription — a hanging connect means
 * onFounderJoin is never registered, wireEars never runs, and nothing is
 * ever logged. A start() failure after voice.join also left the orchestrator
 * in the VC as a zombie (nobody called voice.leave on the throw path).
 *
 * Round-5 contract:
 *   - the Gemini connect is BOUNDED (timeouts.connectMs); hang or rejection
 *     aborts the session honestly: LOUD log, kickoff issue commented+closed,
 *     orchestrator leaves the VC, slot released, and start() rethrows so the
 *     command layer sends the founder-facing failure reply;
 *   - every start() milestone and state transition is logged (the presence
 *     chain was completely blind on the real machine).
 */
import { describe, expect, it, vi } from "vitest";
import { AssistantSession } from "../assistant/AssistantSession.js";
import { GeminiCommand } from "../assistant/GeminiCommand.js";
import { SessionSlot } from "../SessionSlot.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(over: Record<string, unknown> = {}) {
	const slot = new SessionSlot();
	expect(slot.acquire("gemini", "sess-1").ok).toBe(true);
	const lines: string[] = [];
	const tiv = {
		status: vi.fn(),
		caption: vi.fn(),
		card: vi.fn(),
		error: vi.fn(),
	};
	const landing = { run: vi.fn(async () => ({ ok: true }) as const) };
	const linearAbort = {
		comment: vi.fn(async () => ({})),
		closeIssue: vi.fn(async () => {}),
	};
	const voice = {
		join: vi.fn(async () => {}),
		leave: vi.fn(),
		founderPresent: vi.fn(() => false),
		onFounderJoin: (_cb: () => void) => () => {},
		onFounderLeave: (_cb: () => void) => () => {},
	};
	const ears = {
		onFrame: (_cb: (f: Buffer, fmt: unknown) => void) => () => {},
		onSpeakingEnd: (_cb: () => void) => () => {},
		onDown: (_cb: () => void) => () => {},
		onUp: (_cb: () => void) => () => {},
	};
	const conv = {
		sendText: vi.fn(),
		sendAudio: vi.fn(),
		on: (_e: string, _h: unknown) => () => {},
		close: vi.fn(async () => undefined),
	};
	const session = new AssistantSession({
		issueId: "FLY-1234",
		sessionId: "sess-1",
		topic: "声线",
		slot,
		briefing: {
			compose: () => ({
				text: "[简报生成时间 15:00] board…",
				generatedAt: "2026-07-07T15:00:00.000Z",
				stale: false,
			}),
		},
		createConversation: vi.fn(async (_p: string) => conv),
		speaker: {
			beginTurn: vi.fn(),
			feed: vi.fn(),
			endTurn: vi.fn(),
			flush: vi.fn(),
			noteToolCall: vi.fn(),
			noteToolResolved: vi.fn(),
		},
		voice,
		ears,
		tiv,
		landing,
		linearAbort,
		log: (l: string) => lines.push(l),
		...over,
	} as never);
	return { session, slot, tiv, landing, linearAbort, voice, lines, conv };
}

describe("FLY-967 round-5 — bounded Gemini connect + honest start-failure abort", () => {
	it("a HANGING createConversation aborts after connectMs: issue closed, VC left, slot freed, loud log, start() rejects", async () => {
		const { session, slot, voice, linearAbort, lines } = harness({
			createConversation: () => new Promise(() => {}), // hangs forever
			timeouts: { connectMs: 25 },
		});
		await expect(session.start()).rejects.toThrow(/timed out/);
		expect(linearAbort.comment).toHaveBeenCalledWith(
			"FLY-1234",
			expect.stringContaining("启动失败"),
		);
		expect(linearAbort.closeIssue).toHaveBeenCalledWith("FLY-1234");
		expect(voice.leave).toHaveBeenCalled(); // no zombie mouth in the VC
		expect(slot.acquire("gemini", "sess-2").ok).toBe(true); // slot freed
		expect(session.state).toBe("idle");
		expect(lines.join("\n")).toContain("FATAL");
	});

	it("a REJECTING createConversation takes the same abort path", async () => {
		const { session, voice, linearAbort } = harness({
			createConversation: async () => {
				throw new Error("ws connect refused");
			},
		});
		await expect(session.start()).rejects.toThrow("ws connect refused");
		expect(linearAbort.closeIssue).toHaveBeenCalledWith("FLY-1234");
		expect(voice.leave).toHaveBeenCalled();
	});

	it("happy path logs every start() milestone (the chain must never be blind again)", async () => {
		const { session, lines } = harness({
			voice: {
				join: vi.fn(async () => {}),
				leave: vi.fn(),
				founderPresent: vi.fn(() => true),
				onFounderJoin: (_cb: () => void) => () => {},
				onFounderLeave: (_cb: () => void) => () => {},
			},
		});
		await session.start();
		const all = lines.join("\n");
		expect(all).toContain("voice joined");
		expect(all).toContain("briefing composed");
		expect(all).toContain("connecting Gemini Live");
		expect(all).toContain("conversation ready");
		expect(all).toContain("founderPresent()=true");
		expect(all).toContain("state -> live (initial-check)");
	});

	it("stop() racing a pending connect must NOT resurrect the session — the late conversation is closed (Codex R17)", async () => {
		let resolveConv: ((c: unknown) => void) | undefined;
		const lateConv = {
			sendText: vi.fn(),
			sendAudio: vi.fn(),
			on: (_e: string, _h: unknown) => () => {},
			close: vi.fn(async () => undefined),
		};
		const { session } = harness({
			createConversation: () =>
				new Promise((r) => {
					resolveConv = r;
				}),
			timeouts: { connectMs: 5_000 },
		});
		const started = session.start();
		await tick();
		await session.stop(); // daemon shutdown while the connect is in flight
		expect(session.state).toBe("idle");
		resolveConv?.(lateConv); // connect finally lands AFTER teardown
		await started;
		await tick();
		expect(lateConv.close).toHaveBeenCalled(); // no leaked Gemini session
		expect(lateConv.sendText).not.toHaveBeenCalled(); // no OPENING — not resurrected
		expect(session.state).toBe("idle");
	});

	it("a conversation fulfilling AFTER the connect timeout is closed, not leaked (Codex R17)", async () => {
		let resolveConv: ((c: unknown) => void) | undefined;
		const lateConv = {
			sendText: vi.fn(),
			sendAudio: vi.fn(),
			on: (_e: string, _h: unknown) => () => {},
			close: vi.fn(async () => undefined),
		};
		const { session } = harness({
			createConversation: () =>
				new Promise((r) => {
					resolveConv = r;
				}),
			timeouts: { connectMs: 20 },
		});
		await expect(session.start()).rejects.toThrow(/timed out/);
		resolveConv?.(lateConv);
		await tick();
		expect(lateConv.close).toHaveBeenCalled();
	});

	it("GeminiCommand failure reply matches reality: issue CLOSED by the abort path says closed, not 保持打开 (Codex R17)", async () => {
		const replies: string[] = [];
		const slot = { acquire: () => ({ ok: true }) as const, release: () => {} };
		const closedErr = Object.assign(
			new Error("Gemini Live connect timed out"),
			{
				issueClosed: true,
			},
		);
		const cmd = new GeminiCommand({
			slot: slot as never,
			createIssue: async () => ({ identifier: "FLY-1", url: undefined }),
			pingFounder: async () => {},
			joinUrl: "https://discord.gg/x",
			startSession: async () => {
				throw closedErr;
			},
			now: () => new Date("2026-07-08T12:00:00"),
		} as never);
		await cmd.handle({
			topic: undefined,
			userId: "u1",
			reply: async (t: string) => {
				replies.push(t);
			},
		});
		const failure = replies.find((r) => r.includes("启动失败"));
		expect(failure).toBeDefined();
		expect(failure).toContain("已自动关闭");
		expect(failure).not.toContain("保持打开");
	});

	it("waiting path logs the no-show timer and the founder-join trigger source", async () => {
		let founderJoined: (() => void) | undefined;
		const { session, lines } = harness({
			voice: {
				join: vi.fn(async () => {}),
				leave: vi.fn(),
				founderPresent: vi.fn(() => false),
				onFounderJoin: (cb: () => void) => {
					founderJoined = cb;
					return () => {};
				},
				onFounderLeave: (_cb: () => void) => () => {},
			},
		});
		await session.start();
		expect(lines.join("\n")).toContain("founderPresent()=false");
		expect(lines.join("\n")).toContain("no-show timer armed");
		founderJoined?.();
		expect(lines.join("\n")).toContain("state -> live (founder-join)");
		await session.stop();
	});
});
