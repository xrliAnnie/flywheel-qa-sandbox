import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { founderMessageRootId } from "flywheel-comm/founder-reply-routing";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
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

function snowflakeAt(ms: number): string {
	return (BigInt(Math.floor(ms) - DISCORD_EPOCH) << 22n).toString();
}

interface RawMsg {
	id: string;
	content?: string;
	author?: { id?: string; bot?: boolean };
	type?: number;
}

function discordGet(messages: RawMsg[], ok = true) {
	return vi.fn(async () => ({
		ok,
		status: ok ? 200 : 503,
		json: async () => messages,
	})) as unknown as typeof fetch;
}

function ctx(dbPath: string): FounderReplyThreadCtx {
	return {
		issueId: "FLY-1392",
		projectName: "flywheel",
		threadId: "T1",
		botToken: "bot",
		ownerUserId: OWNER,
		graceMs: 10 * 60_000,
		commDbPath: dbPath,
		leadId: "test-lead",
	};
}

function question(
	id: string,
	checkpoint: string | null,
): PendingQuestionForThread {
	return {
		questionId: id,
		checkpoint,
		executionId: `exec-${id}`,
		createdAtMs: Date.now() - 60 * 60_000,
	};
}

function store(): FounderReplyDeliverDeps["store"] {
	return {
		insertEvent: vi.fn(() => true),
	} as unknown as FounderReplyDeliverDeps["store"];
}

describe("FLY-1392 v2 founder ingress", () => {
	let dir: string;
	let dbPath: string;
	let cursor: InMemoryInboundCursorStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1392-founder-ingress-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
		cursor = new InMemoryInboundCursorStore();
		cursor.save("T1", snowflakeAt(Date.now() - 2 * 60 * 60_000));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("records one canonical row and forwards founder text unchanged to Lead", async () => {
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 30_000),
			content: "批准了，可以 merge 了 🆒",
			author: { id: OWNER },
			type: 19,
		};
		const handoff = vi.fn(async () => true);
		const ensureDecisionConvergence =
			vi.fn<
				NonNullable<FounderReplyDeliverDeps["ensureDecisionConvergence"]>
			>();
		const db = new CommDB(dbPath);
		db.registerSession(
			"exec-ship",
			"runner",
			"flywheel",
			"FLY-1392",
			"test-lead",
		);
		const shipQuestionId = db.insertQuestion(
			"exec-ship",
			"test-lead",
			"ship?",
			{ checkpoint: "approve_to_ship" },
		);
		db.close();

		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(dbPath),
			[
				question("brainstorm", "brainstorm"),
				{
					questionId: shipQuestionId,
					checkpoint: "approve_to_ship",
					executionId: "exec-ship",
					createdAtMs: Date.now() - 60 * 60_000,
				},
			],
			{
				store: store(),
				fetchImpl: discordGet([msg]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
				ensureDecisionConvergence,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(ensureDecisionConvergence).toHaveBeenCalledOnce();
		const convergence = ensureDecisionConvergence.mock.calls[0]?.[0];
		expect(convergence.deadlineAtMs - convergence.disposedAtMs).toBe(180_000);
		expect(handoff).toHaveBeenCalledOnce();
		expect(handoff.mock.calls[0]?.[1]).toEqual({
			issueId: "FLY-1392",
			threadId: "T1",
			msgId: msg.id,
			answer: msg.content,
			commDbPath: dbPath,
		});
		const queue = new MailboxQueue(dbPath);
		const row = queue.getById(founderMessageRootId("test-lead", msg.id));
		expect(row).toMatchObject({
			to_agent: "test-lead",
			ref_id: msg.id,
			carrier: "inbox",
		});
		expect(JSON.parse(row?.content ?? "{}").answer).toBe(msg.content);
		queue.close();
	});

	it("is category agnostic: a founder message with zero questions still enters the same path", async () => {
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 20_000),
			content: "a brand-new category",
			author: { id: OWNER },
		};
		const handoff = vi.fn(async () => true);

		await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([msg]),
			cursorStore: cursor,
			deliverAmbiguousToLead: handoff,
		});

		expect(handoff).toHaveBeenCalledOnce();
		expect(cursor.load("T1")).toBe(msg.id);
	});

	it("ignores non-founder and bot-authored traffic", async () => {
		const handoff = vi.fn(async () => true);
		const latest = snowflakeAt(Date.now() - 10_000);

		await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([
				{ id: snowflakeAt(Date.now() - 20_000), author: { id: "other" } },
				{ id: latest, author: { id: OWNER, bot: true } },
			]),
			cursorStore: cursor,
			deliverAmbiguousToLead: handoff,
		});

		expect(handoff).not.toHaveBeenCalled();
		expect(cursor.load("T1")).toBe(latest);
	});

	it("pins the cursor when the durable Lead handoff is absent or fails", async () => {
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 10_000),
			content: "do not drop me",
			author: { id: OWNER },
		};
		const before = cursor.load("T1");

		const missing = await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([msg]),
			cursorStore: cursor,
		});
		expect(missing).toMatchObject({
			result: "process_failed",
			stage: "lead_handoff_missing",
		});
		expect(cursor.load("T1")).toBe(before);

		const failed = await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([msg]),
			cursorStore: cursor,
			deliverAmbiguousToLead: async () => false,
		});
		expect(failed).toMatchObject({
			result: "process_failed",
			stage: "lead_handoff_failed",
		});
		expect(cursor.load("T1")).toBe(before);
	});

	it("retries an idempotent canonical row and advances after handoff recovery", async () => {
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 10_000),
			content: "retry me",
			author: { id: OWNER },
		};
		const handoff = vi
			.fn<() => Promise<boolean>>()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const deps: FounderReplyDeliverDeps = {
			store: store(),
			fetchImpl: discordGet([msg]),
			cursorStore: cursor,
			deliverAmbiguousToLead: handoff,
		};

		expect(
			(await emitFounderReplyDeliveryForThread(ctx(dbPath), [], deps)).result,
		).toBe("process_failed");
		expect(
			(await emitFounderReplyDeliveryForThread(ctx(dbPath), [], deps)).result,
		).toBe("advanced");
		expect(cursor.load("T1")).toBe(msg.id);
		const queue = new MailboxQueue(dbPath);
		expect(
			queue.getById(founderMessageRootId("test-lead", msg.id)),
		).toBeDefined();
		queue.close();
	});

	it("does not advance on a Discord read failure", async () => {
		const before = cursor.load("T1");
		const outcome = await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([], false),
			cursorStore: cursor,
			deliverAmbiguousToLead: async () => true,
		});

		expect(outcome.result).toBe("read_failed");
		expect(cursor.load("T1")).toBe(before);
	});

	it("bootstraps an unseen thread at its current head without replaying history", async () => {
		const freshCursor = new InMemoryInboundCursorStore();
		const head = snowflakeAt(Date.now() - 5_000);
		const handoff = vi.fn(async () => true);
		const outcome = await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([{ id: head, author: { id: OWNER } }]),
			cursorStore: freshCursor,
			deliverAmbiguousToLead: handoff,
		});

		expect(outcome.result).toBe("noop");
		expect(freshCursor.load("T1")).toBe(head);
		expect(handoff).not.toHaveBeenCalled();
	});
});
