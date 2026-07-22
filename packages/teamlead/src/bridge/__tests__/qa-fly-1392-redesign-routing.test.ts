// Independent QA (FLY-1392 RE-TEST, copy-model head 8da8e8f68) — scope ①:
// with the receipt foundation ON, Bridge is a pure transport for founder
// messages. Even a founder reply that MATCHES a pending question (the old
// F-5 auto-answer path) must produce zero runner response and zero runner
// wake — only a later Lead route/no-route action may.
//
// The receipt kill switch controls chasing only; it cannot resurrect the
// retired per-type auto-answer path.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";
import {
	emitFounderReplyDeliveryForThread,
	type FounderReplyDeliverDeps,
	type FounderReplyThreadCtx,
	type PendingQuestionForThread,
} from "../founder-reply-deliverer.js";

const OWNER = "123456789012345678";
const DISCORD_EPOCH = 1_420_070_400_000;
const snowflakeAt = (ms: number) =>
	(BigInt(Math.floor(ms) - DISCORD_EPOCH) << 22n).toString();

describe("FLY-1392 RE-TEST — Bridge is transport only for founder messages", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;
	let queue: LeadInboxQueue;
	let cursor: InMemoryInboundCursorStore;
	let ctx: FounderReplyThreadCtx;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "qa-fly1392-redesign-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		queue = new LeadInboxQueue(dbPath);
		cursor = new InMemoryInboundCursorStore();
		cursor.save("thread-1", snowflakeAt(Date.now() - 120_000));
		ctx = {
			issueId: "FLY-1392",
			projectName: "flywheel",
			threadId: "thread-1",
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
	});

	/** A pending question the founder message will match (created before it). */
	function matchingQuestion(checkpoint: string): {
		questionId: string;
		q: PendingQuestionForThread;
	} {
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1392", "lead-a");
		const questionId = db.insertQuestion("exec-a", "lead-a", "continue?", {
			checkpoint,
		});
		return {
			questionId,
			q: {
				questionId,
				checkpoint,
				executionId: "exec-a",
				createdAtMs: Date.now() - 60_000,
				checkpointGraceMs: 0,
			},
		};
	}

	function drive(input: {
		msgId: string;
		content: string;
		counters: { relay: number };
	}): FounderReplyDeliverDeps {
		return {
			store: {
				insertEvent: () => true,
				getEventsByExecution: () => [],
			} as unknown as FounderReplyDeliverDeps["store"],
			cursorStore: cursor,
			fetchImpl: (async () => ({
				ok: true,
				status: 200,
				json: async () => [
					{ id: input.msgId, content: input.content, author: { id: OWNER } },
				],
			})) as unknown as typeof fetch,
			commDbFactory: () => new CommDB(dbPath, false),
			deliverAmbiguousToLead: async () => {
				input.counters.relay += 1;
				return true;
			},
		} as unknown as FounderReplyDeliverDeps;
	}

	// Scope ①: a matching non-ship question. Receipts ON → transport only.
	it("receipts ON: a founder reply matching a pending question never auto-answers or wakes the runner", async () => {
		const { questionId, q } = matchingQuestion("brainstorm");
		const msgId = snowflakeAt(Date.now() - 30_000);
		const counters = { relay: 0 };

		const outcome = await emitFounderReplyDeliveryForThread(
			ctx,
			[q],
			drive({
				msgId,
				content: "继续",
				counters,
			}),
		);

		expect(outcome.result).toBe("advanced");
		// Bridge relayed the raw message to Lead and did nothing toward the runner.
		expect(counters.relay).toBe(1);
		expect(db.getResponse(questionId)).toBeUndefined();
		expect(db.listRunnerPhaseWakes("exec-a")).toEqual([]);
		// The canonical receipt is queued; durable adapter delivery is covered by
		// the real RuntimeRegistry capability test.
		expect(queue.getById(`founder_msg:lead-a:${msgId}`)).toMatchObject({
			delivered_at: null,
			processed_at: null,
			routing_state: "hub_recorded",
		});
	});

	// Scope ① (safety-critical): even a ship-checkpoint match must not
	// auto-approve or write anything toward the runner.
	it("receipts ON: a founder reply matching an approve_to_ship question does not auto-approve", async () => {
		const { questionId, q } = matchingQuestion("approve_to_ship");
		const msgId = snowflakeAt(Date.now() - 30_000);
		const counters = { relay: 0 };

		await emitFounderReplyDeliveryForThread(
			ctx,
			[q],
			drive({
				msgId,
				content: "ok ship it",
				counters,
			}),
		);

		expect(counters.relay).toBe(1);
		expect(db.getResponse(questionId)).toBeUndefined();
		expect(db.listRunnerPhaseWakes("exec-a")).toEqual([]);
	});

	it("rollback mode still relays the same matching reply only to Lead", async () => {
		const { q } = matchingQuestion("brainstorm");
		const msgId = snowflakeAt(Date.now() - 30_000);
		const counters = { relay: 0 };

		await emitFounderReplyDeliveryForThread(
			ctx,
			[q],
			drive({
				msgId,
				content: "继续",
				counters,
			}),
		);

		// The kill switch pauses chase only; it cannot resurrect auto-answer.
		expect(counters.relay).toBe(1);
		expect(queue.getById(`founder_msg:lead-a:${msgId}`)).toMatchObject({
			delivered_at: null,
			processed_at: null,
			routing_state: "hub_recorded",
		});
	});
});
