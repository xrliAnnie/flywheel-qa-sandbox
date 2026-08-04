/**
 * FLY-1153 QA-6 smoke — /gemini-advanced enablement venue, FULL CHAIN.
 *
 * The existing coverage is layer-local: assistant-advanced.test.ts unit-tests
 * the delegate tool from a HAND-CONSTRUCTED advanced config, and
 * qa-fly1159-injection.test.ts verifies the extraTools injection seam and the
 * two-command registration from a hand-built AssistantModeConfig. Neither
 * starts at the actual enablement venue (an on-disk projects.json) and neither
 * runs one continuous chain to the completion announcements.
 *
 * This smoke closes that: ONE config fixture written to a temp dir drives all
 * three legs, so a regression anywhere along
 *
 *   projects.json (disk) → loadAssistantConfig → wireAssistantMode
 *     → /gemini-advanced session mounts delegate_task (/gemini stays plain)
 *     → delegate dispatch ACK → spoken completion + Discord-text landing
 *
 * fails here even if each layer's own tests still pass. Expected values are
 * asserted as STRING LITERALS (never re-derived from the fixture object) so a
 * same-source drift cannot make the assertions tautologically true.
 *
 * The acoustic loop (Live STT) is not machine-verifiable — FLY-1159's declared
 * boundary; out of scope for this smoke.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the extraTools the REAL wiring hands the Live backend (the fly1159
// seam technique: stub ONLY GeminiLiveBackend.createConversation, everything
// else in voice-core stays real so makeRealConversationFactory runs for real).
const seam = vi.hoisted(() => ({ captured: [] as string[][] }));

vi.mock("flywheel-voice-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("flywheel-voice-core")>();
	class MockGeminiLiveBackend {
		createConversation = (opts: {
			extraTools?: Array<{ declaration: { name: string } }>;
		}) => {
			seam.captured.push(
				(opts?.extraTools ?? []).map((t) => t.declaration.name),
			);
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

import { buildAdvancedDelegateTool } from "../assistant/advanced.js";
import {
	type AssistantModeConfig,
	loadAssistantConfig,
} from "../assistant/config.js";
import { wireAssistantMode } from "../assistant/wiring.js";
import type { HuddleBridgeConfig } from "../config.js";

// ---- the ONE enablement fixture all three legs consume ----
// Kept as a raw JSON string (what an operator actually writes to
// ~/.flywheel/projects.json), not a shared JS object the assertions could
// accidentally re-derive from.
const PROJECTS_JSON_FIXTURE = `[
	{
		"name": "geoforge3d",
		"huddle": {
			"assistant": {
				"commandName": "gemini",
				"voice": "Kore",
				"advanced": { "leadId": "qa-smoke-lead", "deptLabel": "QA-Smoke" }
			}
		}
	}
]`;

// complete deep-agent env (mirrors assistant-advanced.test.ts) — no network
// is ever opened; the bridge URL/token are inert placeholders.
const AGENT_ENV = {
	FLYWHEEL_GEMINI_AGENT: "1",
	GEMINI_API_KEY: "test-key",
	FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9",
	FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN: "scoped-test",
} as NodeJS.ProcessEnv;

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
	bargeInMinRms: 0,
	bargeInHoldoffMs: 1000,
	allowUserIds: [],
	healthPort: 0,
	ffmpegBin: "ffmpeg",
	bridgeUrl: "http://127.0.0.1:1",
	apiToken: "t-bridge",
	founderUserId: "annie-1",
	geminiApiKey: "t-gemini",
	geminiModel: "gemini-live-test",
	claudeBin: "claude",
	brainTimeoutMs: 1000,
};

function makeFakes() {
	const registered: { name: string }[] = [];
	const commandHandlers = new Map<string, (inv: unknown) => void>();

	const deps = {
		createPlayer: () => ({ play() {}, stop() {}, on() {} }),
		createResource: (src: unknown) => src,
		// the wiring owns its room ears when no shared room is passed
		subscribeManual: () => () =>
			({ on() {}, pipe() {}, unpipe() {} }) as unknown as NodeJS.ReadableStream,
		createDecoder: () =>
			({ on() {}, pipe() {}, end() {}, destroy() {} }) as never,
		speakingEvents: () => ({ on() {} }),
		isHumanFactory: () => () => true,
		connectionEvents: () => ({ onDown: () => () => {}, onUp: () => () => {} }),
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
	} as unknown as Parameters<typeof wireAssistantMode>[0]["deps"];

	const registry = {
		client: () => ({ id: "client" }),
		join: vi.fn(async () => ({ conn: "orch" })),
	};

	const fetchImpl = (async (url: string | URL) => {
		if (String(url).includes("/api/linear/create-issue")) {
			return Response.json({
				issue: { identifier: "FLY-1153", url: "https://l/FLY-1153" },
			});
		}
		return Response.json({ ok: true });
	}) as typeof fetch;

	return { deps, registry, fetchImpl, registered, commandHandlers };
}

describe("FLY-1153 QA-6 smoke — /gemini-advanced full chain from the on-disk enablement venue", () => {
	let fixtureDir: string;
	let projectsPath: string;
	let stateDir: string;

	beforeEach(() => {
		seam.captured.length = 0;
		fixtureDir = mkdtempSync(join(tmpdir(), "fly1153-smoke-"));
		projectsPath = join(fixtureDir, "projects.json");
		writeFileSync(projectsPath, PROJECTS_JSON_FIXTURE);
		stateDir = join(fixtureDir, "state");
		mkdirSync(stateDir);
	});
	afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

	/** the shared venue entry: every leg resolves from the DISK fixture. */
	function loadFixtureConfig(): AssistantModeConfig {
		const cfg = loadAssistantConfig({ path: projectsPath, env: {} });
		if (!cfg) throw new Error("fixture projects.json did not resolve");
		return cfg;
	}

	it("leg 1 — the disk fixture resolves to an enabled advanced block (defaulted command name, literal-checked passthrough)", () => {
		const cfg = loadFixtureConfig();
		expect(cfg.commandName).toBe("gemini");
		// literals on purpose (gate requirement b): never compare against values
		// re-read from the fixture object, or drift passes both sides.
		expect(cfg.advanced).toEqual({
			leadId: "qa-smoke-lead",
			commandName: "gemini-advanced",
			deptLabel: "QA-Smoke",
		});
	});

	async function wireFromDisk() {
		const f = makeFakes();
		const runtime = await wireAssistantMode({
			config: CONFIG,
			assistant: loadFixtureConfig(),
			registry: f.registry,
			deps: f.deps,
			earsConnection: { conn: "ears" },
			env: { FLYWHEEL_API_TOKEN: "bridge-token", ...AGENT_ENV },
			log: () => {},
			// NO createConversation → the REAL makeRealConversationFactory runs
			fetchImpl: f.fetchImpl,
			stateDir,
		});
		return { f, runtime };
	}

	async function captureExtraTools(commandName: string): Promise<string[]> {
		const { f, runtime } = await wireFromDisk();
		try {
			const handler = f.commandHandlers.get(commandName);
			if (!handler) throw new Error(`no chat handler for /${commandName}`);
			handler({ topic: undefined, userId: "annie", reply: async () => {} });
			await vi.waitFor(() => {
				if (seam.captured.length === 0)
					throw new Error("no createConversation yet");
			});
			return seam.captured[0];
		} finally {
			await runtime.close();
		}
	}

	it("leg 2 — wiring from the disk fixture registers BOTH commands and mounts delegate_task only on /gemini-advanced sessions", async () => {
		const { f, runtime } = await wireFromDisk();
		expect(f.registered.map((r) => r.name).sort()).toEqual([
			"gemini",
			"gemini-advanced",
		]);
		expect(runtime.commandName).toBe("gemini");
		expect(runtime.advancedCommandName).toBe("gemini-advanced");
		await runtime.close();

		seam.captured.length = 0;
		const advancedTools = await captureExtraTools("gemini-advanced");
		expect(advancedTools).toEqual([
			"lookup_issue",
			"board_snapshot",
			"delegate_task",
		]);

		seam.captured.length = 0;
		const plainTools = await captureExtraTools("gemini");
		expect(plainTools).toEqual(["lookup_issue", "board_snapshot"]);
	});

	it("leg 3 — the SAME resolved advanced block drives a dispatch to completion: ACK, verbatim binding, spoken + text landing", async () => {
		const cfg = loadFixtureConfig();
		if (!cfg.advanced) throw new Error("fixture advanced block missing");

		const spoken: string[] = [];
		const texted: string[] = [];
		const bindings: Array<Record<string, unknown>> = [];
		const tool = buildAdvancedDelegateTool({
			advanced: cfg.advanced,
			projectName: CONFIG.projectName,
			env: AGENT_ENV,
			speak: (t) => spoken.push(t),
			log: () => {},
			sendText: async (t) => {
				texted.push(t);
			},
			_test: {
				runSession: async (opts) => {
					bindings.push(opts.binding as unknown as Record<string, unknown>);
					return {
						sessionId: "qa6-task",
						terminal: {
							reason: "completed" as const,
							finalText: "冒烟链路收工",
							stats: {
								sessionId: "qa6-task",
								steps: 1,
								toolCalls: 1,
								toolErrors: 0,
								hallucinatedToolCalls: 0,
								inputTokens: 0,
								outputTokens: 0,
								durationMs: 1,
								model: "m",
								surface: "interactions",
							},
						},
					};
				},
				newTaskId: () => "qa6-task",
				appendAudit: () => {},
			},
		});

		expect(tool.declaration.name).toBe("delegate_task");

		const ack = await tool.handler(
			{ instruction: "跑一遍全链冒烟" },
			{ signal: new AbortController().signal },
		);
		expect(String(ack)).toContain("已受理");
		expect(String(ack)).toContain("qa6-task");

		await vi.waitFor(() => {
			expect(spoken.join("\n")).toContain("冒烟链路收工");
			expect(texted.join("\n")).toContain("冒烟链路收工");
		});
		expect(spoken.join("\n")).toContain("qa6-task");

		// verbatim binding, literal-checked (gate requirement b): what the raw
		// JSON declared is what the deep session is bound to.
		expect(bindings).toEqual([
			{
				projectName: "geoforge3d",
				leadId: "qa-smoke-lead",
				deptLabel: "QA-Smoke",
			},
		]);
	});
});
