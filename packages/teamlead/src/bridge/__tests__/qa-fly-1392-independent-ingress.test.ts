// Independent QA (FLY-1392 three-stage QA phase) — research §10.2 injection B.
// The accepted limitation is that an edited founder message can stall a thread;
// what is NOT acceptable is a silent loss. This exercises the real deliverer and
// pins the visible-failure contract: cursor does not advance past the message,
// the outcome is a durable process_failed, and the retry ledger sees the stall.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";
import {
	emitFounderReplyDeliveryForThread,
	type FounderReplyDeliverDeps,
	type FounderReplyThreadCtx,
} from "../founder-reply-deliverer.js";

const OWNER = "123456789012345678";
const DISCORD_EPOCH = 1_420_070_400_000;

const snowflakeAt = (ms: number) =>
	(BigInt(Math.floor(ms) - DISCORD_EPOCH) << 22n).toString();

function makeStore() {
	return {
		insertEvent: vi.fn(() => true),
		getEventsByExecution: vi.fn(() => []),
	} as unknown as FounderReplyDeliverDeps["store"];
}

describe("FLY-1392 independent QA — §10.2 injection B (edited founder content)", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;
	let queue: LeadInboxQueue;
	let cursor: InMemoryInboundCursorStore;
	let ctx: FounderReplyThreadCtx;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "qa-fly1392-ingress-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		queue = new LeadInboxQueue(dbPath);
		cursor = new InMemoryInboundCursorStore();
		ctx = {
			issueId: "FLY-1392",
			projectName: "flywheel",
			threadId: "thread-qa",
			botToken: "bot",
			ownerUserId: OWNER,
			graceMs: 0,
			commDbPath: dbPath,
			leadId: "lead-a",
		};
		queue.acquireOrRenewOwner({
			ownerEpoch: "epoch-live",
			now: new Date(Date.now() - 1_000).toISOString(),
			leaseTtlMs: 60_000,
		});
	});

	afterEach(() => {
		queue.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function deps(
		messages: Array<Record<string, unknown>>,
		retryLedger?: FounderReplyDeliverDeps["retryLedger"],
	): FounderReplyDeliverDeps {
		return {
			store: makeStore(),
			cursorStore: cursor,
			fetchImpl: vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => messages,
			})) as unknown as typeof fetch,
			commDbFactory: () => new CommDB(dbPath, false),
			deliverAmbiguousToLead: vi.fn(async () => true),
			...(retryLedger ? { retryLedger } : {}),
		} as FounderReplyDeliverDeps;
	}

	it("an edited founder message stalls loudly: no cursor advance, a recorded retry failure", async () => {
		const msgId = snowflakeAt(Date.now() - 30_000);
		const startCursor = snowflakeAt(Date.now() - 120_000);
		cursor.save(ctx.threadId, startCursor);

		// Round 1: the message is ingested and the hub root freezes its content.
		const first = await emitFounderReplyDeliveryForThread(
			ctx,
			[],
			deps([{ id: msgId, content: "原始内容", author: { id: OWNER } }]),
		);
		expect(first.result).toBe("advanced");
		expect(queue.getById(`founder_msg:lead-a:${msgId}`)?.content).toContain(
			"原始内容",
		);

		// A transient failure downstream means the cursor never really moved past
		// this message, so the next pass sees the SAME id again.
		cursor.save(ctx.threadId, startCursor);

		// Round 2: the founder edits the SAME Discord message and the pass retries.
		const recordFailure = vi.fn(() => ({ deadLettered: false }));
		const second = await emitFounderReplyDeliveryForThread(
			ctx,
			[],
			deps([{ id: msgId, content: "改过的内容", author: { id: OWNER } }], {
				recordFailure,
				clear: vi.fn(),
				clearUpTo: vi.fn(),
				isDeadLettered: vi.fn(() => false),
			} as unknown as FounderReplyDeliverDeps["retryLedger"]),
		);

		// Observed behaviour on this head: the strict content equality throws, the
		// pass stalls loudly, and FLY-1099's retry ledger records the failure. The
		// stall is the accepted limitation; the silence would not be.
		expect(second.result).toBe("process_failed");
		expect(cursor.load(ctx.threadId)).toBe(startCursor);
		expect(recordFailure).toHaveBeenCalledTimes(1);
		expect(recordFailure.mock.calls[0]?.[0]).toMatchObject({ msgId });
		// The frozen original is still the durable record — no silent overwrite.
		expect(queue.getById(`founder_msg:lead-a:${msgId}`)?.content).toContain(
			"原始内容",
		);
	});
});
