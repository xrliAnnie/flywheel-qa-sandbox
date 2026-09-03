import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeGateMessageBinding } from "../bridge/approval-signal/gate-message-binding-store.js";
import {
	voidedWorkflowGateCardText,
	voidSupersededWorkflowGateCards,
	watchVoidedWorkflowGateCards,
} from "../bridge/workflow-gate-card-lifecycle.js";
import { StateStore } from "../StateStore.js";

const HEAD_1 = "a".repeat(40);
const HEAD_2 = "b".repeat(40);
const stores: StateStore[] = [];

function allDeliveryAttempts(
	store: StateStore,
): ReturnType<StateStore["listLiveWorkflowDeliveryAttempts"]> {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw
		.prepare("SELECT * FROM workflow_delivery_attempt")
		.all() as ReturnType<StateStore["listLiveWorkflowDeliveryAttempts"]>;
}

async function createStore(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1772",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	return store;
}

function materializeCard(store: StateStore, questionId: string): void {
	for (const stage of [
		"question_written",
		"session_bound",
		"card_posted",
		"card_bound",
		"completed",
	] as const) {
		const result = store.advanceWorkflowGateHolderMaterialization({
			questionId,
			stage,
			...(stage === "card_posted" ? { cardMessageId: "card-1" } : {}),
			now: "2026-08-14T20:01:00.000Z",
		});
		expect(result.ok).toBe(true);
	}
}

function supersededPostedCard(store: StateStore): void {
	store.ensureWorkflowGateHolder({
		runId: "run-1",
		gateNodeId: "founder_gate",
		attempt: 1,
		headSha: HEAD_1,
		sourceExecutionId: "implement-1",
		questionId: "question-1",
		now: "2026-08-14T20:00:00.000Z",
	});
	materializeCard(store, "question-1");
	store.ensureWorkflowGateHolder({
		runId: "run-1",
		gateNodeId: "founder_gate",
		attempt: 2,
		headSha: HEAD_2,
		sourceExecutionId: "implement-2",
		questionId: "question-2",
		now: "2026-08-14T20:02:00.000Z",
	});
}

function approvedSupersededPostedCard(store: StateStore): void {
	store.ensureWorkflowGateHolder({
		runId: "run-1",
		gateNodeId: "founder_gate",
		attempt: 1,
		headSha: HEAD_1,
		sourceExecutionId: "implement-1",
		questionId: "question-1",
		now: "2026-08-14T20:00:00.000Z",
	});
	materializeCard(store, "question-1");
	(
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db.run(
		"UPDATE workflow_gate_holder SET state = 'approved' WHERE question_id = ?",
		["question-1"],
	);
	store.ensureWorkflowGateHolder({
		runId: "run-1",
		gateNodeId: "founder_gate",
		attempt: 2,
		headSha: HEAD_2,
		sourceExecutionId: "implement-2",
		questionId: "question-2",
		now: "2026-08-14T20:02:00.000Z",
	});
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

it("projects gate-holder materialization clocks and settlement exactly once", async () => {
	const store = await createStore();
	store.ensureWorkflowGateHolder({
		runId: "run-1",
		gateNodeId: "approval",
		attempt: 1,
		headSha: HEAD_1,
		sourceExecutionId: "producer-1",
		questionId: "question-clock",
		now: "2026-08-14T20:00:00.000Z",
	});
	for (const [stage, now] of [
		["question_written", "2026-08-14T20:01:00.000Z"],
		["session_bound", "2026-08-14T20:02:00.000Z"],
		["card_posted", "2026-08-14T20:03:00.000Z"],
		["card_bound", "2026-08-14T20:04:00.000Z"],
		["completed", "2026-08-14T20:05:00.000Z"],
	] as const) {
		expect(
			store.advanceWorkflowGateHolderMaterialization({
				questionId: "question-clock",
				stage,
				...(stage === "card_posted" ? { cardMessageId: "card-clock" } : {}),
				now,
			}),
		).toMatchObject({ ok: true });
	}
	const attempt = allDeliveryAttempts(store).find(
		(row) =>
			row.family === "gate_holder" &&
			JSON.parse(row.contract_ref_json).pk === "question-clock",
	);
	expect(attempt).toMatchObject({
		minted_at: "2026-08-14T20:00:00.000Z",
		granted_at: "2026-08-14T20:01:00.000Z",
		sent_at: "2026-08-14T20:02:00.000Z",
		received_at: "2026-08-14T20:04:00.000Z",
		settlement_reason: "settled",
	});
});

describe("workflow gate card lifecycle", () => {
	it("explains equivalent head carryover without asking founder to approve a nonexistent card", async () => {
		const store = await createStore();
		approvedSupersededPostedCard(store);
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_gate_holder SET superseded_reason = 'head_refresh_equivalent' WHERE question_id = ?",
			["question-1"],
		);
		const holder = store.getWorkflowGateHolderByQuestionId("question-1");
		if (!holder) throw new Error("holder missing");

		const text = voidedWorkflowGateCardText({
			holder,
			issueId: "FLY-1772",
		});
		expect(text).toContain("内容等价");
		expect(text).toContain("无需再次批准");
		expect(text).not.toContain("新的 ship 卡");
	});

	it("explains that land conflict rework must pass QA and founder approval again", async () => {
		const store = await createStore();
		approvedSupersededPostedCard(store);
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_gate_holder SET superseded_reason = 'land_rework' WHERE question_id = ?",
			["question-1"],
		);
		const holder = store.getWorkflowGateHolderByQuestionId("question-1");
		if (!holder) throw new Error("holder missing");

		const text = voidedWorkflowGateCardText({
			holder,
			issueId: "FLY-1833",
		});
		expect(text).toContain("冲突返工");
		expect(text).toContain("QA");
		expect(text).toContain("重新批准");
	});

	it("records the pre-supersede state and schedules a posted card for voiding", async () => {
		const store = await createStore();
		store.ensureWorkflowGateHolder({
			runId: "run-1",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: HEAD_1,
			sourceExecutionId: "implement-1",
			questionId: "question-1",
			now: "2026-08-14T20:00:00.000Z",
		});
		materializeCard(store, "question-1");

		store.ensureWorkflowGateHolder({
			runId: "run-1",
			gateNodeId: "founder_gate",
			attempt: 2,
			headSha: HEAD_2,
			sourceExecutionId: "implement-2",
			questionId: "question-2",
			now: "2026-08-14T20:02:00.000Z",
		});

		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				state: "superseded",
				superseded_reason: "new_gate_attempt",
				superseded_from_state: "awaiting_review",
				card_void_state: "pending",
				card_void_attempts: 0,
			},
		);
	});

	it("keeps card void state empty when a superseded holder never posted a card", async () => {
		const store = await createStore();
		store.ensureWorkflowGateHolder({
			runId: "run-1",
			gateNodeId: "founder_gate",
			attempt: 1,
			headSha: HEAD_1,
			sourceExecutionId: "implement-1",
			questionId: "question-1",
			now: "2026-08-14T20:00:00.000Z",
		});
		store.ensureWorkflowGateHolder({
			runId: "run-1",
			gateNodeId: "founder_gate",
			attempt: 2,
			headSha: HEAD_2,
			sourceExecutionId: "implement-2",
			questionId: "question-2",
			now: "2026-08-14T20:02:00.000Z",
		});

		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				state: "superseded",
				superseded_from_state: "materializing",
				card_void_state: null,
			},
		);
	});

	it("still identifies an approved-origin superseded card so its replies cannot fall through", async () => {
		const store = await createStore();
		approvedSupersededPostedCard(store);

		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				state: "superseded",
				superseded_from_state: "approved",
			},
		);
		expect(
			store.getSupersededWorkflowGateHolderByCardMessageId("card-1"),
		).toMatchObject({
			question_id: "question-1",
			superseded_from_state: "approved",
		});
	});

	it("keeps every workflow_gate_holder supersede writer behind one helper", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../StateStore.ts", import.meta.url)),
			"utf8",
		);
		const directWriters = source.match(
			/UPDATE workflow_gate_holder[\s\S]{0,260}?state = 'superseded',/g,
		);
		expect(directWriters).toHaveLength(1);
	});

	it("edits an exactly-bound superseded card before opening its fixed watch window", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		writeGateMessageBinding(
			store,
			{
				questionId: "question-1",
				executionId: "implement-1",
				issueId: "FLY-1772",
				prHeadSha: HEAD_1,
				threadId: "thread-1",
				gateMessageId: "card-1",
				checkpoint: "approve_to_ship",
				postedAt: "2026-08-14T20:01:00.000Z",
			},
			"flywheel",
		);
		const edits: Array<{ threadId: string; messageId: string; text: string }> =
			[];
		await voidSupersededWorkflowGateCards({
			store,
			now: () => "2026-08-14T21:00:00.000Z",
			resolveDelivery: () => ({
				botToken: "lead-token",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
			editCard: async (input) => {
				edits.push(input);
				return { ok: true };
			},
		});

		expect(edits).toEqual([
			expect.objectContaining({
				threadId: "thread-1",
				messageId: "card-1",
				text: expect.stringContaining("⛔ 已作废(head 已换代)"),
			}),
		]);
		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				card_void_state: "done",
				card_void_attempts: 0,
				card_watch_next_at: "2026-08-14T21:00:00.000Z",
				card_watch_expires_at: "2026-08-16T21:00:00.000Z",
			},
		);
	});

	it("treats exact Discord 404 as voided and never watches the deleted card", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		writeGateMessageBinding(
			store,
			{
				questionId: "question-1",
				executionId: "implement-1",
				issueId: "FLY-1772",
				prHeadSha: HEAD_1,
				threadId: "thread-1",
				gateMessageId: "card-1",
				checkpoint: "approve_to_ship",
				postedAt: "2026-08-14T20:01:00.000Z",
			},
			"flywheel",
		);
		await voidSupersededWorkflowGateCards({
			store,
			now: () => "2026-08-14T21:00:00.000Z",
			resolveDelivery: () => ({
				botToken: "lead-token",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
			editCard: async () => ({ ok: false, status: 404, error: "gone" }),
		});

		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				card_void_state: "done",
				card_watch_next_at: "2026-08-14T21:00:00.000Z",
				card_watch_expires_at: "2026-08-14T21:00:00.000Z",
			},
		);
	});

	it("contains a card-void settlement failure inside its holder tick", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		writeGateMessageBinding(
			store,
			{
				questionId: "question-1",
				executionId: "implement-1",
				issueId: "FLY-1772",
				prHeadSha: HEAD_1,
				threadId: "thread-1",
				gateMessageId: "card-1",
				checkpoint: "approve_to_ship",
				postedAt: "2026-08-14T20:01:00.000Z",
			},
			"flywheel",
		);
		vi.spyOn(store, "advanceWorkflowGateCardVoid").mockImplementation(() => {
			throw new Error("sqlite_busy");
		});
		const log = vi.fn();

		await expect(
			voidSupersededWorkflowGateCards({
				store,
				now: () => "2026-08-14T21:00:00.000Z",
				resolveDelivery: () => ({
					botToken: "lead-token",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
				editCard: async () => ({ ok: true }),
				log,
			}),
		).resolves.toEqual({ attempted: 1, done: 0, failed: 1 });
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("settlement failed for question-1"),
		);
	});

	it("backs off a transient Discord failure without burning the void attempt budget", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		writeGateMessageBinding(
			store,
			{
				questionId: "question-1",
				executionId: "implement-1",
				issueId: "FLY-1772",
				prHeadSha: HEAD_1,
				threadId: "thread-1",
				gateMessageId: "card-1",
				checkpoint: "approve_to_ship",
				postedAt: "2026-08-14T20:01:00.000Z",
			},
			"flywheel",
		);
		const editCard = vi.fn(async () => ({
			ok: false as const,
			status: 429,
			error: "rate limited",
		}));

		await voidSupersededWorkflowGateCards({
			store,
			now: () => "2026-08-14T21:00:00.000Z",
			resolveDelivery: () => ({
				botToken: "lead-token",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
			editCard,
		});

		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				card_void_state: "pending",
				card_void_attempts: 0,
				card_void_transient_attempts: 1,
				card_void_next_at: "2026-08-14T21:01:00.000Z",
			},
		);
		const early = await voidSupersededWorkflowGateCards({
			store,
			now: () => "2026-08-14T21:00:30.000Z",
			resolveDelivery: () => ({
				botToken: "lead-token",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
			editCard,
		});
		expect(early.attempted).toBe(0);
		expect(editCard).toHaveBeenCalledOnce();
	});

	it("fails loud after bounded transient Discord retry windows", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		writeGateMessageBinding(
			store,
			{
				questionId: "question-1",
				executionId: "implement-1",
				issueId: "FLY-1772",
				prHeadSha: HEAD_1,
				threadId: "thread-1",
				gateMessageId: "card-1",
				checkpoint: "approve_to_ship",
				postedAt: "2026-08-14T20:01:00.000Z",
			},
			"flywheel",
		);

		for (
			let transientAttempt = 0;
			transientAttempt < 25;
			transientAttempt += 1
		) {
			const at = new Date(
				Date.parse("2026-08-14T21:00:00.000Z") + transientAttempt * 60_000,
			).toISOString();
			await voidSupersededWorkflowGateCards({
				store,
				now: () => at,
				resolveDelivery: () => ({
					botToken: "lead-token",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
				editCard: async () => ({
					ok: false,
					status: 503,
					error: "Discord unavailable",
				}),
			});
		}

		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				card_void_state: "failed",
				card_void_attempts: 5,
				card_void_transient_attempts: 0,
			},
		);
		expect(
			store.getWorkflowAlertOutbox("card_void_stuck:question-1"),
		).toMatchObject({ run_id: "run-1" });
	});

	it("bounds a hung card edit so the lifecycle tick releases", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		writeGateMessageBinding(
			store,
			{
				questionId: "question-1",
				executionId: "implement-1",
				issueId: "FLY-1772",
				prHeadSha: HEAD_1,
				threadId: "thread-1",
				gateMessageId: "card-1",
				checkpoint: "approve_to_ship",
				postedAt: "2026-08-14T20:01:00.000Z",
			},
			"flywheel",
		);

		const outcome = await Promise.race([
			voidSupersededWorkflowGateCards({
				store,
				now: () => "2026-08-14T21:00:00.000Z",
				requestTimeoutMs: 5,
				resolveDelivery: () => ({
					botToken: "lead-token",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
				editCard: async () => new Promise<never>(() => {}),
			}),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
		]);

		expect(outcome).toEqual({ attempted: 1, done: 0, failed: 1 });
		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				card_void_attempts: 0,
				card_void_transient_attempts: 1,
				card_void_next_at: "2026-08-14T21:01:00.000Z",
			},
		);
	});

	it("fails loud atomically after the fifth card-void failure", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			await voidSupersededWorkflowGateCards({
				store,
				now: () => `2026-08-14T21:0${attempt}:00.000Z`,
				resolveDelivery: () => ({
					botToken: "lead-token",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
				}),
				editCard: async () => ({ ok: true }),
			});
		}

		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				card_void_state: "failed",
				card_void_attempts: 5,
			},
		);
		expect(
			store.getWorkflowAlertOutbox("card_void_stuck:question-1"),
		).toMatchObject({
			run_id: "run-1",
			payload: expect.objectContaining({
				eventId: "card_void_stuck:question-1",
				metadata: {
					workflowEngine: expect.objectContaining({
						disposition: "card_void_stuck",
					}),
				},
			}),
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.filter((event) => event.kind === "gate_card_void_failed"),
		).toHaveLength(1);
	});

	it("keeps the resolved Lead identity when bot-token lookup cannot deliver the void", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		const deps = {
			store,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			}),
			resolveDelivery: () => undefined,
		};

		for (let attempt = 0; attempt < 5; attempt += 1) {
			await voidSupersededWorkflowGateCards({
				...deps,
				now: () => `2026-08-14T22:0${attempt}:00.000Z`,
			});
		}

		expect(
			store.getWorkflowAlertOutbox("card_void_stuck:question-1")?.payload,
		).toMatchObject({
			leadId: "flywheel-eng-lead",
			metadata: {
				workflowEngine: { leadResolution: "resolved" },
			},
		});
	});

	it("alerts the Lead once when the founder reacts on a voided card", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		writeGateMessageBinding(
			store,
			{
				questionId: "question-1",
				executionId: "implement-1",
				issueId: "FLY-1772",
				prHeadSha: HEAD_1,
				threadId: "thread-1",
				gateMessageId: "card-1",
				checkpoint: "approve_to_ship",
				postedAt: "2026-08-14T20:01:00.000Z",
			},
			"flywheel",
		);
		const delivery = () => ({
			botToken: "lead-token",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			},
		});
		await voidSupersededWorkflowGateCards({
			store,
			now: () => "2026-08-14T21:00:00.000Z",
			resolveDelivery: delivery,
			editCard: async () => ({ ok: true }),
		});
		const fetcher = vi.fn(async () => ({
			status: 200,
			body: [{ id: "founder-1" }],
		}));

		await watchVoidedWorkflowGateCards({
			store,
			founderId: "founder-1",
			now: () => "2026-08-14T21:00:00.001Z",
			resolveDelivery: delivery,
			makeReactionFetcher: () => fetcher,
		});

		expect(fetcher).toHaveBeenCalledWith({
			channelId: "thread-1",
			messageId: "card-1",
			emoji: "✅",
			after: undefined,
		});
		expect(
			store.getWorkflowAlertOutbox("voided_card_input:question-1"),
		).toMatchObject({
			run_id: "run-1",
			payload: {
				eventId: "voided_card_input:question-1",
				eventType: "workflow_engine_escalation",
				severity: "warning",
				metadata: {
					workflowEngine: expect.objectContaining({
						disposition: "voided_card_input",
					}),
				},
			},
		});
		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				card_watch_next_at: "2026-08-16T21:00:00.000Z",
				card_watch_expires_at: "2026-08-16T21:00:00.000Z",
			},
		);

		await watchVoidedWorkflowGateCards({
			store,
			founderId: "founder-1",
			now: () => "2026-08-14T21:10:00.000Z",
			resolveDelivery: delivery,
			makeReactionFetcher: () => fetcher,
		});
		expect(fetcher).toHaveBeenCalledOnce();
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(
			store.recordVoidedWorkflowGateInput({
				questionId: "question-1",
				alertIdentity: {
					leadId: "replacement-lead",
					projectName: "flywheel",
					leadResolution: "fallback",
				},
				now: "2026-08-14T21:11:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(
			store.getWorkflowAlertOutbox("voided_card_input:question-1")?.payload
				.leadId,
		).toBe("flywheel-eng-lead");
	});

	it("advances a no-reaction watch by an absolute ten minutes without extending expiry", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		writeGateMessageBinding(
			store,
			{
				questionId: "question-1",
				executionId: "implement-1",
				issueId: "FLY-1772",
				prHeadSha: HEAD_1,
				threadId: "thread-1",
				gateMessageId: "card-1",
				checkpoint: "approve_to_ship",
				postedAt: "2026-08-14T20:01:00.000Z",
			},
			"flywheel",
		);
		const delivery = () => ({
			botToken: "lead-token",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			},
		});
		await voidSupersededWorkflowGateCards({
			store,
			now: () => "2026-08-14T21:00:00.000Z",
			resolveDelivery: delivery,
			editCard: async () => ({ ok: true }),
		});
		await watchVoidedWorkflowGateCards({
			store,
			founderId: "founder-1",
			now: () => "2026-08-15T21:00:00.000Z",
			resolveDelivery: delivery,
			makeReactionFetcher: () => async () => ({ status: 200, body: [] }),
		});

		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				card_watch_next_at: "2026-08-15T21:10:00.000Z",
				card_watch_expires_at: "2026-08-16T21:00:00.000Z",
			},
		);
		expect(store.listWorkflowAlertOutbox()).toEqual([]);
	});

	it("bounds a hung reaction lookup and advances the watch retry window", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		writeGateMessageBinding(
			store,
			{
				questionId: "question-1",
				executionId: "implement-1",
				issueId: "FLY-1772",
				prHeadSha: HEAD_1,
				threadId: "thread-1",
				gateMessageId: "card-1",
				checkpoint: "approve_to_ship",
				postedAt: "2026-08-14T20:01:00.000Z",
			},
			"flywheel",
		);
		const delivery = () => ({
			botToken: "lead-token",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			},
		});
		await voidSupersededWorkflowGateCards({
			store,
			now: () => "2026-08-14T21:00:00.000Z",
			resolveDelivery: delivery,
			editCard: async () => ({ ok: true }),
		});

		const outcome = await Promise.race([
			watchVoidedWorkflowGateCards({
				store,
				founderId: "founder-1",
				now: () => "2026-08-14T21:00:00.001Z",
				requestTimeoutMs: 5,
				resolveDelivery: delivery,
				makeReactionFetcher: () => async () => new Promise<never>(() => {}),
			}),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
		]);

		expect(outcome).toEqual({ checked: 1, alerted: 0, failed: 1 });
		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				card_watch_next_at: "2026-08-14T21:10:00.001Z",
				card_watch_expires_at: "2026-08-16T21:00:00.000Z",
			},
		);
	});

	it("stops watching an impossible alert UID conflict instead of hot-looping", async () => {
		const store = await createStore();
		supersededPostedCard(store);
		writeGateMessageBinding(
			store,
			{
				questionId: "question-1",
				executionId: "implement-1",
				issueId: "FLY-1772",
				prHeadSha: HEAD_1,
				threadId: "thread-1",
				gateMessageId: "card-1",
				checkpoint: "approve_to_ship",
				postedAt: "2026-08-14T20:01:00.000Z",
			},
			"flywheel",
		);
		const delivery = () => ({
			botToken: "lead-token",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			},
		});
		await voidSupersededWorkflowGateCards({
			store,
			now: () => "2026-08-14T21:00:00.000Z",
			resolveDelivery: delivery,
			editCard: async () => ({ ok: true }),
		});
		vi.spyOn(store, "getWorkflowAlertOutbox").mockReturnValue({
			run_id: "different-run",
		} as ReturnType<StateStore["getWorkflowAlertOutbox"]>);

		const result = await watchVoidedWorkflowGateCards({
			store,
			founderId: "founder-1",
			now: () => "2026-08-14T21:00:00.001Z",
			resolveDelivery: delivery,
		});

		expect(result).toEqual({ checked: 0, alerted: 0, failed: 1 });
		expect(store.getWorkflowGateHolderByQuestionId("question-1")).toMatchObject(
			{
				card_watch_next_at: "2026-08-16T21:00:00.000Z",
				card_watch_expires_at: "2026-08-16T21:00:00.000Z",
			},
		);
	});
});
