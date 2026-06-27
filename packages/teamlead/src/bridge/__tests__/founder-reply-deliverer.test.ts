import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";
import {
	emitFounderReplyDeliveryForThread,
	type FounderReplyDeliverDeps,
	type FounderReplyThreadCtx,
	type PendingQuestionForThread,
} from "../founder-reply-deliverer.js";

const OWNER = "123456789012345678";
const DISCORD_EPOCH = 1_420_070_400_000;

/** Build a Discord snowflake id whose embedded time is `ms`. */
function snowflakeAt(ms: number): string {
	return (BigInt(Math.floor(ms) - DISCORD_EPOCH) << 22n).toString();
}

interface RawMsg {
	id: string;
	content?: string;
	author?: { id?: string; bot?: boolean };
}

function discordGet(messages: RawMsg[]) {
	return vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => messages,
	})) as unknown as typeof fetch;
}

function makeStore(existing: Array<{ event_id: string }> = []) {
	const events = existing.map((e) => ({ ...e }));
	const store = {
		insertEvent: vi.fn((e: { event_id: string }) => {
			events.push({ event_id: e.event_id });
			return true;
		}),
		getEventsByExecution: vi.fn(() => events.slice()),
	} as unknown as FounderReplyDeliverDeps["store"];
	return { store, events };
}

function makeCommDb(pendingIds: string[]) {
	return {
		getPendingQuestions: vi.fn(() => pendingIds.map((id) => ({ id }))),
		close: vi.fn(),
	};
}

function ctx(over: Partial<FounderReplyThreadCtx> = {}): FounderReplyThreadCtx {
	return {
		issueId: "FLY-605",
		projectName: "flywheel",
		threadId: "T1",
		botToken: "bot",
		ownerUserId: OWNER,
		graceMs: 10 * 60_000,
		commDbPath: "/tmp/comm.db",
		leadId: "test-lead",
		...over,
	};
}

const QAGO = Date.now() - 60 * 60_000; // question raised 1h ago

function q(
	id: string,
	checkpoint: string | null,
	over: Partial<PendingQuestionForThread> = {},
): PendingQuestionForThread {
	return {
		questionId: id,
		checkpoint,
		executionId: `exec-${id}`,
		createdAtMs: QAGO,
		...over,
	};
}

describe("FLY-605 emitFounderReplyDeliveryForThread (Part B)", () => {
	let envBak: Record<string, string | undefined>;
	beforeEach(() => {
		envBak = {
			BRIDGE_URL: process.env.BRIDGE_URL,
			FLYWHEEL_BRIDGE_URL: process.env.FLYWHEEL_BRIDGE_URL,
			TEAMLEAD_API_TOKEN: process.env.TEAMLEAD_API_TOKEN,
		};
	});
	afterEach(() => {
		for (const [k, v] of Object.entries(envBak)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		vi.restoreAllMocks();
	});

	it("non-gated (brainstorm) → calls respond()'s non-gated path, audits delivered (Codex R1 #1)", async () => {
		const { store, events } = makeStore();
		const respondImpl = vi.fn(
			async () => undefined,
		) as unknown as FounderReplyDeliverDeps["respondImpl"];
		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000), // 30min ago → mature
			content: "looks good, proceed",
			author: { id: OWNER },
		};
		await emitFounderReplyDeliveryForThread(ctx(), [q("q1", "brainstorm")], {
			store,
			fetchImpl: discordGet([reply]),
			cursorStore: new InMemoryInboundCursorStore(),
			respondImpl,
			wakeImpl,
			commDbFactory: () => makeCommDb(["q1"]) as never,
		});
		expect(respondImpl).toHaveBeenCalledTimes(1);
		expect(wakeImpl).not.toHaveBeenCalled();
		expect(
			events.some((e) => e.event_id.startsWith("founder_reply_delivered")),
		).toBe(true);
	});

	it("🔴 approve_to_ship = WAKE-only, never respond/insertResponse even with BRIDGE_URL set (Codex R1 #6)", async () => {
		process.env.BRIDGE_URL = "http://bridge";
		process.env.FLYWHEEL_BRIDGE_URL = "http://bridge";
		process.env.TEAMLEAD_API_TOKEN = "tok";
		const { store } = makeStore();
		const respondImpl = vi.fn(
			async () => undefined,
		) as unknown as FounderReplyDeliverDeps["respondImpl"];
		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "approved / ship it",
			author: { id: OWNER },
		};
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			{
				store,
				fetchImpl: discordGet([reply]),
				cursorStore: new InMemoryInboundCursorStore(),
				respondImpl,
				wakeImpl,
				commDbFactory: () => makeCommDb(["q1"]) as never,
			},
		);
		expect(respondImpl).not.toHaveBeenCalled();
		expect(wakeImpl).toHaveBeenCalledTimes(1);
		const wakeArg = (wakeImpl as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(wakeArg.content).toContain("verify-approval");
	});

	it("🔴 ship: a SECOND founder message wakes again (msg-id dedupe, Codex R1 #3)", async () => {
		const { store } = makeStore();
		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const cursorStore = new InMemoryInboundCursorStore();
		const m1: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "needs one change",
			author: { id: OWNER },
		};
		const m2: RawMsg = {
			id: snowflakeAt(Date.now() - 20 * 60_000),
			content: "and another thing",
			author: { id: OWNER },
		};
		const deps = (msgs: RawMsg[]): FounderReplyDeliverDeps => ({
			store,
			fetchImpl: discordGet(msgs),
			cursorStore,
			wakeImpl,
			respondImpl: vi.fn(
				async () => undefined,
			) as unknown as FounderReplyDeliverDeps["respondImpl"],
			commDbFactory: () => makeCommDb(["q1"]) as never,
		});
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			deps([m1]),
		);
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			deps([m1, m2]),
		);
		expect(wakeImpl).toHaveBeenCalledTimes(2);
	});

	it("only founder-authored messages are treated as answers", async () => {
		const { store } = makeStore();
		const respondImpl = vi.fn(
			async () => undefined,
		) as unknown as FounderReplyDeliverDeps["respondImpl"];
		const notFounder: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "lead chatter",
			author: { id: "999" },
		};
		await emitFounderReplyDeliveryForThread(ctx(), [q("q1", "brainstorm")], {
			store,
			fetchImpl: discordGet([notFounder]),
			cursorStore: new InMemoryInboundCursorStore(),
			respondImpl,
			commDbFactory: () => makeCommDb(["q1"]) as never,
		});
		expect(respondImpl).not.toHaveBeenCalled();
	});

	it("processed-through cursor: respond throw → cursor NOT advanced, retried next pass (Codex R2 #1)", async () => {
		const { store } = makeStore();
		const cursorStore = new InMemoryInboundCursorStore();
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "go",
			author: { id: OWNER },
		};
		const throwOnce = vi
			.fn()
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValueOnce(
				undefined,
			) as unknown as FounderReplyDeliverDeps["respondImpl"];
		const deps: FounderReplyDeliverDeps = {
			store,
			fetchImpl: discordGet([reply]),
			cursorStore,
			respondImpl: throwOnce,
			commDbFactory: () => makeCommDb(["q1"]) as never,
		};
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "brainstorm")],
			deps,
		);
		expect(cursorStore.load("T1")).toBeUndefined(); // not advanced past the failed message
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "brainstorm")],
			deps,
		);
		expect(cursorStore.load("T1")).toBe(reply.id); // advanced after success
	});

	it("pre-grace founder reply → not delivered, cursor not advanced (Codex R2 #1)", async () => {
		const { store } = makeStore();
		const cursorStore = new InMemoryInboundCursorStore();
		const respondImpl = vi.fn(
			async () => undefined,
		) as unknown as FounderReplyDeliverDeps["respondImpl"];
		const fresh: RawMsg = {
			id: snowflakeAt(Date.now() - 60_000),
			content: "go",
			author: { id: OWNER },
		}; // 1min ago < grace
		await emitFounderReplyDeliveryForThread(ctx(), [q("q1", "brainstorm")], {
			store,
			fetchImpl: discordGet([fresh]),
			cursorStore,
			respondImpl,
			commDbFactory: () => makeCommDb(["q1"]) as never,
		});
		expect(respondImpl).not.toHaveBeenCalled();
		expect(cursorStore.load("T1")).toBeUndefined();
	});

	it("🔴 ambiguous (2 non-ship questions, 1 reply) → durable Lead handoff, no respond (Codex R2 #2)", async () => {
		const { store } = makeStore();
		const respondImpl = vi.fn(
			async () => undefined,
		) as unknown as FounderReplyDeliverDeps["respondImpl"];
		const handoff = vi.fn(async () => true);
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "do X",
			author: { id: OWNER },
		};
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "brainstorm"), q("q2", null)],
			{
				store,
				fetchImpl: discordGet([reply]),
				cursorStore: new InMemoryInboundCursorStore(),
				respondImpl,
				deliverAmbiguousToLead: handoff,
				commDbFactory: () => makeCommDb(["q1", "q2"]) as never,
			},
		);
		expect(respondImpl).not.toHaveBeenCalled();
		expect(handoff).toHaveBeenCalledTimes(1);
		expect(handoff.mock.calls[0][0]).toContain("founder-reply-ambiguous-T1-");
	});

	it("ambiguous handoff failure → cursor not advanced (Codex R3 #2)", async () => {
		const { store } = makeStore();
		const cursorStore = new InMemoryInboundCursorStore();
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "do X",
			author: { id: OWNER },
		};
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "brainstorm"), q("q2", null)],
			{
				store,
				fetchImpl: discordGet([reply]),
				cursorStore,
				respondImpl: vi.fn(
					async () => undefined,
				) as unknown as FounderReplyDeliverDeps["respondImpl"],
				deliverAmbiguousToLead: vi.fn(async () => false), // handoff failed
				commDbFactory: () => makeCommDb(["q1", "q2"]) as never,
			},
		);
		expect(cursorStore.load("T1")).toBeUndefined();
	});
});
