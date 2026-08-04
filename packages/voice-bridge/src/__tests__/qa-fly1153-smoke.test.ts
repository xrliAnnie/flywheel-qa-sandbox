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
 * legs, so a regression anywhere along
 *
 *   projects.json (disk) → loadAssistantConfig → wireAssistantMode
 *     → /gemini-advanced session mounts delegate_task (/gemini stays plain)
 *     → dispatch of the FACTORY-PRODUCED delegate_task object
 *     → ACK + acceptance-on-disk + spoken announce + Discord-text landing
 *
 * fails here even if each layer's own tests still pass. Expected values are
 * asserted as STRING LITERALS (never re-derived from the fixture object) so a
 * same-source drift cannot make the assertions tautologically true.
 *
 * Leg 3 dispatches the tool object the REAL wiring handed the Live backend
 * (Codex R1 HIGH-2: re-building the tool in the test would let a wiring
 * regression — wrong binding, disconnected sinks — pass silently). Hermetic
 * discipline: global fetch is stubbed to reject, so the deep loop dies at its
 * first model call and the delegate's guaranteed-completion contract fires the
 * REAL sinks with a failure terminal ("未完成"); binding is verified from the
 * real audit trail (FLYWHEEL_GEMINI_AGENT_AUDIT_DIR → temp dir), which
 * runSession writes BEFORE the first model call. The success-copy semantics
 * (完成 + finalText) are covered by leg 4 through the _test session seam —
 * the one part a no-network test cannot reach through the real deep loop.
 *
 * The acoustic loop (Live STT) is not machine-verifiable — FLY-1159's declared
 * boundary; out of scope for this smoke.
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the extraTools the REAL wiring hands the Live backend (the fly1159
// seam technique: stub ONLY GeminiLiveBackend.createConversation, everything
// else in voice-core stays real so makeRealConversationFactory runs for real).
interface CapturedTool {
	declaration: { name: string };
	handler: (
		args: unknown,
		opts: { signal: AbortSignal },
	) => Promise<unknown> | unknown;
}

const seam = vi.hoisted(() => ({
	captured: [] as string[][],
	/** the ACTUAL LiveToolSpec objects the real wiring handed the backend. */
	tools: [] as CapturedTool[][],
	/** per-created-session sendText recordings — the spoken-announce surface. */
	sessions: [] as { sentTexts: string[] }[],
}));

vi.mock("flywheel-voice-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("flywheel-voice-core")>();
	class MockGeminiLiveBackend {
		createConversation = (opts: { extraTools?: CapturedTool[] }) => {
			const tools = opts?.extraTools ?? [];
			seam.captured.push(tools.map((t) => t.declaration.name));
			seam.tools.push(tools);
			const record = { sentTexts: [] as string[] };
			seam.sessions.push(record);
			return {
				on: () => () => {},
				sendAudio() {},
				sendText(text: string) {
					record.sentTexts.push(text);
				},
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
		seam.tools.length = 0;
		seam.sessions.length = 0;
		fixtureDir = mkdtempSync(join(tmpdir(), "fly1153-smoke-"));
		projectsPath = join(fixtureDir, "projects.json");
		writeFileSync(projectsPath, PROJECTS_JSON_FIXTURE);
		stateDir = join(fixtureDir, "state");
		mkdirSync(stateDir);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(fixtureDir, { recursive: true, force: true });
	});

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

	async function wireFromDisk(extraEnv: NodeJS.ProcessEnv = {}) {
		const f = makeFakes();
		const runtime = await wireAssistantMode({
			config: CONFIG,
			assistant: loadFixtureConfig(),
			registry: f.registry,
			deps: f.deps,
			earsConnection: { conn: "ears" },
			env: { FLYWHEEL_API_TOKEN: "bridge-token", ...AGENT_ENV, ...extraEnv },
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

	it("leg 3 — dispatching the FACTORY-PRODUCED delegate_task fires the REAL sinks: ACK, acceptance-on-disk, spoken + Discord-text announce, FULL verbatim binding on the real path", async () => {
		// Hermetic network boundary (Codex R2 HIGH: leadId/deptLabel must be
		// observed on the REAL wiring path, not via a rebuilt tool). The stub
		// plays the smallest conversation that surfaces the whole binding:
		//   1st interactions call  → canned function_call step: save_memory —
		//      its REQUEST body carries the real system prompt, where the
		//      binding's deptLabel is embedded verbatim (context.ts);
		//   bridge /api/memory/add → the REAL registry attaches project_name +
		//      agent_id(=binding.leadId) to the body (registry.ts) — captured,
		//      answered ok;
		//   2nd interactions call  → rejected → failure terminal → the
		//      delegate's guaranteed-completion contract fires the real sinks.
		const fetchLog: { url: string; body: string }[] = [];
		let cannedServed = false;
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input instanceof Request ? input.url : input);
				// the SDK may carry the payload as a Request object, a string, or
				// a byte/stream body — normalize all of them for the assertions.
				let body = "";
				if (input instanceof Request) {
					body = await input
						.clone()
						.text()
						.catch(() => "");
				} else if (typeof init?.body === "string") {
					body = init.body;
				} else if (init?.body != null) {
					body = await new Response(init.body as BodyInit)
						.text()
						.catch(() => "");
				}
				fetchLog.push({ url, body });
				if (url.startsWith("http://127.0.0.1:9/")) {
					return Promise.resolve(Response.json({ ok: true }));
				}
				if (!cannedServed) {
					cannedServed = true;
					return Promise.resolve(
						Response.json({
							id: "int-fly1153",
							steps: [
								{
									type: "function_call",
									id: "fc-1",
									name: "save_memory",
									arguments: { content: "FLY-1153 smoke checkpoint" },
								},
							],
							usage: { total_input_tokens: 1, total_output_tokens: 1 },
						}),
					);
				}
				return Promise.reject(new Error("FLY-1153 smoke: outbound disabled"));
			},
		);
		const auditDir = join(fixtureDir, "audit");
		const { f, runtime } = await wireFromDisk({
			FLYWHEEL_GEMINI_AGENT_AUDIT_DIR: auditDir,
		});
		try {
			const handler = f.commandHandlers.get("gemini-advanced");
			if (!handler) throw new Error("no chat handler for /gemini-advanced");
			handler({ topic: undefined, userId: "annie", reply: async () => {} });
			await vi.waitFor(() => {
				if (seam.tools.length === 0) throw new Error("no session yet");
			});

			// the ACTUAL tool object the real wiring handed the Live backend —
			// NOT one rebuilt by the test (Codex R1 HIGH-2).
			const tool = seam.tools[0].find(
				(t) => t.declaration.name === "delegate_task",
			);
			if (!tool) throw new Error("delegate_task not mounted by the wiring");

			const ack = String(
				await tool.handler(
					{ instruction: "跑一遍全链冒烟" },
					{ signal: new AbortController().signal },
				),
			);
			expect(ack).toContain("已受理");
			const taskId = /任务 ([0-9a-f-]+)/.exec(ack)?.[1];
			if (!taskId) throw new Error(`no task id in ACK: ${ack}`);

			// acceptance-on-disk happened BEFORE the ACK returned (delegate.ts) —
			// through the real defaultAppendAudit at the env-pointed audit dir.
			const delegateLog = readFileSync(
				join(auditDir, "delegate.jsonl"),
				"utf8",
			);
			expect(delegateLog).toContain('"type":"delegate_accept"');
			expect(delegateLog).toContain(taskId);

			// the guaranteed completion announce lands through BOTH real sinks:
			// spoken (adapter.sendText → rotator → Live session) and Discord text
			// (deps.sendMessage into the voice channel).
			await vi.waitFor(
				() => {
					const spoken = seam.sessions.flatMap((s) => s.sentTexts).join("\n");
					expect(spoken).toContain(`任务 ${taskId} 未完成`);
					const sent = (
						f.deps.sendMessage as ReturnType<typeof vi.fn>
					).mock.calls
						.map((c) => String(c[2]))
						.join("\n");
					expect(sent).toContain(`任务 ${taskId} 未完成`);
				},
				{ timeout: 15_000 },
			);

			// binding through the REAL chain, ALL THREE fields literal-checked
			// (gate requirement b + Codex R2 HIGH — never re-derived from the
			// fixture object):
			// (1) projectName: runSession wrote sessionStart to the audit trail
			//     BEFORE its first model call.
			const sessionFiles = readdirSync(auditDir).filter((n) =>
				n.includes(taskId),
			);
			expect(sessionFiles.length).toBeGreaterThan(0);
			const sessionLog = sessionFiles
				.map((n) => readFileSync(join(auditDir, n), "utf8"))
				.join("\n");
			expect(sessionLog).toContain('"projectName":"geoforge3d"');
			// (2) deptLabel: embedded verbatim in the system prompt the REAL
			//     session sent on its first model call (context.ts).
			const modelBodies = fetchLog
				.filter((c) => !c.url.startsWith("http://127.0.0.1:9/"))
				.map((c) => c.body)
				.join("\n");
			expect(modelBodies).toContain("QA-Smoke");
			// (3) leadId: the REAL registry attached agent_id from the session
			//     binding to the bridge save_memory body (registry.ts) — the model
			//     never supplies it, so only correct wiring can put it there.
			const bridgeBodies = fetchLog
				.filter((c) => c.url.startsWith("http://127.0.0.1:9/"))
				.map((c) => c.body)
				.join("\n");
			expect(bridgeBodies).toContain('"agent_id":"qa-smoke-lead"');
			expect(bridgeBodies).toContain('"project_name":"geoforge3d"');
		} finally {
			await runtime.close();
		}
	}, 30_000);

	it("leg 4 — completed-terminal announcement semantics via the _test session seam (the success copy the hermetic real-dispatch leg cannot reach): ACK, verbatim binding, spoken + text landing", async () => {
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
