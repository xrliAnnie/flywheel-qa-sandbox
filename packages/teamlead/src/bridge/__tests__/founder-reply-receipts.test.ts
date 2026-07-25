import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	emitFounderReplyDeliveryForThread,
	type FounderReplyDeliverDeps,
	type FounderReplyThreadCtx,
	type PendingQuestionForThread,
} from "../founder-reply-deliverer.js";
import { LeadInboxRuntime } from "../lead-inbox-runtime.js";
import type { LeadRuntime } from "../lead-runtime.js";
import { RuntimeRegistry } from "../runtime-registry.js";

const OWNER = "123456789012345678";
const DISCORD_EPOCH = 1_420_070_400_000;

function snowflakeAt(ms: number): string {
	return (BigInt(Math.floor(ms) - DISCORD_EPOCH) << 22n).toString();
}

function makeStore() {
	return {
		insertEvent: vi.fn(() => true),
		getEventsByExecution: vi.fn(() => []),
	} as unknown as FounderReplyDeliverDeps["store"];
}

describe("FLY-1392 founder receipt ingress", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;
	let queue: LeadInboxQueue;
	let cursor: InMemoryInboundCursorStore;
	let ctx: FounderReplyThreadCtx;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1392-ingress-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		queue = new LeadInboxQueue(dbPath);
		cursor = new InMemoryInboundCursorStore();
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
		vi.restoreAllMocks();
	});

	function deps(
		messages: Array<Record<string, unknown>>,
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
		} as FounderReplyDeliverDeps;
	}

	function leadOnlyDeps(
		messages: Array<Record<string, unknown>>,
	): FounderReplyDeliverDeps & {
		deliverAmbiguousToLead: ReturnType<typeof vi.fn>;
	} {
		const deliverAmbiguousToLead = vi.fn(async () => true);
		return {
			...deps(messages),
			deliverAmbiguousToLead,
		};
	}

	it("bootstraps an empty-pending thread at the current Discord head without replay", async () => {
		const old = snowflakeAt(Date.now() - 60_000);
		const d = deps([
			{ id: old, content: "old history", author: { id: OWNER } },
		]);
		const outcome = await emitFounderReplyDeliveryForThread(ctx, [], d);

		expect(outcome.result).toBe("noop");
		expect(cursor.load(ctx.threadId)).toBe(old);
		expect(d.fetchImpl).toHaveBeenCalledWith(
			expect.stringMatching(/messages\?limit=1$/),
			expect.anything(),
		);
		expect(queue.getById(`founder_msg:lead-a:${old}`)).toBeUndefined();
	});

	it("records one canonical queue row and leaves even an ACK open until Lead handles it", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		const msgId = snowflakeAt(Date.now() - 30_000);
		const outcome = await emitFounderReplyDeliveryForThread(
			ctx,
			[],
			deps([{ id: msgId, content: "好的", author: { id: OWNER } }]),
		);

		expect(outcome.result).toBe("advanced");
		const root = queue.getById(`founder_msg:lead-a:${msgId}`);
		expect(root).toMatchObject({
			msg_class: "model",
			delivered_at: null,
			consumed_at: null,
			disposition: null,
			processed_at: null,
			processed_evidence: null,
			routing_state: "hub_recorded",
			next_unprocessed_at: null,
		});
		expect(queue.countPending("lead-a")).toBe(1);
	});

	it("uses a real RuntimeRegistry doorbell to deliver exactly one founder receipt row", async () => {
		const lead = {
			agentId: "lead-a",
			chatChannel: "chat-a",
			match: { labels: ["Engineering"] },
		};
		const projects: ProjectEntry[] = [
			{
				projectName: "flywheel",
				projectRoot: dir,
				leads: [lead],
			},
		];
		const registry = new RuntimeRegistry();
		registry.register(lead, {
			type: "test",
			deliver: vi.fn(),
			renderEnvelope: () => "unused audit rendering",
			sendBootstrap: vi.fn(),
			health: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as LeadRuntime);
		const delivered = vi.fn(async (batch) => ({
			batchId: batch.batchId,
			memberIds: batch.members.map(
				(member: { deliveryId: string }) => member.deliveryId,
			),
			status: "accepted_new" as const,
		}));
		const runtime = new LeadInboxRuntime({
			projects,
			store: {
				getActiveSessions: () => [],
				markLeadEventDelivered: vi.fn(),
			} as never,
			registry,
			commDbPathForProject: () => dbPath,
			ownerEpoch: "epoch-live",
			adapterForLead: () => ({ deliverBatch: delivered }),
			runLegacyCutover: vi.fn(async () => undefined),
		});
		registry.setLeadInboxNudge((leadId, projectName) =>
			runtime.nudge(leadId, projectName),
		);
		runtime.start();
		try {
			cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
			const msgId = snowflakeAt(Date.now() - 30_000);
			const d = deps([
				{ id: msgId, content: "只交给 Lead", author: { id: OWNER } },
			]);
			d.deliverAmbiguousToLead = vi.fn(async () =>
				registry.nudgeLeadInbox("lead-a", "flywheel"),
			);

			expect((await emitFounderReplyDeliveryForThread(ctx, [], d)).result).toBe(
				"advanced",
			);
			await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
			const batch = delivered.mock.calls[0]?.[0];
			expect(batch.members.map(({ deliveryId }) => deliveryId)).toEqual([
				`founder_msg:lead-a:${msgId}`,
			]);
			expect(batch.modelPayload).toContain(
				`[receipt:founder_msg:lead-a:${msgId}]`,
			);
			const raw = new Database(dbPath, { readonly: true });
			const rows = raw
				.prepare(
					`SELECT * FROM lead_inbox
					  WHERE ref_message_id = ? OR family_root_id = ?`,
				)
				.all(msgId, `founder_msg:lead-a:${msgId}`) as Array<{
				id: string;
				delivered_at: string | null;
				processed_at: string | null;
			}>;
			raw.close();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				id: `founder_msg:lead-a:${msgId}`,
				delivered_at: expect.any(String),
				processed_at: null,
			});
		} finally {
			runtime.close();
		}
	});

	it("keeps Bridge as a pure founder-to-Lead conveyor when receipt chasing is disabled", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		const msgId = snowflakeAt(Date.now() - 30_000);
		const d = leadOnlyDeps([
			{
				id: msgId,
				content: "flag off still goes to Lead",
				author: { id: OWNER },
			},
		]);

		const outcome = await emitFounderReplyDeliveryForThread(ctx, [], d);

		expect(outcome.result).toBe("advanced");
		expect(d.deliverAmbiguousToLead).toHaveBeenCalledTimes(1);
		expect(queue.getById(`founder_msg:lead-a:${msgId}`)).toMatchObject({
			msg_class: "model",
			processed_at: null,
			next_unprocessed_at: null,
		});
	});

	it("F-5 sends the untouched founder message only to Lead and waits for Lead relay", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1392", "lead-a");
		const questionId = db.insertQuestion("exec-a", "lead-a", "continue?");
		const msgId = snowflakeAt(Date.now() - 30_000);
		const q: PendingQuestionForThread = {
			questionId,
			checkpoint: "brainstorm",
			executionId: "exec-a",
			createdAtMs: Date.now() - 60_000,
			checkpointGraceMs: 0,
		};
		const d = leadOnlyDeps([
			{ id: msgId, content: "继续", author: { id: OWNER } },
		]);

		const outcome = await emitFounderReplyDeliveryForThread(ctx, [q], d);

		expect(outcome.result).toBe("advanced");
		expect(d.deliverAmbiguousToLead).toHaveBeenCalledWith(
			`founder-reply-${ctx.threadId}-${msgId}`,
			{
				issueId: "FLY-1392",
				threadId: "thread-1",
				msgId,
				answer: "继续",
				commDbPath: dbPath,
			},
		);
		expect(db.getResponse(questionId)).toBeUndefined();
		expect(db.listRunnerPhaseWakes("exec-a")).toEqual([]);
		expect(queue.getById(`founder_msg:lead-a:${msgId}`)).toMatchObject({
			msg_class: "model",
			delivered_at: null,
			processed_at: null,
			processed_evidence: null,
			routing_state: "hub_recorded",
			next_unprocessed_at: null,
		});
		expect(queue.getById(`founder_route:lead-a:${msgId}`)).toBeUndefined();

		const handled = db.routeFounderReply({
			msgId,
			leadId: "lead-a",
			toQuestionId: questionId,
			now: new Date().toISOString(),
			provenance: { senderGeneration: 12 },
			intentKey: `founder-route:lead-a:${msgId}:${questionId}`,
			envelope: {
				id: `founder-route-wake:lead-a:${msgId}:${questionId}`,
				to: "exec-a",
				content: "founder reply routed",
				metadata: { msgId, questionId },
			},
			queuedAtMs: Date.now(),
		});
		expect(handled.kind).toBe("routed");
		expect(db.getResponse(questionId)).toMatchObject({
			from_agent: "lead-a",
			content: "继续",
		});
		const processed = queue.getById(`founder_msg:lead-a:${msgId}`);
		expect(processed).toMatchObject({
			processed_at: expect.any(String),
			routing_state: "bound",
			next_unprocessed_at: null,
		});
		expect(JSON.parse(processed?.processed_evidence ?? "null")).toMatchObject({
			kind: "lead_routed",
			actor: "lead-a",
			actor_kind: "lead",
			fence: { lease_generation: 12 },
			basis: [`question:${questionId}`],
		});
		expect(db.listRunnerPhaseWakes("exec-a")).toHaveLength(1);
	});

	it("F-2 forwards a reply-to-card to Lead without running card attribution", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1392", "lead-a");
		const questionId = db.insertQuestion("exec-a", "lead-a", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const msgId = snowflakeAt(Date.now() - 30_000);
		const q: PendingQuestionForThread = {
			questionId,
			checkpoint: "approve_to_ship",
			executionId: "exec-a",
			createdAtMs: Date.now() - 60_000,
			checkpointGraceMs: 0,
		};
		const d = leadOnlyDeps([
			{
				id: msgId,
				content: "可以",
				type: 19,
				author: { id: OWNER },
				message_reference: {
					type: 0,
					channel_id: ctx.threadId,
					message_id: "gate-card-1",
				},
			},
		]);
		await emitFounderReplyDeliveryForThread(ctx, [q], d);

		expect(d.deliverAmbiguousToLead).toHaveBeenCalledTimes(1);
		expect(db.getResponse(questionId)).toBeUndefined();
		expect(queue.getById(`founder_msg:lead-a:${msgId}`)).toMatchObject({
			processed_at: null,
			routing_state: "hub_recorded",
		});
	});

	it("F-3 forwards a clear ship phrase to Lead without running the ship classifier", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1392", "lead-a");
		const questionId = db.insertQuestion("exec-a", "lead-a", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const msgId = snowflakeAt(Date.now() - 30_000);
		const q: PendingQuestionForThread = {
			questionId,
			checkpoint: "approve_to_ship",
			executionId: "exec-a",
			createdAtMs: Date.now() - 60_000,
			checkpointGraceMs: 0,
		};
		const d = leadOnlyDeps([
			{ id: msgId, content: "ship it", author: { id: OWNER } },
		]);
		await emitFounderReplyDeliveryForThread(ctx, [q], d);

		expect(d.deliverAmbiguousToLead).toHaveBeenCalledTimes(1);
		expect(db.getResponse(questionId)).toBeUndefined();
		expect(queue.getById(`founder_msg:lead-a:${msgId}`)).toMatchObject({
			processed_at: null,
			routing_state: "hub_recorded",
		});
	});

	it("FLY-1448 binds a founder ship decision only after the canonical receipt root exists", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1448", "lead-a");
		const questionId = db.insertQuestion("exec-a", "lead-a", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const msgId = snowflakeAt(Date.now() - 30_000);
		const q: PendingQuestionForThread = {
			questionId,
			checkpoint: "approve_to_ship",
			executionId: "exec-a",
			createdAtMs: Date.now() - 60_000,
			checkpointGraceMs: 0,
		};
		const d = leadOnlyDeps([
			{
				id: msgId,
				content: '{"approved": true}',
				author: { id: OWNER },
			},
		]);
		const tryFounderShipApproval = vi.fn(async (args) => {
			const rootId = `founder_msg:lead-a:${msgId}`;
			expect(queue.getById(rootId)).toBeDefined();
			expect(args).toMatchObject({
				msg: {
					id: msgId,
					content: '{"approved": true}',
					authorId: OWNER,
				},
				shipGates: [{ questionId, executionId: "exec-a" }],
				founderReceipt: {
					rootId,
					msgId,
					intentKey: `founder-route:lead-a:${msgId}:${questionId}`,
					envelope: {
						to: "exec-a",
						metadata: {
							origin: "founder",
							msgId,
							questionId,
						},
					},
				},
			});
			expect(
				db.insertResponse(questionId, OWNER, '{"approved": true}'),
			).toEqual({ written: true });
			const responseId = db.getResponse(questionId)?.id;
			expect(responseId).toBeTruthy();
			queue.markProcessed(rootId, {
				now: new Date().toISOString(),
				evidence: {
					v: 1,
					kind: "ship_gate_bound",
					ref: responseId!,
					actor: OWNER,
					actor_kind: "founder-writer",
					fence: { discord_message_id: msgId },
					basis: [`question:${questionId}`],
				},
			});
			return {
				bound: [{ questionId, decision: "approve" as const }],
				deferred: [],
				retry: false,
			};
		});

		const outcome = await emitFounderReplyDeliveryForThread(ctx, [q], {
			...d,
			tryFounderShipApproval,
		} as FounderReplyDeliverDeps);

		expect(outcome.result).toBe("advanced");
		expect(tryFounderShipApproval).toHaveBeenCalledOnce();
		expect(d.deliverAmbiguousToLead).not.toHaveBeenCalled();
		expect(queue.getById(`founder_msg:lead-a:${msgId}`)).toMatchObject({
			processed_at: expect.any(String),
			routing_state: "bound",
		});
	});

	it("FLY-1448 closes an open receipt when the exact ship decision was already applied", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1448", "lead-a");
		const questionId = db.insertQuestion("exec-a", "lead-a", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const msgId = snowflakeAt(Date.now() - 30_000);
		const q: PendingQuestionForThread = {
			questionId,
			checkpoint: "approve_to_ship",
			executionId: "exec-a",
			createdAtMs: Date.now() - 60_000,
			checkpointGraceMs: 0,
		};
		const d = leadOnlyDeps([
			{
				id: msgId,
				content: '{"approved": true}',
				author: { id: OWNER },
			},
		]);

		const outcome = await emitFounderReplyDeliveryForThread(ctx, [q], {
			...d,
			tryFounderShipApproval: vi.fn(async () => ({
				bound: [{ questionId, decision: "approve" as const }],
				deferred: [],
				retry: false,
			})),
		} as FounderReplyDeliverDeps);

		expect(outcome.result).toBe("advanced");
		expect(d.deliverAmbiguousToLead).not.toHaveBeenCalled();
		const root = queue.getById(`founder_msg:lead-a:${msgId}`);
		expect(root).toMatchObject({
			processed_at: expect.any(String),
			routing_state: "bound",
		});
		expect(JSON.parse(root?.processed_evidence ?? "{}")).toMatchObject({
			kind: "already_applied",
			ref: questionId,
			actor: OWNER,
			actor_kind: "founder-writer",
			fence: { discord_message_id: msgId },
			basis: [`question:${questionId}`],
		});
	});

	it("FLY-1448 records a durably deferred founder decision as terminal receipt evidence", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1448", "lead-a");
		const questionId = db.insertQuestion("exec-a", "lead-a", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const msgId = snowflakeAt(Date.now() - 30_000);
		const q: PendingQuestionForThread = {
			questionId,
			checkpoint: "approve_to_ship",
			executionId: "exec-a",
			createdAtMs: Date.now() - 60_000,
			checkpointGraceMs: 0,
		};
		const d = leadOnlyDeps([
			{ id: msgId, content: "ship it", author: { id: OWNER } },
		]);

		const outcome = await emitFounderReplyDeliveryForThread(ctx, [q], {
			...d,
			tryFounderShipApproval: vi.fn(async () => ({
				bound: [],
				deferred: [{ questionId, decision: "approve" as const }],
				retry: false,
			})),
		} as FounderReplyDeliverDeps);

		expect(outcome.result).toBe("advanced");
		expect(d.deliverAmbiguousToLead).not.toHaveBeenCalled();
		const root = queue.getById(`founder_msg:lead-a:${msgId}`);
		expect(JSON.parse(root?.processed_evidence ?? "{}")).toMatchObject({
			kind: "deferred_founder_decision",
			ref: questionId,
			fence: { discord_message_id: msgId },
		});
	});

	it("FLY-1448 dead-letters an unreachable post-write failure before advancing the cursor", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1448", "lead-a");
		const questionId = db.insertQuestion("exec-a", "lead-a", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const msgId = snowflakeAt(Date.now() - 30_000);
		const q: PendingQuestionForThread = {
			questionId,
			checkpoint: "approve_to_ship",
			executionId: "exec-a",
			createdAtMs: Date.now() - 60_000,
			checkpointGraceMs: 0,
		};
		const d = leadOnlyDeps([
			{ id: msgId, content: "ship it", author: { id: OWNER } },
		]);
		const deadLetterNow = vi.fn(() => ({ deadLettered: true }));

		const outcome = await emitFounderReplyDeliveryForThread(ctx, [q], {
			...d,
			tryFounderShipApproval: vi.fn(async () => ({
				bound: [],
				deferred: [],
				retry: false,
				deadLetter: {
					questionId,
					stage: "convergence_park_failed",
					reason: "response durable but convergence anchors failed",
				},
			})),
			retryLedger: {
				recordFailure: vi.fn(() => ({ deadLettered: false })),
				deadLetterNow,
				isDeadLettered: vi.fn(() => false),
				clear: vi.fn(),
				clearUpTo: vi.fn(),
			},
		} as FounderReplyDeliverDeps);

		expect(outcome.result).toBe("advanced");
		expect(deadLetterNow).toHaveBeenCalledWith(
			expect.objectContaining({
				msgId,
				executionId: "exec-a",
				stage: "convergence_park_failed",
			}),
		);
		expect(d.deliverAmbiguousToLead).not.toHaveBeenCalled();
		const root = queue.getById(`founder_msg:lead-a:${msgId}`);
		expect(JSON.parse(root?.processed_evidence ?? "{}")).toMatchObject({
			kind: "dead_lettered",
			ref: questionId,
			fence: { discord_message_id: msgId },
		});
	});

	it("FLY-1448 repairs an open canonical root before skipping an already dead-lettered message", async () => {
		const before = snowflakeAt(Date.now() - 120_000);
		cursor.save(ctx.threadId, before);
		const msgId = snowflakeAt(Date.now() - 30_000);
		const rootId = `founder_msg:lead-a:${msgId}`;
		db.enqueueFounderHubRoot({
			id: rootId,
			toLead: "lead-a",
			content: JSON.stringify({
				v: 1,
				receiptId: rootId,
				msgId,
				answer: "ship it",
				projectName: "flywheel",
				issueId: "FLY-1448",
				threadId: ctx.threadId,
				isReply: false,
			}),
			refMessageId: msgId,
			now: new Date().toISOString(),
			routingState: "hub_recorded",
		});
		const d = leadOnlyDeps([
			{ id: msgId, content: "ship it", author: { id: OWNER } },
		]);

		const outcome = await emitFounderReplyDeliveryForThread(ctx, [], {
			...d,
			retryLedger: {
				recordFailure: vi.fn(() => ({ deadLettered: false })),
				deadLetterNow: vi.fn(() => ({ deadLettered: true })),
				isDeadLettered: vi.fn(() => true),
				clear: vi.fn(),
				clearUpTo: vi.fn(),
			},
		});

		expect(outcome.result).toBe("advanced");
		expect(cursor.load(ctx.threadId)).toBe(msgId);
		expect(d.deliverAmbiguousToLead).not.toHaveBeenCalled();
		const root = queue.getById(rootId);
		expect(root).toMatchObject({
			processed_at: expect.any(String),
			routing_state: "bound",
		});
		expect(JSON.parse(root?.processed_evidence ?? "{}")).toMatchObject({
			kind: "dead_lettered",
			ref: msgId,
		});
	});

	it("FLY-1448 accepts a valid bound root when replaying a post-write dead letter", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1448", "lead-a");
		const questionId = db.insertQuestion("exec-a", "lead-a", "ship?", {
			checkpoint: "approve_to_ship",
		});
		expect(db.insertResponse(questionId, OWNER, "ship it")).toEqual({
			written: true,
		});
		const responseId = db.getResponse(questionId)?.id;
		expect(responseId).toBeTruthy();
		const msgId = snowflakeAt(Date.now() - 30_000);
		const rootId = `founder_msg:lead-a:${msgId}`;
		db.enqueueFounderHubRoot({
			id: rootId,
			toLead: "lead-a",
			content: JSON.stringify({
				v: 1,
				receiptId: rootId,
				msgId,
				answer: "ship it",
				projectName: "flywheel",
				issueId: "FLY-1448",
				threadId: ctx.threadId,
				isReply: false,
			}),
			refMessageId: msgId,
			now: new Date().toISOString(),
			routingState: "awaiting_rebind",
		});
		queue.markProcessed(rootId, {
			now: new Date().toISOString(),
			evidence: {
				v: 1,
				kind: "ship_gate_bound",
				ref: responseId!,
				actor: OWNER,
				actor_kind: "founder-writer",
				fence: { discord_message_id: msgId },
				basis: [`question:${questionId}`],
			},
		});
		const d = leadOnlyDeps([
			{ id: msgId, content: "ship it", author: { id: OWNER } },
		]);

		const outcome = await emitFounderReplyDeliveryForThread(ctx, [], {
			...d,
			retryLedger: {
				recordFailure: vi.fn(() => ({ deadLettered: false })),
				deadLetterNow: vi.fn(() => ({ deadLettered: true })),
				isDeadLettered: vi.fn(() => true),
				clear: vi.fn(),
				clearUpTo: vi.fn(),
			},
		});

		expect(outcome.result).toBe("advanced");
		expect(cursor.load(ctx.threadId)).toBe(msgId);
		expect(queue.getById(rootId)).toMatchObject({
			routing_state: "bound",
			processed_evidence: expect.stringContaining("ship_gate_bound"),
		});
	});

	it("FLY-1448 narrows a verified Discord reply to the exact bound ship card", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		db.registerSession("exec-a", "runner-a", "flywheel", "FLY-1448", "lead-a");
		db.registerSession("exec-b", "runner-b", "flywheel", "FLY-1448", "lead-a");
		const questionA = db.insertQuestion("exec-a", "lead-a", "ship A?", {
			checkpoint: "approve_to_ship",
		});
		const questionB = db.insertQuestion("exec-b", "lead-a", "ship B?", {
			checkpoint: "approve_to_ship",
		});
		const msgId = snowflakeAt(Date.now() - 30_000);
		const questions: PendingQuestionForThread[] = [
			{
				questionId: questionA,
				checkpoint: "approve_to_ship",
				executionId: "exec-a",
				createdAtMs: Date.now() - 60_000,
				checkpointGraceMs: 0,
			},
			{
				questionId: questionB,
				checkpoint: "approve_to_ship",
				executionId: "exec-b",
				createdAtMs: Date.now() - 60_000,
				checkpointGraceMs: 0,
			},
		];
		const d = leadOnlyDeps([
			{
				id: msgId,
				content: "okay",
				type: 19,
				author: { id: OWNER },
				message_reference: {
					type: 0,
					channel_id: ctx.threadId,
					message_id: "gate-card-b",
				},
			},
		]);
		d.store = {
			...makeStore(),
			getSession: vi.fn((executionId: string) => ({
				pr_head_sha: executionId === "exec-a" ? "head-a" : "head-b",
			})),
		} as unknown as FounderReplyDeliverDeps["store"];
		const tryFounderShipApproval = vi.fn(async (args) => ({
			bound: [
				{
					questionId: args.shipGates[0]?.questionId ?? "",
					decision: "approve" as const,
				},
			],
			deferred: [],
			retry: false,
		}));

		const outcome = await emitFounderReplyDeliveryForThread(ctx, questions, {
			...d,
			readCurrentBinding: vi.fn((_executionId: string, questionId: string) =>
				questionId === questionB
					? { gateMessageId: "gate-card-b" }
					: { gateMessageId: "gate-card-a" },
			),
			tryFounderShipApproval,
		} as FounderReplyDeliverDeps);

		expect(outcome.result).toBe("advanced");
		expect(tryFounderShipApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				shipGates: [expect.objectContaining({ questionId: questionB })],
				replyToCard: true,
				founderReceipt: expect.objectContaining({
					intentKey: `founder-route:lead-a:${msgId}:${questionB}`,
					envelope: expect.objectContaining({ to: "exec-b" }),
				}),
			}),
		);
		expect(d.deliverAmbiguousToLead).not.toHaveBeenCalled();
	});

	it("preserves the full founder text in both the Lead handoff and receipt root", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		const msgId = snowflakeAt(Date.now() - 30_000);
		const fullText = `start-${"x".repeat(1_200)}-end`;
		const d = leadOnlyDeps([
			{ id: msgId, content: fullText, author: { id: OWNER } },
		]);

		await emitFounderReplyDeliveryForThread(ctx, [], d);

		expect(d.deliverAmbiguousToLead).toHaveBeenCalledWith(
			`founder-reply-${ctx.threadId}-${msgId}`,
			expect.objectContaining({ answer: fullText }),
		);
		expect(
			JSON.parse(queue.getById(`founder_msg:lead-a:${msgId}`)?.content ?? "{}"),
		).toMatchObject({
			receiptId: `founder_msg:lead-a:${msgId}`,
			answer: fullText,
		});
	});

	it("forwards a fresh founder message immediately instead of waiting for attribution grace", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		ctx.graceMs = 10 * 60_000;
		const msgId = snowflakeAt(Date.now() - 1_000);
		const d = leadOnlyDeps([
			{ id: msgId, content: "fresh", author: { id: OWNER } },
		]);

		const outcome = await emitFounderReplyDeliveryForThread(ctx, [], d);

		expect(outcome.result).toBe("advanced");
		expect(d.deliverAmbiguousToLead).toHaveBeenCalledTimes(1);
		expect(cursor.load(ctx.threadId)).toBe(msgId);
	});

	it.each(["帮我把这个也改了", "等下先别 ship", "🛑", "🚢", "❌"])(
		"forwards fixture %s unchanged without creating a Bridge route",
		async (content) => {
			cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
			const msgId = snowflakeAt(Date.now() - 30_000);
			const d = deps([{ id: msgId, content, author: { id: OWNER } }]);
			await emitFounderReplyDeliveryForThread(ctx, [], d);

			const root = queue.getById(`founder_msg:lead-a:${msgId}`);
			const route = queue.getById(`founder_route:lead-a:${msgId}`);
			expect(root).toMatchObject({
				processed_at: null,
				next_unprocessed_at: null,
				routing_state: "hub_recorded",
			});
			expect(route).toBeUndefined();
			expect(d.deliverAmbiguousToLead).toHaveBeenCalledWith(
				`founder-reply-${ctx.threadId}-${msgId}`,
				expect.objectContaining({ answer: content }),
			);
		},
	);

	it("never answers one non-ship question before Lead relays it", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1392", "lead-a");
		const questionId = db.insertQuestion("exec-a", "lead-a", "continue?");
		const msgId = snowflakeAt(Date.now() - 30_000);
		const q: PendingQuestionForThread = {
			questionId,
			checkpoint: "brainstorm",
			executionId: "exec-a",
			createdAtMs: Date.now() - 60_000,
			checkpointGraceMs: 0,
		};
		await emitFounderReplyDeliveryForThread(
			ctx,
			[q],
			deps([{ id: msgId, content: "继续", author: { id: OWNER } }]),
		);

		expect(db.getResponse(questionId)).toBeUndefined();
		expect(queue.getById(`founder_msg:lead-a:${msgId}`)).toMatchObject({
			processed_at: null,
			routing_state: "hub_recorded",
		});
		expect(db.listRunnerPhaseWakes("exec-a")).toEqual([]);
	});

	it("forwards an unclear ship message to Lead without classifier or runner wake", async () => {
		cursor.save(ctx.threadId, snowflakeAt(Date.now() - 120_000));
		db.registerSession("exec-a", "runner", "flywheel", "FLY-1392", "lead-a");
		const questionId = db.insertQuestion("exec-a", "lead-a", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const msgId = snowflakeAt(Date.now() - 30_000);
		const q: PendingQuestionForThread = {
			questionId,
			checkpoint: "approve_to_ship",
			executionId: "exec-a",
			createdAtMs: Date.now() - 60_000,
			checkpointGraceMs: 0,
		};
		const d = deps([{ id: msgId, content: "🤔", author: { id: OWNER } }]);

		await emitFounderReplyDeliveryForThread(ctx, [q], d);

		expect(queue.getById(`founder_msg:lead-a:${msgId}`)).toMatchObject({
			processed_at: null,
			routing_state: "hub_recorded",
			next_unprocessed_at: null,
		});
		expect(d.deliverAmbiguousToLead).toHaveBeenCalledTimes(1);
	});
});
