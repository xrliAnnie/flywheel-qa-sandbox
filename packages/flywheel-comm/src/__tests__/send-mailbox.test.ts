import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { send } from "../commands/send.js";
import { CommDB } from "../db.js";

describe("send canonical mailbox write", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1572-send-"));
		dbPath = join(dir, "comm.db");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("writes one durable Runner instruction without a runner_phase_wakes mirror", async () => {
		const db = new CommDB(dbPath);
		db.registerSession(
			"exec-1",
			"session:window",
			"project-a",
			"FLY-1572",
			"lead-a",
			"codex",
		);
		db.close();
		const id = await send({
			fromAgent: "lead-a",
			toAgent: "exec-1",
			content: "continue",
			dbPath,
		});
		const verify = new CommDB(dbPath);
		try {
			expect(verify.getUnreadInstructions("exec-1")).toMatchObject([
				{
					id,
					from_agent: "lead-a",
					to_agent: "exec-1",
					content: "continue",
					delivered_at: null,
				},
			]);
			expect(verify.listRunnerPhaseWakes("exec-1")).toEqual([]);
		} finally {
			verify.close();
		}
	});

	it("keeps the mailbox row durable before a Runner session exists", async () => {
		await send({
			fromAgent: "lead-a",
			toAgent: "future-exec",
			content: "wait for Bridge delivery",
			dbPath,
		});
		const db = new CommDB(dbPath);
		try {
			expect(db.getUnreadInstructions("future-exec")).toHaveLength(1);
		} finally {
			db.close();
		}
	});
});
