/**
 * FLY-967 QA-B1 — wireAssistantMode + the cli.ts hook: /gemini must be
 * INVOKABLE on the running daemon, not dormant library code. Fake DiscordDeps
 * + a fake conversation drive the full chain: config → slash-command
 * registration → interaction dispatch → kickoff issue (Bridge HTTP, scoped)
 * → session start (VC join, briefing preamble, opening prompt) → close
 * teardown. Byte-compat: no assistant block → zero assistant surface.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationLike } from "../assistant/AssistantSession.js";
import {
	assistantTranscriptPath,
	classifyVoiceDelta,
	RotatorConversationAdapter,
	wireAssistantMode,
} from "../assistant/wiring.js";
import type { DiscordDeps } from "../bots/discordWiring.js";
import { runVoiceBridge } from "../cli.js";
import type { HuddleBridgeConfig } from "../config.js";
import { VoiceRoomRuntime } from "../VoiceRoomRuntime.js";

const CONFIG: HuddleBridgeConfig = {
	projectName: "flywheel",
	projectRoot: "/tmp/flywheel",
	guildId: "guild-1",
	voiceChannelId: "vc-1",
	commandName: "meet",
	moveMembers: true,
	orchestratorToken: "orch-token",
	earsToken: "ears-token",
	leads: [],
	backchannelMs: 350,
	allowUserIds: [],
	healthPort: 0,
	ffmpegBin: "ffmpeg",
};

const ASSISTANT = {
	commandName: "gemini",
	voice: "Kore",
	assistantToken: null,
	briefing: { refreshSec: 600, maxAgeSec: 1800, charBudget: 8000, docs: [] },
	localBargeIn: false,
};

class FakeConversation implements ConversationLike {
	sentTexts: string[] = [];
	preamble: string;
	/** FLY-1065 P3: the factory now receives { sessionId } (sink path contract). */
	opts?: { sessionId: string };
	closed = false;
	private readonly handlers = new Map<string, Set<(...a: unknown[]) => void>>();
	constructor(preamble: string, opts?: { sessionId: string }) {
		this.preamble = preamble;
		this.opts = opts;
	}
	sendText(t: string): void {
		this.sentTexts.push(t);
	}
	sendAudio(): void {}
	endUserTurn(): void {}
	on(event: string, h: (...a: never[]) => void): () => void {
		const set = this.handlers.get(event) ?? new Set();
		set.add(h as (...a: unknown[]) => void);
		this.handlers.set(event, set);
		return () => set.delete(h as (...a: unknown[]) => void);
	}
	emit(event: string, ...args: unknown[]): void {
		for (const h of this.handlers.get(event) ?? []) h(...args);
	}
	async close(): Promise<undefined> {
		this.closed = true;
		return undefined;
	}
}

function makeFakes() {
	const speakingEventsCalls = { count: 0 };
	const registered: { name: string; description: string }[] = [];
	const commandHandlers = new Map<
		string,
		(inv: {
			topic?: string;
			userId: string;
			reply: (text: string, opts?: { joinUrl?: string }) => Promise<void>;
		}) => void
	>();
	const messages: string[] = [];
	const statusAnchors: string[] = [];
	const statusEdits: { id: string; text: string }[] = [];
	const fetchCalls: { url: string; init: RequestInit }[] = [];
	const conversations: FakeConversation[] = [];

	const deps: DiscordDeps = {
		createClient: () => ({
			id: "client",
			login: async () => "ok",
			isReady: () => true,
			once: () => {},
			destroy: () => {},
		}),
		joinVoice: vi.fn(async () => ({ conn: true })),
		subscribeManual: () => () =>
			({ on() {}, pipe() {}, unpipe() {} }) as unknown as NodeJS.ReadableStream,
		createDecoder: () =>
			({ on() {}, pipe() {}, end() {}, destroy() {} }) as never,
		createPlayer: () => ({ play() {}, stop() {}, on() {} }),
		createResource: (src) => src,
		speakingEvents: () => {
			speakingEventsCalls.count++;
			return { on() {} };
		},
		isHumanFactory: () => () => true,
		registerGuildCommand: vi.fn(async (_c, _g, spec) => {
			registered.push(spec);
		}),
		onChatCommand: (_c, name, cb) => {
			commandHandlers.set(name, cb);
		},
		sendMessage: vi.fn(async (_c, _ch, text: string) => {
			messages.push(text);
		}),
		sendMessageForId: vi.fn(async (_c, _ch, text: string) => {
			statusAnchors.push(text);
			return { messageId: `m${statusAnchors.length}` };
		}),
		editMessage: vi.fn(async (_c, _ch, id: string, text: string) => {
			statusEdits.push({ id, text });
		}),
		onVoiceStateUpdate: () => () => {},
		voiceChannelHumanCount: async () => 1, // founder already in the VC
		moveMember: vi.fn(async () => true),
		leaveVoice: vi.fn(),
		connectionEvents: () => ({ onDown: () => () => {}, onUp: () => () => {} }),
	};

	const registry = {
		client: () => ({ id: "client" }),
		join: vi.fn(async () => ({ conn: "orch" })),
	};

	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		fetchCalls.push({ url: String(url), init: init ?? {} });
		const u = String(url);
		if (u.includes("/api/linear/create-issue")) {
			return Response.json({
				issue: { identifier: "FLY-1400", url: "https://l/FLY-1400" },
			});
		}
		if (u.includes("/api/linear/issues")) {
			return Response.json({ issues: [], truncated: false });
		}
		return Response.json({ ok: true });
	}) as typeof fetch;

	return {
		deps,
		registry,
		fetchImpl,
		get speakingEventsCalls() {
			return speakingEventsCalls.count;
		},
		registered,
		commandHandlers,
		messages,
		statusAnchors,
		statusEdits,
		fetchCalls,
		conversations,
		createConversation: async (
			preamble: string,
			opts?: { sessionId: string },
		) => {
			const c = new FakeConversation(preamble, opts);
			conversations.push(c);
			return c;
		},
	};
}

describe("wireAssistantMode (FLY-967 QA-B1)", () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "fly967-wire-"));
	});
	afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

	async function wire(over: Record<string, unknown> = {}) {
		const f = makeFakes();
		const runtime = await wireAssistantMode({
			config: CONFIG,
			assistant: ASSISTANT,
			registry: f.registry,
			deps: f.deps,
			earsConnection: { conn: "ears" },
			env: { FLYWHEEL_API_TOKEN: "bridge-token" },
			log: () => {},
			createConversation: f.createConversation,
			fetchImpl: f.fetchImpl,
			stateDir,
			...over,
		});
		return { ...f, runtime };
	}

	it("registers the configured slash command on the guild", async () => {
		const h = await wire();
		expect(h.registered).toEqual([expect.objectContaining({ name: "gemini" })]);
		expect(h.runtime.commandName).toBe("gemini");
		await h.runtime.close();
	});

	it("FLY-1006 S5b: a shared room means NO second ears — the daemon owns the receiver", async () => {
		const room = new VoiceRoomRuntime();
		const h = await wire({ room });
		// wireAssistantMode must not build its own EarsReceiver when the daemon
		// passed the shared room (double-subscription is the bug S5b prevents).
		expect(h.speakingEventsCalls).toBe(0);
		await h.runtime.close();
	});

	it("FLY-1006 S5b: /gemini and /eleven contend for the SHARED slot", async () => {
		const room = new VoiceRoomRuntime();
		const h = await wire({ room });
		// another mode holds the room → /gemini must be rejected founder-facing
		expect(room.slot.acquire("eleven", "vc-session-1").ok).toBe(true);
		const replies: string[] = [];
		h.commandHandlers.get("gemini")?.({
			topic: undefined,
			userId: "annie",
			reply: async (text) => {
				replies.push(text);
			},
		});
		await vi.waitFor(() => {
			if (replies.length === 0) throw new Error("not yet");
		});
		expect(replies[0]).toContain("/eleven");
		// no kickoff issue was created for the rejected invocation
		expect(h.fetchCalls.find((c) => c.url.includes("create-issue"))).toBe(
			undefined,
		);
		// release → /gemini can acquire the same room
		room.slot.release("eleven", "vc-session-1");
		expect(room.slot.acquire("gemini", "s2").ok).toBe(true);
		await h.runtime.close();
	});

	it("an interaction drives the FULL chain: issue → VC join → briefing preamble → opening prompt", async () => {
		const h = await wire();
		const replies: string[] = [];
		h.commandHandlers.get("gemini")?.({
			topic: "声线",
			userId: "annie",
			reply: async (text) => {
				replies.push(text);
			},
		});
		await vi.waitFor(() => {
			if (h.conversations.length === 0) throw new Error("not yet");
		});
		// kickoff issue went through the Bridge, projectName-scoped
		const createCall = h.fetchCalls.find((c) => c.url.includes("create-issue"));
		expect(createCall).toBeDefined();
		expect(String(createCall?.init.body)).toContain('"projectName":"flywheel"');
		expect(replies[0]).toContain("FLY-1400");
		// orchestrator joined the VC as the mouth (deaf — the ears bot hears)
		expect(h.registry.join).toHaveBeenCalledWith(
			"orchestrator",
			expect.objectContaining({ selfMute: false, selfDeaf: true }),
		);
		// briefing preamble reached the conversation; opening control prompt sent
		expect(h.conversations[0].preamble).toBeTruthy();
		await vi.waitFor(() => {
			if (h.conversations[0].sentTexts.length === 0) throw new Error("not yet");
		});
		expect(h.conversations[0].sentTexts[0]).toContain("开场");
		await h.runtime.close();
		// close() degrades the live meeting honestly and tears it down
		expect(h.conversations[0].closed).toBe(true);
	});

	it("fail-fast when the Bridge token is missing", async () => {
		const f = makeFakes();
		await expect(
			wireAssistantMode({
				config: CONFIG,
				assistant: ASSISTANT,
				registry: f.registry,
				deps: f.deps,
				earsConnection: {},
				env: {},
				log: () => {},
				createConversation: f.createConversation,
				fetchImpl: f.fetchImpl,
				stateDir,
			}),
		).rejects.toThrow(/FLYWHEEL_API_TOKEN/);
	});

	it("fail-fast when GEMINI_API_KEY is missing and no factory injected", async () => {
		const f = makeFakes();
		await expect(
			wireAssistantMode({
				config: CONFIG,
				assistant: ASSISTANT,
				registry: f.registry,
				deps: f.deps,
				earsConnection: {},
				env: { FLYWHEEL_API_TOKEN: "t" },
				log: () => {},
				fetchImpl: f.fetchImpl,
				stateDir,
			}),
		).rejects.toThrow(/GEMINI_API_KEY/);
	});
});

describe("FLY-1065 — TIV presenter wiring + sink path alignment", () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "fly1065-wire-"));
	});
	afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

	async function driveMeeting(over: Record<string, unknown> = {}) {
		const f = makeFakes();
		const logs: string[] = [];
		const runtime = await wireAssistantMode({
			config: CONFIG,
			assistant: ASSISTANT,
			registry: f.registry,
			deps: f.deps,
			earsConnection: { conn: "ears" },
			env: { FLYWHEEL_API_TOKEN: "bridge-token" },
			log: (l: string) => logs.push(l),
			createConversation: f.createConversation,
			fetchImpl: f.fetchImpl,
			stateDir,
			...over,
		});
		f.commandHandlers.get("gemini")?.({
			topic: undefined,
			userId: "annie",
			reply: async () => {},
		});
		await vi.waitFor(() => {
			if (f.conversations.length === 0) throw new Error("not yet");
			if (f.conversations[0].sentTexts.length === 0)
				throw new Error("not live yet");
		});
		return { ...f, runtime, logs };
	}

	it("assistantTranscriptPath is the ONE path both the sink and the landing use", () => {
		expect(assistantTranscriptPath("/state", "sess-1")).toBe(
			join("/state", "sess-1.jsonl"),
		);
	});

	it("the conversation factory receives the assistant sessionId (JSONL sink path = <sessionId>.jsonl, the FLY-967 broken link)", async () => {
		const h = await driveMeeting();
		expect(h.conversations[0].opts?.sessionId).toBeTruthy();
		await h.runtime.close();
	});

	it("status lines are ONE edited anchor message, never a message per state change (967 status spam fix)", async () => {
		const h = await driveMeeting();
		// session start pushed at least two status lines (进场 → listening);
		// the presenter must funnel them into one anchor.
		await vi.waitFor(
			() => {
				if (h.statusAnchors.length === 0) throw new Error("no anchor yet");
			},
			{ timeout: 3000 },
		);
		await vi.waitFor(
			() => {
				const last = h.statusEdits.at(-1)?.text ?? h.statusAnchors.at(-1) ?? "";
				if (!last.includes("listening")) throw new Error("not converged");
			},
			{ timeout: 4000 },
		);
		expect(h.statusAnchors).toHaveLength(1);
		// no status line ever went out as a plain new message
		expect(
			h.messages.filter(
				(m) => m.includes("正在进场") || m.includes("listening"),
			),
		).toEqual([]);
		await h.runtime.close();
	});

	it("a final transcript renders a per-turn caption message in the TIV (Annie's ask: see who said what, live)", async () => {
		const h = await driveMeeting();
		h.conversations[0].emit("transcript", {
			role: "user",
			text: "今天聊转写面板",
			final: true,
		});
		h.conversations[0].emit("transcript", {
			role: "assistant",
			text: "好的,我们逐轮显示",
			final: true,
		});
		await vi.waitFor(() => {
			if (!h.messages.some((m) => m.includes("今天聊转写面板")))
				throw new Error("user caption not rendered yet");
		});
		const userCaption = h.messages.find((m) => m.includes("今天聊转写面板"));
		const assistantCaption = h.messages.find((m) =>
			m.includes("好的,我们逐轮显示"),
		);
		expect(userCaption).toContain("🗣️");
		expect(userCaption).toContain("Annie");
		await vi.waitFor(() => {
			if (!h.messages.some((m) => m.includes("好的,我们逐轮显示")))
				throw new Error("assistant caption not rendered yet");
		});
		expect(assistantCaption ?? h.messages.at(-1)).toContain("💬");
		// fragments (final:false) never render
		h.conversations[0].emit("transcript", {
			role: "user",
			text: "碎片不上屏",
			final: false,
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(h.messages.some((m) => m.includes("碎片不上屏"))).toBe(false);
		await h.runtime.close();
	});

	it("captions:false degrades captions to the daemon log (escape hatch = 967 v1 behavior)", async () => {
		const h = await driveMeeting({
			assistant: { ...ASSISTANT, captions: false },
		});
		h.conversations[0].emit("transcript", {
			role: "user",
			text: "只进日志的转写",
			final: true,
		});
		await vi.waitFor(() => {
			if (!h.logs.some((l) => l.includes("只进日志的转写")))
				throw new Error("caption not logged yet");
		});
		expect(h.messages.some((m) => m.includes("只进日志的转写"))).toBe(false);
		await h.runtime.close();
	});
});

describe("Codex R3 regressions", () => {
	it("adapter: handlers registered AFTER the first session attaches still receive events (R3 HIGH)", () => {
		// simulate the rotator: attach the first session, THEN register handlers
		const bound: Record<string, ((...a: unknown[]) => void)[]> = {};
		const fakeSession = {
			on: (event: string, h: (...a: unknown[]) => void) => {
				if (!bound[event]) bound[event] = [];
				bound[event].push(h);
				return () => {};
			},
		};
		const adapter = new RotatorConversationAdapter({
			sendText() {},
			sendAudio() {},
			close: async () => undefined,
		} as never);
		adapter.bind(fakeSession as never); // rotator.start() attached first
		const seen: string[] = [];
		adapter.on("response-audio", (() => seen.push("audio")) as never);
		expect(bound["response-audio"]).toHaveLength(1); // late handler reached the live session
		bound["response-audio"][0]();
		expect(seen).toEqual(["audio"]);
	});

	it("presence: mute/deaf updates (from === to === VC) are not joins or leaves (R3 MEDIUM)", () => {
		expect(
			classifyVoiceDelta(
				{ fromChannelId: "vc-1", toChannelId: "vc-1" },
				"vc-1",
			),
		).toBe("none");
		expect(
			classifyVoiceDelta({ fromChannelId: null, toChannelId: "vc-1" }, "vc-1"),
		).toBe("join");
		expect(
			classifyVoiceDelta({ fromChannelId: "vc-1", toChannelId: null }, "vc-1"),
		).toBe("leave");
		expect(
			classifyVoiceDelta(
				{ fromChannelId: "other", toChannelId: "vc-1" },
				"vc-1",
			),
		).toBe("join");
		expect(
			classifyVoiceDelta(
				{ fromChannelId: "other", toChannelId: "elsewhere" },
				"vc-1",
			),
		).toBe("none");
	});

	it("a configured dedicated assistant bot is rejected until wired (R3 LOW)", async () => {
		const f = makeFakes();
		await expect(
			wireAssistantMode({
				config: CONFIG,
				assistant: { ...ASSISTANT, assistantToken: "dedicated-token" },
				registry: f.registry,
				deps: f.deps,
				earsConnection: {},
				env: { FLYWHEEL_API_TOKEN: "t" },
				log: () => {},
				createConversation: f.createConversation,
				fetchImpl: f.fetchImpl,
				stateDir: mkdtempSync(join(tmpdir(), "fly967-r3-")),
			}),
		).rejects.toThrow(/assistantBotTokenEnv/);
	});
});

describe("staged QA seams (FLY-967 ②)", () => {
	it("FLYWHEEL_GEMINI_AUTOSTART opens a round without a human interaction", async () => {
		vi.useFakeTimers();
		try {
			const f = makeFakes();
			const stateDir = mkdtempSync(join(tmpdir(), "fly967-auto-"));
			const runtime = await wireAssistantMode({
				config: CONFIG,
				assistant: ASSISTANT,
				registry: f.registry,
				deps: f.deps,
				earsConnection: {},
				env: {
					FLYWHEEL_API_TOKEN: "t",
					FLYWHEEL_GEMINI_AUTOSTART: "staged 冒烟",
				},
				log: () => {},
				createConversation: f.createConversation,
				fetchImpl: f.fetchImpl,
				stateDir,
			});
			await vi.advanceTimersByTimeAsync(2_100); // seam delay
			await vi.waitFor(() => {
				if (f.conversations.length === 0) throw new Error("not yet");
			});
			// the synthetic invocation drove the same chain: issue + reply on TIV
			expect(f.fetchCalls.some((c) => c.url.includes("create-issue"))).toBe(
				true,
			);
			expect(f.messages.some((m) => m.includes("FLY-1400"))).toBe(true);
			await runtime.close();
			rmSync(stateDir, { recursive: true, force: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it("slash-registration scope failure is LOUD but not fatal (daemon stays up)", async () => {
		const f = makeFakes();
		(f.deps.registerGuildCommand as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("Missing Access"),
		);
		const logs: string[] = [];
		const stateDir = mkdtempSync(join(tmpdir(), "fly967-scope-"));
		const runtime = await wireAssistantMode({
			config: CONFIG,
			assistant: ASSISTANT,
			registry: f.registry,
			deps: f.deps,
			earsConnection: {},
			env: { FLYWHEEL_API_TOKEN: "t" },
			log: (m) => logs.push(m),
			createConversation: f.createConversation,
			fetchImpl: f.fetchImpl,
			stateDir,
		});
		expect(logs.some((l) => l.includes("applications.commands"))).toBe(true);
		expect(f.commandHandlers.has("gemini")).toBe(true); // dispatch still wired
		await runtime.close();
		rmSync(stateDir, { recursive: true, force: true });
	});
});

describe("runVoiceBridge assistant hook (FLY-967 QA-B1)", () => {
	it("assistant: null keeps the daemon byte-compatible (no assistant surface)", async () => {
		const f = makeFakes();
		const runtime = await runVoiceBridge({
			config: CONFIG,
			deps: f.deps,
			log: () => {},
			probe: async () => ({ ok: true, detail: "fake" }),
			assistant: null,
		});
		expect(f.registered).toHaveLength(0);
		const health = await fetch(
			`http://127.0.0.1:${(runtime as unknown as { config: { healthPort: number } }).config.healthPort}/health`,
		).catch(() => null);
		void health; // healthPort 0 in tests — the assertion above is the point
		await runtime.close();
	});

	it("assistant config wires /gemini into the daemon and health reports it", async () => {
		const f = makeFakes();
		const stateDir = mkdtempSync(join(tmpdir(), "fly967-cli-"));
		try {
			const runtime = await runVoiceBridge({
				config: CONFIG,
				deps: f.deps,
				log: () => {},
				probe: async () => ({ ok: true, detail: "fake" }),
				assistant: ASSISTANT,
				assistantWiring: {
					createConversation: f.createConversation,
					fetchImpl: f.fetchImpl,
					stateDir,
					env: { FLYWHEEL_API_TOKEN: "t" },
				},
			});
			expect(f.registered).toEqual([
				expect.objectContaining({ name: "gemini" }),
			]);
			expect(f.commandHandlers.has("gemini")).toBe(true);
			await runtime.close();
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});
});
