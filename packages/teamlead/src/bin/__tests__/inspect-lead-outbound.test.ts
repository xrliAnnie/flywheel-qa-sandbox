import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CodexOutboundSender } from "../../lead-backends/codex/CodexOutboundSender.js";
import { LeadJournal } from "../../lead-backends/codex/LeadJournal.js";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { SqliteOutboundDedupStore } from "../../lead-backends/codex/SqliteOutboundDedupStore.js";
import { runInspectLeadOutbound } from "../inspect-lead-outbound.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

interface Fixture {
	stateDir: string;
	journalDb: string;
	outboxDb: string;
	dedupDb: string;
	deliveryId: string;
	entryId: string;
	idempotencyKey: string;
}

async function createFixture(): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "inspect-lead-outbound-"));
	roots.push(root);
	const stateDir = join(root, "lead-state");
	mkdirSync(stateDir);
	const journalDb = join(stateDir, "journal.db");
	const outboxDb = join(stateDir, "outbox.db");
	const dedupDb = join(root, "codex-lead-outbound-dedup.db");
	const deliveryId = "chat:demo-codex:423456789012345678";
	const entryId = "entry-for-message";
	const idempotencyKey = `${entryId}:out`;

	const journalStore = new SqliteJournalStore(journalDb);
	const journal = new LeadJournal({
		store: journalStore,
		idFactory: () => entryId,
		now: () => 1_725_753_600_000,
	});
	const accepted = journal.acceptBatch({
		batchId: "batch-1#r1",
		memberIds: [deliveryId],
		payload: "reply to the founder",
	});
	journal.toDispatching(accepted.entry.id, "corr-1");
	journal.toDispatched(accepted.entry.id, "turn-1");
	journal.toModelCompleted(accepted.entry.id, "done");

	const sender = new CodexOutboundSender({
		bridgeUrl: "http://bridge.test",
		apiToken: "fixture-token",
		projectName: "codex-demo",
		leadId: "demo-codex",
		channelId: "10000000000000003",
		dbPath: outboxDb,
		post: async () => ({
			status: 200,
			body: '{"status":"sent","messageId":"523456789012345678"}',
		}),
		now: () => 1_725_753_600_100,
	});
	const outboxId = await sender.enqueue({
		leadId: "demo-codex",
		text: "done",
		idempotencyKey,
	});
	journal.toOutputPending(accepted.entry.id, outboxId);
	await sender.deliver(outboxId);
	journal.toCompleted(accepted.entry.id);
	sender.close();
	journalStore.close();

	const dedup = new SqliteOutboundDedupStore(dedupDb, () => 1_725_753_600_200);
	expect(dedup.setInFlight(idempotencyKey)).toBe(true);
	dedup.markSent(idempotencyKey, "523456789012345678");
	dedup.close();

	return {
		stateDir,
		journalDb,
		outboxDb,
		dedupDb,
		deliveryId,
		entryId,
		idempotencyKey,
	};
}

function inspect(fixture: Fixture): {
	rc: number;
	stdout: Record<string, unknown> | undefined;
	stderr: Record<string, unknown> | undefined;
} {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const rc = runInspectLeadOutbound(
		[
			"--state-dir",
			fixture.stateDir,
			"--delivery-id",
			fixture.deliveryId,
			"--dedup-db",
			fixture.dedupDb,
		],
		{
			stdout: (line) => stdout.push(line),
			stderr: (line) => stderr.push(line),
		},
	);
	return {
		rc,
		stdout: stdout[0]
			? (JSON.parse(stdout[0]) as Record<string, unknown>)
			: undefined,
		stderr: stderr[0]
			? (JSON.parse(stderr[0]) as Record<string, unknown>)
			: undefined,
	};
}

describe("inspect-lead-outbound", () => {
	it("proves the exact mailbox member through journal, local outbox, and Bridge dedup", async () => {
		const fixture = await createFixture();
		const result = inspect(fixture);
		expect(result.rc).toBe(0);
		expect(result.stdout).toMatchObject({
			ok: true,
			deliveryId: fixture.deliveryId,
			entryId: fixture.entryId,
			idempotencyKey: fixture.idempotencyKey,
			journalState: "completed",
			outboxStatus: "sent",
			bridgeStatus: "sent",
			messageId: "523456789012345678",
		});
	});

	it.each([
		{
			name: "journal membership",
			code: "outbound_journal_member_missing",
			mutate: (f: Fixture) => {
				const db = new Database(f.journalDb);
				db.prepare("DELETE FROM journal_member WHERE delivery_id = ?").run(
					f.deliveryId,
				);
				db.close();
			},
		},
		{
			name: "journal entry",
			code: "outbound_journal_entry_missing",
			mutate: (f: Fixture) => {
				const db = new Database(f.journalDb);
				db.pragma("foreign_keys = OFF");
				db.prepare("DELETE FROM journal WHERE id = ?").run(f.entryId);
				db.close();
			},
		},
		{
			name: "local outbox",
			code: "outbound_local_outbox_missing",
			mutate: (f: Fixture) => {
				const db = new Database(f.outboxDb);
				db.prepare("DELETE FROM outbox WHERE idempotency_key = ?").run(
					f.idempotencyKey,
				);
				db.close();
			},
		},
		{
			name: "Bridge dedup",
			code: "outbound_bridge_dedup_missing",
			mutate: (f: Fixture) => {
				const db = new Database(f.dedupDb);
				db.prepare("DELETE FROM outbound_dedup WHERE idempotency_key = ?").run(
					f.idempotencyKey,
				);
				db.close();
			},
		},
		{
			name: "Bridge message receipt",
			code: "outbound_bridge_receipt_incomplete",
			mutate: (f: Fixture) => {
				const db = new Database(f.dedupDb);
				db.prepare(
					"UPDATE outbound_dedup SET message_id = NULL WHERE idempotency_key = ?",
				).run(f.idempotencyKey);
				db.close();
			},
		},
	])("fails closed at a missing $name hop", async ({ code, mutate }) => {
		const fixture = await createFixture();
		mutate(fixture);
		const result = inspect(fixture);
		expect(result.rc).toBe(1);
		expect(result.stderr).toMatchObject({ ok: false, code });
	});

	it("does not accept a later unrelated Bridge outbound row", async () => {
		const fixture = await createFixture();
		const db = new Database(fixture.dedupDb);
		db.prepare("DELETE FROM outbound_dedup WHERE idempotency_key = ?").run(
			fixture.idempotencyKey,
		);
		db.prepare(
			`INSERT INTO outbound_dedup
			 (idempotency_key, status, message_id, created_at, updated_at)
			 VALUES (?, 'sent', ?, ?, ?)`,
		).run(
			"later-entry:out",
			"623456789012345678",
			1_725_753_601_000,
			1_725_753_601_000,
		);
		db.close();

		const result = inspect(fixture);
		expect(result.rc).toBe(1);
		expect(result.stderr).toMatchObject({
			ok: false,
			code: "outbound_bridge_dedup_missing",
			idempotencyKey: fixture.idempotencyKey,
		});
	});
});
