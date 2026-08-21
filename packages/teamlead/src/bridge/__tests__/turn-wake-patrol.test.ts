import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainTurnWakeOutbox } from "../turn-wake-patrol.js";

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
		await expect(run(1_700_000_000_000)).resolves.toEqual({
			pushed: 1,
			alerts: 0,
			cancelled: 0,
		});
		await expect(run(1_700_000_060_000)).resolves.toEqual({
			pushed: 1,
			alerts: 0,
			cancelled: 0,
		});
		await expect(run(1_700_001_200_000)).resolves.toEqual({
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
		).resolves.toEqual({ pushed: 0, alerts: 0, cancelled: 1 });
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
		).resolves.toEqual({ pushed: 1, alerts: 0, cancelled: 0 });
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

		await expect(run(t0)).resolves.toEqual({
			pushed: 1,
			alerts: 0,
			cancelled: 0,
		});
		await expect(run(t0 + 179_999)).resolves.toEqual({
			pushed: 0,
			alerts: 0,
			cancelled: 0,
		});
		await expect(run(t0 + 180_000)).resolves.toEqual({
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
		const receipt = vi.fn(async () => "projected" as const);

		await expect(
			drainTurnWakeOutbox({
				projectNames: ["flywheel"],
				commDbPathForProject: () => path,
				wake,
				nowMs: t0 + 180_000,
				onSecondPushUnacked: pointer,
				onReceipt: receipt,
			}),
		).resolves.toEqual({ pushed: 0, alerts: 0, cancelled: 0 });
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
