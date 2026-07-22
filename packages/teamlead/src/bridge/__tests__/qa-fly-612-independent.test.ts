/**
 * FLY-612 independent relay reliability, updated for FLY-1392 v2.
 * Founder issue-thread traffic is now always one canonical Lead receipt plus an
 * audit-only StateStore mirror; Bridge never answers or wakes a runner directly.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { founderMessageRootId } from "flywheel-comm/founder-reply-routing";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";
import { StateStore } from "../../StateStore.js";
import {
	emitFounderReplyDeliveryForThread,
	type FounderReplyThreadCtx,
} from "../founder-reply-deliverer.js";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const OWNER = "123456789012345678";
const DISCORD_EPOCH = 1_420_070_400_000;

function snowflakeAt(ms: number): string {
	return (BigInt(Math.floor(ms) - DISCORD_EPOCH) << 22n).toString();
}

function discordGet(messages: unknown[], ok = true) {
	return vi.fn(async () => ({
		ok,
		status: ok ? 200 : 500,
		json: async () => messages,
	})) as unknown as typeof fetch;
}

type PrivHandoff = {
	makeAmbiguousHandoff(
		lead: { agentId: string },
		projectName: string,
	): (eventId: string, payload: Record<string, unknown>) => Promise<boolean>;
};

function makePoller(store: StateStore, nudgeLeadInbox = vi.fn()) {
	const runtimeRegistry = {
		getForLead: vi.fn(() => undefined),
		nudgeLeadInbox,
	} as unknown as GatePollerConfig["runtimeRegistry"];
	const poller = new GatePoller({
		pollIntervalMs: 3_000,
		projects: [],
		store,
		runtimeRegistry,
		chatThreadsEnabled: true,
		discordOwnerUserId: OWNER,
	});
	return { poller: poller as unknown as PrivHandoff, nudgeLeadInbox };
}

function context(dbPath: string): FounderReplyThreadCtx {
	return {
		issueId: "FLY-1392",
		projectName: "flywheel",
		threadId: "T1",
		botToken: "bot",
		ownerUserId: OWNER,
		graceMs: 0,
		commDbPath: dbPath,
		leadId: "test-lead",
	};
}

describe("FLY-612 independent reliability under the FLY-1392 v2 topology", () => {
	let dir: string;
	let dbPath: string;
	let cursorPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly612-v2-"));
		dbPath = join(dir, "comm.db");
		cursorPath = join(dir, "cursor.json");
		new CommDB(dbPath).close();
		new FileInboundCursorStore(cursorPath).save(
			"T1",
			snowflakeAt(Date.now() - 60 * 60_000),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("durably records one canonical row, one audit mirror, and then advances the cursor", async () => {
		const statePath = join(dir, "state.db");
		const state = await StateStore.create(statePath);
		const append = vi.spyOn(state, "appendLeadEvent");
		const { poller, nudgeLeadInbox } = makePoller(state);
		const handoff = poller.makeAmbiguousHandoff(
			{ agentId: "test-lead" },
			"flywheel",
		);
		const msg = {
			id: snowflakeAt(Date.now() - 10_000),
			content: "approved / ship it",
			author: { id: OWNER },
		};

		const result = await emitFounderReplyDeliveryForThread(
			context(dbPath),
			[],
			{
				store: state,
				fetchImpl: discordGet([msg]),
				cursorStore: new FileInboundCursorStore(cursorPath),
				deliverAmbiguousToLead: handoff,
			},
		);

		expect(result.result).toBe("advanced");
		expect(append).toHaveBeenCalledOnce();
		expect(nudgeLeadInbox).toHaveBeenCalledWith("test-lead", "flywheel");
		expect(
			state.isLeadEventDelivered("test-lead", `founder-reply-T1-${msg.id}`),
		).toBe(true);
		expect(new FileInboundCursorStore(cursorPath).load("T1")).toBe(msg.id);

		const queue = new LeadInboxQueue(dbPath);
		const receipt = queue.getById(founderMessageRootId("test-lead", msg.id));
		expect(receipt).toMatchObject({
			carrier: "inbox",
			msg_class: "model",
			priority: 0,
		});
		expect(JSON.parse(receipt?.content ?? "{}").answer).toBe(msg.content);
		queue.close();
	});

	it("a flush crash pins the cursor; retry re-flushes without a duplicate audit row", async () => {
		const state = await StateStore.create(join(dir, "state.db"));
		const append = vi.spyOn(state, "appendLeadEvent");
		const realFlush = state.flush.bind(state);
		vi.spyOn(state, "flush")
			.mockImplementationOnce(() => {
				throw new Error("disk full");
			})
			.mockImplementation(realFlush);
		const { poller } = makePoller(state);
		const handoff = poller.makeAmbiguousHandoff(
			{ agentId: "test-lead" },
			"flywheel",
		);
		const msg = {
			id: snowflakeAt(Date.now() - 10_000),
			content: "do not drop this",
			author: { id: OWNER },
		};
		const cursor = new FileInboundCursorStore(cursorPath);
		const before = cursor.load("T1");
		const deps = {
			store: state,
			fetchImpl: discordGet([msg]),
			cursorStore: cursor,
			deliverAmbiguousToLead: handoff,
		};

		expect(
			await emitFounderReplyDeliveryForThread(context(dbPath), [], deps),
		).toMatchObject({ result: "process_failed", stage: "process_exception" });
		expect(cursor.load("T1")).toBe(before);

		expect(
			await emitFounderReplyDeliveryForThread(context(dbPath), [], deps),
		).toMatchObject({ result: "advanced" });
		expect(cursor.load("T1")).toBe(msg.id);
		expect(append).toHaveBeenCalledOnce();
	});

	it("a transient Discord read failure leaves the cursor untouched and retry delivers", async () => {
		const state = await StateStore.create(join(dir, "state.db"));
		const { poller } = makePoller(state);
		const handoff = poller.makeAmbiguousHandoff(
			{ agentId: "test-lead" },
			"flywheel",
		);
		const msg = {
			id: snowflakeAt(Date.now() - 10_000),
			content: "retry after read outage",
			author: { id: OWNER },
		};
		const cursor = new FileInboundCursorStore(cursorPath);
		const before = cursor.load("T1");

		expect(
			await emitFounderReplyDeliveryForThread(context(dbPath), [], {
				store: state,
				fetchImpl: discordGet([], false),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
			}),
		).toMatchObject({ result: "read_failed" });
		expect(cursor.load("T1")).toBe(before);

		expect(
			await emitFounderReplyDeliveryForThread(context(dbPath), [], {
				store: state,
				fetchImpl: discordGet([msg]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
			}),
		).toMatchObject({ result: "advanced" });
		expect(cursor.load("T1")).toBe(msg.id);
	});
});
