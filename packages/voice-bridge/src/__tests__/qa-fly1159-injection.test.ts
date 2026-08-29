/**
 * FLY-1159 QA — /gemini-advanced voice wiring (route A) machine verification.
 *
 * The 14 implement-phase tests (assistant-advanced.test.ts) cover the delegate
 * tool's own behavior (config parse, spoken/text announce, fail-fast) in
 * isolation. This QA file closes the two seams they do NOT touch:
 *
 *   layer (a) — the extraTools INJECTION seam. We drive the REAL
 *     `makeRealConversationFactory` (via `wireAssistantMode` with NO injected
 *     conversation factory) and capture the extraTools array the production
 *     code actually hands the Gemini Live backend — by stubbing ONLY
 *     `GeminiLiveBackend.createConversation` (voice-core), leaving the whole
 *     wiring.ts assembly path real. So if wiring.ts ever stopped appending the
 *     delegate tool (or stopped honoring `assistant.advanced`), this fails —
 *     it is NOT a mirror of the production expression, it runs it.
 *     TWO-COMMAND contract (founder correction 2026-07-11 — /gemini stays
 *     plain; the delegate mounts on its OWN voice command):
 *       advanced present → /gemini sessions get EXACTLY the base read-only
 *         tools (byte-freeze), and the separate /gemini-advanced command's
 *         sessions get base + delegate_task;
 *       advanced absent  → only /gemini exists, exactly the base tools;
 *       the deep 6-tool registry stays INSIDE delegate_task (gemini-agent),
 *       it is NOT expanded into the Live extraTools (Codex R1 tool-count fix).
 *
 *   layer (a) startup guard — cli.ts's fail-fast preflight:
 *     advanced configured + deep-agent env incomplete + real factory path
 *       → the daemon dies at boot with fix guidance (never at Annie's first
 *         /gemini-advanced use);
 *     the staged-QA seam (assistantWiring.createConversation injected) skips
 *       the preflight — the real factory is bypassed there, so it must not
 *       fail-fast (this is exactly the path a QA harness / this suite uses).
 *
 * The acoustic loop (Annie speaks → Gemini Live STT → deep run → spoken +
 * text landing) is NOT machine-verifiable: Live STT cannot ingest synthetic
 * audio (brainstorm-gate boundary). It is the founder ⏳ column of the QA
 * report, not a gap in this file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the extraTools the REAL wiring hands the Live backend. vi.hoisted so
// the mock factory (hoisted above the imports) can reach it.
const seam = vi.hoisted(() => ({ captured: [] as string[][] }));

// Stub ONLY GeminiLiveBackend.createConversation; everything else in voice-core
// (resolveConfig, createGenaiTransport, TalkSessionRotator, JsonlTranscriptSink,
// HeadlessClaudeBrain, …) stays REAL so makeRealConversationFactory runs for real.
vi.mock("flywheel-voice-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("flywheel-voice-core")>();
	class MockGeminiLiveBackend {
		createConversation = (opts: {
			extraTools?: Array<{ declaration: { name: string } }>;
		}) => {
			const names = (opts?.extraTools ?? []).map((t) => t.declaration.name);
			seam.captured.push(names);
			// minimal ConversationSession the rotator/adapter need
			return {
				on: () => () => {},
				sendAudio() {},
				sendText() {},
				endUserTurn() {},
				close: async () => undefined,
			};
		};
	}
	return { ...actual, GeminiLiveBackend: MockGeminiLiveBackend };
});

import { wireAssistantMode } from "../assistant/wiring.js";
import { runVoiceBridge } from "../cli.js";
import type { HuddleBridgeConfig } from "../config.js";

const CONFIG: HuddleBridgeConfig = {
	projectName: "geoforge3d",
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

// a complete deep-agent env (mirrors assistant-advanced.test.ts) — the advanced
// tool build (buildAdvancedDelegateTool) needs it; GEMINI_API_KEY also lets the
// real factory resolve its api key. No network is opened.
const AGENT_ENV = {
	FLYWHEEL_GEMINI_AGENT: "1",
	GEMINI_API_KEY: "test-key",
	FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9",
	FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN: "scoped-test",
} as NodeJS.ProcessEnv;

// full DiscordDeps + registry + fetch fakes — modelled on
// assistant-wiring.test.ts's makeFakes (the FLY-967 hook harness). Enough to
// drive an interaction all the way to session start (create-issue → VC join →
// createConversation).
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
	const fetchCalls: string[] = [];

	const deps = {
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
		createResource: (src: unknown) => src,
		speakingEvents: () => ({ on() {} }),
		isHumanFactory: () => () => true,
		registerGuildCommand: vi.fn(
			async (_c: unknown, _g: unknown, spec: { name: string }) => {
				registered.push(spec);
			},
		),
		onChatCommand: (_c: unknown, name: string, cb: (inv: never) => void) => {
			commandHandlers.set(name, cb as (inv: unknown) => void);
		},
		sendMessage: vi.fn(async () => {}),
		sendMessageForId: vi.fn(async () => ({ messageId: "m1" })),
		editMessage: vi.fn(async () => {}),
		onVoiceStateUpdate: () => () => {},
		voiceChannelHumanCount: async () => 1,
		moveMember: vi.fn(async () => true),
		leaveVoice: vi.fn(),
		connectionEvents: () => ({ onDown: () => () => {}, onUp: () => () => {} }),
	} as unknown as Parameters<typeof runVoiceBridge>[0]["deps"];

	const registry = {
		client: () => ({ id: "client" }),
		join: vi.fn(async () => ({ conn: "orch" })),
	};

	const fetchImpl = (async (url: string | URL) => {
		fetchCalls.push(String(url));
		if (String(url).includes("/api/linear/create-issue")) {
			return Response.json({
				issue: { identifier: "FLY-1400", url: "https://l/FLY-1400" },
			});
		}
		return Response.json({ ok: true });
	}) as typeof fetch;

	return { deps, registry, fetchImpl, registered, commandHandlers, fetchCalls };
}

describe("FLY-1159 layer (a) — extraTools injection through the REAL factory", () => {
	let stateDir: string;

	beforeEach(() => {
		seam.captured.length = 0;
		stateDir = mkdtempSync(join(tmpdir(), "fly1159-seam-"));
	});
	afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

	/** drive wireAssistantMode with NO injected factory → the real
	 * makeRealConversationFactory runs; trigger a meeting via the named
	 * command → capture extraTools. */
	async function captureExtraTools(
		assistant: Record<string, unknown>,
		env: NodeJS.ProcessEnv,
		commandName = "gemini",
	): Promise<{ names: string[]; close: () => Promise<void> }> {
		const f = makeFakes();
		const runtime = await wireAssistantMode({
			config: CONFIG,
			assistant: assistant as never,
			registry: f.registry,
			deps: f.deps,
			earsConnection: { conn: "ears" },
			env: { FLYWHEEL_API_TOKEN: "bridge-token", ...env },
			log: () => {},
			// NO createConversation → the REAL makeRealConversationFactory is used
			fetchImpl: f.fetchImpl,
			stateDir,
		});
		const handler = f.commandHandlers.get(commandName);
		if (!handler) {
			await runtime.close();
			throw new Error(`no chat handler registered for /${commandName}`);
		}
		handler({
			topic: undefined,
			userId: "annie",
			reply: async () => {},
		});
		await vi.waitFor(() => {
			if (seam.captured.length === 0)
				throw new Error("no createConversation yet");
		});
		return { names: seam.captured[0], close: () => runtime.close() };
	}

	it("advanced present → /gemini sessions still receive EXACTLY the base tools (byte-freeze — the plain command never carries the delegate)", async () => {
		const { names, close } = await captureExtraTools(
			{ ...ASSISTANT, advanced: { leadId: "qa-lead", deptLabel: "Ops-Test" } },
			AGENT_ENV,
			"gemini",
		);
		expect(names).toEqual(["lookup_issue", "board_snapshot"]);
		await close();
	});

	it("advanced present → the /gemini-advanced command's sessions receive base tools + delegate_task (deep 6-tool registry stays inside delegate)", async () => {
		const { names, close } = await captureExtraTools(
			{ ...ASSISTANT, advanced: { leadId: "qa-lead", deptLabel: "Ops-Test" } },
			AGENT_ENV,
			"gemini-advanced",
		);
		// exactly 3 — NOT 2+6. delegate_task is the single Live-facing surface;
		// the gemini-agent deep registry lives behind it (Codex R1 correction).
		expect(names).toEqual(["lookup_issue", "board_snapshot", "delegate_task"]);
		await close();
	});

	it("advanced absent → the Live backend receives EXACTLY the base read-only tools (byte-compat)", async () => {
		const { names, close } = await captureExtraTools(ASSISTANT, {
			GEMINI_API_KEY: "test-key",
		} as NodeJS.ProcessEnv);
		expect(names).toEqual(["lookup_issue", "board_snapshot"]);
		await close();
	});
});

describe("FLY-1159 two-command registration (founder contract 2026-07-11)", () => {
	let stateDir: string;
	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "fly1159-reg-"));
	});
	afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

	async function wire(assistant: Record<string, unknown>) {
		const f = makeFakes();
		const runtime = await wireAssistantMode({
			config: CONFIG,
			assistant: assistant as never,
			registry: f.registry,
			deps: f.deps,
			earsConnection: { conn: "ears" },
			env: {
				FLYWHEEL_API_TOKEN: "bridge-token",
				...AGENT_ENV,
			} as NodeJS.ProcessEnv,
			log: () => {},
			createConversation: async () =>
				({
					on: () => () => {},
					sendAudio() {},
					sendText() {},
					endUserTurn() {},
					close: async () => undefined,
				}) as never,
			fetchImpl: f.fetchImpl,
			stateDir,
		});
		return { f, runtime };
	}

	it("advanced present → BOTH commands are registered (slash + chat), and the runtime reports the advanced name", async () => {
		const { f, runtime } = await wire({
			...ASSISTANT,
			advanced: { leadId: "qa-lead", commandName: "gemini-advanced" },
		});
		expect(f.registered.map((r) => r.name).sort()).toEqual([
			"gemini",
			"gemini-advanced",
		]);
		expect([...f.commandHandlers.keys()].sort()).toEqual([
			"gemini",
			"gemini-advanced",
		]);
		expect(runtime.commandName).toBe("gemini");
		expect(runtime.advancedCommandName).toBe("gemini-advanced");
		await runtime.close();
	});

	it("advanced present with a custom commandName → the second command uses it", async () => {
		const { f, runtime } = await wire({
			...ASSISTANT,
			advanced: { leadId: "qa-lead", commandName: "ga-test" },
		});
		expect(f.commandHandlers.has("ga-test")).toBe(true);
		expect(runtime.advancedCommandName).toBe("ga-test");
		await runtime.close();
	});

	it("advanced absent → exactly ONE command registered (byte-compat)", async () => {
		const { f, runtime } = await wire(ASSISTANT);
		expect(f.registered.map((r) => r.name)).toEqual(["gemini"]);
		expect([...f.commandHandlers.keys()]).toEqual(["gemini"]);
		expect(runtime.advancedCommandName).toBeUndefined();
		await runtime.close();
	});
});

// minimal DiscordDeps for the cli.ts fail-fast tests (the throw fires before
// deps are used; the seam test needs only that they exist).
function makeDeps() {
	return makeFakes().deps;
}

describe("FLY-1159 layer (a) — cli.ts startup fail-fast (half-configured advanced)", () => {
	let savedEnv: NodeJS.ProcessEnv;
	let stateDir: string;

	beforeEach(() => {
		savedEnv = { ...process.env };
		stateDir = mkdtempSync(join(tmpdir(), "fly1159-cli-"));
	});
	afterEach(() => {
		// restore process.env exactly (delete keys the test added, re-set the rest)
		for (const k of Object.keys(process.env)) {
			if (!(k in savedEnv)) delete process.env[k];
		}
		Object.assign(process.env, savedEnv);
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("advanced set + incomplete deep-agent env + real factory path → dies at startup with fix guidance", async () => {
		// GEMINI_API_KEY present so the pre-existing FLY-967 assistant check
		// passes and control reaches the advanced preflight (cli.ts:114).
		process.env.GEMINI_API_KEY = "present-so-the-967-check-passes";
		// deep-agent env deliberately incomplete → loadAgentConfig throws.
		delete process.env.FLYWHEEL_GEMINI_AGENT;
		delete process.env.FLYWHEEL_BRIDGE_URL;
		delete process.env.FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN;

		// the advanced-specific wrapper phrase proves it is the advanced
		// preflight (advanced.ts) that fired — NOT the pre-existing FLY-967
		// GEMINI_API_KEY guard (which says "huddle.assistant is configured",
		// no `.advanced`) — and that the founder-facing fix guidance is present.
		await expect(
			runVoiceBridge({
				config: CONFIG,
				assistant: {
					...ASSISTANT,
					advanced: { leadId: "qa-lead", deptLabel: "Ops-Test" },
				},
				deps: makeDeps(),
				log: () => {},
				probe: async () => ({ ok: true, detail: "fake" }),
			}),
		).rejects.toThrow(
			/huddle\.assistant\.advanced is configured but the deep agent env is incomplete/,
		);
	});

	// FLY-1159 Codex R3 MEDIUM-2: every enabled voice command registers its own
	// interaction handler on the SAME orchestrator client — a duplicate name
	// would attach two handlers to one command (double deferReply). The daemon
	// must refuse to assemble.
	it("advanced.commandName colliding with the /eleven command name → dies at startup", async () => {
		// pass the pre-existing FLY-967 GEMINI_API_KEY guard so control reaches
		// the command-name uniqueness check (which fires before the advanced
		// env preflight).
		process.env.GEMINI_API_KEY = "present-so-the-967-check-passes";
		await expect(
			runVoiceBridge({
				config: CONFIG,
				assistant: {
					...ASSISTANT,
					advanced: { leadId: "qa-lead", commandName: "eleven" },
				},
				eleven: { commandName: "eleven" } as never,
				deps: makeDeps(),
				log: () => {},
				probe: async () => ({ ok: true, detail: "fake" }),
			}),
		).rejects.toThrow(/duplicate voice command name/);
	});

	// FLY-1159 Codex R3 MEDIUM-1: the advanced command name is part of the
	// /health contract (operators must see which commands this daemon serves).
	it("health JSON reports assistantAdvanced when advanced mode is on", async () => {
		const port = 21000 + Math.floor(Math.random() * 20000);
		const f = makeFakes();
		const runtime = await runVoiceBridge({
			config: { ...CONFIG, healthPort: port },
			assistant: {
				...ASSISTANT,
				advanced: { leadId: "qa-lead", deptLabel: "Ops-Test" },
			},
			eleven: null,
			deps: f.deps,
			log: () => {},
			probe: async () => ({ ok: true, detail: "fake" }),
			assistantWiring: {
				createConversation: async () =>
					({
						sendText() {},
						sendAudio() {},
						endUserTurn() {},
						on: () => () => {},
						close: async () => undefined,
					}) as never,
				fetchImpl: f.fetchImpl,
				stateDir,
				env: { FLYWHEEL_API_TOKEN: "bridge-token" },
			},
		});
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.assistant).toBe("gemini");
			expect(body.assistantAdvanced).toBe("gemini-advanced");
		} finally {
			await runtime.close();
		}
	});

	it("staged-QA seam (createConversation injected) skips the advanced preflight even with incomplete env", async () => {
		// The QA harness / this suite drives via an injected factory, which
		// bypasses the real Gemini factory — so the cli.ts guard must NOT
		// fail-fast on the deep-agent env there (cli.ts:114 `!createConversation`).
		delete process.env.GEMINI_API_KEY;
		delete process.env.FLYWHEEL_GEMINI_AGENT;
		delete process.env.FLYWHEEL_BRIDGE_URL;
		delete process.env.FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN;

		const runtime = await runVoiceBridge({
			config: CONFIG,
			assistant: {
				...ASSISTANT,
				advanced: { leadId: "qa-lead", deptLabel: "Ops-Test" },
			},
			deps: makeDeps(),
			log: () => {},
			probe: async () => ({ ok: true, detail: "fake" }),
			assistantWiring: {
				createConversation: async (
					preamble: string,
					opts?: { sessionId: string },
				) =>
					({
						preamble,
						opts,
						sentTexts: [] as string[],
						sendText() {},
						sendAudio() {},
						endUserTurn() {},
						on: () => () => {},
						close: async () => undefined,
					}) as never,
				fetchImpl: (async () => Response.json({ ok: true })) as typeof fetch,
				stateDir,
				env: { FLYWHEEL_API_TOKEN: "bridge-token" },
			},
		});
		expect(runtime).toBeDefined();
		await runtime.close();
	});
});
