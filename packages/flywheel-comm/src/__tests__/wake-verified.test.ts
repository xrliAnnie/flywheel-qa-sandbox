import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommDB } from "../db.js";
import { wakeRunnerMailbox } from "../wake.js";

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
		).resolves.toEqual({ ok: true });
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
});
