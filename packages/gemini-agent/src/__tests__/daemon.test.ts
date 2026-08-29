import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import {
	COMMAND_DEFINITION,
	COMMAND_NAME,
	createInteractionHandler,
	type SlashInteractionLike,
	upsertGuildCommands,
} from "../discord/daemon.js";
import { chunkMessage } from "../discord/render.js";
import type { SessionResult } from "../session.js";
import type { Terminal } from "../types.js";

function config(): AgentConfig {
	return {
		apiKey: "k",
		modelTier: "flash",
		model: "gemini-3.5-flash",
		surface: "interactions",
		maxSteps: 12,
		tokenBudgetIn: 200_000,
		tokenBudgetOut: 20_000,
		toolTimeoutMs: 1_000,
		resultCapChars: 16_000,
		bridgeUrl: "http://127.0.0.1:1",
		bridgeToken: "t",
		auditDir: "/tmp/unused",
	};
}

const BINDINGS = [
	{
		channelId: "chan-1",
		projectName: "flywheel",
		leadId: "flywheel-eng-lead",
		contextNote: "eng channel",
	},
];

function terminalOf(
	reason: Terminal["reason"],
	finalText: string | null,
	error?: Terminal["error"],
): Terminal {
	return {
		reason,
		finalText,
		...(error && { error }),
		stats: {
			sessionId: "s",
			steps: 1,
			toolCalls: 0,
			toolErrors: 0,
			hallucinatedToolCalls: 0,
			inputTokens: 1,
			outputTokens: 1,
			durationMs: 1,
			model: "m",
			surface: "interactions",
		},
	};
}

interface FakeInteraction extends SlashInteractionLike {
	calls: Array<{ kind: string; content?: string; ephemeral?: boolean }>;
}

function fakeInteraction(
	channelId: string,
	instruction: string | null = "do the thing",
): FakeInteraction {
	const calls: FakeInteraction["calls"] = [];
	return {
		calls,
		channelId,
		commandName: COMMAND_NAME,
		options: { getString: () => instruction },
		deferReply: async () => {
			calls.push({ kind: "defer" });
		},
		reply: async (opts) => {
			calls.push({ kind: "reply", ...opts });
		},
		followUp: async (opts) => {
			calls.push({ kind: "followUp", ...opts });
		},
	};
}

describe("chunkMessage (2000-char Discord cap)", () => {
	it("returns short text as one chunk", () => {
		expect(chunkMessage("hi")).toEqual(["hi"]);
	});
	it("returns exactly-2000 as one chunk", () => {
		expect(chunkMessage("x".repeat(2000))).toHaveLength(1);
	});
	it("splits 2001 chars into two chunks", () => {
		const chunks = chunkMessage("x".repeat(2001));
		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.length).toBe(2000);
		expect(chunks[1]).toBe("x");
	});
	it("prefers newline boundaries", () => {
		const text = `${"a".repeat(1500)}\n${"b".repeat(1000)}`;
		const chunks = chunkMessage(text);
		expect(chunks[0]).toBe("a".repeat(1500));
		expect(chunks[1]).toBe("b".repeat(1000));
	});
	it("reassembles to the original content (no loss)", () => {
		const text = Array.from(
			{ length: 50 },
			(_, i) => `line ${i} ${"y".repeat(80)}`,
		).join("\n");
		const chunks = chunkMessage(text, 500);
		expect(chunks.join("\n")).toBe(text);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
	});
});

describe("createInteractionHandler", () => {
	it("refuses unbound channels ephemerally (allowlist)", async () => {
		const runSession = vi.fn();
		const handler = createInteractionHandler({
			bindings: BINDINGS,
			config: config(),
			runSession,
		});
		const interaction = fakeInteraction("not-allowed");
		await handler(interaction);
		expect(runSession).not.toHaveBeenCalled();
		expect(interaction.calls).toEqual([
			{
				kind: "reply",
				content: "This channel is not configured for /gemini-advanced.",
				ephemeral: true,
			},
		]);
	});

	it("happy path: defer → ACK → session runs with binding → final answer follow-up", async () => {
		const runSession = vi.fn(
			async (): Promise<SessionResult> => ({
				sessionId: "sid12345",
				terminal: terminalOf("completed", "the final answer"),
			}),
		);
		const handler = createInteractionHandler({
			bindings: BINDINGS,
			config: config(),
			runSession,
			newSessionId: () => "sid12345",
		});
		const interaction = fakeInteraction("chan-1");
		await handler(interaction);
		expect(interaction.calls.map((c) => c.kind)).toEqual([
			"defer",
			"followUp",
			"followUp",
		]);
		expect(interaction.calls[1]?.content).toContain("已受理,session sid12345");
		expect(interaction.calls[2]?.content).toBe("the final answer");
		// session got the binding's project/lead/context — the north-star anchor
		expect(runSession).toHaveBeenCalledWith(
			expect.objectContaining({
				binding: { projectName: "flywheel", leadId: "flywheel-eng-lead" },
				contextNote: "eng channel",
				entry: "discord",
				sessionId: "sid12345",
				userText: "do the thing",
			}),
		);
	});

	it("threads the binding deptLabel into the session (FLY-1060 QA F2)", async () => {
		const runSession = vi.fn(
			async (): Promise<SessionResult> => ({
				sessionId: "sid-dept",
				terminal: terminalOf("completed", "ok"),
			}),
		);
		const handler = createInteractionHandler({
			bindings: [{ ...BINDINGS[0]!, deptLabel: "Eng" }],
			config: config(),
			runSession,
			newSessionId: () => "sid-dept",
		});
		await handler(fakeInteraction("chan-1"));
		expect(runSession).toHaveBeenCalledWith(
			expect.objectContaining({
				binding: {
					projectName: "flywheel",
					leadId: "flywheel-eng-lead",
					deptLabel: "Eng",
				},
			}),
		);
	});

	it("chunks long answers into ≤2000-char follow-ups", async () => {
		const runSession = vi.fn(
			async (): Promise<SessionResult> => ({
				sessionId: "s",
				terminal: terminalOf("completed", "z".repeat(4100)),
			}),
		);
		const handler = createInteractionHandler({
			bindings: BINDINGS,
			config: config(),
			runSession,
		});
		const interaction = fakeInteraction("chan-1");
		await handler(interaction);
		const followUps = interaction.calls.filter((c) => c.kind === "followUp");
		// 1 ACK + 3 answer chunks
		expect(followUps).toHaveLength(4);
		for (const f of followUps.slice(1)) {
			expect((f.content ?? "").length).toBeLessThanOrEqual(2000);
		}
	});

	it("reports non-completed terminals honestly (reason + error + sessionId)", async () => {
		const runSession = vi.fn(
			async (): Promise<SessionResult> => ({
				sessionId: "s",
				terminal: terminalOf("model_error", null, {
					kind: "quota",
					message: "quota exhausted",
				}),
			}),
		);
		const handler = createInteractionHandler({
			bindings: BINDINGS,
			config: config(),
			runSession,
			newSessionId: () => "sidE",
		});
		const interaction = fakeInteraction("chan-1");
		await handler(interaction);
		const last = interaction.calls.at(-1);
		expect(last?.content).toContain("model_error");
		expect(last?.content).toContain("quota exhausted");
		expect(last?.content).toContain("sidE");
	});

	it("per-channel mutex: concurrent second interaction gets an ephemeral busy reply", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const runSession = vi.fn(async (): Promise<SessionResult> => {
			await gate;
			return { sessionId: "s1", terminal: terminalOf("completed", "ok") };
		});
		const handler = createInteractionHandler({
			bindings: BINDINGS,
			config: config(),
			runSession,
			newSessionId: () => "busy-sid",
		});
		const first = fakeInteraction("chan-1");
		const running = handler(first);
		// let the first interaction take the mutex
		await new Promise((r) => setImmediate(r));
		const second = fakeInteraction("chan-1");
		await handler(second);
		expect(second.calls[0]).toMatchObject({
			kind: "reply",
			ephemeral: true,
		});
		expect(second.calls[0]?.content).toContain("busy-sid");
		release?.();
		await running;
		// after completion the channel frees up
		const third = fakeInteraction("chan-1");
		await handler(third);
		expect(runSession).toHaveBeenCalledTimes(2);
	});

	it("mutex releases even when the session throws, and the user is told", async () => {
		const runSession = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce({
				sessionId: "s2",
				terminal: terminalOf("completed", "ok"),
			});
		const handler = createInteractionHandler({
			bindings: BINDINGS,
			config: config(),
			runSession,
		});
		const first = fakeInteraction("chan-1");
		await handler(first);
		expect(first.calls.at(-1)?.content).toContain("内部错误");
		const second = fakeInteraction("chan-1");
		await handler(second);
		expect(runSession).toHaveBeenCalledTimes(2);
	});

	it("rejects an empty instruction ephemerally", async () => {
		const runSession = vi.fn();
		const handler = createInteractionHandler({
			bindings: BINDINGS,
			config: config(),
			runSession,
		});
		const interaction = fakeInteraction("chan-1", "  ");
		await handler(interaction);
		expect(runSession).not.toHaveBeenCalled();
		expect(interaction.calls[0]?.ephemeral).toBe(true);
	});

	it("ignores other commands", async () => {
		const handler = createInteractionHandler({
			bindings: BINDINGS,
			config: config(),
			runSession: vi.fn(),
		});
		const interaction = fakeInteraction("chan-1");
		interaction.commandName = "other";
		await handler(interaction);
		expect(interaction.calls).toEqual([]);
	});
});

describe("upsertGuildCommands", () => {
	it("upserts the command definition once per unique guild", async () => {
		const puts: Array<{ route: string; body: unknown }> = [];
		await upsertGuildCommands(
			{
				put: async (route, opts) => {
					puts.push({ route, body: opts.body });
				},
			},
			"app-1",
			["g1", "g2", "g1"],
		);
		expect(puts).toHaveLength(2);
		expect(puts[0]?.route).toBe("/applications/app-1/guilds/g1/commands");
		expect(puts[1]?.route).toBe("/applications/app-1/guilds/g2/commands");
		expect(puts[0]?.body).toEqual([COMMAND_DEFINITION]);
	});
});
