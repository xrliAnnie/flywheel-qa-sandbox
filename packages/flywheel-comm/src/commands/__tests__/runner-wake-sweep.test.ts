import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommDB } from "../../db.js";
import { runnerWakeSweep } from "../runner-wake-sweep.js";

describe("runner-wake-sweep", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("opens the runner CommDB and queues a zero-settlement doorbell", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1774-sweep-command-"));
		dirs.push(dir);
		const dbPath = join(dir, "comm.db");
		const db = new CommDB(dbPath);
		db.registerSession(
			"exec-1",
			"@1",
			"flywheel",
			"FLY-1774",
			"lead",
			"codex",
			true,
		);
		const instructionId = db.insertInstruction("lead", "exec-1", "revise");
		db.close();

		expect(
			runnerWakeSweep({ dbPath, execId: "exec-1", now: () => 1_000 }).kind,
		).toBe("queued");

		const verify = new CommDB(dbPath, false);
		try {
			expect(verify.getUnreadInstructions("exec-1")[0]?.id).toBe(instructionId);
			expect(verify.listRunnerPhaseWakes("exec-1")).toHaveLength(1);
		} finally {
			verify.close();
		}
	});
});
