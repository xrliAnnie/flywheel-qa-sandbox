import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { send } from "../commands/send.js";
import { CommDB } from "../db.js";
import { createTestLeadIdentityEnvs } from "./helpers/lead-identity-env.js";

describe("send canonical mailbox write", () => {
	let dir: string;
	let dbPath: string;
	let leadEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1572-send-"));
		dbPath = join(dir, "comm.db");
		leadEnv = createTestLeadIdentityEnvs(dir, ["lead-a"])["lead-a"]!;
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("writes one durable Runner instruction without a runner_phase_wakes mirror", async () => {
		const db = new CommDB(dbPath);
		db.registerSession(
			"b1023db2-d31b-5e51-8d7e-5aba3c296626",
			"session:window",
			"project-a",
			"FLY-1572",
			"lead-a",
			"codex",
		);
		db.close();
		const id = await send({
			fromAgent: "lead-a",
			toAgent: "b1023db2-d31b-5e51-8d7e-5aba3c296626",
			content: "continue",
			dbPath,
			env: leadEnv,
		});
		const verify = new CommDB(dbPath);
		try {
			expect(
				verify.getUnreadInstructions("b1023db2-d31b-5e51-8d7e-5aba3c296626"),
			).toMatchObject([
				{
					id,
					from_agent: "lead-a",
					to_agent: "b1023db2-d31b-5e51-8d7e-5aba3c296626",
					content: "continue",
					delivered_at: null,
				},
			]);
			expect(
				verify.listRunnerPhaseWakes("b1023db2-d31b-5e51-8d7e-5aba3c296626"),
			).toEqual([]);
		} finally {
			verify.close();
		}
	});

	it("rejects a nonexistent Runner before writing a mailbox row", async () => {
		await expect(
			send({
				fromAgent: "lead-a",
				toAgent: "future-exec",
				content: "wait for Bridge delivery",
				dbPath,
				env: leadEnv,
			}),
		).rejects.toThrow(/recipient_malformed/);
		const db = new CommDB(dbPath);
		try {
			expect(db.getUnreadInstructions("future-exec")).toHaveLength(0);
		} finally {
			db.close();
		}
	});
});
