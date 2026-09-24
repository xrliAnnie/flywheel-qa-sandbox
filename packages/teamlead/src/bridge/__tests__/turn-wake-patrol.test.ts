import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB, type TurnWakeOutboxRow } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	drainTurnWakeOutbox,
	type TurnWakeReceiptOutcome,
} from "../turn-wake-patrol.js";
import { classifyTurnWakeReceiptProjection } from "../turn-wake-receipt-classifier.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("drainTurnWakeOutbox", () => {
	it("uses the existing patrol to send once, retry once, then alert once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1614-wake-patrol-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		const seed = new CommDB(path);
		seed.registerSession(
			"exec-1",
			"window",
			"flywheel",
			"FLY-1614",
			"flywheel-eng-lead",
		);
		seed.enqueueTurnWake({
			wakeId: "wake-1",
			executionId: "exec-1",
			issueId: "FLY-1614",
			epoch: 4,
			activationId: "activation-4",
			purpose: "workflow_ship_carrier",
			envelope: {
				fromAgent: "bridge",
				content: "TURN ready",
				metadata: { wakeId: "wake-1" },
			},
			backend: "codex",
			createdAtMs: 1_700_000_000_000,
		});
		seed.close();
		const wake = vi.fn(async () => ({ ok: true }));
		const run = (nowMs: number) =>
			drainTurnWakeOutbox({
				projectNames: ["flywheel"],
				commDbPathForProject: () => path,
				wake,
				nowMs,
				retryAfterMs: 60_000,
				alertAfterMs: 20 * 60_000,
				maxPerProject: 5,
			});
		await expect(run(1_700_000_000_000)).resolves.toMatchObject({
			pushed: 1,
			alerts: 0,
			cancelled: 0,
		});
		await expect(run(1_700_000_060_000)).resolves.toMatchObject({
			pushed: 1,
			alerts: 0,
			cancelled: 0,
		});
		await expect(run(1_700_001_200_000)).resolves.toMatchObject({
			pushed: 0,
			alerts: 1,
			cancelled: 0,
		});
		expect(wake).toHaveBeenCalledTimes(2);
		expect(wake.mock.calls[0]?.[0]).toMatchObject({ verified: false });
		expect(wake.mock.calls[1]?.[0]).toMatchObject({ verified: true });
		const db = new CommDB(path);
		expect(db.getTurnWake("wake-1")).toMatchObject({ push_count: 2 });
		expect(db.getPendingQuestions("flywheel-eng-lead")).toHaveLength(1);
		db.close();
	});

	it("runs the terminal guard before a retry and cancels without mailbox I/O", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1614-wake-guard-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		const seed = new CommDB(path);
		seed.enqueueTurnWake({
			wakeId: "wake-terminal",
			executionId: "exec-done",
			issueId: "FLY-1614",
			epoch: 9,
			activationId: "activation-done",
			purpose: "workflow_rework",
			envelope: { fromAgent: "bridge", content: "stale wake" },
			backend: "codex",
			createdAtMs: 1_700_000_000_000,
		});
		seed.close();
		const wake = vi.fn(async () => ({ ok: true }));
		await expect(
			drainTurnWakeOutbox({
				projectNames: ["flywheel"],
				commDbPathForProject: () => path,
				wake,
				nowMs: 1_700_000_000_000,
				canDeliver: async () => ({
					disposition: "cancel",
					reason: "attempt_done",
				}),
			}),
		).resolves.toMatchObject({ pushed: 0, alerts: 0, cancelled: 1 });
		expect(wake).not.toHaveBeenCalled();
		const db = new CommDB(path);
		expect(db.getTurnWake("wake-terminal")).toMatchObject({
			state: "cancelled",
			cancel_reason: "terminal_guard:attempt_done",
		});
		db.close();
	});

	it("continues past a waiting wake so later project rows can drain", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1614-wake-no-hol-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		const seed = new CommDB(path);
		for (const [wakeId, createdAtMs] of [
			["wake-wait", 1_700_000_000_000],
			["wake-ready", 1_700_000_000_001],
		] as const) {
			seed.enqueueTurnWake({
				wakeId,
				executionId: `exec-${wakeId}`,
				issueId: "FLY-1614",
				epoch: 1,
				purpose: "workflow_rework",
				envelope: { fromAgent: "bridge", content: wakeId },
				backend: "codex",
				createdAtMs,
			});
		}
		seed.close();
		const wake = vi.fn(async () => ({ ok: true }));

		await expect(
			drainTurnWakeOutbox({
				projectNames: ["flywheel"],
				commDbPathForProject: () => path,
				wake,
				nowMs: 1_700_000_000_010,
				maxPerProject: 5,
				canDeliver: async (row) => ({
					disposition: row.wake_id === "wake-wait" ? "wait" : "deliver",
				}),
			}),
		).resolves.toMatchObject({ pushed: 1, alerts: 0, cancelled: 0 });
		expect(wake).toHaveBeenCalledOnce();
		expect(wake.mock.calls[0]?.[0]).toMatchObject({
			execId: "exec-wake-ready",
		});
		const db = new CommDB(path);
		expect(db.getTurnWake("wake-wait")).toMatchObject({
			push_count: 0,
			claim_token: null,
		});
		expect(db.getTurnWake("wake-ready")).toMatchObject({ push_count: 1 });
		db.close();
	});

	it("at T+180s performs the one verified retry, one Codex pointer, and alerts immediately when the pointer fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1940-turn-pointer-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		const t0 = 1_700_000_000_000;
		const seed = new CommDB(path);
		seed.registerSession(
			"exec-codex",
			"window",
			"flywheel",
			"FLY-1940",
			"flywheel-eng-lead",
		);
		seed.enqueueTurnWake({
			wakeId: "rework-wake:req-1940",
			executionId: "exec-codex",
			issueId: "FLY-1940",
			epoch: 11,
			activationId: "activation:req-1940",
			purpose: "workflow_rework",
			envelope: { fromAgent: "bridge", content: "TURN ready" },
			backend: "codex",
			createdAtMs: t0,
		});
		seed.close();
		const wake = vi.fn(async () => ({ ok: true }));
		const onSecondPushUnacked = vi.fn(async () => ({
			ok: false as const,
			error: "no idle input box",
		}));
		const run = (nowMs: number) =>
			drainTurnWakeOutbox({
				projectNames: ["flywheel"],
				commDbPathForProject: () => path,
				wake,
				nowMs,
				onSecondPushUnacked,
			});

		await expect(run(t0)).resolves.toMatchObject({
			pushed: 1,
			alerts: 0,
			cancelled: 0,
		});
		await expect(run(t0 + 179_999)).resolves.toMatchObject({
			pushed: 0,
			alerts: 0,
			cancelled: 0,
		});
		await expect(run(t0 + 180_000)).resolves.toMatchObject({
			pushed: 1,
			alerts: 1,
			cancelled: 0,
		});
		expect(wake).toHaveBeenCalledTimes(2);
		expect(onSecondPushUnacked).toHaveBeenCalledTimes(1);
		expect(onSecondPushUnacked).toHaveBeenCalledWith(
			expect.objectContaining({
				wake_id: "rework-wake:req-1940",
				push_count: 2,
			}),
			"flywheel",
		);
		const db = new CommDB(path);
		expect(db.getTurnWake("rework-wake:req-1940")).toMatchObject({
			push_count: 2,
			alert_question_id: "turn-wake-alert:rework-wake:req-1940",
		});
		db.close();
	});

	it("projects an ACK observed before T+180s without a retry or pointer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1940-turn-receipt-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		const t0 = 1_700_000_000_000;
		const seed = new CommDB(path);
		seed.enqueueTurnWake({
			wakeId: "carrier-wake:q-1940",
			executionId: "exec-codex",
			issueId: "FLY-1940",
			epoch: 12,
			activationId: "carrier:q-1940",
			purpose: "workflow_ship_carrier",
			envelope: { fromAgent: "bridge", content: "TURN ready" },
			backend: "codex",
			createdAtMs: t0,
		});
		const first = seed.claimDueTurnWake({
			nowMs: t0,
			retryAfterMs: 180_000,
			leaseMs: 30_000,
		})!;
		seed.finishTurnWakePush({
			wakeId: first.wake_id,
			claimToken: first.claim_token!,
			pushedAtMs: t0,
			result: "ok",
		});
		seed.ackTurnWakes({
			executionId: "exec-codex",
			epoch: 12,
			activationId: "carrier:q-1940",
			ackedAtMs: t0 + 179_999,
		});
		seed.close();
		const wake = vi.fn(async () => ({ ok: true }));
		const pointer = vi.fn(async () => ({ ok: true as const }));
		const receipt = vi.fn(async () => ({ kind: "projected" as const }));

		await expect(
			drainTurnWakeOutbox({
				projectNames: ["flywheel"],
				commDbPathForProject: () => path,
				wake,
				nowMs: t0 + 180_000,
				onSecondPushUnacked: pointer,
				onReceipt: receipt,
			}),
		).resolves.toMatchObject({
			pushed: 0,
			alerts: 0,
			cancelled: 0,
			receipts: { projected: 1, notApplicable: 0, retried: 0, quarantined: 0 },
		});
		expect(wake).not.toHaveBeenCalled();
		expect(pointer).not.toHaveBeenCalled();
		expect(receipt).toHaveBeenCalledOnce();
		const db = new CommDB(path);
		expect(db.getTurnWake("carrier-wake:q-1940")).toMatchObject({
			push_count: 1,
			receipt_projected_at: t0 + 180_000,
		});
		db.close();
	});
});

/**
 * FLY-2828: the receipt projection loop must isolate every receipt, log every
 * retry with its wake id, quarantine a permanently failing receipt behind one
 * durable Lead question, and never let a poison row starve the window.
 */
describe("drainTurnWakeOutbox receipt projection (FLY-2828)", () => {
	const T0 = 1_700_000_000_000;

	function seedAckedWakes(
		path: string,
		wakeIds: string[],
		options: { purpose?: string; lead?: boolean } = {},
	): void {
		const seed = new CommDB(path);
		try {
			for (const [index, wakeId] of wakeIds.entries()) {
				if (options.lead !== false) {
					seed.registerSession(
						`exec-${wakeId}`,
						"window",
						"flywheel",
						"FLY-2828",
						"flywheel-eng-lead",
					);
				}
				seed.enqueueTurnWake({
					wakeId,
					executionId: `exec-${wakeId}`,
					issueId: "FLY-2828",
					epoch: 1,
					activationId: `activation-${wakeId}`,
					purpose: options.purpose ?? "workflow_rework",
					envelope: { fromAgent: "bridge", content: "TURN ready" },
					backend: "codex",
					createdAtMs: T0 + index,
				});
				const claim = seed.claimTurnWakeById({
					wakeId,
					nowMs: T0,
					retryAfterMs: 60_000,
					leaseMs: 10_000,
				});
				seed.finishTurnWakePush({
					wakeId,
					claimToken: claim!.claim_token!,
					pushedAtMs: T0,
					result: "ok",
				});
				expect(
					seed.ackTurnWakes({
						executionId: `exec-${wakeId}`,
						epoch: 1,
						activationId: `activation-${wakeId}`,
						ackedAtMs: T0 + 1_000 + index,
					}),
				).toBe(1);
			}
		} finally {
			seed.close();
		}
	}

	function withDb<T>(path: string, fn: (db: CommDB) => T): T {
		const db = new CommDB(path);
		try {
			return fn(db);
		} finally {
			db.close();
		}
	}

	it("T1: a backlog larger than the window drains fully while retrying receipts sink", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2828-backlog-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		const wakeIds = Array.from(
			{ length: 25 },
			(_, i) => `wake-${String(i + 1).padStart(2, "0")}`,
		);
		seedAckedWakes(path, wakeIds);
		const visited: string[][] = [];
		const onReceipt = vi.fn(async (row: TurnWakeOutboxRow) => {
			visited[visited.length - 1]!.push(row.wake_id);
			return row.wake_id === "wake-01" || row.wake_id === "wake-02"
				? ({ kind: "retry", reason: "rework_wake_receipt_not_ready" } as const)
				: ({ kind: "projected" } as const);
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const results = [];
			for (let round = 0; round < 6; round += 1) {
				visited.push([]);
				results.push(
					await drainTurnWakeOutbox({
						projectNames: ["flywheel"],
						commDbPathForProject: () => path,
						wake: vi.fn(async () => ({ ok: true })),
						nowMs: T0 + 60_000 * (round + 1),
						maxPerProject: 5,
						onReceipt,
					}),
				);
			}
			expect(visited[0]).toEqual([
				"wake-01",
				"wake-02",
				"wake-03",
				"wake-04",
				"wake-05",
			]);
			expect(results[0]!.receipts).toEqual({
				projected: 3,
				notApplicable: 0,
				retried: 2,
				quarantined: 0,
			});
			for (const round of [1, 2, 3, 4]) {
				expect(visited[round]).toEqual(
					wakeIds.slice(5 + (round - 1) * 5, 5 + round * 5),
				);
				expect(results[round]!.receipts).toEqual({
					projected: 5,
					notApplicable: 0,
					retried: 0,
					quarantined: 0,
				});
			}
			expect(visited[5]).toEqual(["wake-01", "wake-02"]);
			expect(results[5]!.receipts).toEqual({
				projected: 0,
				notApplicable: 0,
				retried: 2,
				quarantined: 0,
			});
			withDb(path, (db) => {
				expect(
					db.listUnprojectedTurnWakeReceipts(100).map((r) => r.wake_id),
				).toEqual(["wake-01", "wake-02"]);
				for (const wakeId of wakeIds.slice(2)) {
					expect(db.getTurnWake(wakeId)?.receipt_projected_at).not.toBeNull();
				}
				expect(db.getTurnWake("wake-01")).toMatchObject({
					projection_attempts: 2,
					projection_last_error: "rework_wake_receipt_not_ready",
				});
				expect(db.getTurnWake("wake-02")).toMatchObject({
					projection_attempts: 2,
				});
			});
			expect(
				warn.mock.calls.filter(([line]) =>
					String(line).includes("receipt projection retry for wake-01"),
				),
			).toHaveLength(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("T2: a throwing head-of-queue receipt is isolated, counted, quarantined, and alerted once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2828-poison-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		seedAckedWakes(path, ["wake-1", "wake-2"]);
		const onReceipt = vi.fn(async (row: TurnWakeOutboxRow) => {
			if (row.wake_id === "wake-1") {
				throw new Error("workflow_rework_activation_not_admitted_on_receipt");
			}
			return { kind: "projected" } as const;
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const run = (nowMs: number) =>
				drainTurnWakeOutbox({
					projectNames: ["flywheel"],
					commDbPathForProject: () => path,
					wake: vi.fn(async () => ({ ok: true })),
					nowMs,
					maxPerProject: 5,
					quarantineAfterAttempts: 3,
					projectionAlertAfterMs: 60 * 60_000,
					onReceipt,
				});
			const first = await run(T0 + 60_000);
			expect(first).toMatchObject({
				alerts: 0,
				receipts: { projected: 1, retried: 1, quarantined: 0 },
			});
			withDb(path, (db) => {
				expect(db.getTurnWake("wake-2")?.receipt_projected_at).toBe(
					T0 + 60_000,
				);
				expect(db.getTurnWake("wake-1")).toMatchObject({
					receipt_projected_at: null,
					projection_attempts: 1,
					projection_last_error: expect.stringMatching(
						/^exception:workflow_rework_activation_not_admitted_on_receipt/,
					),
				});
			});
			expect(
				warn.mock.calls.some(
					([line]) =>
						String(line).includes("wake-1") &&
						String(line).includes("exception:"),
				),
			).toBe(true);
			expect(await run(T0 + 120_000)).toMatchObject({
				alerts: 0,
				receipts: { projected: 0, retried: 1, quarantined: 0 },
			});
			const third = await run(T0 + 180_000);
			expect(third).toMatchObject({
				alerts: 1,
				receipts: { projected: 0, retried: 1, quarantined: 1 },
			});
			expect(onReceipt).toHaveBeenCalledTimes(4);
			withDb(path, (db) => {
				expect(db.listUnprojectedTurnWakeReceipts(100, 3)).toEqual([]);
				expect(db.getTurnWake("wake-1")).toMatchObject({
					receipt_projected_at: null,
					projection_attempts: 3,
					projection_alerted_at: T0 + 180_000,
					projection_alert_question_id: "turn-wake-projection-alert:wake-1",
				});
				const questions = db
					.getPendingQuestions("flywheel-eng-lead")
					.filter((q) => q.id.startsWith("turn-wake-projection-alert:"));
				expect(questions).toHaveLength(1);
				expect(questions[0]!.content).toContain("purpose workflow_rework");
				expect(questions[0]!.content).toContain("workflow_rework_delivery");
			});
			const fourth = await run(T0 + 240_000);
			expect(fourth).toMatchObject({
				alerts: 0,
				receipts: { projected: 0, retried: 0, quarantined: 0 },
			});
			expect(onReceipt).toHaveBeenCalledTimes(4);
		} finally {
			warn.mockRestore();
		}
	});

	it("T3: every retry and every failed mark leaves a log line with the wake id", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2828-log-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		seedAckedWakes(path, ["wake-unresolved", "wake-marked-twice"]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const onReceipt = vi.fn(async (row: TurnWakeOutboxRow) => {
				if (row.wake_id === "wake-unresolved") {
					return {
						kind: "retry",
						reason: "activation_or_run_unresolved",
					} as const;
				}
				// Simulate a concurrent writer closing the row before our mark.
				withDb(path, (db) => {
					expect(db.markTurnWakeReceiptProjected(row.wake_id, T0 + 1)).toBe(
						true,
					);
				});
				return { kind: "projected" } as const;
			});
			await expect(
				drainTurnWakeOutbox({
					projectNames: ["flywheel"],
					commDbPathForProject: () => path,
					wake: vi.fn(async () => ({ ok: true })),
					nowMs: T0 + 60_000,
					onReceipt,
				}),
			).resolves.toMatchObject({
				receipts: {
					projected: 1,
					notApplicable: 0,
					retried: 1,
					quarantined: 0,
				},
			});
			const lines = warn.mock.calls.map(([line]) => String(line));
			expect(
				lines.find(
					(line) =>
						line.includes("receipt projection retry for wake-unresolved") &&
						line.includes("activation_or_run_unresolved") &&
						line.includes("attempt 1"),
				),
			).toBeDefined();
			expect(
				lines.find(
					(line) =>
						line.includes(
							"receipt projection mark failed for wake-marked-twice",
						) && line.includes("projected"),
				),
			).toBeDefined();
		} finally {
			warn.mockRestore();
		}
	});

	it("T4: a terminal not_applicable receipt is closed with its reason and never alerted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2828-na-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		seedAckedWakes(path, ["wake-stale"]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				drainTurnWakeOutbox({
					projectNames: ["flywheel"],
					commDbPathForProject: () => path,
					wake: vi.fn(async () => ({ ok: true })),
					nowMs: T0 + 60_000,
					projectionAlertAfterMs: 0,
					onReceipt: async () => ({
						kind: "not_applicable",
						reason: "rework_wake_receipt_identity_conflict",
					}),
				}),
			).resolves.toMatchObject({
				alerts: 0,
				receipts: {
					projected: 0,
					notApplicable: 1,
					retried: 0,
					quarantined: 0,
				},
			});
			withDb(path, (db) => {
				expect(db.getTurnWake("wake-stale")).toMatchObject({
					receipt_projected_at: T0 + 60_000,
					projection_last_error: "rework_wake_receipt_identity_conflict",
					projection_alerted_at: null,
				});
				expect(db.getPendingQuestions("flywheel-eng-lead")).toEqual([]);
			});
			expect(
				warn.mock.calls.some(
					([line]) =>
						String(line).includes("wake-stale") &&
						String(line).includes("rework_wake_receipt_identity_conflict"),
				),
			).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it("T4b: the production classifier routes structural corruption to a durable question, not to projected", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2828-corrupt-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		seedAckedWakes(path, ["wake-corrupt"]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const onReceipt = async (
				row: TurnWakeOutboxRow,
			): Promise<TurnWakeReceiptOutcome> =>
				classifyTurnWakeReceiptProjection({
					purpose: row.purpose,
					activationResolved: true,
					projected: {
						ok: false,
						reason: "rework_wake_receipt_context_corrupt",
					},
					deliveryState: "awaiting_receipt",
				});
			for (let round = 1; round <= 3; round += 1) {
				await drainTurnWakeOutbox({
					projectNames: ["flywheel"],
					commDbPathForProject: () => path,
					wake: vi.fn(async () => ({ ok: true })),
					nowMs: T0 + 60_000 * round,
					quarantineAfterAttempts: 3,
					onReceipt,
				});
			}
			withDb(path, (db) => {
				expect(db.getTurnWake("wake-corrupt")).toMatchObject({
					receipt_projected_at: null,
					projection_attempts: 3,
					projection_last_error: "rework_wake_receipt_context_corrupt",
					projection_alert_question_id:
						"turn-wake-projection-alert:wake-corrupt",
				});
				expect(
					db
						.getPendingQuestions("flywheel-eng-lead")
						.filter((q) => q.id === "turn-wake-projection-alert:wake-corrupt"),
				).toHaveLength(1);
			});
		} finally {
			warn.mockRestore();
		}
	});

	it("T14: a quarantined carrier receipt names the carrier ledger", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2828-carrier-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		seedAckedWakes(path, ["carrier-1"], { purpose: "workflow_ship_carrier" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await drainTurnWakeOutbox({
				projectNames: ["flywheel"],
				commDbPathForProject: () => path,
				wake: vi.fn(async () => ({ ok: true })),
				nowMs: T0 + 60_000,
				quarantineAfterAttempts: 1,
				onReceipt: async () => ({
					kind: "retry",
					reason: "carrier_wake_receipt_not_ready",
				}),
			});
			withDb(path, (db) => {
				const question = db
					.getPendingQuestions("flywheel-eng-lead")
					.find((q) => q.id === "turn-wake-projection-alert:carrier-1");
				expect(question?.content).toContain("workflow_carrier_delivery");
				expect(question?.content).toContain("purpose workflow_ship_carrier");
			});
		} finally {
			warn.mockRestore();
		}
	});

	it("T18: a no-receipt alert followed by an ACK and a stuck projection yields two ordered questions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2828-two-alerts-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		const seed = new CommDB(path);
		seed.registerSession(
			"exec-late",
			"window",
			"flywheel",
			"FLY-2828",
			"flywheel-eng-lead",
		);
		seed.enqueueTurnWake({
			wakeId: "wake-late",
			executionId: "exec-late",
			issueId: "FLY-2828",
			epoch: 1,
			activationId: "activation-late",
			purpose: "workflow_rework",
			envelope: { fromAgent: "bridge", content: "TURN ready" },
			backend: "codex",
			createdAtMs: T0,
		});
		seed.close();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const wake = vi.fn(async () => ({ ok: true }));
			const run = (
				nowMs: number,
				onReceipt?: (row: TurnWakeOutboxRow) => Promise<TurnWakeReceiptOutcome>,
			) =>
				drainTurnWakeOutbox({
					projectNames: ["flywheel"],
					commDbPathForProject: () => path,
					wake,
					nowMs,
					retryAfterMs: 60_000,
					alertAfterMs: 20 * 60_000,
					quarantineAfterAttempts: 2,
					onReceipt,
				});
			await run(T0);
			await run(T0 + 60_000);
			expect(await run(T0 + 20 * 60_000)).toMatchObject({ alerts: 1 });
			withDb(path, (db) => {
				expect(
					db.ackTurnWakes({
						executionId: "exec-late",
						epoch: 1,
						activationId: "activation-late",
						ackedAtMs: T0 + 21 * 60_000,
					}),
				).toBe(1);
			});
			const stuck = async () =>
				({
					kind: "retry",
					reason: "rework_wake_receipt_node_not_reserved:done",
				}) as const;
			expect(await run(T0 + 22 * 60_000, stuck)).toMatchObject({ alerts: 0 });
			expect(await run(T0 + 23 * 60_000, stuck)).toMatchObject({
				alerts: 1,
				receipts: { retried: 1, quarantined: 1 },
			});
			withDb(path, (db) => {
				const questions = db.getPendingQuestions("flywheel-eng-lead");
				expect(questions.map((q) => q.id)).toEqual([
					"turn-wake-alert:wake-late",
					"turn-wake-projection-alert:wake-late",
				]);
				expect(questions[1]!.content).toContain(
					"earlier no-receipt question turn-wake-alert:wake-late",
				);
				expect(db.getTurnWake("wake-late")).toMatchObject({
					alert_question_id: "turn-wake-alert:wake-late",
					projection_alert_question_id: "turn-wake-projection-alert:wake-late",
				});
			});
		} finally {
			warn.mockRestore();
		}
	});

	it("T13 (patrol): push-exhausted unacked wakes are cancelled only for completed obligations", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2828-exhausted-"));
		dirs.push(dir);
		const path = join(dir, "comm.db");
		const seed = new CommDB(path);
		const wakeIds = [
			"wake-completed",
			"wake-settled",
			"wake-terminal",
			"wake-deliver",
			"wake-wait",
			"wake-throws",
		];
		for (const [index, wakeId] of wakeIds.entries()) {
			seed.registerSession(
				`exec-${wakeId}`,
				"window",
				"flywheel",
				"FLY-2828",
				"flywheel-eng-lead",
			);
			seed.enqueueTurnWake({
				wakeId,
				executionId: `exec-${wakeId}`,
				issueId: "FLY-2828",
				epoch: 1,
				activationId: `activation-${wakeId}`,
				purpose:
					wakeId === "wake-terminal"
						? "workflow_ship_carrier"
						: "workflow_rework",
				envelope: { fromAgent: "bridge", content: "TURN ready" },
				backend: "codex",
				createdAtMs: T0 + index,
			});
			for (const push of [0, 1]) {
				const claim = seed.claimTurnWakeById({
					wakeId,
					nowMs: T0 + push * 60_000,
					retryAfterMs: 60_000,
					leaseMs: 10_000,
				});
				seed.finishTurnWakePush({
					wakeId,
					claimToken: claim!.claim_token!,
					pushedAtMs: T0 + push * 60_000,
					result: "ok",
				});
			}
		}
		seed.close();
		const guards: Record<
			string,
			() => Promise<{
				disposition: "deliver" | "cancel" | "wait";
				reason?: string;
			}>
		> = {
			"wake-completed": async () => ({
				disposition: "cancel",
				reason: "rework_obligation_completed",
			}),
			"wake-settled": async () => ({
				disposition: "cancel",
				reason: "rework_obligation_settled",
			}),
			"wake-terminal": async () => ({
				disposition: "cancel",
				reason: "carrier_target_terminal",
			}),
			"wake-deliver": async () => ({ disposition: "deliver" }),
			"wake-wait": async () => ({ disposition: "wait" }),
			"wake-throws": async () => {
				throw new Error("guard exploded");
			},
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = await drainTurnWakeOutbox({
				projectNames: ["flywheel"],
				commDbPathForProject: () => path,
				wake: vi.fn(async () => ({ ok: true })),
				nowMs: T0 + 20 * 60_000,
				retryAfterMs: 60_000,
				alertAfterMs: 20 * 60_000,
				canDeliver: (row) => guards[row.wake_id]!(),
			});
			expect(result).toMatchObject({ pushed: 0, cancelled: 1, alerts: 5 });
			withDb(path, (db) => {
				expect(db.getTurnWake("wake-completed")).toMatchObject({
					state: "cancelled",
					cancel_reason: "terminal_guard:rework_obligation_completed",
					alert_question_id: null,
				});
				for (const wakeId of wakeIds.slice(1)) {
					expect(db.getTurnWake(wakeId)).toMatchObject({
						state: "sent",
						push_count: 2,
						alert_question_id: `turn-wake-alert:${wakeId}`,
					});
				}
			});
			expect(
				warn.mock.calls.some(
					([line]) =>
						String(line).includes(
							"exhausted-wake guard failed for wake-throws",
						) && String(line).includes("guard exploded"),
				),
			).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});
});
