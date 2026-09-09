import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AccountStore,
	readStore,
	writeStore,
} from "../../account-heal/account-store.js";
import { type AccountSwitchSnapshot, StateStore } from "../../StateStore.js";
import {
	createAccountSwitchConsumer,
	WAKE_TEXT,
} from "../account-switch-consumer.js";

const SWITCH_MS = Date.parse("2026-09-08T21:49:00.000Z");

function switchSnapshot(
	generation = 1,
	overrides: Partial<AccountSwitchSnapshot> = {},
): AccountSwitchSnapshot {
	return {
		generation,
		triggerKind: "account_dead",
		from: generation === 1 ? "personal1" : `personal${generation}`,
		to: generation === 1 ? "business" : `business${generation}`,
		atMs: SWITCH_MS + (generation - 1) * 120_000,
		...overrides,
	};
}

function accountStore(snapshot?: AccountSwitchSnapshot): AccountStore {
	return {
		generation: snapshot?.generation ?? 0,
		activeAccount: snapshot?.to ?? null,
		accounts: [
			{
				name: "personal1",
				quotaExhaustedUntil: null,
				weeklyResetAt: null,
			},
			{
				name: "business",
				quotaExhaustedUntil: null,
				weeklyResetAt: null,
			},
		],
		pendingSwitchNotifications: [],
		...(snapshot
			? {
					lastSwitch: {
						generation: snapshot.generation,
						triggerKind: snapshot.triggerKind,
						from: snapshot.from,
						to: snapshot.to,
						at: new Date(snapshot.atMs).toISOString(),
					},
				}
			: {}),
	};
}

describe("FLY-2452 account-switch consumer", () => {
	let dir: string;
	let accountPath: string;
	let commDbPath: string;
	let store: StateStore;
	let nowMs: number;
	let redrive: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly2452-switch-consumer-"));
		accountPath = join(dir, "accounts.json");
		commDbPath = join(dir, "comm", "comm.db");
		store = await StateStore.create(join(dir, "teamlead.db"));
		nowMs = SWITCH_MS + 10_000;
		redrive = vi.fn(async () => ({
			requeued: 1,
			retired: 0,
			deferred: false,
		}));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function registerStateSession(
		executionId: string,
		status = "running",
		startedAt = "2026-09-08 21:48:00.123",
		projectName = "flywheel",
	): void {
		store.upsertSession({
			execution_id: executionId,
			issue_id: `issue-${executionId}`,
			issue_identifier: `FLY-${executionId}`,
			project_name: projectName,
			status,
			started_at: startedAt,
		});
	}

	function registerCommSession(
		executionId: string,
		vendor?: string,
		projectName = "flywheel",
	): void {
		const db = new CommDB(commDbPath);
		try {
			db.registerSession(
				executionId,
				`window:${executionId}`,
				projectName,
				`issue-${executionId}`,
				"flywheel-eng-lead",
				vendor,
			);
		} finally {
			db.close();
		}
	}

	function makeConsumer(
		overrides: Partial<Parameters<typeof createAccountSwitchConsumer>[0]> = {},
	) {
		return createAccountSwitchConsumer({
			store,
			readStore: () => readStore(accountPath),
			commDbPathFor: () => commDbPath,
			coordinator: { redriveAfterAccountSwitch: redrive },
			sweepEnabled: () => true,
			now: () => nowMs,
			log: vi.fn(),
			...overrides,
		});
	}

	function readCommDb<T>(read: (db: CommDB) => T): T {
		const db = new CommDB(commDbPath, false);
		try {
			return read(db);
		} finally {
			db.close();
		}
	}

	it("begins, executes, and completes both actions from a valid account_dead lastSwitch", async () => {
		const snapshot = switchSnapshot();
		writeStore(accountStore(snapshot), accountPath);
		registerStateSession("claude-exec");
		registerCommSession("claude-exec", "claude-code");
		readCommDb((db) =>
			db.upsertDeclaredState("claude-exec", "parked", "403", nowMs, null),
		);

		await makeConsumer().tick();

		expect(redrive).toHaveBeenCalledWith({ generation: 1, atMs: SWITCH_MS });
		expect(
			store.getAccountSwitchActionReceipt(1, "review_redrive"),
		).toMatchObject({
			status: "completed",
			switch: snapshot,
			outcome: { requeued: 1, retired: 0, deferred: false },
		});
		expect(store.getAccountSwitchActionReceipt(1, "wake_sweep")).toMatchObject({
			status: "completed",
			outcome: {
				sent: 1,
				skipped_vendor: 0,
				skipped_started_after: 0,
				skipped_not_running: 0,
			},
		});
		const instruction = readCommDb(
			(db) => db.getUnreadInstructions("claude-exec")[0],
		);
		expect(instruction).toMatchObject({
			id: "account-switch-wake:g1:claude-exec",
			content: WAKE_TEXT("personal1", "business"),
		});
		expect(
			readCommDb((db) => db.getEffectiveDeclaredState("claude-exec", nowMs)),
		).toBeNull();
		expect(store.getEventsByExecution("claude-exec")).toEqual([
			expect.objectContaining({
				event_id: "account-switch-wake:g1:claude-exec",
				event_type: "account_switch_wake",
				payload: { generation: 1, from: "personal1", to: "business" },
			}),
		]);
	});

	it("wakes only pre-switch running claude-code sessions and records permanent skips", async () => {
		writeStore(accountStore(switchSnapshot()), accountPath);
		const fixtures = [
			["claude", "running", "2026-09-08 21:48:00.123", "claude-code"],
			["codex", "running", "2026-09-08 21:48:00.123", "codex"],
			["none", "running", "2026-09-08 21:48:00.123", undefined],
			["missing", "running", "2026-09-08 21:48:00.123", null],
			["parked", "awaiting_review", "2026-09-08 21:48:00.123", "claude-code"],
			["after", "running", "2026-09-08 21:50:00", "claude-code"],
			["equal", "running", "2026-09-08 21:49:00", "claude-code"],
			["bad-time", "running", "not-a-time", "claude-code"],
		] as const;
		for (const [executionId, status, startedAt, vendor] of fixtures) {
			registerStateSession(executionId, status, startedAt);
			if (vendor !== null) registerCommSession(executionId, vendor);
		}

		await makeConsumer().tick();

		for (const [executionId] of fixtures) {
			const unread = readCommDb((db) => db.getUnreadInstructions(executionId));
			expect(unread, executionId).toHaveLength(
				executionId === "claude" ? 1 : 0,
			);
		}
		expect(
			store.getAccountSwitchActionReceipt(1, "wake_sweep")?.outcome,
		).toEqual({
			sent: 1,
			skipped_vendor: 3,
			skipped_started_after: 3,
			skipped_not_running: 1,
		});
	});

	it("parses the HTTP sqlite seconds format as an eligible pre-switch start", async () => {
		writeStore(accountStore(switchSnapshot()), accountPath);
		registerStateSession("claude-seconds", "running", "2026-09-08 21:48:00");
		registerCommSession("claude-seconds", "claude-code");

		await makeConsumer().tick();

		expect(
			readCommDb((db) => db.getUnreadInstructions("claude-seconds")),
		).toHaveLength(1);
	});

	it.each(["quota", "witness", "manual"] as const)(
		"%s switches redrive reviews but permanently skip the wake sweep",
		async (triggerKind) => {
			const snapshot = switchSnapshot(1, { triggerKind });
			const source = accountStore(snapshot);
			if (triggerKind === "manual") {
				source.accounts[0]!.unavailable = {
					reason: "terminal",
					markedAt: new Date(SWITCH_MS).toISOString(),
					evidence: "403",
					markedBy: "quota-monitor",
				};
			}
			writeStore(source, accountPath);
			registerStateSession("claude-exec");
			registerCommSession("claude-exec", "claude-code");

			await makeConsumer().tick();

			expect(redrive).toHaveBeenCalledOnce();
			expect(
				store.getAccountSwitchActionReceipt(1, "wake_sweep")?.outcome,
			).toBe("skipped:trigger_kind");
			expect(
				readCommDb((db) => db.getUnreadInstructions("claude-exec")),
			).toEqual([]);
		},
	);

	it("uses pending receipt snapshots before reading and processing a newer switch", async () => {
		const first = switchSnapshot(1);
		const second = switchSnapshot(2);
		store.beginAccountSwitchAction(1, "review_redrive", first, nowMs - 5_000);
		store.beginAccountSwitchAction(1, "wake_sweep", first, nowMs - 5_000);
		writeStore(accountStore(second), accountPath);
		registerStateSession("claude-exec", "running", "2026-09-08 21:47:00");
		registerCommSession("claude-exec", "claude-code");
		nowMs = second.atMs + 10_000;
		const consumer = makeConsumer();

		await consumer.replayPending();
		await consumer.tick();

		expect(redrive.mock.calls.map(([value]) => value.generation)).toEqual([
			1, 2,
		]);
		const instructions = readCommDb((db) =>
			db.getUnreadInstructions("claude-exec"),
		);
		expect(instructions.map((row) => row.id)).toEqual([
			"account-switch-wake:g1:claude-exec",
			"account-switch-wake:g2:claude-exec",
		]);
		expect(instructions.map((row) => row.content)).toEqual([
			WAKE_TEXT(first.from, first.to),
			WAKE_TEXT(second.from, second.to),
		]);
		for (const generation of [1, 2]) {
			expect(
				store.getAccountSwitchActionReceipt(generation, "review_redrive")
					?.status,
			).toBe("completed");
			expect(
				store.getAccountSwitchActionReceipt(generation, "wake_sweep")?.status,
			).toBe("completed");
		}
	});

	it("reads account state at most once per 60-second gate and ignores unrelated generation changes", async () => {
		const snapshot = switchSnapshot();
		const source = accountStore(snapshot);
		const readAccountStore = vi.fn(() => source);
		const consumer = makeConsumer({ readStore: readAccountStore });

		await consumer.tick();
		nowMs += 59_999;
		await consumer.tick();
		source.generation += 20;
		nowMs += 1;
		await consumer.tick();

		expect(readAccountStore).toHaveBeenCalledTimes(2);
		expect(redrive).toHaveBeenCalledTimes(1);
	});

	it("does nothing for a missing lastSwitch and warns rather than throwing on unreadable state", async () => {
		writeStore(accountStore(), accountPath);
		const log = vi.fn();
		const consumer = makeConsumer({ log });
		await consumer.tick();
		expect(redrive).not.toHaveBeenCalled();

		nowMs += 60_000;
		const broken = makeConsumer({
			readStore: () => {
				throw new Error("unreadable");
			},
			log,
		});
		await expect(broken.tick()).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("unreadable"));

		const invalid = makeConsumer({ readStore: () => null, log });
		await expect(invalid.tick()).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith(
			"[account-switch-consumer] account store unreadable",
		);
	});

	it.each([
		{ generation: 0 },
		{ triggerKind: "future_kind" },
		{ from: "../escape" },
		{ to: ".hidden" },
		{ at: "not-a-time" },
		{ at: "1960-01-01T00:00:00.000Z" },
		{ at: new Date(SWITCH_MS + 10_000 + 5 * 60_000 + 1).toISOString() },
	])(
		"rejects malformed lastSwitch snapshots fail-closed: $generation$triggerKind$from$to$at",
		async (lastSwitch) => {
			const log = vi.fn();
			const consumer = makeConsumer({
				readStore: () =>
					({
						...accountStore(),
						lastSwitch: {
							generation: 1,
							triggerKind: "account_dead",
							from: "personal1",
							to: "business",
							at: new Date(SWITCH_MS).toISOString(),
							...lastSwitch,
						},
					}) as AccountStore,
				log,
			});

			await consumer.tick();

			expect(redrive).not.toHaveBeenCalled();
			expect(log).toHaveBeenCalledWith(expect.stringContaining("lastSwitch"));
		},
	);

	it("keeps a kill-switch-deferred review receipt pending and retries it later", async () => {
		writeStore(accountStore(switchSnapshot()), accountPath);
		redrive
			.mockResolvedValueOnce({ requeued: 0, retired: 0, deferred: true })
			.mockResolvedValueOnce({ requeued: 1, retired: 0, deferred: false });
		const consumer = makeConsumer();

		await consumer.tick();
		expect(
			store.getAccountSwitchActionReceipt(1, "review_redrive")?.status,
		).toBe("pending");
		nowMs += 60_000;
		await consumer.tick();
		expect(
			store.getAccountSwitchActionReceipt(1, "review_redrive"),
		).toMatchObject({
			status: "completed",
			outcome: { requeued: 1, retired: 0, deferred: false },
		});
	});

	it("completes a disabled wake sweep as skipped and never backfills it after re-enable", async () => {
		writeStore(accountStore(switchSnapshot()), accountPath);
		registerStateSession("claude-exec");
		registerCommSession("claude-exec", "claude-code");
		let enabled = false;
		const consumer = makeConsumer({ sweepEnabled: () => enabled });

		await consumer.tick();
		expect(store.getAccountSwitchActionReceipt(1, "wake_sweep")?.outcome).toBe(
			"skipped:flag_off",
		);
		enabled = true;
		nowMs += 60_000;
		await consumer.tick();
		expect(readCommDb((db) => db.getUnreadInstructions("claude-exec"))).toEqual(
			[],
		);
	});

	it.each([
		"openCommDb",
		"insertInstruction",
		"clearDeclaredState",
		"insertEvent",
		"completeReceipt",
	] as const)(
		"leaves wake_sweep pending after %s failure and replays idempotently",
		async (failurePoint) => {
			writeStore(accountStore(switchSnapshot()), accountPath);
			registerStateSession("claude-exec");
			registerCommSession("claude-exec", "claude-code");
			let fail = true;
			const originalInsertEvent = store.insertEvent.bind(store);
			const originalComplete = store.completeAccountSwitchAction.bind(store);
			if (failurePoint === "insertEvent") {
				store.insertEvent = ((event) => {
					if (fail) {
						fail = false;
						throw new Error("insertEvent failed");
					}
					return originalInsertEvent(event);
				}) as StateStore["insertEvent"];
			}
			if (failurePoint === "completeReceipt") {
				store.completeAccountSwitchAction = ((
					generation,
					action,
					outcome,
					at,
				) => {
					if (action === "wake_sweep" && fail) {
						fail = false;
						throw new Error("complete failed");
					}
					return originalComplete(generation, action, outcome, at);
				}) as StateStore["completeAccountSwitchAction"];
			}

			const openCommDb = (path: string): CommDB => {
				if (failurePoint === "openCommDb" && fail) {
					fail = false;
					throw new Error("open failed");
				}
				const db = new CommDB(path, false);
				if (failurePoint === "insertInstruction" && fail) {
					const original = db.insertInstructionWithId.bind(db);
					db.insertInstructionWithId = ((..._args) => {
						fail = false;
						throw new Error("insert failed");
					}) as typeof original;
				}
				if (failurePoint === "clearDeclaredState" && fail) {
					const original = db.clearDeclaredState.bind(db);
					db.clearDeclaredState = ((..._args) => {
						fail = false;
						throw new Error("clear failed");
					}) as typeof original;
				}
				return db;
			};
			const consumer = makeConsumer({ openCommDb });

			await consumer.tick();
			expect(store.getAccountSwitchActionReceipt(1, "wake_sweep")?.status).toBe(
				"pending",
			);
			nowMs += 60_000;
			await consumer.tick();

			expect(store.getAccountSwitchActionReceipt(1, "wake_sweep")?.status).toBe(
				"completed",
			);
			expect(
				readCommDb((db) => db.getUnreadInstructions("claude-exec")),
			).toHaveLength(1);
			expect(store.getEventsByExecution("claude-exec")).toHaveLength(1);
		},
	);
});
