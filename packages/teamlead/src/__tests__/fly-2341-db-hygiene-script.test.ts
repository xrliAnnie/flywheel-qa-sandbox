import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, describe, expect, it } from "vitest";
import {
	executeFly2341Archive,
	executeFly2341Inventory,
	executeFly2341Restore,
	executeFly2341Vacuum,
	parseFly2341Args,
} from "../../../../scripts/fly-2341-db-hygiene.mjs";
import { StateStore } from "../StateStore.js";

const NOW = "2026-09-04T20:00:00.000Z";
const OLD = "2026-08-20T00:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("FLY-2341 database hygiene operator", () => {
	it("requires explicit paths and exposes no retention or batch knobs", () => {
		expect(() => parseFly2341Args(["inventory"])).toThrow(/teamlead-db/);
		expect(() =>
			parseFly2341Args([
				"archive",
				"--teamlead-db",
				"teamlead.db",
				"--comm-db",
				"comm.db",
				"--retention-days",
				"1",
			]),
		).toThrow(/unknown argument/);
		expect(() =>
			parseFly2341Args([
				"archive",
				"--teamlead-db",
				"teamlead.db",
				"--comm-db",
				"comm.db",
			]),
		).toThrow(/now/);
		expect(() =>
			parseFly2341Args(["restore", "--db", "comm.db", "--db-kind", "comm"]),
		).toThrow(/key/);
	});

	it("inventories, drains, reruns idempotently, and restores both cold formats", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2341-operator-"));
		roots.push(root);
		const teamleadDbPath = join(root, "teamlead.db");
		const commDbPath = join(root, "comm.db");
		const store = await StateStore.create(teamleadDbPath);
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		raw
			.prepare(
				"INSERT INTO sessions(execution_id,issue_id,project_name,status) VALUES(?,?,?,'completed')",
			)
			.run("operator-exec", "operator-issue", "flywheel");
		raw
			.prepare(`INSERT INTO session_events
			(event_id,ts,execution_id,issue_id,project_name,event_type,payload,source)
			VALUES(?,?,?,?,?,'session_completed','{}','test')`)
			.run(
				"operator-event",
				OLD,
				"operator-exec",
				"operator-issue",
				"flywheel",
			);
		store.close();

		new CommDB(commDbPath).close();
		const queue = new MailboxQueue(commDbPath);
		queue.enqueue({
			id: "operator-mail",
			deliveryId: "delivery:operator-mail",
			fromAgent: "lead-a",
			toAgent: "runner-a",
			recipientKind: "runner",
			type: "instruction",
			content: "archive me",
			createdAt: OLD,
			senderRef: encodeSenderRef(),
		});
		queue.ack("operator-mail", OLD);
		queue.close();

		const before = executeFly2341Inventory({ teamleadDbPath, commDbPath });
		expect(before.teamlead.hot.session_events).toBe(1);
		expect(before.comm.hot.mailbox).toBe(1);

		const first = await executeFly2341Archive({
			teamleadDbPath,
			commDbPath,
			now: NOW,
		});
		expect(first.archived).toMatchObject({
			teamlead: 1,
			commFamilies: 1,
			commIdentities: 1,
		});
		const second = await executeFly2341Archive({
			teamleadDbPath,
			commDbPath,
			now: NOW,
		});
		expect(second).toMatchObject({
			archived: { teamlead: 0, commFamilies: 0, commIdentities: 0 },
		});
		expect(second.batches).toBe(8);
		expect(executeFly2341Vacuum({ dbPath: teamleadDbPath })).toMatchObject({
			beforeBytes: expect.any(Number),
			afterBytes: expect.any(Number),
		});

		expect(
			executeFly2341Restore({
				dbKind: "teamlead",
				dbPath: teamleadDbPath,
				key: "session_events:1",
			}),
		).toEqual({ outcome: "restored" });
		expect(
			executeFly2341Restore({
				dbKind: "comm",
				dbPath: commDbPath,
				key: "delivery:operator-mail",
			}),
		).toEqual({ outcome: "restored" });
		const after = executeFly2341Inventory({ teamleadDbPath, commDbPath });
		expect(after.teamlead).toMatchObject({
			hot: { session_events: 1 },
			cold: { workflow_terminal_archive: 1 },
		});
		expect(after.comm).toMatchObject({
			hot: { mailbox: 1, mailbox_identity: 1 },
			cold: { mailbox_terminal_archive: 1 },
		});
	});

	it("isolates a malformed legacy identity while draining its healthy sibling", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2341-operator-isolation-"));
		roots.push(root);
		const teamleadDbPath = join(root, "teamlead.db");
		const commDbPath = join(root, "comm.db");
		(await StateStore.create(teamleadDbPath)).close();
		new CommDB(commDbPath).close();
		const db = new Database(commDbPath);
		const insert = db.prepare(`INSERT INTO mailbox_identity
			(id,delivery_id,insert_projection_hash,archived_at,terminal_at)
			VALUES(?,?,?,?,?)`);
		for (let index = 0; index < 26; index++) {
			const id = `bad-time-${String(index).padStart(2, "0")}`;
			insert.run(id, `delivery:${id}`, `hash:${id}`, "not-a-time", null);
		}
		insert.run(
			"zz-healthy",
			"delivery:zz-healthy",
			"hash:zz-healthy",
			OLD,
			null,
		);
		db.close();

		const result = await executeFly2341Archive({
			teamleadDbPath,
			commDbPath,
			now: NOW,
		});
		expect(result.archived.commIdentities).toBe(1);
		expect(result.commIdentityFailures).toHaveLength(26);
		expect(result.commIdentityFailures).toEqual(
			expect.arrayContaining([
				{
					id: "bad-time-00",
					error: "terminalAt must be a valid UTC ISO timestamp ending in Z",
				},
				{
					id: "bad-time-25",
					error: "terminalAt must be a valid UTC ISO timestamp ending in Z",
				},
			]),
		);
		expect(
			executeFly2341Inventory({ teamleadDbPath, commDbPath }).comm,
		).toMatchObject({
			hot: { mailbox_identity: 26 },
			cold: { mailbox_terminal_archive: 1 },
		});
	});

	it("refreshes active Comm lineage between operator drain iterations", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2341-operator-lineage-"));
		roots.push(root);
		const teamleadDbPath = join(root, "teamlead.db");
		const commDbPath = join(root, "comm.db");
		const store = await StateStore.create(teamleadDbPath);
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		raw
			.prepare(
				"INSERT INTO sessions(execution_id,issue_id,project_name,status) VALUES(?,?,?,'completed')",
			)
			.run("changing-exec", "changing-issue", "flywheel");
		const insert = raw.prepare(`INSERT INTO session_events
			(event_id,ts,execution_id,issue_id,project_name,event_type,payload,source)
			VALUES(?,?,?,?,?,'session_completed',?,'test')`);
		for (let index = 0; index < 101; index++) {
			insert.run(
				`changing-${index}`,
				OLD,
				"changing-exec",
				"changing-issue",
				"flywheel",
				JSON.stringify({ index }),
			);
		}
		store.close();
		new CommDB(commDbPath).close();
		setImmediate(() => {
			const comm = new CommDB(commDbPath, false, false);
			comm.registerSession(
				"changing-exec",
				"changing-window",
				"flywheel",
				"changing-issue",
				"flywheel-eng-lead",
			);
			comm.close();
		});

		expect(
			await executeFly2341Archive({ teamleadDbPath, commDbPath, now: NOW }),
		).toMatchObject({ archived: { teamlead: 100 } });
		expect(
			executeFly2341Inventory({ teamleadDbPath, commDbPath }).teamlead.hot
				.session_events,
		).toBe(1);
	});
});
