import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-1448 terminal receipt settlement intents", () => {
	let store: StateStore;
	const originalFlag = process.env.FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT;
	const fields = { issue_id: "FLY-1448", project_name: "flywheel" };

	beforeEach(async () => {
		process.env.FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT = "1";
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			...fields,
			status: "running",
		});
	});

	afterEach(() => {
		store.close();
		if (originalFlag === undefined) {
			delete process.env.FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT;
		} else {
			process.env.FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT = originalFlag;
		}
	});

	it("creates one fenced intent per continuous terminal lifecycle", () => {
		store.persistTransition("exec-1", "completed", fields);
		const firstLifecycle = store.getSession("exec-1")?.terminal_lifecycle_id;
		expect(store.listReceiptSettlementIntents()).toMatchObject([
			{
				authority_kind: "session_terminal",
				execution_id: "exec-1",
				terminal_lifecycle_id: firstLifecycle,
				state: "pending",
			},
		]);

		store.persistTransition("exec-1", "failed", fields);
		expect(store.listReceiptSettlementIntents()).toHaveLength(1);

		store.persistTransition("exec-1", "awaiting_review", fields);
		store.persistTransition("exec-1", "blocked", fields);
		const intents = store.listReceiptSettlementIntents();
		expect(intents).toHaveLength(2);
		expect(
			new Set(intents.map((intent) => intent.terminal_lifecycle_id)).size,
		).toBe(2);
	});

	it("OFF writes no intent and ON catch-up creates exactly one", () => {
		process.env.FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT = "0";
		store.persistTransition("exec-1", "completed", fields);
		const lifecycleId = store.getSession("exec-1")?.terminal_lifecycle_id;
		expect(store.listReceiptSettlementIntents()).toEqual([]);

		process.env.FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT = "1";
		const first = store.ensureTerminalSettlementIntent(
			"exec-1",
			lifecycleId ?? "",
		);
		const replay = store.ensureTerminalSettlementIntent(
			"exec-1",
			lifecycleId ?? "",
		);
		expect(replay?.intent_id).toBe(first?.intent_id);
		expect(store.listReceiptSettlementIntents()).toHaveLength(1);
	});

	it("transition-first fences the old intent, while claim-first remains resumable", () => {
		store.persistTransition("exec-1", "completed", fields);
		const first = store.listReceiptSettlementIntents()[0]!;
		store.persistTransition("exec-1", "awaiting_review", fields);
		expect(
			store.claimTerminalSettlementIntent(
				first.intent_id,
				first.terminal_lifecycle_id!,
			),
		).toBeUndefined();
		expect(store.getReceiptSettlementIntent(first.intent_id)?.state).toBe(
			"fenced",
		);

		store.persistTransition("exec-1", "failed", fields);
		const second = store
			.listReceiptSettlementIntents()
			.find((intent) => intent.state === "pending")!;
		const claimed = store.claimTerminalSettlementIntent(
			second.intent_id,
			second.terminal_lifecycle_id!,
		);
		expect(claimed?.state).toBe("applying");
		expect(claimed?.claim_token).toBeTruthy();

		store.persistTransition("exec-1", "awaiting_review", fields);
		expect(
			store.claimTerminalSettlementIntent(
				second.intent_id,
				second.terminal_lifecycle_id!,
			)?.claim_token,
		).toBe(claimed?.claim_token);
		expect(
			store.completeReceiptSettlementIntent(
				second.intent_id,
				claimed?.claim_token ?? "",
			),
		).toBe(true);
	});
});
