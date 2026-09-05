import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../StateStore.js";
import {
	archiveTerminalRows,
	installTerminalRowArchiveSchema,
	MAX_TERMINAL_ARCHIVE_DURATION_MS,
	MAX_TERMINAL_ARCHIVE_PAGE_DURATION_MS,
	restoreTerminalRow,
	TERMINAL_ROW_RETENTION_MS,
} from "../terminal-row-archive.js";

const NOW = "2026-09-04T20:00:00.000Z";
const OLD = "2026-08-20T00:00:00.000Z";
const RECENT = "2026-09-03T00:00:00.000Z";

afterEach(() => {
	vi.restoreAllMocks();
});

function database(verbose?: (message?: unknown) => void): Database.Database {
	const db = new Database(":memory:", verbose ? { verbose } : undefined);
	db.pragma("foreign_keys = ON");
	db.exec(`
		CREATE TABLE sessions (
			execution_id TEXT PRIMARY KEY,
			issue_id TEXT NOT NULL,
			status TEXT NOT NULL
		);
		CREATE TABLE session_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT UNIQUE NOT NULL,
			ts TEXT NOT NULL,
			execution_id TEXT NOT NULL,
			issue_id TEXT NOT NULL,
			project_name TEXT NOT NULL,
			event_type TEXT NOT NULL,
			severity TEXT NOT NULL DEFAULT 'info',
			payload JSON,
			source TEXT NOT NULL
		);
		CREATE TABLE workflow_run (
			run_id TEXT PRIMARY KEY,
			issue_id TEXT NOT NULL,
			status TEXT NOT NULL
		);
		CREATE TABLE workflow_run_node (
			run_id TEXT NOT NULL,
			execution_id TEXT
		);
		CREATE TABLE workflow_run_event (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			event_uid TEXT NOT NULL UNIQUE,
			kind TEXT NOT NULL,
			node_id TEXT,
			edge_id TEXT,
			execution_id TEXT,
			payload JSON,
			at TEXT NOT NULL,
			UNIQUE(run_id, seq)
		);
		CREATE TABLE lead_events (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			lead_id TEXT NOT NULL,
			event_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			payload TEXT NOT NULL,
			session_key TEXT,
			delivered_at TEXT,
			delivery_attempts INTEGER NOT NULL DEFAULT 0,
			last_delivery_error TEXT,
			ack_required INTEGER NOT NULL DEFAULT 0,
			acked_at TEXT,
			dead_lettered_at TEXT,
			ingress_disposed_at TEXT,
			ack_retired_at TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE lead_event_delivery_attempts (attempt_id TEXT PRIMARY KEY, event_seq INTEGER);
		CREATE TABLE legacy_cutover_quarantine (seq INTEGER PRIMARY KEY);
		CREATE TABLE legacy_render_fallback (seq INTEGER PRIMARY KEY);
		CREATE TABLE legacy_stock_suppressed (seq INTEGER PRIMARY KEY);
	`);
	installTerminalRowArchiveSchema(db);
	return db;
}

function addSessionEvent(
	db: Database.Database,
	id: string,
	status: string,
	eventType: string,
	ts = OLD,
): void {
	db.prepare(
		"INSERT INTO sessions(execution_id,issue_id,status) VALUES(?,?,?)",
	).run(`exec-${id}`, `issue-${id}`, status);
	db.prepare(`INSERT INTO session_events
		(event_id,ts,execution_id,issue_id,project_name,event_type,payload,source)
		VALUES(?,?,?,?,?,?,?,?)`).run(
		id,
		ts,
		`exec-${id}`,
		`issue-${id}`,
		"flywheel",
		eventType,
		JSON.stringify({ id }),
		"test",
	);
}

function addWorkflowEvent(
	db: Database.Database,
	id: string,
	status: string,
	kind: string,
	at = OLD,
): void {
	db.prepare(
		"INSERT INTO workflow_run(run_id,issue_id,status) VALUES(?,?,?)",
	).run(`run-${id}`, `issue-${id}`, status);
	db.prepare(`INSERT INTO workflow_run_event
		(run_id,seq,event_uid,kind,payload,at) VALUES(?,1,?,?,?,?)`).run(
		`run-${id}`,
		id,
		kind,
		JSON.stringify({ id }),
		at,
	);
}

function addLeadEvent(
	db: Database.Database,
	id: string,
	eventType = "session_completed",
	createdAt = OLD,
): number {
	return Number(
		db
			.prepare(`INSERT INTO lead_events
				(lead_id,event_id,event_type,payload,delivered_at,created_at)
				VALUES('lead',?,?,?, ?, ?)`)
			.run(id, eventType, JSON.stringify({ id }), OLD, createdAt)
			.lastInsertRowid,
	);
}

describe("FLY-2341 TeamLead terminal archive", () => {
	it("rides the existing detached maintenance tick once, after delivery passes", () => {
		const source = readFileSync(
			new URL("../bridge/plugin.ts", import.meta.url),
			"utf8",
		);
		const operations = source.indexOf('"delivery-contract:operations"');
		const archive = source.indexOf("store.archiveTerminalRows(");
		const residue = source.indexOf("if (residueHarvester)", operations);
		expect(operations).toBeGreaterThan(0);
		expect(archive).toBeGreaterThan(operations);
		expect(archive).toBeLessThan(residue);
		expect(source.match(/store\.archiveTerminalRows\(/g)).toHaveLength(1);
		expect(source.slice(operations, residue)).not.toContain("setInterval(");
		expect(source.slice(operations, archive)).toContain(
			"projects.every(({ projectName }) =>",
		);
		expect(source.slice(operations, archive)).toContain(
			"projects.length > 0 &&",
		);
		expect(source.slice(archive, residue)).toContain("sourceTable:");
	});

	it("archives against the production StateStore schema", async () => {
		const store = await StateStore.create(":memory:");
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		raw
			.prepare(
				"INSERT INTO sessions(execution_id,issue_id,project_name,status) VALUES(?,?,?,'completed')",
			)
			.run("production-exec", "production-issue", "flywheel");
		raw
			.prepare(`INSERT INTO session_events
			(event_id,ts,execution_id,issue_id,project_name,event_type,payload,source)
			VALUES(?,?,?,?,?,'session_completed','{}','test')`)
			.run(
				"production-event",
				OLD,
				"production-exec",
				"production-issue",
				"flywheel",
			);

		expect(store.archiveTerminalRows({ now: NOW, limit: 1 })).toEqual({
			archived: 1,
			byTable: { session_events: 1, workflow_run_event: 0, lead_events: 0 },
		});
		store.close();
	});

	it("preserves session event idempotency after the hot row is archived", async () => {
		const store = await StateStore.create(":memory:");
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		raw
			.prepare(
				"INSERT INTO sessions(execution_id,issue_id,project_name,status) VALUES(?,?,?,'completed')",
			)
			.run("cold-replay-exec", "cold-replay-issue", "flywheel");
		const event = {
			event_id: "cold-replay-event",
			execution_id: "cold-replay-exec",
			issue_id: "cold-replay-issue",
			project_name: "flywheel",
			event_type: "session_completed",
			payload: { outcome: "done" },
			source: "test",
		};
		expect(store.insertEvent(event)).toBe(true);
		raw
			.prepare("UPDATE session_events SET ts=? WHERE event_id=?")
			.run(OLD, event.event_id);
		expect(
			store.archiveTerminalRows({
				now: NOW,
				limit: 1,
				sourceTable: "session_events",
			}).archived,
		).toBe(1);

		expect(store.insertEvent(event)).toBe(false);
		expect(
			raw
				.prepare("SELECT count(*) AS n FROM session_events WHERE event_id=?")
				.get(event.event_id),
		).toEqual({ n: 0 });
		store.close();
	});

	it("preserves lead event idempotency after the hot row is archived", async () => {
		const store = await StateStore.create(":memory:");
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		expect(
			store.tryClaimLeadEvent(
				"cold-replay-lead",
				"cold-replay-alert",
				"session_completed",
				"{}",
			),
		).toBe(true);
		raw
			.prepare(
				"UPDATE lead_events SET created_at=?,delivered_at=? WHERE lead_id=? AND event_id=?",
			)
			.run(OLD, OLD, "cold-replay-lead", "cold-replay-alert");
		expect(
			store.archiveTerminalRows({
				now: NOW,
				limit: 1,
				sourceTable: "lead_events",
			}).archived,
		).toBe(1);

		expect(
			store.tryClaimLeadEvent(
				"cold-replay-lead",
				"cold-replay-alert",
				"session_completed",
				"{}",
			),
		).toBe(false);
		expect(
			raw
				.prepare(
					"SELECT count(*) AS n FROM lead_events WHERE lead_id=? AND event_id=?",
				)
				.get("cold-replay-lead", "cold-replay-alert"),
		).toEqual({ n: 0 });
		store.close();
	});

	it("keeps appendLeadEvent dedup durable after archiving", async () => {
		const store = await StateStore.create(":memory:");
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		const firstSeq = store.appendLeadEvent(
			"cold-append-lead",
			"cold-append-event",
			"session_completed",
			"{}",
		);
		raw
			.prepare("UPDATE lead_events SET created_at=?,delivered_at=? WHERE seq=?")
			.run(OLD, OLD, firstSeq);
		expect(
			store.archiveTerminalRows({
				now: NOW,
				limit: 1,
				sourceTable: "lead_events",
			}).archived,
		).toBe(1);

		expect(
			store.appendLeadEvent(
				"cold-append-lead",
				"cold-append-event",
				"session_completed",
				"{}",
			),
		).toBe(firstSeq);
		expect(
			raw
				.prepare("SELECT count(*) AS n FROM lead_events WHERE seq=?")
				.get(firstSeq),
		).toEqual({ n: 0 });
		store.close();
	});

	it("keeps direct chat-thread archive replay atomic after its audit row is cold", async () => {
		const store = await StateStore.create(":memory:");
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		store.upsertSession({
			execution_id: "thread-archive-exec",
			issue_id: "FLY-2341",
			project_name: "flywheel",
			status: "completed",
		});
		store.upsertChatThread(
			"thread-archive-id",
			"channel-archive-id",
			"FLY-2341",
			"lead",
		);
		const event = {
			event_id: "cold-thread-archive-event",
			execution_id: "thread-archive-exec",
			issue_id: "FLY-2341",
			project_name: "flywheel",
			event_type: "chat_thread_archived",
			source: "test",
			payload: { archived: true },
		};
		store.commitThreadArchive("thread-archive-id", event);
		raw
			.prepare("UPDATE session_events SET ts=? WHERE event_id=?")
			.run(OLD, event.event_id);
		expect(
			store.archiveTerminalRows({
				now: NOW,
				limit: 1,
				sourceTable: "session_events",
			}).archived,
		).toBe(1);
		const receipt = {
			version: 1 as const,
			state: "prepared" as const,
			archiveEpoch: "2026-09-04T00:00:00.000Z",
			frontier: "1",
			cause: "unknown" as const,
			at: "2026-09-04T00:00:01.000Z",
		};
		store.setChatThreadCompensationPending("thread-archive-id", receipt);

		expect(() => store.commitThreadArchive("thread-archive-id", event)).toThrow(
			/session_event_replay/,
		);
		expect(store.getChatThreadCompensationPending("thread-archive-id")).toEqual(
			receipt,
		);
		expect(
			raw
				.prepare("SELECT count(*) AS n FROM session_events WHERE event_id=?")
				.get(event.event_id),
		).toEqual({ n: 0 });
		store.close();
	});

	it("preserves checked workflow event replay semantics after archiving", async () => {
		const store = await StateStore.create(":memory:");
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		raw
			.prepare(`INSERT INTO workflow_run
			(run_id,issue_id,project_name,status,created_at)
			VALUES('cold-workflow-run','FLY-2341','flywheel','completed',?)`)
			.run(OLD);
		const event = {
			runId: "cold-workflow-run",
			eventUid: "alert_posted:cold-workflow-event",
			kind: "workflow_engine_alert_posted",
			payload: { escalationUid: "cold-workflow-event" },
		};
		expect(store.appendWorkflowRunEventChecked(event)).toEqual({
			seq: 1,
			deduped: false,
		});
		expect(
			store.archiveTerminalRows({
				now: "2100-01-01T00:00:00.000Z",
				limit: 1,
				sourceTable: "workflow_run_event",
			}).archived,
		).toBe(1);

		expect(() =>
			store.appendWorkflowRunEventChecked({
				...event,
				payload: { escalationUid: "different" },
			}),
		).toThrow(/workflow_event_uid_conflict/);
		expect(store.appendWorkflowRunEventChecked(event)).toEqual({
			seq: 1,
			deduped: true,
		});
		expect(
			raw
				.prepare(
					"SELECT count(*) AS n FROM workflow_run_event WHERE event_uid=?",
				)
				.get(event.eventUid),
		).toEqual({ n: 0 });
		store.close();
	});

	it("keeps workflow event seq monotonic across archive and restore", async () => {
		const store = await StateStore.create(":memory:");
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		raw
			.prepare(`INSERT INTO workflow_run
			(run_id,issue_id,project_name,status,created_at)
			VALUES('restore-workflow-run','FLY-2341','flywheel','completed',?)`)
			.run(OLD);
		expect(
			store.appendWorkflowRunEventChecked({
				runId: "restore-workflow-run",
				eventUid: "restore-workflow-event-1",
				kind: "workflow_engine_alert_posted",
				payload: { ordinal: 1 },
			}),
		).toEqual({ seq: 1, deduped: false });
		const sourceIdentity = String(
			(
				raw
					.prepare(
						"SELECT id FROM workflow_run_event WHERE event_uid='restore-workflow-event-1'",
					)
					.get() as { id: number }
			).id,
		);
		expect(
			store.archiveTerminalRows({
				now: "2100-01-01T00:00:00.000Z",
				limit: 1,
				sourceTable: "workflow_run_event",
			}).archived,
		).toBe(1);

		expect(
			store.appendWorkflowRunEventChecked({
				runId: "restore-workflow-run",
				eventUid: "restore-workflow-event-2",
				kind: "workflow_engine_alert_posted",
				payload: { ordinal: 2 },
			}),
		).toEqual({ seq: 2, deduped: false });
		expect(
			restoreTerminalRow(raw, {
				sourceTable: "workflow_run_event",
				sourceIdentity,
			}),
		).toEqual({ outcome: "restored" });
		expect(
			raw
				.prepare(
					"SELECT seq,event_uid FROM workflow_run_event WHERE run_id=? ORDER BY seq",
				)
				.all("restore-workflow-run"),
		).toEqual([
			{ seq: 1, event_uid: "restore-workflow-event-1" },
			{ seq: 2, event_uid: "restore-workflow-event-2" },
		]);
		store.close();
	});

	it("keeps cold replay guards on exact-match indexes", () => {
		const db = database();
		const plans = [
			db
				.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM workflow_terminal_archive
					WHERE source_table='session_events'
					  AND json_extract(row_json, '$.event_id')=? LIMIT 1`)
				.all("event") as Array<{ detail: string }>,
			db
				.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM workflow_terminal_archive
					WHERE source_table='lead_events'
					  AND json_extract(row_json, '$.lead_id')=?
					  AND json_extract(row_json, '$.event_id')=? LIMIT 1`)
				.all("lead", "event") as Array<{ detail: string }>,
			db
				.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM workflow_terminal_archive
					WHERE source_table='workflow_run_event'
					  AND json_extract(row_json, '$.event_uid')=? LIMIT 1`)
				.all("event") as Array<{ detail: string }>,
			db
				.prepare(`EXPLAIN QUERY PLAN
					SELECT CAST(json_extract(row_json,'$.seq') AS INTEGER) AS seq
					FROM workflow_terminal_archive
					INDEXED BY idx_workflow_terminal_archive_workflow_run_seq
					WHERE source_table='workflow_run_event'
					  AND json_extract(row_json,'$.run_id')=?
					ORDER BY CAST(json_extract(row_json,'$.seq') AS INTEGER) DESC
					LIMIT 1`)
				.all("run") as Array<{ detail: string }>,
		];

		expect(
			plans[0]?.some(({ detail }) =>
				detail.includes("idx_workflow_terminal_archive_session_event_id"),
			),
		).toBe(true);
		expect(
			plans[1]?.some(({ detail }) =>
				detail.includes("idx_workflow_terminal_archive_lead_event_id"),
			),
		).toBe(true);
		expect(
			plans[2]?.some(({ detail }) =>
				detail.includes("idx_workflow_terminal_archive_workflow_event_uid"),
			),
		).toBe(true);
		expect(
			plans[3]?.some(({ detail }) =>
				detail.includes("idx_workflow_terminal_archive_workflow_run_seq"),
			),
		).toBe(true);
		db.close();
	});

	it("repairs and verifies stale archive index predicates at startup", () => {
		const db = database();
		db.exec(`
			DROP INDEX idx_session_events_archive_keyset;
			CREATE INDEX idx_session_events_archive_keyset
				ON session_events(julianday(ts), id)
				WHERE event_type IN ('wrong');
			DROP INDEX idx_workflow_terminal_archive_session_event_id;
			CREATE INDEX idx_workflow_terminal_archive_session_event_id
				ON workflow_terminal_archive(json_extract(row_json,'$.wrong'))
				WHERE source_table='wrong';
			DROP INDEX idx_workflow_terminal_archive_workflow_run_seq;
			CREATE INDEX idx_workflow_terminal_archive_workflow_run_seq
				ON workflow_terminal_archive(json_extract(row_json,'$.wrong'))
				WHERE source_table='wrong';
		`);

		installTerminalRowArchiveSchema(db);
		const definitions = db
			.prepare(`SELECT name,sql FROM sqlite_master
				WHERE type='index' AND name IN (
					'idx_session_events_archive_keyset',
					'idx_workflow_terminal_archive_session_event_id',
					'idx_workflow_terminal_archive_workflow_run_seq'
				) ORDER BY name`)
			.all() as Array<{ name: string; sql: string }>;
		expect(definitions).toHaveLength(3);
		expect(definitions[0]!.sql).toContain("session_completed");
		expect(definitions[0]!.sql).not.toContain("'wrong'");
		expect(definitions[1]!.sql).toContain("$.event_id");
		expect(definitions[1]!.sql).toContain("source_table='session_events'");
		expect(definitions[2]!.sql).toContain("$.run_id");
		expect(definitions[2]!.sql).toContain("$.seq");
		expect(definitions[2]!.sql).toContain("source_table='workflow_run_event'");
		db.close();
	});

	it("replaces the historical workflow event delete guard with an exact cold-evidence guard", () => {
		const db = database();
		db.exec(`
			DROP TRIGGER IF EXISTS workflow_run_event_no_delete;
			CREATE TRIGGER workflow_run_event_no_delete
			BEFORE DELETE ON workflow_run_event
			BEGIN SELECT RAISE(ABORT, 'workflow_run_event is append-only'); END;
		`);
		installTerminalRowArchiveSchema(db);
		addWorkflowEvent(
			db,
			"historical-guard",
			"completed",
			"workflow_engine_alert_posted",
		);

		expect(archiveTerminalRows(db, { now: NOW, limit: 1 }).archived).toBe(1);
		addWorkflowEvent(db, "no-evidence", "completed", "run_completed");
		expect(() =>
			db
				.prepare("DELETE FROM workflow_run_event WHERE event_uid='no-evidence'")
				.run(),
		).toThrow(/append-only/);
		db.close();
	});

	it("uses one immutable cold table and a fixed seven-day boundary", () => {
		const db = database();
		expect(TERMINAL_ROW_RETENTION_MS).toBe(7 * 24 * 60 * 60_000);
		expect(MAX_TERMINAL_ARCHIVE_DURATION_MS).toBe(50);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_terminal_archive'",
				)
				.get(),
		).toEqual({ name: "workflow_terminal_archive" });
		const indexes = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%archive_keyset%'",
			)
			.all() as Array<{ name: string }>;
		expect(indexes.map(({ name }) => name).sort()).toEqual([
			"idx_lead_events_archive_keyset",
			"idx_session_events_archive_keyset",
			"idx_workflow_run_event_archive_keyset",
		]);
		db.prepare(`INSERT INTO workflow_terminal_archive
			(source_table,source_identity,source_created_at,archived_at,row_json,row_sha256)
			VALUES('session_events','0',?,?,?,?)`).run(
			OLD,
			NOW,
			"{}",
			createHash("sha256").update("{}").digest("hex"),
		);
		expect(() =>
			db.prepare("DELETE FROM workflow_terminal_archive").run(),
		).toThrow(/immutable/);
		db.close();
	});

	it("archives only safe old terminal narratives and obeys the total batch cap", () => {
		vi.spyOn(performance, "now").mockReturnValue(0);
		const db = database();
		addSessionEvent(db, "eligible-session", "completed", "session_completed");
		addSessionEvent(db, "active-session", "running", "session_completed");
		addSessionEvent(
			db,
			"recent-session",
			"completed",
			"session_completed",
			RECENT,
		);
		addSessionEvent(db, "authority-session", "completed", "gate_question");
		addSessionEvent(db, "durable-claim", "completed", "external_merge_suspect");
		addSessionEvent(db, "held-node", "completed", "session_completed");
		db.prepare(
			"INSERT INTO workflow_run(run_id,issue_id,status) VALUES('held-run','held-issue','held')",
		).run();
		db.prepare(
			"INSERT INTO workflow_run_node(run_id,execution_id) VALUES('held-run','exec-held-node')",
		).run();
		addSessionEvent(db, "comm-active", "completed", "session_completed");
		addWorkflowEvent(
			db,
			"eligible-workflow",
			"terminated",
			"workflow_engine_alert_posted",
		);
		addWorkflowEvent(
			db,
			"active-workflow",
			"active",
			"workflow_engine_alert_posted",
		);
		addWorkflowEvent(db, "authority-workflow", "completed", "run_completed");
		const eligibleLead = addLeadEvent(db, "eligible-lead");
		const referencedLead = addLeadEvent(db, "referenced-lead");
		addLeadEvent(db, "durable-lead-claim", "external_merge_suspect");
		db.prepare(
			"INSERT INTO lead_event_delivery_attempts(attempt_id,event_seq) VALUES('a',?)",
		).run(referencedLead);

		const first = archiveTerminalRows(db, {
			now: NOW,
			limit: 2,
			activeExecutionIds: ["exec-comm-active"],
			activeIssueIds: ["issue-comm-active"],
		});
		expect(first.archived).toBe(2);
		expect(
			db.prepare("SELECT count(*) AS n FROM workflow_terminal_archive").get(),
		).toEqual({ n: 2 });
		const second = archiveTerminalRows(db, {
			now: NOW,
			limit: 2,
			activeExecutionIds: ["exec-comm-active"],
			activeIssueIds: ["issue-comm-active"],
		});
		expect(second.archived).toBe(1);
		expect(
			archiveTerminalRows(db, {
				now: NOW,
				limit: 2,
				activeExecutionIds: ["exec-comm-active"],
				activeIssueIds: ["issue-comm-active"],
			}).archived,
		).toBe(0);

		expect(
			db.prepare("SELECT event_id FROM session_events ORDER BY event_id").all(),
		).toEqual([
			{ event_id: "active-session" },
			{ event_id: "authority-session" },
			{ event_id: "comm-active" },
			{ event_id: "durable-claim" },
			{ event_id: "held-node" },
			{ event_id: "recent-session" },
		]);
		expect(
			db
				.prepare("SELECT event_uid FROM workflow_run_event ORDER BY event_uid")
				.all(),
		).toEqual([
			{ event_uid: "active-workflow" },
			{ event_uid: "authority-workflow" },
		]);
		expect(
			db.prepare("SELECT seq FROM lead_events ORDER BY seq").all(),
		).toEqual([{ seq: referencedLead }, { seq: referencedLead + 1 }]);
		expect(eligibleLead).not.toBe(referencedLead);
		db.close();
	});

	it("stops after the current bounded page at its wall-time budget", () => {
		const db = database();
		addSessionEvent(db, "budget-a", "completed", "session_completed");
		addSessionEvent(db, "budget-b", "completed", "session_completed");
		const clock = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(MAX_TERMINAL_ARCHIVE_PAGE_DURATION_MS + 1);
		try {
			expect(archiveTerminalRows(db, { now: NOW, limit: 100 }).archived).toBe(
				2,
			);
			expect(
				db.prepare("SELECT count(*) AS n FROM session_events").get(),
			).toEqual({
				n: 0,
			});
		} finally {
			clock.mockRestore();
			db.close();
		}
	});

	it("caps a call at two pages and reserves its aggregate time budget", () => {
		const candidateSelects: string[] = [];
		const db = database((sql) => {
			if (typeof sql === "string" && sql.includes("SELECT e.* FROM")) {
				candidateSelects.push(sql);
			}
		});
		addSessionEvent(
			db,
			"call-budget-session",
			"completed",
			"session_completed",
		);
		addWorkflowEvent(
			db,
			"call-budget-workflow",
			"completed",
			"workflow_engine_alert_posted",
		);
		addLeadEvent(db, "call-budget-lead");
		const pageClock = vi.spyOn(performance, "now").mockReturnValue(0);
		try {
			expect(archiveTerminalRows(db, { now: NOW, limit: 3 }).archived).toBe(2);
			expect(candidateSelects).toHaveLength(2);
		} finally {
			pageClock.mockRestore();
			db.close();
		}

		const timedSelects: string[] = [];
		const timedDb = database((sql) => {
			if (typeof sql === "string" && sql.includes("SELECT e.* FROM")) {
				timedSelects.push(sql);
			}
		});
		addSessionEvent(
			timedDb,
			"timed-call-session",
			"completed",
			"session_completed",
		);
		addWorkflowEvent(
			timedDb,
			"timed-call-workflow",
			"completed",
			"workflow_engine_alert_posted",
		);
		const callClock = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(10)
			.mockReturnValue(30);
		try {
			expect(
				archiveTerminalRows(timedDb, { now: NOW, limit: 2 }).archived,
			).toBe(1);
			expect(timedSelects).toHaveLength(1);
		} finally {
			callClock.mockRestore();
			timedDb.close();
		}
	});

	it("starts the budget before bounded keyset candidate pages", () => {
		let budgetStarted = false;
		const candidateSelects: string[] = [];
		const db = database((sql) => {
			if (
				typeof sql === "string" &&
				sql.includes("SELECT e.* FROM session_events")
			) {
				expect(budgetStarted).toBe(true);
				candidateSelects.push(sql);
			}
		});
		for (let index = 0; index < 65; index++) {
			addSessionEvent(
				db,
				`page-${String(index).padStart(2, "0")}`,
				"completed",
				"session_completed",
			);
		}
		const clock = vi.spyOn(performance, "now").mockImplementation(() => {
			budgetStarted = true;
			return 0;
		});
		try {
			expect(
				archiveTerminalRows(db, {
					now: NOW,
					limit: 65,
					sourceTable: "session_events",
				}).archived,
			).toBe(65);
			expect(candidateSelects).toHaveLength(2);
			expect(candidateSelects[1]).toContain("julianday(e.ts) > julianday(");
			expect(candidateSelects[1]).toContain("e.id > 64.0");
			const plan = db
				.prepare(`EXPLAIN QUERY PLAN ${candidateSelects[1]}`)
				.all() as Array<{ detail: string }>;
			const details = plan.map(({ detail }) => detail).join("\n");
			expect(details).toContain("idx_session_events_archive_keyset");
			expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
		} finally {
			clock.mockRestore();
			db.close();
		}
	});

	it("consumes paid keyset pages before yielding on a growing clock", () => {
		const db = database();
		for (let index = 0; index < 100; index++) {
			addSessionEvent(
				db,
				`volume-${String(index).padStart(2, "0")}`,
				"completed",
				"session_completed",
			);
		}
		const clock = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0)
			.mockReturnValue(30);
		try {
			expect(
				archiveTerminalRows(db, {
					now: NOW,
					limit: 100,
					sourceTable: "session_events",
				}).archived,
			).toBe(64);
		} finally {
			clock.mockRestore();
			db.close();
		}
	});

	it("resumes the keyset cursor on the next tick after a budget yield", () => {
		const candidateSelects: string[] = [];
		const db = database((sql) => {
			if (
				typeof sql === "string" &&
				sql.includes("SELECT e.* FROM session_events")
			) {
				candidateSelects.push(sql);
			}
		});
		for (let index = 0; index < 70; index++) {
			addSessionEvent(
				db,
				`resume-${String(index).padStart(2, "0")}`,
				"completed",
				"session_completed",
			);
		}
		const clock = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0)
			.mockReturnValue(30);
		try {
			expect(
				archiveTerminalRows(db, {
					now: NOW,
					limit: 70,
					sourceTable: "session_events",
				}).archived,
			).toBe(64);
			candidateSelects.length = 0;
			clock.mockReturnValue(0);
			expect(
				archiveTerminalRows(db, {
					now: NOW,
					limit: 70,
					sourceTable: "session_events",
				}).archived,
			).toBe(6);
			expect(candidateSelects[0]).toContain("e.id > 64.0");
		} finally {
			clock.mockRestore();
			db.close();
		}
	});

	it("can isolate one source table per maintenance tick", () => {
		const db = database();
		addSessionEvent(db, "table-session", "completed", "session_completed");
		addWorkflowEvent(
			db,
			"table-workflow",
			"completed",
			"workflow_engine_alert_posted",
		);

		expect(
			archiveTerminalRows(db, {
				now: NOW,
				limit: 1,
				sourceTable: "workflow_run_event",
			}).byTable,
		).toEqual({ session_events: 0, workflow_run_event: 1, lead_events: 0 });
		expect(
			db.prepare("SELECT count(*) AS n FROM session_events").get(),
		).toEqual({
			n: 1,
		});
		db.close();
	});

	it("rolls back a digest conflict and restores exact rows without deleting evidence", () => {
		const db = database();
		addSessionEvent(db, "conflict", "completed", "session_completed");
		const row = db.prepare("SELECT * FROM session_events").get() as Record<
			string,
			unknown
		>;
		db.prepare(`INSERT INTO workflow_terminal_archive
			(source_table,source_identity,source_created_at,archived_at,row_json,row_sha256)
			VALUES('session_events',?,?,?,?,?)`).run(
			String(row.id),
			OLD,
			NOW,
			JSON.stringify({ wrong: true }),
			createHash("sha256").update("wrong").digest("hex"),
		);
		expect(() => archiveTerminalRows(db, { now: NOW, limit: 1 })).toThrow(
			/archive_digest_conflict/,
		);
		expect(db.prepare("SELECT event_id FROM session_events").get()).toEqual({
			event_id: "conflict",
		});
		db.close();
	});

	it("restores an archived row byte-for-byte and leaves the cold row immutable", () => {
		const db = database();
		addSessionEvent(db, "restore", "completed", "session_completed");
		const before = db.prepare("SELECT * FROM session_events").get();
		archiveTerminalRows(db, { now: NOW, limit: 1 });
		expect(db.prepare("SELECT * FROM session_events").get()).toBeUndefined();
		expect(
			restoreTerminalRow(db, {
				sourceTable: "session_events",
				sourceIdentity: "1",
			}),
		).toEqual({ outcome: "restored" });
		expect(db.prepare("SELECT * FROM session_events").get()).toEqual(before);
		expect(
			restoreTerminalRow(db, {
				sourceTable: "session_events",
				sourceIdentity: "1",
			}),
		).toEqual({ outcome: "idempotent" });
		expect(
			db.prepare("SELECT count(*) AS n FROM workflow_terminal_archive").get(),
		).toEqual({ n: 1 });
		db.close();
	});
});
