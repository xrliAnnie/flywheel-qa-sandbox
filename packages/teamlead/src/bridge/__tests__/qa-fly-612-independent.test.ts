/**
 * FLY-612 — INDEPENDENT QA of FLY-605 #367 (founder-relay reliability hook).
 *
 * This file is NOT the implementer's self-test. It closes the 3 gaps the
 * implementer's 37 tests leave (they verify the halves in isolation; these
 * stitch the REAL components end-to-end), per the Tadashi-approved QA plan:
 *
 *  G1  R2 silent-drop END-TO-END — real StateStore (sql.js) + real
 *      GatePoller.makeAmbiguousHandoff + real FileInboundCursorStore +
 *      real emitFounderReplyDeliveryForThread. Proves: short-circuit flush()
 *      throw → surfaces as a `process_exception` failure outcome (FLY-1099:
 *      the deliverer converts the throw into a bounded-retry-eligible
 *      disposition instead of propagating) → on-disk cursor NOT advanced →
 *      retry re-flushes + delivers durably → handoff never lost NOR duplicated.
 *      Plus the happy path (flush OK → cursor advances + handoff durable).
 *
 *  G2  🔴 FLY-175 boundary — approve_to_ship inbound is WAKE-only. English +
 *      Chinese + emoji ship phrasings, fake BRIDGE_URL/TOKEN env + a GLOBAL
 *      fetch network spy: 0 consent-HTTP, 0 insertResponse, exactly 1 wake.
 *      Crown trace: after the wake, REAL verifyApproval (real StateStore +
 *      real CommDB) STILL returns not-approved — scraped thread text never
 *      becomes merge authority.
 *
 *  G3  Inbound relay reliability — a transient Discord READ failure leaves the
 *      cursor untouched and the next pass re-reads + delivers (no silent drop).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { verifyApproval } from "flywheel-comm/verify-approval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FileInboundCursorStore,
	InMemoryInboundCursorStore,
} from "../../lead-backends/codex/InboundCursorStore.js";
import { StateStore } from "../../StateStore.js";
import {
	emitFounderReplyDeliveryForThread,
	type FounderReplyDeliverDeps,
	type FounderReplyThreadCtx,
	type PendingQuestionForThread,
} from "../founder-reply-deliverer.js";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const OWNER = "123456789012345678";
const DISCORD_EPOCH = 1_420_070_400_000;
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"; // 40-hex, valid

function snowflakeAt(ms: number): string {
	return (BigInt(Math.floor(ms) - DISCORD_EPOCH) << 22n).toString();
}

interface RawMsg {
	id: string;
	content?: string;
	author?: { id?: string; bot?: boolean };
}

/** A Discord GET stub returning `messages`, recording how many times called. */
function discordGet(messages: RawMsg[]) {
	return vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => messages,
	})) as unknown as typeof fetch;
}

/** Stub CommDB read used by the deliverer to snapshot still-pending qids. */
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

const QAGO = Date.now() - 60 * 60_000; // raised 1h ago

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

/** A real GatePoller, used only to reach the real private makeAmbiguousHandoff. */
type PrivHandoff = {
	makeAmbiguousHandoff(
		lead: { agentId: string },
		projectName: string,
	): (eventId: string, payload: Record<string, unknown>) => Promise<boolean>;
};
function pollerFor(
	store: StateStore,
	deliver: () => Promise<{ delivered: boolean; error?: string }>,
) {
	const runtimeRegistry = {
		getForLead: vi.fn(() => ({ deliver: vi.fn(deliver) })),
	} as unknown as GatePollerConfig["runtimeRegistry"];
	return new GatePoller({
		pollIntervalMs: 3_000,
		projects: [],
		store,
		runtimeRegistry,
		chatThreadsEnabled: true,
		discordOwnerUserId: OWNER,
	});
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "fly612-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(tmp, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// G1 — R2 silent-drop END-TO-END (real StateStore + real handoff + real cursor)
// ───────────────────────────────────────────────────────────────────────────
describe("FLY-612 G1: R2 silent-drop end-to-end (real components)", () => {
	const ambiguousReply = (): RawMsg => ({
		id: snowflakeAt(Date.now() - 30 * 60_000), // mature
		content: "do the second thing",
		author: { id: OWNER },
	});

	it("HAPPY PATH: flush OK → ambiguous handoff durably delivered + cursor advances on disk", async () => {
		const store = await StateStore.create(join(tmp, "state.db"));
		const flushSpy = vi.spyOn(store, "flush");
		const appendSpy = vi.spyOn(store, "appendLeadEvent");
		const deliver = vi.fn(async () => ({ delivered: true }));
		const handoff = (
			pollerFor(store, deliver) as unknown as PrivHandoff
		).makeAmbiguousHandoff({ agentId: "test-lead" }, "flywheel");
		const cursorPath = join(tmp, "cursor.json");
		const cursor = new FileInboundCursorStore(cursorPath);
		const reply = ambiguousReply();

		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "brainstorm"), q("q2", null)], // 2 non-ship → ambiguous
			{
				store,
				fetchImpl: discordGet([reply]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
				respondImpl: vi.fn(
					async () => undefined,
				) as unknown as FounderReplyDeliverDeps["respondImpl"],
				commDbFactory: () => makeCommDb(["q1", "q2"]) as never,
			},
		);

		const eventId = `founder-reply-ambiguous-T1-${reply.id}`;
		// handoff durably accepted + delivered
		expect(store.isLeadEventDelivered("test-lead", eventId)).toBe(true);
		expect(appendSpy).toHaveBeenCalledTimes(1);
		expect(flushSpy).toHaveBeenCalledTimes(1); // flushed before cursor advance
		// cursor advanced AND persisted to disk (fresh reader == restart)
		expect(new FileInboundCursorStore(cursorPath).load("T1")).toBe(reply.id);
		// lead_event durable on disk too (re-open the StateStore file)
		const reopened = await StateStore.create(join(tmp, "state.db"));
		expect(reopened.isLeadEventDelivered("test-lead", eventId)).toBe(true);
	});

	it("🔴 FAILURE PATH: short-circuit flush() throw → cursor NOT advanced → retry delivers, no drop, no dupe", async () => {
		const store = await StateStore.create(join(tmp, "state.db"));
		// flush throws on the FIRST handoff call (first-delivery path), succeeds after.
		const flushSpy = vi.spyOn(store, "flush").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		const appendSpy = vi.spyOn(store, "appendLeadEvent");
		const deliver = vi.fn(async () => ({ delivered: true }));
		const handoff = (
			pollerFor(store, deliver) as unknown as PrivHandoff
		).makeAmbiguousHandoff({ agentId: "test-lead" }, "flywheel");
		const cursorPath = join(tmp, "cursor.json");
		const cursor = new FileInboundCursorStore(cursorPath);
		const reply = ambiguousReply();
		const deps = (): FounderReplyDeliverDeps => ({
			store,
			fetchImpl: discordGet([reply]),
			cursorStore: cursor,
			deliverAmbiguousToLead: handoff,
			respondImpl: vi.fn(
				async () => undefined,
			) as unknown as FounderReplyDeliverDeps["respondImpl"],
			commDbFactory: () => makeCommDb(["q1", "q2"]) as never,
		});
		const pending = [q("q1", "brainstorm"), q("q2", null)];

		// PASS 1: flush throws inside the handoff. FLY-1099 (Codex code R1
		// HIGH-3): the throw no longer escapes the deliverer — it is converted
		// into a bounded-retry-eligible failure outcome (`process_exception`) so
		// the retry ledger sees it. The LOAD-BEARING contract is unchanged:
		// cursor NOT advanced, the retry pass re-delivers, no drop, no dupe.
		const pass1 = await emitFounderReplyDeliveryForThread(
			ctx(),
			pending,
			deps(),
		);
		expect(pass1).toMatchObject({
			result: "process_failed",
			stage: "process_exception",
			reason: expect.stringContaining("disk full"),
		});
		// cursor NOT advanced — nothing on disk (fresh reader sees no cursor)
		expect(new FileInboundCursorStore(cursorPath).load("T1")).toBeUndefined();

		// PASS 2: retry. isLeadEventDelivered() short-circuit re-flushes (now OK)
		// and returns true → deliverer advances the cursor.
		await emitFounderReplyDeliveryForThread(ctx(), pending, deps());
		const eventId = `founder-reply-ambiguous-T1-${reply.id}`;
		expect(new FileInboundCursorStore(cursorPath).load("T1")).toBe(reply.id);
		// handoff NOT duplicated: appended once (pass 1), short-circuited on pass 2
		expect(appendSpy).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledTimes(1);
		// flush attempted in both passes (threw, then succeeded)
		expect(flushSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		// durable on disk after the successful retry
		const reopened = await StateStore.create(join(tmp, "state.db"));
		expect(reopened.isLeadEventDelivered("test-lead", eventId)).toBe(true);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// G2 — 🔴 FLY-175 boundary (approve_to_ship = WAKE-only)
// ───────────────────────────────────────────────────────────────────────────
describe("FLY-612 G2: 🔴 FLY-175 — thread NL never becomes merge authority", () => {
	let envBak: Record<string, string | undefined>;
	beforeEach(() => {
		envBak = {
			BRIDGE_URL: process.env.BRIDGE_URL,
			FLYWHEEL_BRIDGE_URL: process.env.FLYWHEEL_BRIDGE_URL,
			TEAMLEAD_API_TOKEN: process.env.TEAMLEAD_API_TOKEN,
		};
		// Hostile env: if ANY code path resolved a bridge consent URL from env,
		// these would make it POST. The boundary must hold regardless.
		process.env.BRIDGE_URL = "http://attacker-bridge.local";
		process.env.FLYWHEEL_BRIDGE_URL = "http://attacker-bridge.local";
		process.env.TEAMLEAD_API_TOKEN = "fake-token";
	});
	afterEach(() => {
		for (const [k, v] of Object.entries(envBak)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	const SHIP_PHRASINGS = [
		"approved / ship it",
		"lgtm, merge it",
		"yes go ahead, merge to main",
		"批准了，可以 merge 了",
		"同意 ship 🆒",
		"🆒",
	];

	for (const phrasing of SHIP_PHRASINGS) {
		it(`ship reply "${phrasing}" → 0 consent-HTTP, 0 respond, exactly 1 wake`, async () => {
			const store = await StateStore.create(join(tmp, "state.db"));
			const respondImpl = vi.fn(
				async () => undefined,
			) as unknown as FounderReplyDeliverDeps["respondImpl"];
			const wakeImpl = vi.fn(async () => ({
				ok: true,
			})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
			const reply: RawMsg = {
				id: snowflakeAt(Date.now() - 30 * 60_000),
				content: phrasing,
				author: { id: OWNER },
			};
			// GLOBAL fetch network spy — records EVERY outbound HTTP. The deliverer
			// uses global fetch (no fetchImpl passed) for the thread GET.
			const calls: Array<{ url: string; method: string }> = [];
			vi.spyOn(globalThis, "fetch").mockImplementation((async (
				url: unknown,
				init?: { method?: string },
			) => {
				calls.push({
					url: String(url),
					method: (init?.method ?? "GET").toUpperCase(),
				});
				return {
					ok: true,
					status: 200,
					json: async () => [reply],
				} as unknown as Response;
			}) as unknown as typeof fetch);

			await emitFounderReplyDeliveryForThread(
				ctx(),
				[q("q1", "approve_to_ship")],
				{
					store,
					// NB: no fetchImpl → exercises global fetch (caught by the spy)
					cursorStore: new InMemoryInboundCursorStore(),
					respondImpl,
					wakeImpl,
					commDbFactory: () => makeCommDb(["q1"]) as never,
				},
			);

			// 🔴 ship NEVER routes through respond()/insertResponse
			expect(respondImpl).not.toHaveBeenCalled();
			// exactly one wake, carrying the non-authoritative + verify-approval hint
			expect(wakeImpl).toHaveBeenCalledTimes(1);
			const wakeArg = (wakeImpl as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(wakeArg.content).toContain("verify-approval");
			// 🔴 0 consent-HTTP. Allowed outbound is EXACTLY: the Discord thread
			// GET, plus (FLY-1041 Chunk 8) the ❓ receipt reaction PUT on the
			// founder's own message — a pure notification, method PUT to the
			// Discord reactions API, carrying no approval/consent semantics.
			// Anything else (any POST, any consent/attacker URL) is a violation.
			const gets = calls.filter((c) => c.method === "GET");
			expect(gets).toHaveLength(1);
			expect(gets[0].url).toContain("/channels/T1/messages");
			const nonGets = calls.filter((c) => c.method !== "GET");
			for (const c of nonGets) {
				expect(c.method).toBe("PUT");
				expect(c.url).toMatch(/\/reactions\/.+\/@me$/);
			}
			// nothing POSTed anywhere, in particular not to the attacker bridge
			expect(calls.some((c) => c.method === "POST")).toBe(false);
			expect(calls.some((c) => c.url.includes("attacker-bridge"))).toBe(false);
			expect(calls.some((c) => c.url.includes("founder-consent"))).toBe(false);
		});
	}

	it("🔴 CROWN TRACE: founder types 'approved' in thread → wake delivered → verify-approval STILL not-approved", async () => {
		// Real CommDB with a real approve_to_ship gate bound to a real session.
		const commDbPath = join(tmp, "comm.db");
		const commDb = new CommDB(commDbPath); // createIfMissing (default) → seed
		const execId = "runner-exec-FLY-605";
		const qid = commDb.insertQuestion(
			execId, // from_agent = the runner
			"test-lead", // to_agent = the lead
			"PR ready: ship?",
			{ checkpoint: "approve_to_ship" },
		);
		commDb.close();

		// Real StateStore session bound for verify-approval (status + binding + sha).
		const stateDbPath = join(tmp, "state.db");
		const store = await StateStore.create(stateDbPath);
		store.upsertSession({
			execution_id: execId,
			issue_id: "FLY-605",
			project_name: "flywheel",
			status: "approved_to_ship",
		});
		store.setReviewBinding(execId, {
			questionId: qid,
			prHeadSha: HEAD_SHA,
		}); // persists (save())

		const wakeImpl = vi.fn(async () => ({
			ok: true,
		})) as unknown as FounderReplyDeliverDeps["wakeImpl"];
		const respondImpl = vi.fn(
			async () => undefined,
		) as unknown as FounderReplyDeliverDeps["respondImpl"];
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "approved! 可以 ship 了 🆒",
			author: { id: OWNER },
		};

		await emitFounderReplyDeliveryForThread(
			ctx({ commDbPath }),
			[
				q("__ignored__", "approve_to_ship", {
					questionId: qid,
					executionId: execId,
				}),
			],
			{
				store,
				fetchImpl: discordGet([reply]),
				cursorStore: new InMemoryInboundCursorStore(),
				wakeImpl,
				respondImpl,
				// REAL CommDB so getPendingQuestions returns the real bound gate
				commDbFactory: (p) => new CommDB(p, false),
			},
		);

		// the runner was waked (non-authoritative) ...
		expect(wakeImpl).toHaveBeenCalledTimes(1);
		expect(respondImpl).not.toHaveBeenCalled();
		// ... but NO response was written to the gate
		const check = new CommDB(commDbPath, false);
		expect(check.getResponse(qid)).toBeUndefined();
		check.close();
		// 🔴 and verify-approval — the ONLY ship authority — still refuses
		const verdict = verifyApproval({
			execId,
			prHead: HEAD_SHA,
			dbPath: commDbPath,
			stateDbPath,
		});
		expect(verdict.approved).toBe(false);
		expect(verdict.reason).toBe("gate_not_answered");
	});
});

// ───────────────────────────────────────────────────────────────────────────
// G3 — Inbound relay reliability across a transient Discord READ failure
// ───────────────────────────────────────────────────────────────────────────
describe("FLY-612 G3: inbound relay survives a transient Discord read failure (no drop)", () => {
	it("read fails (500) → not delivered, cursor untouched → next pass re-reads + delivers", async () => {
		const store = await StateStore.create(join(tmp, "state.db"));
		const cursor = new InMemoryInboundCursorStore();
		const reply: RawMsg = {
			id: snowflakeAt(Date.now() - 30 * 60_000),
			content: "go ahead",
			author: { id: OWNER },
		};
		const respondImpl = vi.fn(
			async () => undefined,
		) as unknown as FounderReplyDeliverDeps["respondImpl"];
		// pass 1: 500 (transient read failure); pass 2: 200 with the reply
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, status: 500, json: async () => [] })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => [reply],
			}) as unknown as typeof fetch;
		const deps = (): FounderReplyDeliverDeps => ({
			store,
			fetchImpl,
			cursorStore: cursor,
			respondImpl,
			commDbFactory: () => makeCommDb(["q1"]) as never,
		});

		// PASS 1: read failed → no delivery, cursor untouched
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "brainstorm")],
			deps(),
		);
		expect(respondImpl).not.toHaveBeenCalled();
		expect(cursor.load("T1")).toBeUndefined();

		// PASS 2: read OK → delivered, cursor advances
		await emitFounderReplyDeliveryForThread(
			ctx(),
			[q("q1", "brainstorm")],
			deps(),
		);
		expect(respondImpl).toHaveBeenCalledTimes(1);
		expect(cursor.load("T1")).toBe(reply.id);
	});
});
