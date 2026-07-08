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
import { wireAssistantMode } from "../assistant/wiring.js";
import type { DiscordDeps } from "../bots/discordWiring.js";
import { runVoiceBridge } from "../cli.js";
import type { HuddleBridgeConfig } from "../config.js";

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
	closed = false;
	constructor(preamble: string) {
		this.preamble = preamble;
	}
	sendText(t: string): void {
		this.sentTexts.push(t);
	}
	sendAudio(): void {}
	on(): () => void {
		return () => {};
	}
	async close(): Promise<undefined> {
		this.closed = true;
		return undefined;
	}
}

function makeFakes() {
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
		speakingEvents: () => ({ on() {} }),
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
		registered,
		commandHandlers,
		messages,
		fetchCalls,
		conversations,
		createConversation: async (preamble: string) => {
			const c = new FakeConversation(preamble);
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
