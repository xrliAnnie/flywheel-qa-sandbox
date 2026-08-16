import { describe, expect, it, vi } from "vitest";
import { parseCodexLeadRuntimeConfig } from "../codex-lead-runtime.js";
import { buildReplyInThreadWiring } from "../roundtable-reply-in-thread-wiring.js";

const RT = "1512578695468941333";

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	return {
		FLYWHEEL_LEAD_ID: "mufasa",
		FLYWHEEL_PROJECT_NAME: "mufasa-project",
		FLYWHEEL_LEAD_KEY: "mufasa-project-mufasa",
		FLYWHEEL_LEAD_BACKEND: "codex-app-server",
		FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		DISCORD_EXPECTED_BOT_USER_ID: "bot-1",
		DISCORD_BOT_TOKEN: "tok",
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "chan-chat",
		FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
		FLYWHEEL_API_TOKEN: "api",
		FLYWHEEL_CODEX_LEAD_STATE_DIR: "/var/state/mufasa",
		FLYWHEEL_COMM_DB: "/var/state/mufasa/comm.db",
		FLYWHEEL_CODEX_BIN: "/usr/local/bin/codex",
		CODEX_HOME: "/Users/x/.codex-mufasa",
		FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: RT,
		...over,
	};
}

describe("parseCodexLeadRuntimeConfig — reply-in-thread (FLY-314 Phase 2)", () => {
	// FLY-1243: FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD retired — a resolvable
	// roundtable parent (here the sole cross-dept channel) is the switch now, so
	// reply-in-thread activates unconditionally.
	it("resolvable parent (cross-dept) → reply-in-thread active (固化 default-on)", () => {
		const cfg = parseCodexLeadRuntimeConfig(env()).replyInThread;
		expect(cfg).toEqual({
			enabled: true,
			parentChannelId: RT,
			autoContinue: true,
		});
	});

	it("flag=1 + parent in cross-dept → enabled config (with guildId; FLY-676 autoContinue default-on)", () => {
		const cfg = parseCodexLeadRuntimeConfig(
			env({
				FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "1",
				FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT,
				FLYWHEEL_ROUNDTABLE_GUILD_ID: "guild-9",
			}),
		).replyInThread;
		expect(cfg).toEqual({
			enabled: true,
			parentChannelId: RT,
			guildId: "guild-9",
			autoContinue: true,
		});
	});

	it("FLY-676: autoContinue ON by default when reply-in-thread enabled (env unset)", () => {
		const cfg = parseCodexLeadRuntimeConfig(
			env({
				FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "1",
				FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT,
			}),
		).replyInThread;
		// FLY-676 flipped autoContinue default-on (was default-off in FLY-314); the
		// config shape now carries autoContinue:true when REPLY_IN_THREAD=1 + env unset.
		expect(cfg).toEqual({
			enabled: true,
			parentChannelId: RT,
			autoContinue: true,
		});
	});
	it("FLY-314 Part(b): resolvable parent + THREAD_BUDGET → autoContinue + budgetN", () => {
		const cfg = parseCodexLeadRuntimeConfig(
			env({
				FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "1",
				FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT,
				FLYWHEEL_ROUNDTABLE_THREAD_BUDGET: "3",
			}),
		).replyInThread;
		expect(cfg).toEqual({
			enabled: true,
			parentChannelId: RT,
			autoContinue: true,
			budgetN: 3,
		});
	});

	it("flag=1 defaults parent to the sole cross-dept channel", () => {
		const cfg = parseCodexLeadRuntimeConfig(
			env({ FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "1" }),
		).replyInThread;
		expect(cfg?.parentChannelId).toBe(RT);
	});

	it("flag=1 but parent NOT in cross-dept → throws (so it is polled + gated)", () => {
		expect(() =>
			parseCodexLeadRuntimeConfig(
				env({
					FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "1",
					FLYWHEEL_ROUNDTABLE_CHANNEL_ID: "not-a-cross-dept-channel",
				}),
			),
		).toThrow(/must be in FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS/);
	});

	it("no resolvable parent (no cross-dept, no roundtable channel) → undefined", () => {
		expect(
			parseCodexLeadRuntimeConfig(
				env({ FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "" }),
			).replyInThread,
		).toBeUndefined();
	});
});

describe("buildReplyInThreadWiring (FLY-314 Phase 2)", () => {
	function fakeSource() {
		const added: string[] = [];
		return {
			added,
			addChannel: vi.fn(async (id: string) => {
				added.push(id);
			}),
			removeChannel: vi.fn(),
		};
	}

	it("returns undefined when disabled (byte-compat)", () => {
		const wiring = buildReplyInThreadWiring({
			cfg: { enabled: false, parentChannelId: RT },
			botToken: "tok",
			botUserId: "bot-1",
			crossDeptChannelIds: [RT],
			source: fakeSource(),
		});
		expect(wiring).toBeUndefined();
	});

	it("routes a roundtable parent message to its thread + subscribes (path i)", async () => {
		const source = fakeSource();
		const wiring = buildReplyInThreadWiring({
			cfg: { enabled: true, parentChannelId: RT }, // no guildId → immediate-only
			botToken: "tok",
			botUserId: "bot-1",
			crossDeptChannelIds: [RT, "other-shared"],
			source,
		});
		expect(wiring).toBeDefined();
		const r = wiring?.resolveReplyRoute({
			id: "100",
			channelId: RT,
			authorId: "u",
			authorBot: false,
			content: "topic",
		});
		expect(r?.replyChannelId).toBe("100");
		expect(r?.replyRoute?.threadId).toBe("100");
		// subscribed (immediate path) — fire-and-forget; drain microtasks
		await new Promise((res) => setTimeout(res, 0));
		expect(source.added).toContain("100");
		expect(wiring?.registry.has("100")).toBe(true);
	});

	it("OTHER cross-dept channel keeps FLY-267 source-channel reply, no subscribe", () => {
		const source = fakeSource();
		const wiring = buildReplyInThreadWiring({
			cfg: { enabled: true, parentChannelId: RT },
			botToken: "tok",
			botUserId: "bot-1",
			crossDeptChannelIds: [RT, "other-shared"],
			source,
		});
		const r = wiring?.resolveReplyRoute({
			id: "9",
			channelId: "other-shared",
			authorId: "u",
			authorBot: false,
			content: "x",
		});
		expect(r?.replyChannelId).toBe("other-shared");
		expect(r?.replyRoute).toBeUndefined();
		expect(source.added).toHaveLength(0);
	});

	it("FLY-802: reuses one cached parent-channel read across consecutive ensures", async () => {
		const parentReads: string[] = [];
		const createBodies: Array<Record<string, unknown>> = [];
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			const method = (init?.method ?? "GET").toUpperCase();
			if (method === "GET" && url.endsWith(`/channels/${RT}`)) {
				parentReads.push(url);
				return {
					ok: true,
					status: 200,
					json: async () => ({ default_auto_archive_duration: 60 }),
				} as Response;
			}
			if (method === "POST" && url.endsWith("/threads")) {
				createBodies.push(JSON.parse(String(init?.body ?? "{}")));
				return {
					ok: true,
					status: 201,
					json: async () => ({ id: url.includes("/100/") ? "100" : "101" }),
				} as Response;
			}
			throw new Error(`unexpected ${method} ${url}`);
		});
		const wiring = buildReplyInThreadWiring({
			cfg: { enabled: true, parentChannelId: RT },
			botToken: "tok",
			botUserId: "bot-1",
			crossDeptChannelIds: [RT],
			source: fakeSource(),
			fetchImpl: fetchImpl as typeof fetch,
		});

		await wiring?.ensureReplyRoute({
			kind: "roundtable_thread_from_message",
			parentChannelId: RT,
			sourceMessageId: "100",
			threadId: "100",
			threadName: "first topic",
		});
		await wiring?.ensureReplyRoute({
			kind: "roundtable_thread_from_message",
			parentChannelId: RT,
			sourceMessageId: "101",
			threadId: "101",
			threadName: "second topic",
		});

		expect(parentReads).toHaveLength(1);
		expect(createBodies.map((body) => body.auto_archive_duration)).toEqual([
			60, 60,
		]);
	});
});
