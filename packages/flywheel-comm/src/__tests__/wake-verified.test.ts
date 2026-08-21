import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommDB } from "../db.js";
import { deliverDurableTurnWake, wakeRunnerMailbox } from "../wake.js";

describe("FLY-1392 verified receipt wake", () => {
	let db: CommDB;
	let tmpDir: string;
	const previousBackend = process.env.FLYWHEEL_COMM_BACKEND;

	beforeEach(() => {
		process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
		tmpDir = mkdtempSync(join(tmpdir(), "wake-verified-"));
		db = new CommDB(join(tmpDir, "comm.db"));
		db.registerSession("exec-1", "session", "proj", "FLY-1", "lead-1", "codex");
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
		if (previousBackend === undefined) delete process.env.FLYWHEEL_COMM_BACKEND;
		else process.env.FLYWHEEL_COMM_BACKEND = previousBackend;
	});

	it("read-after-write verifies a non-idempotent T1 push", async () => {
		const write = vi.fn(async () => ({
			idempotent: false,
			finalized: true,
			wroteAt: 1,
		}));
		const verifyLastWrite = vi.fn(async () => {});

		await expect(
			wakeRunnerMailbox({
				db,
				execId: "exec-1",
				fromAgent: "lead-1",
				content: "pending wake",
				metadata: { flywheelId: "wake-1" },
				backend: "codex",
				verified: true,
				transportFactory: () => ({ write, verifyLastWrite }),
			}),
		).resolves.toEqual({
			ok: true,
			backend: "codex",
			settlement: "on_consume",
		});
		expect(verifyLastWrite).toHaveBeenCalledOnce();
	});

	it("fails loud when verification does not confirm the mailbox entry", async () => {
		const result = await wakeRunnerMailbox({
			db,
			execId: "exec-1",
			fromAgent: "lead-1",
			content: "pending wake",
			backend: "codex",
			verified: true,
			transportFactory: () => ({
				write: vi.fn(async () => ({
					idempotent: false,
					finalized: true,
					wroteAt: 1,
				})),
				verifyLastWrite: vi.fn(async () => {
					throw new Error("verify_mismatch");
				}),
			}),
		});
		expect(result).toEqual({ ok: false, error: "verify_mismatch" });
	});

	it("resumes the same durable wake after restart and performs only one T1 retry", async () => {
		const write = vi
			.fn()
			.mockRejectedValueOnce(new Error("mailbox unavailable"))
			.mockResolvedValue({ idempotent: false, finalized: true, wroteAt: 2 });
		const verifyLastWrite = vi.fn(async () => {});
		const wake = {
			db,
			wakeId: "turn-wake-1",
			execId: "exec-1",
			issueId: "FLY-1",
			epoch: 3,
			activationId: "activation-3",
			purpose: "workflow_ship_carrier",
			fromAgent: "bridge",
			content: "TURN epoch 3 is ready",
			metadata: { wakeId: "turn-wake-1", epoch: 3 },
			backend: "codex",
			retryAfterMs: 60_000,
			transportFactory: () => ({ write, verifyLastWrite }),
		};
		await expect(
			deliverDurableTurnWake({ ...wake, nowMs: 1_700_000_000_000 }),
		).resolves.toEqual({ ok: false, error: "mailbox unavailable" });

		db.close();
		db = new CommDB(join(tmpDir, "comm.db"));
		await expect(
			deliverDurableTurnWake({ ...wake, db, nowMs: 1_700_000_060_000 }),
		).resolves.toEqual({
			ok: true,
			backend: "codex",
			settlement: "on_consume",
		});
		expect(db.getTurnWake("turn-wake-1")).toMatchObject({
			push_count: 2,
			last_push_result: "ok",
		});
		expect(write).toHaveBeenCalledTimes(2);
		expect(verifyLastWrite).toHaveBeenCalledOnce();
	});
});
