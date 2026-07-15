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

	it.each([["backend_commdb"], ["no_session_lead"]] as const)(
		"🔴 ship wake skipped ({ok:false, skippedReason:%s}, no error) → NO marker, cursor NOT advanced (Codex ship-gate #2)",
		async (skippedReason) => {
			const { store, events } = makeStore();
			const cursorStore = new InMemoryInboundCursorStore();
			const wakeImpl = vi.fn(async () => ({
				ok: false,
				skippedReason,
			})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
			const reply: RawMsg = {
				id: snowflakeAt(Date.now() - 30 * 60_000),
				content: "approved",
				author: { id: OWNER },
			};
			await emitFounderReplyDeliveryForThread(
				ctx(),
				[q("q1", "approve_to_ship")],
				{
					store,
					fetchImpl: discordGet([reply]),
					cursorStore,
					wakeImpl,
					respondImpl: vi.fn(
						async () => undefined,
					) as unknown as FounderReplyDeliverDeps["respondImpl"],
					commDbFactory: () => makeCommDb(["q1"]) as never,
				},
			);
			// No wake delivered → ship reply NOT consumed: no durable marker, cursor
			// stays put (next sub-cadence retries). A skip-audit event IS recorded.
			expect(
				events.some((e) => e.event_id.startsWith("founder-ship-wake-")),
			).toBe(false);
			expect(
				events.some((e) =>
					e.event_id.startsWith("founder_ship_reply_wake_skipped"),
				),
			).toBe(true);
			expect(cursorStore.load("T1")).toBeUndefined();
		},
	);

	it("🔴 ship wake skip is transient: a later successful wake delivers + advances (Codex ship-gate #2)", async () => {
		const { store, events } = makeStore();
		const cursorStore = new InMemoryInboundCursorStore();
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "approved",
			author: { id: OWNER },
		};
		const wakeImpl = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, skippedReason: "no_session_lead" })
			.mockResolvedValueOnce({
				ok: true,
			}) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const deps: FounderReplyDeliverDeps = {
			store,
			fetchImpl: discordGet([reply]),
			cursorStore,
			wakeImpl,
			respondImpl: vi.fn(
				async () => undefined,
			) as unknown as FounderReplyDeliverDeps["respondImpl"],
			commDbFactory: () => makeCommDb(["q1"]) as never,
		};
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			deps,
		);
		expect(cursorStore.load("T1")).toBeUndefined(); // skipped → not advanced
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			deps,
		);
		expect(
			events.some((e) => e.event_id.startsWith("founder-ship-wake-")),
		).toBe(true); // waked on retry
		expect(cursorStore.load("T1")).toBe(reply.id); // advanced after real wake
	});

	// ────────────────────────────────────────────────────────────────────
	// FLY-945 Fix A: per-checkpoint grace (ship gates skip the 10min wait)
	// + stop-advance loop (immature messages pin the cursor without blocking
	// later mature ship messages).
	// ────────────────────────────────────────────────────────────────────

	it("FLY-945 ① mature ship (checkpointGraceMs=15s, msg 30s old) → waked immediately, cursor advanced", async () => {
		const { store } = makeStore();
		const cursorStore = new InMemoryInboundCursorStore();
		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 30_000), // 30s ago — inside the old 10min grace
			content: "ship it",
			author: { id: OWNER },
		};
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("qs", "approve_to_ship", { checkpointGraceMs: 15_000 })],
			{
				store,
				fetchImpl: discordGet([reply]),
				cursorStore,
				wakeImpl,
				respondImpl: vi.fn(
					async () => undefined,
				) as unknown as FounderReplyDeliverDeps["respondImpl"],
				commDbFactory: () => makeCommDb(["qs"]) as never,
			},
		);
		expect(wakeImpl).toHaveBeenCalledTimes(1);
		expect(cursorStore.load("T1")).toBe(reply.id);
	});

	it("FLY-945 ② immature non-ship BEFORE + mature ship AFTER → ship processed, cursor pinned before the non-ship msg", async () => {
		const { store } = makeStore();
		const cursorStore = new InMemoryInboundCursorStore();
		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const respondImpl = vi.fn(
			async () => undefined,
		) as unknown as FounderReplyDeliverDeps["respondImpl"];
		const handoff = vi.fn(async () => true);
		const now = Date.now();
		// brainstorm question 20min ago; founder answers it 5min ago (immature: 10min grace)
		const qb = q("qb", "brainstorm", {
			createdAtMs: now - 20 * 60_000,
			checkpointGraceMs: 600_000,
		});
		const m1: RawMsg = {
			id: snowflakeAt(now - 5 * 60_000),
			content: "for the brainstorm: use X",
			author: { id: OWNER },
		};
		// ship gate 2min ago; founder says ship 30s ago (mature: 15s grace)
		const qs = q("qs", "approve_to_ship", {
			createdAtMs: now - 2 * 60_000,
			checkpointGraceMs: 15_000,
		});
		const m2: RawMsg = {
			id: snowflakeAt(now - 30_000),
			content: "ship it",
			author: { id: OWNER },
		};
		await emitFounderReplyDeliveryForThread(ctx(), [qb, qs], {
			store,
			fetchImpl: discordGet([m1, m2]),
			cursorStore,
			wakeImpl,
			respondImpl,
			deliverAmbiguousToLead: handoff,
			commDbFactory: () => makeCommDb(["qb", "qs"]) as never,
		});
		// m2's ship half is processed (waked); its non-ship half is ambiguous
		// (matching=2) → handoff, unchanged semantics.
		expect(wakeImpl).toHaveBeenCalledTimes(1);
		expect(handoff).toHaveBeenCalledTimes(1);
		expect(respondImpl).not.toHaveBeenCalled();
		// cursor MUST stay before m1 (the immature non-ship reply is re-read later)
		expect(cursorStore.load("T1")).toBeUndefined();
	});

	it("FLY-945 ③ re-scan of the same mature ship msg is idempotent (marker dedupe, no second wake)", async () => {
		const { store } = makeStore();
		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 60_000),
			content: "ship it",
			author: { id: OWNER },
		};
		const deps = (): FounderReplyDeliverDeps => ({
			store,
			fetchImpl: discordGet([reply]),
			// fresh cursor each scan → the message is re-read both times
			cursorStore: new InMemoryInboundCursorStore(),
			wakeImpl,
			respondImpl: vi.fn(
				async () => undefined,
			) as unknown as FounderReplyDeliverDeps["respondImpl"],
			commDbFactory: () => makeCommDb(["qs"]) as never,
		});
		const shipQ = q("qs", "approve_to_ship", { checkpointGraceMs: 15_000 });
		await emitFounderReplyDeliveryForThread(ctx(), [shipQ], deps());
		await emitFounderReplyDeliveryForThread(ctx(), [shipQ], deps());
		expect(wakeImpl).toHaveBeenCalledTimes(1);
	});

	it("FLY-945 ⑤ reverse-compat: ship grace raised to 600000 → 30s-old ship msg NOT processed (old behavior)", async () => {
		const { store } = makeStore();
		const cursorStore = new InMemoryInboundCursorStore();
		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 30_000),
			content: "ship it",
			author: { id: OWNER },
		};
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("qs", "approve_to_ship", { checkpointGraceMs: 600_000 })],
			{
				store,
				fetchImpl: discordGet([reply]),
				cursorStore,
				wakeImpl,
				respondImpl: vi.fn(
					async () => undefined,
				) as unknown as FounderReplyDeliverDeps["respondImpl"],
				commDbFactory: () => makeCommDb(["qs"]) as never,
			},
		);
		expect(wakeImpl).not.toHaveBeenCalled();
		expect(cursorStore.load("T1")).toBeUndefined();
	});

	it("FLY-945 ⑥ young non-ship question's founder reply is NOT lost: matching uses the full set, cursor waits", async () => {
		// Old GatePoller pre-filter dropped young questions entirely → the reply
		// found no matching question → classified irrelevant → cursor advanced
		// past it → permanently lost. New semantics: the question is passed with
		// its grace; the message is immature → cursor pinned, retried later.
		const { store } = makeStore();
		const cursorStore = new InMemoryInboundCursorStore();
		const respondImpl = vi.fn(
			async () => undefined,
		) as unknown as FounderReplyDeliverDeps["respondImpl"];
		const now = Date.now();
		const young = q("q1", "brainstorm", {
			createdAtMs: now - 60_000, // 1min old — pre-grace
			checkpointGraceMs: 600_000,
		});
		const reply: RawMsg = {
			id: snowflakeAt(now - 30_000),
			content: "use approach B",
			author: { id: OWNER },
		};
		await emitFounderReplyDeliveryForThread(ctx(), [young], {
			store,
			fetchImpl: discordGet([reply]),
			cursorStore,
			respondImpl,
			commDbFactory: () => makeCommDb(["q1"]) as never,
		});
		expect(respondImpl).not.toHaveBeenCalled();
		expect(cursorStore.load("T1")).toBeUndefined(); // NOT advanced past the reply
	});

	it("FLY-945: questions without checkpointGraceMs fall back to ctx.graceMs (byte-compat)", async () => {
		const { store } = makeStore();
		const cursorStore = new InMemoryInboundCursorStore();
		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 30_000),
			content: "ship it",
			author: { id: OWNER },
		};
		await emitFounderReplyDeliveryForThread(
			ctx(), // graceMs = 10min
			[q("qs", "approve_to_ship")], // no checkpointGraceMs
			{
				store,
				fetchImpl: discordGet([reply]),
				cursorStore,
				wakeImpl,
				respondImpl: vi.fn(
					async () => undefined,
				) as unknown as FounderReplyDeliverDeps["respondImpl"],
				commDbFactory: () => makeCommDb(["qs"]) as never,
			},
		);
		expect(wakeImpl).not.toHaveBeenCalled(); // still 10min-gated
		expect(cursorStore.load("T1")).toBeUndefined();
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

describe("FLY-1041 Chunk 7: reply-to-card deterministic binding", () => {
	afterEach(() => {
		delete process.env.FLYWHEEL_REPLY_TO_CARD;
		vi.restoreAllMocks();
	});

	const CARD_MSG_ID = "424242424242424242";
	const HEAD = "a".repeat(40);

	function replyMsg(over: Record<string, unknown> = {}) {
		return {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "okk",
			author: { id: OWNER },
			type: 19,
			message_reference: {
				message_id: CARD_MSG_ID,
				channel_id: "T1",
			},
			...over,
		} as RawMsg;
	}

	function makeShipDeps(msg: RawMsg) {
		const { store } = makeStore();
		(store as unknown as { getSession: unknown }).getSession = vi.fn(() => ({
			pr_head_sha: HEAD,
			status: "awaiting_review",
		}));
		const tryShip = vi.fn(
			async (args: { shipGates: Array<{ questionId: string }> }) => ({
				bound: args.shipGates.map((g) => ({
					questionId: g.questionId,
					decision: "approve" as const,
				})),
				deferred: [],
				retry: false,
			}),
		);
		// Only q2's current binding points at the card message.
		const readCurrentBinding = vi.fn(
			(_execId: string, questionId: string, _head: string) =>
				questionId === "q2"
					? ({ gateMessageId: CARD_MSG_ID, threadId: "T1" } as never)
					: null,
		);
		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const deps: FounderReplyDeliverDeps = {
			store,
			fetchImpl: discordGet([msg]),
			cursorStore: new InMemoryInboundCursorStore(),
			wakeImpl,
			commDbFactory: () => makeCommDb(["q1", "q2"]) as never,
			tryFounderShipApproval:
				tryShip as unknown as FounderReplyDeliverDeps["tryFounderShipApproval"],
			readCurrentBinding,
		};
		return { deps, tryShip, readCurrentBinding };
	}

	const twoShipGates = [q("q1", "approve_to_ship"), q("q2", "approve_to_ship")];

	it("verified reply to the card narrows the attribution to THAT gate + passes replyToCard", async () => {
		const { deps, tryShip } = makeShipDeps(replyMsg());
		await emitFounderReplyDeliveryForThread(ctx(), twoShipGates, deps);
		expect(tryShip).toHaveBeenCalledTimes(1);
		const args = tryShip.mock.calls[0]?.[0] as {
			shipGates: Array<{ questionId: string }>;
			replyToCard?: boolean;
		};
		expect(args.shipGates.map((g) => g.questionId)).toEqual(["q2"]);
		expect(args.replyToCard).toBe(true);
	});

	it("reference to an unrelated message (no binding hit) → full ship set, no replyToCard (byte-compat)", async () => {
		const { deps, tryShip } = makeShipDeps(
			replyMsg({
				message_reference: { message_id: "111", channel_id: "T1" },
			}),
		);
		await emitFounderReplyDeliveryForThread(ctx(), twoShipGates, deps);
		const args = tryShip.mock.calls[0]?.[0] as {
			shipGates: Array<{ questionId: string }>;
			replyToCard?: boolean;
		};
		expect(args.shipGates.map((g) => g.questionId)).toEqual(["q1", "q2"]);
		expect(args.replyToCard).toBeFalsy();
	});

	it("negative (Codex R1 #3): type !== 19 with a reference to the card id (forward shape) → NOT narrowed", async () => {
		const { deps, tryShip } = makeShipDeps(replyMsg({ type: 0 }));
		await emitFounderReplyDeliveryForThread(ctx(), twoShipGates, deps);
		const args = tryShip.mock.calls[0]?.[0] as {
			shipGates: Array<{ questionId: string }>;
			replyToCard?: boolean;
		};
		expect(args.shipGates).toHaveLength(2);
		expect(args.replyToCard).toBeFalsy();
	});

	it("negative: message_reference.type = 1 (forward) → NOT narrowed", async () => {
		const { deps, tryShip } = makeShipDeps(
			replyMsg({
				message_reference: {
					type: 1,
					message_id: CARD_MSG_ID,
					channel_id: "T1",
				},
			}),
		);
		await emitFounderReplyDeliveryForThread(ctx(), twoShipGates, deps);
		expect(
			(tryShip.mock.calls[0]?.[0] as { replyToCard?: boolean }).replyToCard,
		).toBeFalsy();
	});

	it("negative: reference.channel_id ≠ this thread → NOT narrowed", async () => {
		const { deps, tryShip } = makeShipDeps(
			replyMsg({
				message_reference: { message_id: CARD_MSG_ID, channel_id: "OTHER" },
			}),
		);
		await emitFounderReplyDeliveryForThread(ctx(), twoShipGates, deps);
		expect(
			(tryShip.mock.calls[0]?.[0] as { replyToCard?: boolean }).replyToCard,
		).toBeFalsy();
	});

	it("FLYWHEEL_REPLY_TO_CARD=0 kill-switch → message_reference ignored entirely", async () => {
		process.env.FLYWHEEL_REPLY_TO_CARD = "0";
		const { deps, tryShip, readCurrentBinding } = makeShipDeps(replyMsg());
		await emitFounderReplyDeliveryForThread(ctx(), twoShipGates, deps);
		expect(readCurrentBinding).not.toHaveBeenCalled();
		expect(
			(tryShip.mock.calls[0]?.[0] as { replyToCard?: boolean }).replyToCard,
		).toBeFalsy();
	});
});

describe("FLY-1041 Chunk 8: founder receipt reaction (✅/❓)", () => {
	afterEach(() => {
		delete process.env.FLYWHEEL_FOUNDER_APPROVAL_ACK;
		vi.restoreAllMocks();
	});

	/** insertEvent enforcing UNIQUE(event_id) like the real StateStore. */
	function uniqueStore(existing: string[] = []) {
		const ids = new Set(existing);
		const events: Array<{ event_id: string; event_type?: string }> =
			existing.map((event_id) => ({ event_id }));
		const store = {
			insertEvent: vi.fn((e: { event_id: string; event_type: string }) => {
				if (ids.has(e.event_id)) return false;
				ids.add(e.event_id);
				events.push({ event_id: e.event_id, event_type: e.event_type });
				return true;
			}),
			getEventsByExecution: vi.fn(() => events.slice()),
		} as unknown as FounderReplyDeliverDeps["store"];
		return { store, events };
	}

	function ackHarness(opts: {
		msgId?: string;
		handled?: boolean;
		suppressed?: boolean;
		existingEventIds?: string[];
		reactResult?: { ok: boolean; status?: number };
	}) {
		const msgId = opts.msgId ?? snowflakeAt(Date.now() - 30 * 60_000);
		const { store, events } = uniqueStore(opts.existingEventIds ?? []);
		const reactImpl = vi.fn(
			async () => opts.reactResult ?? { ok: true, status: 204 },
		);
		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const tryShip = vi.fn(
			async (args: { shipGates: Array<{ questionId: string }> }) =>
				opts.suppressed
					? {
							bound: [],
							deferred: [],
							suppressed: args.shipGates.map((g) => ({
								questionId: g.questionId,
							})),
							retry: false,
						}
					: opts.handled
						? {
								bound: args.shipGates.map((g) => ({
									questionId: g.questionId,
									decision: "approve" as const,
								})),
								deferred: [],
								retry: false,
							}
						: null,
		);
		const msg: RawMsg = {
			id: msgId,
			content: "嗯ship",
			author: { id: OWNER },
		};
		const deps: FounderReplyDeliverDeps = {
			store,
			fetchImpl: discordGet([msg]),
			cursorStore: new InMemoryInboundCursorStore(),
			wakeImpl,
			commDbFactory: () => makeCommDb(["q1"]) as never,
			tryFounderShipApproval:
				tryShip as unknown as FounderReplyDeliverDeps["tryFounderShipApproval"],
			reactToFounderMessageImpl:
				reactImpl as unknown as FounderReplyDeliverDeps["reactToFounderMessageImpl"],
		};
		return { deps, reactImpl, wakeImpl, events, msgId };
	}

	it("bound decision (approve written) → ✅ on the founder's message + founder_ack_reacted audit", async () => {
		const { deps, reactImpl, events, msgId } = ackHarness({ handled: true });
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			deps,
		);
		expect(reactImpl).toHaveBeenCalledTimes(1);
		const call = reactImpl.mock.calls[0]?.[0] as {
			emoji: string;
			messageId: string;
			channelId: string;
		};
		expect(call.emoji).toBe("✅");
		expect(call.messageId).toBe(msgId);
		expect(call.channelId).toBe("T1");
		expect(events.some((e) => e.event_type === "founder_ack_reacted")).toBe(
			true,
		);
	});

	it("unbound (unclear / null attribution) → ❓ receipt", async () => {
		const { deps, reactImpl } = ackHarness({ handled: false });
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			deps,
		);
		expect((reactImpl.mock.calls[0]?.[0] as { emoji: string }).emoji).toBe(
			"❓",
		);
	});

	it("merged suppression is fully silent: no wake and no receipt reaction", async () => {
		const { deps, reactImpl, wakeImpl } = ackHarness({ suppressed: true });
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			deps,
		);
		expect(wakeImpl).not.toHaveBeenCalled();
		expect(reactImpl).not.toHaveBeenCalled();
	});

	it("no ship gates in matching (brainstorm only) → zero receipts (chatter untouched)", async () => {
		const { deps, reactImpl } = ackHarness({ handled: false });
		const respondImpl = vi.fn(
			async () => undefined,
		) as unknown as FounderReplyDeliverDeps["respondImpl"];
		await emitFounderReplyDeliveryForThread(ctx(), [q("q1", "brainstorm")], {
			...deps,
			respondImpl,
		});
		expect(reactImpl).not.toHaveBeenCalled();
	});

	it("PUT failure (403) → founder_ack_failed audit, never throws, no retry", async () => {
		const { deps, reactImpl, events } = ackHarness({
			handled: true,
			reactResult: { ok: false, status: 403 },
		});
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			deps,
		);
		expect(reactImpl).toHaveBeenCalledTimes(1);
		expect(events.some((e) => e.event_type === "founder_ack_failed")).toBe(
			true,
		);
	});

	it("durable marker dedup: an existing same-outcome marker suppresses the PUT", async () => {
		const msgId = snowflakeAt(Date.now() - 30 * 60_000);
		const { deps, reactImpl } = ackHarness({
			msgId,
			handled: true,
			existingEventIds: [`founder-ack-${msgId}-bound`],
		});
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			deps,
		);
		expect(reactImpl).not.toHaveBeenCalled();
	});

	it("Codex R1 MEDIUM: an earlier ❓ (unbound marker) must NOT suppress the ✅ when a re-scan binds", async () => {
		const msgId = snowflakeAt(Date.now() - 30 * 60_000);
		const { deps, reactImpl } = ackHarness({
			msgId,
			handled: true, // the retry bound successfully this pass
			existingEventIds: [`founder-ack-${msgId}-unbound`],
		});
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			deps,
		);
		expect(reactImpl).toHaveBeenCalledTimes(1);
		expect((reactImpl.mock.calls[0]?.[0] as { emoji: string }).emoji).toBe(
			"✅",
		);
	});

	it("FLYWHEEL_FOUNDER_APPROVAL_ACK=0 kill-switch → no receipt (byte-compat)", async () => {
		process.env.FLYWHEEL_FOUNDER_APPROVAL_ACK = "0";
		const { deps, reactImpl } = ackHarness({ handled: true });
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			deps,
		);
		expect(reactImpl).not.toHaveBeenCalled();
	});
});

describe("FLY-1099: bounded retry + dead-letter + 🕒 receipt + scan outcomes", () => {
	afterEach(() => {
		delete process.env.FLYWHEEL_FOUNDER_APPROVAL_ACK;
		vi.restoreAllMocks();
	});

	function retryLedgerFake(opts: { deadLetterOn?: number } = {}) {
		let failures = 0;
		const dead = new Set<string>();
		const recordFailure = vi.fn(({ msgId }: { msgId: string }) => {
			failures++;
			if (opts.deadLetterOn !== undefined && failures >= opts.deadLetterOn) {
				dead.add(msgId);
				return { deadLettered: true };
			}
			return { deadLettered: false };
		});
		const clear = vi.fn();
		const clearUpTo = vi.fn();
		const deadLetterNow = vi.fn(({ msgId }: { msgId: string }) => {
			dead.add(msgId);
			return { deadLettered: true };
		});
		return {
			ledger: {
				recordFailure,
				deadLetterNow,
				isDeadLettered: (_t: string, m: string) => dead.has(m),
				clear,
				clearUpTo,
			},
			recordFailure,
			deadLetterNow,
			clear,
			clearUpTo,
			markDead: (m: string) => dead.add(m),
		};
	}

	function shipHarness(opts: {
		msgs: RawMsg[];
		tryShip?: FounderReplyDeliverDeps["tryFounderShipApproval"];
		ledger?: ReturnType<typeof retryLedgerFake>["ledger"];
		wakeOk?: boolean;
	}) {
		const { store } = makeStore();
		const cursorStore = new InMemoryInboundCursorStore();
		const reactImpl = vi.fn(async () => ({ ok: true, status: 204 }));
		const wakeImpl = vi.fn(async () =>
			opts.wakeOk === false
				? { ok: false, skippedReason: "no_session_lead" }
				: { ok: true },
		) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const deps: FounderReplyDeliverDeps = {
			store,
			fetchImpl: discordGet(opts.msgs),
			cursorStore,
			wakeImpl,
			commDbFactory: () => makeCommDb(["q1"]) as never,
			tryFounderShipApproval: opts.tryShip,
			retryLedger: opts.ledger,
			reactToFounderMessageImpl:
				reactImpl as unknown as FounderReplyDeliverDeps["reactToFounderMessageImpl"],
		};
		return { deps, cursorStore, reactImpl, wakeImpl };
	}

	const matureMsg = (content = "ship"): RawMsg => ({
		id: snowflakeAt(Date.now() - 30 * 60_000),
		content,
		author: { id: OWNER },
	});

	it("deferred disposition → 🕒 receipt, WAKE skipped, cursor ADVANCES (message durably disposed)", async () => {
		const msg = matureMsg();
		const tryShip = vi.fn(async () => ({
			bound: [],
			deferred: [{ questionId: "q1", decision: "approve" as const }],
			retry: false,
		}));
		const { deps, cursorStore, reactImpl, wakeImpl } = shipHarness({
			msgs: [msg],
			tryShip: tryShip as never,
		});
		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship", { checkpointGraceMs: 15_000 })],
			deps,
		);
		expect(wakeImpl).not.toHaveBeenCalled();
		expect(reactImpl).toHaveBeenCalledWith(
			expect.objectContaining({ emoji: "🕒", messageId: msg.id }),
		);
		expect(cursorStore.load("T1")).toBe(msg.id);
		expect(outcome.result).toBe("advanced");
	});

	it("handler retry disposition → recordFailure with the handler stage, cursor PINNED (process_failed)", async () => {
		const msg = matureMsg();
		const tryShip = vi.fn(async () => ({
			bound: [],
			deferred: [],
			retry: true,
			stage: "tier3_runner_failed",
			reason: "spawn timeout",
		}));
		const rl = retryLedgerFake();
		const { deps, cursorStore } = shipHarness({
			msgs: [msg],
			tryShip: tryShip as never,
			ledger: rl.ledger,
		});
		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship", { checkpointGraceMs: 15_000 })],
			deps,
		);
		expect(rl.recordFailure).toHaveBeenCalledWith(
			expect.objectContaining({ msgId: msg.id, stage: "tier3_runner_failed" }),
		);
		expect(cursorStore.load("T1")).toBeUndefined();
		expect(outcome).toMatchObject({
			result: "process_failed",
			pinnedMsgId: msg.id,
			stage: "tier3_runner_failed",
		});
	});

	it("dead-letter DISPOSES the message: cursor advances past it, scan continues (waterline rule §7.1)", async () => {
		const msg = matureMsg();
		const rl = retryLedgerFake({ deadLetterOn: 1 });
		const { deps, cursorStore } = shipHarness({
			msgs: [msg],
			wakeOk: false, // wake_no_session_lead — tonight's FLY-1049 shape
			ledger: rl.ledger,
		});
		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship", { checkpointGraceMs: 15_000 })],
			deps,
		);
		expect(rl.recordFailure).toHaveBeenCalledOnce();
		expect(cursorStore.load("T1")).toBe(msg.id); // disposed → cursor passed it
		expect(outcome.result).toBe("advanced");
	});

	it("an already dead-lettered msgId is SKIPPED like a non-matching message", async () => {
		const msg = matureMsg();
		const rl = retryLedgerFake();
		rl.markDead(msg.id);
		const { deps, cursorStore, wakeImpl } = shipHarness({
			msgs: [msg],
			ledger: rl.ledger,
		});
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship", { checkpointGraceMs: 15_000 })],
			deps,
		);
		expect(wakeImpl).not.toHaveBeenCalled();
		expect(cursorStore.load("T1")).toBe(msg.id);
	});

	it("cursor save triggers the waterline cleanup (clearUpTo) — Codex R2 #6", async () => {
		const msg = matureMsg();
		const rl = retryLedgerFake();
		const { deps } = shipHarness({ msgs: [msg], ledger: rl.ledger });
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship", { checkpointGraceMs: 15_000 })],
			deps,
		);
		expect(rl.clearUpTo).toHaveBeenCalledWith("T1", msg.id);
	});

	it("Discord GET failure → ThreadScanOutcome read_failed (a health OUTCOME, not just an audit)", async () => {
		const { store } = makeStore();
		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "approve_to_ship")],
			{
				store,
				fetchImpl: vi.fn(async () => ({
					ok: false,
					status: 500,
				})) as unknown as typeof fetch,
				cursorStore: new InMemoryInboundCursorStore(),
				commDbFactory: () => makeCommDb(["q1"]) as never,
			},
		);
		expect(outcome).toMatchObject({ result: "read_failed" });
	});
});

describe("Codex code R1 HIGH-3: a processing THROW flows into the retry ledger", () => {
	it("tryFounderShipApproval throws → recordFailure(process_exception), scan outcome process_failed", async () => {
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "ship",
			author: { id: OWNER },
		};
		const recordFailure = vi.fn(() => ({ deadLettered: false }));
		const { store } = makeStore();
		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(),
			[
				q("q1", "approve_to_ship", {
					checkpointGraceMs: 15_000,
				}),
			],
			{
				store,
				fetchImpl: discordGet([msg]),
				cursorStore: new InMemoryInboundCursorStore(),
				commDbFactory: () => makeCommDb(["q1"]) as never,
				tryFounderShipApproval: vi.fn(async () => {
					throw new Error("sql.js exploded");
				}) as never,
				retryLedger: {
					recordFailure,
					deadLetterNow: vi.fn(() => ({ deadLettered: true })),
					isDeadLettered: () => false,
					clear: vi.fn(),
					clearUpTo: vi.fn(),
				},
			},
		);
		expect(recordFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "process_exception",
				reason: "sql.js exploded",
			}),
		);
		expect(outcome).toMatchObject({
			result: "process_failed",
			stage: "process_exception",
		});
	});
});

describe("Codex code R3 HIGH: deadLetter disposition — immediate terminal, no unreachable retry", () => {
	const matureShip = () =>
		q("q1", "approve_to_ship", { checkpointGraceMs: 15_000 });

	function dlHarness(deadLettered: boolean) {
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "改一下",
			author: { id: OWNER },
		};
		const { store } = makeStore();
		const cursorStore = new InMemoryInboundCursorStore();
		const deadLetterNow = vi.fn(() => ({ deadLettered }));
		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const tryShip = vi.fn(async () => ({
			bound: [],
			deferred: [],
			retry: false,
			deadLetter: {
				questionId: "q1",
				stage: "convergence_park_failed",
				reason: "ledger down; park failed: still down",
			},
		}));
		const deps: FounderReplyDeliverDeps = {
			store,
			fetchImpl: discordGet([msg]),
			cursorStore,
			wakeImpl,
			commDbFactory: () => makeCommDb(["q1"]) as never,
			tryFounderShipApproval: tryShip as never,
			retryLedger: {
				recordFailure: vi.fn(() => ({ deadLettered: false })),
				deadLetterNow,
				isDeadLettered: () => false,
				clear: vi.fn(),
				clearUpTo: vi.fn(),
			},
		};
		return { msg, deps, cursorStore, deadLetterNow, wakeImpl };
	}

	it("dead-letter lands → message DISPOSED: WAKE skipped, cursor advances", async () => {
		const { msg, deps, cursorStore, deadLetterNow, wakeImpl } = dlHarness(true);
		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(),
			[matureShip()],
			deps,
		);
		expect(deadLetterNow).toHaveBeenCalledWith(
			expect.objectContaining({
				msgId: msg.id,
				stage: "convergence_park_failed",
			}),
		);
		expect(wakeImpl).not.toHaveBeenCalled();
		expect(cursorStore.load("T1")).toBe(msg.id);
		expect(outcome.result).toBe("advanced");
	});

	it("dead-letter write itself fails (store broken) → cursor PINS (watchdog last resort)", async () => {
		const { deps, cursorStore } = dlHarness(false);
		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(),
			[matureShip()],
			deps,
		);
		expect(cursorStore.load("T1")).toBeUndefined();
		expect(outcome).toMatchObject({
			result: "process_failed",
			stage: "convergence_park_failed",
		});
	});
});
