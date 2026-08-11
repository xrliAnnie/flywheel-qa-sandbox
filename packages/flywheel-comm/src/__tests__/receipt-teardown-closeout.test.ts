import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MailboxQueue } from "../mailbox-queue.js";
import { runReceiptTeardownCloseout } from "../receipt-teardown-closeout.js";
import { encodeSenderRef } from "../sender-ref.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function seed(): { root: string; commDb: string; stateDb: string } {
	const root = mkdtempSync(join(tmpdir(), "fly1645-closeout-"));
	roots.push(root);
	const commDb = join(root, "comm.db");
	const stateDb = join(root, "teamlead.db");
	const senderRef = encodeSenderRef({
		kind: "system",
		producer: "test",
		lease_key: "test",
		generation: "test",
		writer_pid: 1,
		writer_start: "2026-08-11T00:00:00.000Z",
	});
	const queue = new MailboxQueue(commDb);
	const base = {
		fromAgent: "founder",
		toAgent: "lead-a",
		recipientKind: "lead" as const,
		type: "discord_chat",
		content: "hello",
		createdAt: "2026-08-11T00:00:00.000Z",
		senderRef,
	};
	queue.enqueue({
		...base,
		id: "chat:lead-a:inbox-1",
		deliveryId: "chat:lead-a:inbox-1",
		carrier: "inbox",
	});
	queue.enqueue({
		...base,
		id: "chat:lead-a:external-1",
		deliveryId: "chat:lead-a:external-1",
		carrier: "external",
	});
	queue.enqueue({
		...base,
		id: "xdept:lead-a:keep-1",
		deliveryId: "xdept:lead-a:keep-1",
		carrier: "external",
		type: "cross_department",
	});
	queue.enqueue({
		...base,
		id: "lead-event:legacy-open",
		deliveryId: "lead-event:legacy-open",
		carrier: "inbox",
		type: "lead_event",
	});
	queue.enqueue({
		...base,
		id: "question:lead-a:q-1",
		deliveryId: "question:lead-a:q-1",
		carrier: "inbox",
		type: "question",
	});
	queue.close();

	const raw = new Database(commDb);
	raw.exec(`
		DROP TRIGGER mailbox_non_question_relay_insert_guard;
		DROP TRIGGER mailbox_non_question_relay_update_guard;
		UPDATE mailbox
		   SET relay_state = 'open', resolved_at = NULL, resolved_via = NULL
		 WHERE id IN ('chat:lead-a:external-1', 'lead-event:legacy-open');
		INSERT INTO mailbox_log
			(event_id, message_id, event, at, row_json)
		VALUES
			('legacy-processed', 'chat:lead-a:external-1', 'processed',
			 '2026-08-11T00:01:00.000Z', '{}');
		CREATE TABLE receipt_root_lineage (root_id TEXT PRIMARY KEY);
		CREATE TABLE receipt_handle_requests (request_id TEXT PRIMARY KEY);
		CREATE INDEX mailbox_log_settlement_slot ON mailbox_log(message_id)
			WHERE event IN ('processed','disposed');
	`);
	raw.close();

	const state = new Database(stateDb);
	state.exec("CREATE TABLE durable_state (id TEXT PRIMARY KEY, value TEXT)");
	state
		.prepare("INSERT INTO durable_state VALUES ('state-1', 'preserved')")
		.run();
	state.close();
	return { root, commDb, stateDb };
}

describe("FLY-1645 receipt teardown closeout", () => {
	it("dry-runs physically readonly, then applies with backups and idempotent replay", async () => {
		const { root, commDb, stateDb } = seed();
		const commBefore = sha256(commDb);
		const stateBefore = sha256(stateDb);

		const dryRun = await runReceiptTeardownCloseout({
			dbPaths: [commDb],
			stateDbPath: stateDb,
			apply: false,
			confirmQuiesced: false,
			resolutions: [],
			now: "2026-08-11T01:00:00.000Z",
		});
		expect(dryRun.mode).toBe("dry-run");
		expect(dryRun.shards[0]).toMatchObject({
			externalChatCount: 1,
			unresolvedExternalChatCount: 1,
			nonQuestionActiveRelayCount: 2,
		});
		expect(sha256(commDb)).toBe(commBefore);
		expect(sha256(stateDb)).toBe(stateBefore);

		const manifestPath = join(root, "closeout-manifest.json");
		const applied = await runReceiptTeardownCloseout({
			dbPaths: [commDb],
			stateDbPath: stateDb,
			apply: true,
			confirmQuiesced: true,
			resolutions: [
				{
					shard: commDb,
					id: "chat:lead-a:external-1",
					disposition: "manually_completed",
				},
			],
			manifestPath,
			now: "2026-08-11T01:00:00.000Z",
		});
		expect(applied.mode).toBe("apply");
		expect(applied.manifestRecords).toHaveLength(1);
		expect(applied.manifestRecords[0]).toMatchObject({
			shard: commDb,
			id: "chat:lead-a:external-1",
			carrier: "external",
			state: "QUEUED",
			relay_state: "open",
			disposition: "manually_completed",
			backup_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(existsSync(applied.backups[0]!.path)).toBe(true);
		expect(existsSync(applied.stateBackup!.path)).toBe(true);
		expect(readFileSync(manifestPath, "utf8")).toContain(
			"chat:lead-a:external-1",
		);

		const db = new Database(commDb, { readonly: true });
		expect(
			db
				.prepare("SELECT id, state, seq FROM mailbox WHERE id LIKE 'chat:%'")
				.all(),
		).toEqual([
			expect.objectContaining({ id: "chat:lead-a:inbox-1", state: "QUEUED" }),
		]);
		expect(
			db
				.prepare("SELECT carrier, state FROM mailbox WHERE id = ?")
				.get("xdept:lead-a:keep-1"),
		).toEqual({ carrier: "external", state: "QUEUED" });
		expect(
			db
				.prepare(
					"SELECT relay_state, resolved_via FROM mailbox WHERE id = 'lead-event:legacy-open'",
				)
				.get(),
		).toEqual({
			relay_state: "terminal_disposed",
			resolved_via: "fly1645_teardown_final_sweep",
		});
		expect(
			db
				.prepare(
					"SELECT relay_state FROM mailbox WHERE id = 'question:lead-a:q-1'",
				)
				.get(),
		).toEqual({ relay_state: "open" });
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE name IN ('receipt_root_lineage','receipt_handle_requests','mailbox_log_settlement_slot')",
				)
				.all(),
		).toEqual([]);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE name LIKE 'mailbox_non_question_relay_%' ORDER BY name",
				)
				.all(),
		).toEqual([
			{ name: "mailbox_non_question_relay_insert_guard" },
			{ name: "mailbox_non_question_relay_update_guard" },
		]);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM mailbox_log WHERE event = 'processed'",
				)
				.get(),
		).toEqual({ count: 1 });
		db.close();

		const queue = new MailboxQueue(commDb);
		expect(queue.getIdentityCarrier("chat:lead-a:external-1")).toBe("external");
		queue.close();

		const replay = await runReceiptTeardownCloseout({
			dbPaths: [commDb],
			stateDbPath: stateDb,
			apply: true,
			confirmQuiesced: true,
			resolutions: [],
			now: "2026-08-11T01:05:00.000Z",
		});
		expect(replay.shards[0]).toMatchObject({
			externalChatCount: 0,
			nonQuestionActiveRelayCount: 0,
		});
	});

	it("fails closed before backup or mutation when an external row is unresolved", async () => {
		const { root, commDb, stateDb } = seed();
		const before = sha256(commDb);
		await expect(
			runReceiptTeardownCloseout({
				dbPaths: [commDb],
				stateDbPath: stateDb,
				apply: true,
				confirmQuiesced: true,
				resolutions: [
					{
						shard: commDb,
						id: "chat:lead-a:external-1",
						disposition: "unresolved",
					},
				],
				now: "2026-08-11T02:00:00.000Z",
			}),
		).rejects.toThrow("unresolved_external_chat");
		expect(sha256(commDb)).toBe(before);
		expect(existsSync(join(root, "backups"))).toBe(false);
	});

	it("never creates a missing database", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1645-closeout-missing-"));
		roots.push(root);
		const missing = join(root, "missing.db");
		await expect(
			runReceiptTeardownCloseout({
				dbPaths: [missing],
				stateDbPath: join(root, "missing-state.db"),
				apply: false,
				confirmQuiesced: false,
				resolutions: [],
			}),
		).rejects.toThrow("closeout_database_missing");
		expect(existsSync(missing)).toBe(false);
	});
});
