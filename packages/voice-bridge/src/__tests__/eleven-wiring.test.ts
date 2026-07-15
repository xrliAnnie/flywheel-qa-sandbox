/**
 * FLY-1006 S7 — wireElevenMode: /eleven must be INVOKABLE on the daemon and
 * must consume the SHARED room (S5b). Fake DiscordDeps + injected connectWs
 * drive command registration → preflight → session start → cross-mode slot
 * contention → stop.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordDeps } from "../bots/discordWiring.js";
import type { HuddleBridgeConfig } from "../config.js";
import type { ElevenWsHandlers } from "../eleven/ElevenSession.js";
import { wireElevenMode } from "../eleven/wiring.js";
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

const ELEVEN = {
	commandName: "eleven",
	agentId: "agent_x",
	apiKeyEnv: "ELEVENLABS_API_KEY",
	shimHealthUrl: "http://127.0.0.1:8980/health",
};

function makeFakes() {
	const registered: { name: string }[] = [];
	const commandHandlers = new Map<
		string,
		(inv: {
			topic?: string;
			userId: string;
			reply: (text: string, opts?: { joinUrl?: string }) => Promise<void>;
		}) => void
	>();
	const messages: string[] = [];
	const deps = {
		createPlayer: () => ({ play() {}, stop() {}, on() {} }),
		createResource: (src: unknown) => src,
		registerGuildCommand: vi.fn(
			async (_c: unknown, _g: unknown, spec: never) => {
				registered.push(spec);
			},
		),
		onChatCommand: (_c: unknown, name: string, cb: never) => {
			commandHandlers.set(name, cb);
		},
		sendMessage: vi.fn(async (_c: unknown, _ch: unknown, text: string) => {
			messages.push(text);
		}),
		leaveVoice: vi.fn(),
	} as unknown as DiscordDeps;
	const registry = {
		client: () => ({ id: "client" }),
		join: vi.fn(async () => ({ conn: "orch" })),
	};
	return { deps, registry, registered, commandHandlers, messages };
}

describe("wireElevenMode (FLY-1006 S7)", () => {
	let stateDir: string;
	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "fly1006-wire-"));
	});
	afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

	async function wire(over: Record<string, unknown> = {}) {
		const f = makeFakes();
		const room = new VoiceRoomRuntime();
		const wsHandlers: ElevenWsHandlers[] = [];
		const runtime = await wireElevenMode({
			config: CONFIG,
			eleven: ELEVEN,
			registry: f.registry,
			deps: f.deps,
			room,
			env: { ELEVENLABS_API_KEY: "xi-key" } as NodeJS.ProcessEnv,
			log: () => {},
			fetchImpl: (async () => Response.json({ ok: true })) as typeof fetch,
			connectWs: async (handlers) => {
				wsHandlers.push(handlers);
				return { sendAudio() {}, flushAudio() {}, close() {} };
			},
			stateDir,
			...over,
		});
		return { ...f, room, runtime, wsHandlers };
	}

	function invoke(
		h: Awaited<ReturnType<typeof wire>>,
		topic?: string,
	): Promise<{ text: string; joinUrl?: string }[]> {
		const replies: { text: string; joinUrl?: string }[] = [];
		h.commandHandlers.get("eleven")?.({
			topic,
			userId: "annie",
			reply: async (text, opts) => {
				replies.push({ text, joinUrl: opts?.joinUrl });
			},
		});
		return vi.waitFor(() => {
			if (replies.length === 0) throw new Error("no reply yet");
			return replies;
		});
	}

	it("registers /eleven and a happy invocation goes live on the shared slot", async () => {
		const h = await wire();
		expect(h.registered).toEqual([expect.objectContaining({ name: "eleven" })]);
		const replies = await invoke(h);
		expect(replies[0].joinUrl).toContain("discord.com/channels");
		await vi.waitFor(() => {
			if (h.room.slot.current()?.mode !== "eleven") throw new Error("not yet");
		});
		// orchestrator joined deaf (the ears bot hears; the mouth must not echo)
		expect(h.registry.join).toHaveBeenCalledWith(
			"orchestrator",
			expect.objectContaining({ selfMute: false, selfDeaf: true }),
		);
		expect(h.wsHandlers).toHaveLength(1);
		await h.runtime.close();
		expect(h.room.slot.current()).toBe(null);
	});

	it("/gemini holding the room → /eleven rejected founder-facing", async () => {
		const h = await wire();
		h.room.slot.acquire("gemini", "meeting-1");
		const replies = await invoke(h);
		expect(replies[0].text).toContain("/gemini");
		expect(h.wsHandlers).toHaveLength(0);
		await h.runtime.close();
	});

	it("preflight failure (shim down) is a fail-loud reply, no session", async () => {
		const h = await wire({
			fetchImpl: (async (url: unknown) => {
				if (String(url).includes("convai/agents")) {
					return Response.json({ ok: true });
				}
				throw new Error("ECONNREFUSED");
			}) as typeof fetch,
		});
		const replies = await invoke(h);
		expect(replies[0].text).toContain("shim");
		expect(h.room.slot.current()).toBe(null);
		await h.runtime.close();
	});

	it("/eleven stop tears the live session down and frees the room", async () => {
		const h = await wire();
		await invoke(h);
		await vi.waitFor(() => {
			if (h.room.slot.current() == null) throw new Error("not live yet");
		});
		const replies = await invoke(h, "stop");
		expect(replies[0].text).toContain("已结束");
		expect(h.room.slot.current()).toBe(null);
	});

	it("waiting cue: loops on idle until the answer's onset, then never cuts the turn stream (QA B2 + plan §4 循环)", async () => {
		// a recording player with a real idle surface — the cue and the mouth
		// share this ONE player (the production shape).
		const events: string[] = [];
		const idleCbs: (() => void)[] = [];
		const player = {
			play: (resource: unknown) => {
				const src = resource as { kind: string };
				events.push(`play:${src.kind}`);
			},
			stop: () => {
				events.push("stop");
			},
			on: (event: string, cb: () => void) => {
				if (event === "idle") idleCbs.push(cb);
			},
		};
		const fireIdle = () => {
			for (const cb of [...idleCbs]) cb();
		};

		const h = await wire({
			eleven: { ...ELEVEN, waitingCuePath: "/clips/cue.opus" },
		});
		// route the shared deferred player at our recording player
		(h.deps as unknown as { createPlayer: () => typeof player }).createPlayer =
			() => player;
		await invoke(h);
		await vi.waitFor(() => {
			if (h.wsHandlers.length === 0) throw new Error("not live yet");
		});

		// founder finished speaking → cue starts and LOOPS while waiting
		h.room.routeSpeakingEnd();
		expect(events).toEqual(["play:file"]);
		fireIdle(); // the 1.4s clip ended — the wait is ~9s, replay
		fireIdle();
		expect(events).toEqual(["play:file", "play:file", "play:file"]);

		// the real answer's onset: cue off (one stop), then the turn stream
		h.wsHandlers[0].onAudio(Buffer.alloc(480));
		const streamAt = events.lastIndexOf("play:stream");
		expect(streamAt).toBeGreaterThanOrEqual(0);
		expect(events.slice(0, streamAt)).toContain("stop");

		// player going idle mid-turn (e.g. after the forced stop) must NOT
		// replay the cue, and later chunks must never stop the live stream
		fireIdle();
		h.wsHandlers[0].onAudio(Buffer.alloc(480));
		h.wsHandlers[0].onAudio(Buffer.alloc(480));
		expect(events.slice(streamAt + 1)).toEqual([]);

		await h.runtime.close();
	});

	it("tiv: transcripts + wait status land in the voice channel text area (QA R3 ②③)", async () => {
		const h = await wire();
		await invoke(h);
		await vi.waitFor(() => {
			if (h.wsHandlers.length === 0) throw new Error("not live yet");
		});

		// her words (platform STT) and the agent's reply are POSTED, not just
		// written to the jsonl file — Annie: 「对话在文本那边没有显示」.
		h.wsHandlers[0].onUserTranscript?.("哈豆模式能用吗");
		h.wsHandlers[0].onAgentResponse?.("可以用，我看了一下状态。");
		await vi.waitFor(() => {
			if (!h.messages.some((m) => m.includes("哈豆模式能用吗")))
				throw new Error("user caption not posted yet");
			if (!h.messages.some((m) => m.includes("可以用，我看了一下状态。")))
				throw new Error("agent caption not posted yet");
		});

		// the wait state is VISIBLE as text, not only audible as a cue clip
		// (posts after the 800ms anti-spam debounce — real timers here).
		h.room.routeSpeakingEnd();
		await vi.waitFor(
			() => {
				if (!h.messages.some((m) => m.includes("正在处理")))
					throw new Error("thinking status not posted yet");
			},
			{ timeout: 3_000 },
		);

		await h.runtime.close();
	});
});
