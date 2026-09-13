import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		leadEnv.TEAMLEAD_DB_PATH = join(dir, "absent-teamlead.db");
		const db = new CommDB(dbPath);
		for (const id of [
			"b1023db2-d31b-5e51-8d7e-5aba3c296626",
			"c1023db2-d31b-5e51-8d7e-5aba3c296626",
		]) {
			db.registerSession(
				id,
				"session:window",
				"project-a",
				"FLY-1572",
				"lead-a",
				"codex",
			);
		}
		db.close();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("replays a stable ID after consumption without clearing a new parked state", async () => {
		const args = {
			fromAgent: "lead-a",
			toAgent: "b1023db2-d31b-5e51-8d7e-5aba3c296626",
			content: "continue",
			dbPath,
			env: leadEnv,
			instructionId: "stable-1",
		};
		expect(await send(args)).toBe("stable-1");
		const db = new CommDB(dbPath);
		try {
			db.markInstructionRead("stable-1");
			db.upsertDeclaredState(
				"b1023db2-d31b-5e51-8d7e-5aba3c296626",
				"parked",
				"done",
				Date.now(),
				null,
			);
			expect(await send(args)).toBe("stable-1");
			expect(
				db.getUnreadInstructions("b1023db2-d31b-5e51-8d7e-5aba3c296626"),
			).toEqual([]);
			expect(
				db.getEffectiveDeclaredState(
					"b1023db2-d31b-5e51-8d7e-5aba3c296626",
					Date.now(),
				),
			).toMatchObject({
				kind: "parked",
				reason: "done",
			});
		} finally {
			db.close();
		}
	});

	it.each(["content", "toAgent", "fromAgent", "provenance"])(
		"rejects stable ID conflicts in %s",
		async (field) => {
			const envs = createTestLeadIdentityEnvs(dir, ["lead-a", "lead-b"]);
			for (const env of Object.values(envs)) {
				env.TEAMLEAD_DB_PATH = join(dir, "absent-teamlead.db");
				env.FLYWHEEL_LEAD_LEASE_MODE = "audit_only";
				env.FLYWHEEL_LEAD_LEASE_DB = join(dir, "lead-lease.db");
				env.FLYWHEEL_LEAD_LEASE_MODE_FILE = join(dir, "lease-mode.json");
			}
			const args = {
				fromAgent: "lead-a",
				toAgent: "b1023db2-d31b-5e51-8d7e-5aba3c296626",
				content: "continue",
				dbPath,
				env: envs["lead-a"],
				instructionId: "stable-1",
				authorizationDeps: { processStart: () => "original-process" },
			};
			await send(args);
			const changed =
				field === "provenance"
					? { authorizationDeps: { processStart: () => "restarted-process" } }
					: field === "fromAgent"
						? { fromAgent: "lead-b", env: envs["lead-b"] }
						: {
								[field]:
									field === "toAgent"
										? "c1023db2-d31b-5e51-8d7e-5aba3c296626"
										: "changed",
							};
			await expect(send({ ...args, ...changed })).rejects.toThrow(
				"reused with different content",
			);
		},
	);

	it("rolls back the insert if declared-state clearing fails", async () => {
		vi.spyOn(CommDB.prototype, "clearDeclaredState").mockImplementation(() => {
			throw new Error("clear failed");
		});
		await expect(
			send({
				fromAgent: "lead-a",
				toAgent: "b1023db2-d31b-5e51-8d7e-5aba3c296626",
				content: "continue",
				dbPath,
				env: leadEnv,
				instructionId: "stable-1",
			}),
		).rejects.toThrow("clear failed");
		const db = new CommDB(dbPath);
		try {
			expect(
				db.getUnreadInstructions("b1023db2-d31b-5e51-8d7e-5aba3c296626"),
			).toEqual([]);
		} finally {
			db.close();
		}
	});

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
