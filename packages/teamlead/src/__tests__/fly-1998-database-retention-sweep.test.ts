import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertSupportedSqliteVersion,
	createFly2139ActivationReceipt,
	encodeSqliteLiteral,
	executeApply,
	executeInventory,
	executeRotateLog,
	parseFly2006Args,
	validateFly2006InventoryPaths,
} from "../../../../scripts/fly-1998-database-retention-sweep.mjs";

const NOW = "2026-08-22T12:00:00.000Z";
const OLD = "2026-07-01T00:00:00.000Z";
const RECENT = "2026-08-20T00:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

type Fixture = {
	root: string;
	teamleadDbPath: string;
	commDbPath: string;
	evidenceDir: string;
	ids: Record<string, number>;
};

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "fly1998-retention-"));
	roots.push(root);
	const teamleadDbPath = join(root, "teamlead.db");
	const commDbPath = join(root, "comm.db");
	const evidenceDir = join(root, "evidence");
	const teamlead = new Database(teamleadDbPath);
	teamlead.pragma("journal_mode = WAL");
	teamlead.exec(`
		CREATE TABLE workflow_run (
			run_id TEXT PRIMARY KEY,
			status TEXT NOT NULL
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
			UNIQUE (run_id, seq)
		);
		CREATE TRIGGER workflow_run_event_no_update
			BEFORE UPDATE ON workflow_run_event
			BEGIN SELECT RAISE(ABORT, 'workflow_run_event is append-only'); END;
		CREATE TRIGGER workflow_run_event_no_delete
			BEFORE DELETE ON workflow_run_event
			BEGIN SELECT RAISE(ABORT, 'workflow_run_event is append-only'); END;
		CREATE TABLE workflow_rework_delivery (
			request_id TEXT PRIMARY KEY,
			generation INTEGER NOT NULL,
			state TEXT NOT NULL
		);
		CREATE TABLE workflow_alert_outbox (
			escalation_uid TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			state TEXT NOT NULL
		);
		CREATE TABLE dead_letter_alerts (
			id TEXT PRIMARY KEY,
			source_kind TEXT NOT NULL,
			recipient TEXT NOT NULL,
			through_dead_seq INTEGER NOT NULL,
			lead_id TEXT NOT NULL,
			project_name TEXT NOT NULL,
			dead_count INTEGER NOT NULL,
			summary TEXT NOT NULL,
			state TEXT NOT NULL,
			created_at TEXT NOT NULL,
			attempted_at TEXT,
			reclaim_at TEXT,
			accepted_at TEXT,
			claim_token TEXT,
			last_error TEXT
		);
		CREATE TABLE session_events (
			id INTEGER PRIMARY KEY,
			event_type TEXT NOT NULL,
			source TEXT NOT NULL,
			ts TEXT NOT NULL
		);
		CREATE INDEX idx_events_type_ts ON session_events(event_type, ts);
		CREATE TABLE sessions (
			execution_id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			terminal_at TEXT
		);
	`);
	teamlead
		.prepare("INSERT INTO workflow_run (run_id, status) VALUES (?, ?)")
		.run("terminal", "completed");
	teamlead
		.prepare("INSERT INTO workflow_run (run_id, status) VALUES (?, ?)")
		.run("active", "active");
	teamlead
		.prepare("INSERT INTO workflow_run (run_id, status) VALUES (?, ?)")
		.run("held", "held");
	const insertDelivery = teamlead.prepare(
		"INSERT INTO workflow_rework_delivery (request_id, generation, state) VALUES (?, ?, 'completed')",
	);
	for (const requestId of [
		"claim",
		"release",
		"recent",
		"active",
		"held",
		"invalid",
		"late-added",
	]) {
		insertDelivery.run(requestId, 3);
	}
	teamlead
		.prepare(
			"INSERT INTO workflow_alert_outbox (escalation_uid, run_id, state) VALUES (?, 'terminal', ?)",
		)
		.run("alert-enqueued", "sent");
	teamlead
		.prepare(
			"INSERT INTO workflow_alert_outbox (escalation_uid, run_id, state) VALUES (?, 'terminal', ?)",
		)
		.run("alert-posted", "sent");
	teamlead
		.prepare(
			"INSERT INTO workflow_alert_outbox (escalation_uid, run_id, state) VALUES (?, 'terminal', ?)",
		)
		.run("alert-pending", "pending");
	const insertEvent = teamlead.prepare(`
		INSERT INTO workflow_run_event (run_id, seq, event_uid, kind, payload, at)
		VALUES (@runId, @seq, @eventUid, @kind, @payload, @at)
	`);
	let seq = 0;
	const addEvent = (input: {
		runId?: string;
		eventUid: string;
		kind: string;
		payload?: unknown;
		at?: string;
	}) =>
		Number(
			insertEvent.run({
				runId: input.runId ?? "terminal",
				seq: ++seq,
				eventUid: input.eventUid,
				kind: input.kind,
				payload: JSON.stringify(input.payload ?? {}),
				at: input.at ?? OLD,
			}).lastInsertRowid,
		);
	const ids = {
		claim: addEvent({
			eventUid: "rework_delivery_claimed:claim:1",
			kind: "rework_delivery_claimed",
			payload: { requestId: "claim", generation: 1 },
		}),
		release: addEvent({
			eventUid: "rework_delivery_released:release:1",
			kind: "rework_delivery_released",
			payload: { requestId: "release", generation: 1 },
		}),
		enqueued: addEvent({
			eventUid: "alert_enqueued:alert-enqueued",
			kind: "workflow_engine_alert_enqueued",
			payload: { escalationUid: "alert-enqueued" },
		}),
		posted: addEvent({
			eventUid: "alert_posted:alert-posted",
			kind: "workflow_engine_alert_posted",
			payload: { escalationUid: "alert-posted" },
		}),
		fence: addEvent({
			eventUid: "run_terminated:terminal:operator",
			kind: "run_terminated_by_operator",
		}),
		active: addEvent({
			runId: "active",
			eventUid: "rework_delivery_claimed:active:1",
			kind: "rework_delivery_claimed",
			payload: { requestId: "active", generation: 1 },
		}),
		held: addEvent({
			runId: "held",
			eventUid: "rework_delivery_claimed:held:1",
			kind: "rework_delivery_claimed",
			payload: { requestId: "held", generation: 1 },
		}),
		recent: addEvent({
			eventUid: "rework_delivery_claimed:recent:1",
			kind: "rework_delivery_claimed",
			payload: { requestId: "recent", generation: 1 },
			at: RECENT,
		}),
		invalid: addEvent({
			eventUid: "rework_delivery_claimed:invalid:1",
			kind: "rework_delivery_claimed",
			payload: { requestId: "invalid", generation: 1 },
			at: "not-a-time",
		}),
		unbacked: addEvent({
			eventUid: "rework_delivery_claimed:missing:1",
			kind: "rework_delivery_claimed",
			payload: { requestId: "missing", generation: 1 },
		}),
		pendingAlert: addEvent({
			eventUid: "alert_enqueued:alert-pending",
			kind: "workflow_engine_alert_enqueued",
			payload: { escalationUid: "alert-pending" },
		}),
	};
	teamlead
		.prepare(`
		INSERT INTO dead_letter_alerts
		(id, source_kind, recipient, through_dead_seq, lead_id, project_name,
		 dead_count, summary, state, created_at, accepted_at)
		VALUES (?, 'lead_unacked', 'lead', 1, 'lead', 'flywheel', 1, 'old', ?, ?, ?)
	`)
		.run("dead-'quoted", "accepted", OLD, OLD);
	teamlead
		.prepare(`
		INSERT INTO dead_letter_alerts
		(id, source_kind, recipient, through_dead_seq, lead_id, project_name,
		 dead_count, summary, state, created_at, accepted_at)
		VALUES ('dead-pending', 'lead_unacked', 'lead', 2, 'lead', 'flywheel', 1, 'pending', 'pending', ?, NULL)
	`)
		.run(OLD);
	teamlead
		.prepare(
			"INSERT INTO session_events (id, event_type, source, ts) VALUES (1, 'issue_thread_infra_notify_skipped', 'bridge.founder-thread-notifier', '2026-08-02 00:00:00')",
		)
		.run();
	teamlead
		.prepare("INSERT INTO sessions VALUES ('old-team-session', 'completed', ?)")
		.run(OLD);
	teamlead.close();

	const comm = new Database(commDbPath);
	comm.pragma("journal_mode = WAL");
	comm.exec(`
		CREATE TABLE mailbox (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			checkpoint TEXT,
			from_agent TEXT NOT NULL,
			to_agent TEXT,
			relay_state TEXT NOT NULL,
			ref_id TEXT,
			resolved_via TEXT,
			created_at TEXT
		);
		CREATE TABLE mailbox_log (
			log_seq INTEGER PRIMARY KEY,
			event TEXT NOT NULL,
			message_id TEXT,
			row_json TEXT,
			at TEXT NOT NULL
		);
		CREATE TABLE mailbox_identity (
			message_id TEXT PRIMARY KEY,
			archived_at TEXT
		);
		CREATE TABLE sessions (
			execution_id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			terminal_at TEXT
		);
		CREATE TABLE receipt_alert_outbox (
			id TEXT PRIMARY KEY,
			state TEXT NOT NULL
		);
	`);
	comm
		.prepare(
			"INSERT INTO mailbox VALUES ('voice-1','question',NULL,'voice-honeylemon-fly1911','lead','open',NULL,NULL,?)",
		)
		.run(OLD);
	comm
		.prepare(
			"INSERT INTO mailbox VALUES ('forensic-1','question',NULL,'voice-honeylemon-fly1911','lead','terminal_disposed',NULL,'fly1995_sessionless_ask',?)",
		)
		.run(OLD);
	comm
		.prepare(
			"INSERT INTO mailbox_log VALUES (1,'archived','archived-1','{}',?)",
		)
		.run(OLD);
	comm
		.prepare("INSERT INTO mailbox_identity VALUES ('archived-1', ?)")
		.run(OLD);
	comm
		.prepare("INSERT INTO sessions VALUES ('old-comm-session','completed',?)")
		.run(OLD);
	comm
		.prepare(
			"INSERT INTO receipt_alert_outbox VALUES ('pending-receipt','pending')",
		)
		.run();
	comm.close();

	return { root, teamleadDbPath, commDbPath, evidenceDir, ids };
}

async function withHealthServer<T>(
	run: (url: string) => Promise<T>,
	status = 200,
): Promise<T> {
	const server = createServer((_request, response) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end('{"ok":true}');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("health_server_address_missing");
	try {
		return await run(`http://127.0.0.1:${address.port}/health`);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

async function inventory(fixture: Fixture) {
	return withHealthServer((healthUrl) =>
		executeInventory({
			teamleadDbPath: fixture.teamleadDbPath,
			commDbPath: fixture.commDbPath,
			evidenceDir: fixture.evidenceDir,
			healthUrl,
			now: NOW,
			healthSampleCount: 2,
			healthTimeoutMs: 250,
			allowFixturePaths: true,
		}),
	);
}

function allEventIds(dbPath: string): number[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare("SELECT id FROM workflow_run_event ORDER BY id")
			.all()
			.map((row) => Number((row as { id: number }).id));
	} finally {
		db.close();
	}
}

function addBulkWorkflowEvents(fixture: Fixture, count = 205) {
	const db = new Database(fixture.teamleadDbPath);
	let seq = Number(
		(
			db.prepare("SELECT max(seq) AS seq FROM workflow_run_event").get() as {
				seq: number;
			}
		).seq,
	);
	const insertDelivery = db.prepare(
		"INSERT INTO workflow_rework_delivery (request_id,generation,state) VALUES (?,1,'completed')",
	);
	const insertEvent = db.prepare(`
		INSERT INTO workflow_run_event
		(run_id,seq,event_uid,kind,payload,at)
		VALUES ('terminal',? ,?,'rework_delivery_claimed',?,?)
	`);
	for (let index = 0; index < count; index += 1) {
		const requestId = `bulk-${String(index).padStart(3, "0")}`;
		insertDelivery.run(requestId);
		insertEvent.run(
			++seq,
			`rework_delivery_claimed:${requestId}:1`,
			JSON.stringify({ requestId, generation: 1 }),
			OLD,
		);
	}
	db.close();
}

describe("FLY-1998 database retention sweep", () => {
	it("inventories only backed narrative rows and creates restorable mode-insert snapshots", async () => {
		const fixture = createFixture();
		const beforeBytes = new Map(
			[fixture.teamleadDbPath, fixture.commDbPath].map((path) => [
				path,
				readFileSync(path),
			]),
		);
		const result = await inventory(fixture);
		const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
		expect(manifest.targets.workflowRunEvent.primaryKeys).toEqual([
			fixture.ids.claim,
			fixture.ids.release,
			fixture.ids.enqueued,
			fixture.ids.posted,
		]);
		expect(manifest.targets.deadLetterAlerts).toBeUndefined();
		expect(manifest.measurements.health.samples).toHaveLength(2);
		expect(manifest.readonlyProof.concurrentWriterObservation.before).toEqual(
			manifest.readonlyProof.concurrentWriterObservation.after,
		);
		expect(manifest.readonlyProof.statements.length).toBeGreaterThan(10);
		expect(manifest.exclusions.fly1995.mailbox.baselineIds).toEqual([
			"forensic-1",
			"voice-1",
		]);
		expect(manifest.exclusions.fly1995.sessionEvents.count).toBe(1);
		for (const target of Object.values(manifest.targets) as Array<
			Record<string, unknown>
		>) {
			const snapshotPath = target.snapshotPath as string;
			expect(existsSync(snapshotPath)).toBe(true);
			expect(lstatSync(snapshotPath).mode & 0o777).toBe(0o600);
			expect(readFileSync(snapshotPath, "utf8")).toContain("INSERT INTO");
			expect(target.restoreVerified).toBe(true);
		}
		expect(lstatSync(fixture.evidenceDir).mode & 0o777).toBe(0o700);
		for (const [path, bytes] of beforeBytes)
			expect(readFileSync(path)).toEqual(bytes);
		expect(allEventIds(fixture.teamleadDbPath)).toContain(fixture.ids.fence);
	});

	it("applies only frozen PKs and preserves active, held, recent, invalid, authority, session, and mailbox rows", async () => {
		const fixture = createFixture();
		const { manifestPath } = await inventory(fixture);
		const teamlead = new Database(fixture.teamleadDbPath);
		const nextSeq =
			Number(
				(
					teamlead
						.prepare("SELECT max(seq) AS seq FROM workflow_run_event")
						.get() as { seq: number }
				).seq,
			) + 1;
		const lateId = Number(
			teamlead
				.prepare(`
				INSERT INTO workflow_run_event
				(run_id, seq, event_uid, kind, payload, at)
				VALUES ('terminal', ?, 'rework_delivery_claimed:late-added:1',
				'rework_delivery_claimed', ?, ?)
			`)
				.run(
					nextSeq,
					JSON.stringify({ requestId: "late-added", generation: 1 }),
					OLD,
				).lastInsertRowid,
		);
		teamlead.close();
		const result = await withHealthServer((healthUrl) =>
			executeApply({
				manifestPath,
				healthUrl,
				healthSampleCount: 2,
				healthTimeoutMs: 250,
				allowFixturePaths: true,
			}),
		);
		expect(result.status).toBe("complete");
		const remaining = allEventIds(fixture.teamleadDbPath);
		for (const id of [
			fixture.ids.claim,
			fixture.ids.release,
			fixture.ids.enqueued,
			fixture.ids.posted,
		]) {
			expect(remaining).not.toContain(id);
		}
		for (const id of [
			fixture.ids.fence,
			fixture.ids.active,
			fixture.ids.held,
			fixture.ids.recent,
			fixture.ids.invalid,
			fixture.ids.unbacked,
			fixture.ids.pendingAlert,
			lateId,
		]) {
			expect(remaining).toContain(id);
		}
		const teamleadAfter = new Database(fixture.teamleadDbPath);
		expect(
			teamleadAfter.prepare("SELECT count(*) AS n FROM sessions").get(),
		).toEqual({ n: 1 });
		expect(
			teamleadAfter
				.prepare("SELECT count(*) AS n FROM dead_letter_alerts")
				.get(),
		).toEqual({ n: 2 });
		expect(() =>
			teamleadAfter
				.prepare("DELETE FROM workflow_run_event WHERE id = ?")
				.run(fixture.ids.fence),
		).toThrow("append-only");
		teamleadAfter.close();
		const commAfter = new Database(fixture.commDbPath, { readonly: true });
		expect(
			commAfter.prepare("SELECT count(*) AS n FROM mailbox").get(),
		).toEqual({ n: 2 });
		expect(
			commAfter.prepare("SELECT count(*) AS n FROM mailbox_log").get(),
		).toEqual({ n: 1 });
		expect(
			commAfter.prepare("SELECT count(*) AS n FROM mailbox_identity").get(),
		).toEqual({ n: 1 });
		commAfter.close();
	});

	it("allows FLY-1995 mailbox state transition but rejects a disappearing baseline id", async () => {
		const fixture = createFixture();
		const first = await inventory(fixture);
		const comm = new Database(fixture.commDbPath);
		comm
			.prepare(
				"UPDATE mailbox SET relay_state='terminal_disposed', resolved_via='fly1995_sessionless_ask' WHERE id='voice-1'",
			)
			.run();
		comm.close();
		await expect(
			withHealthServer((healthUrl) =>
				executeApply({
					manifestPath: first.manifestPath,
					healthUrl,
					healthSampleCount: 1,
					healthTimeoutMs: 250,
					allowFixturePaths: true,
				}),
			),
		).resolves.toMatchObject({ status: "complete" });

		const secondFixture = createFixture();
		const second = await inventory(secondFixture);
		const secondComm = new Database(secondFixture.commDbPath);
		secondComm.prepare("DELETE FROM mailbox WHERE id='voice-1'").run();
		secondComm.close();
		await expect(
			withHealthServer((healthUrl) =>
				executeApply({
					manifestPath: second.manifestPath,
					healthUrl,
					healthSampleCount: 1,
					healthTimeoutMs: 250,
					allowFixturePaths: true,
				}),
			),
		).rejects.toThrow("fly1995_mailbox_baseline_missing");
	});

	it("rejects concurrent mutation of the exact FLY-1995 session-events cohort", async () => {
		const fixture = createFixture();
		const result = await inventory(fixture);
		const db = new Database(fixture.teamleadDbPath);
		db.prepare("DELETE FROM session_events WHERE id=1").run();
		db.close();
		await expect(
			withHealthServer((healthUrl) =>
				executeApply({
					manifestPath: result.manifestPath,
					healthUrl,
					healthSampleCount: 1,
					healthTimeoutMs: 250,
					allowFixturePaths: true,
				}),
			),
		).rejects.toThrow("fly1995_session_events_changed");
	});

	it("fails closed on CAS drift and snapshot tampering without losing the append-only trigger", async () => {
		const fixture = createFixture();
		const inventoryResult = await inventory(fixture);
		const manifest = JSON.parse(
			readFileSync(inventoryResult.manifestPath, "utf8"),
		);
		const db = new Database(fixture.teamleadDbPath);
		db.prepare(
			"UPDATE workflow_run SET status='active' WHERE run_id='terminal'",
		).run();
		db.close();
		await expect(
			withHealthServer((healthUrl) =>
				executeApply({
					manifestPath: inventoryResult.manifestPath,
					healthUrl,
					healthSampleCount: 1,
					healthTimeoutMs: 250,
					allowFixturePaths: true,
				}),
			),
		).rejects.toThrow("candidate_cas_mismatch");
		expect(allEventIds(fixture.teamleadDbPath)).toContain(fixture.ids.claim);
		const triggerDb = new Database(fixture.teamleadDbPath);
		expect(() =>
			triggerDb
				.prepare("DELETE FROM workflow_run_event WHERE id = ?")
				.run(fixture.ids.claim),
		).toThrow("append-only");
		triggerDb.close();

		const tampered = createFixture();
		const tamperedInventory = await inventory(tampered);
		const tamperedManifest = JSON.parse(
			readFileSync(tamperedInventory.manifestPath, "utf8"),
		);
		writeFileSync(
			tamperedManifest.targets.workflowRunEvent.snapshotPath,
			"tampered\n",
			{ flag: "a" },
		);
		await expect(
			withHealthServer((healthUrl) =>
				executeApply({
					manifestPath: tamperedInventory.manifestPath,
					healthUrl,
					healthSampleCount: 1,
					healthTimeoutMs: 250,
					allowFixturePaths: true,
				}),
			),
		).rejects.toThrow("snapshot_digest_mismatch");
		expect(manifest.targets.workflowRunEvent.primaryKeys).toHaveLength(4);
	});

	it("pins SQLite 3.42 and round-trips hostile text PK literals", () => {
		expect(() => assertSupportedSqliteVersion("3.41.2")).toThrow(
			"sqlite_version_unsupported",
		);
		expect(() => assertSupportedSqliteVersion("3.42.0")).not.toThrow();
		const value = "dead-'; DROP TABLE dead_letter_alerts; --";
		const literal = encodeSqliteLiteral(value);
		const db = new Database(":memory:");
		expect(
			(db.prepare(`SELECT ${literal} AS value`).get() as { value: string })
				.value,
		).toBe(value);
		db.close();
	});

	it("keeps FLY-2006 inventory independent from an absent FLY-2139 root", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-paths-"));
		roots.push(root);
		const teamleadDbPath = join(root, ".flywheel", "teamlead.db");
		const commDbPath = join(root, ".flywheel", "comm", "flywheel", "comm.db");
		const evidenceRoot = join(root, ".flywheel", "maintenance", "fly-2006");
		const evidenceDir = join(evidenceRoot, "run-1");
		mkdirSync(join(root, ".flywheel", "comm", "flywheel"), { recursive: true });
		mkdirSync(evidenceRoot, { recursive: true });
		writeFileSync(teamleadDbPath, "");
		writeFileSync(commDbPath, "");
		expect(() =>
			validateFly2006InventoryPaths({
				homeDir: root,
				teamleadDbPath,
				commDbPath,
				evidenceDir,
			}),
		).not.toThrow();
		expect(existsSync(join(root, ".flywheel", "maintenance", "fly-2139"))).toBe(
			false,
		);
	});

	it("keeps every non-fixture consumer bound to the exported path validator", () => {
		const source = readFileSync(
			new URL(
				"../../../../scripts/lib/fly-2006-retention-engine.mjs",
				import.meta.url,
			),
			"utf8",
		);
		expect(source).not.toMatch(/\bvalidateInventoryPaths\s*\(/);
		expect(source.match(/\bvalidateFly2006InventoryPaths\s*\(/g)).toHaveLength(
			5,
		);
	});

	it("mints the exact canonical activation receipt through the shipped CLI contract", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2139-activation-"));
		roots.push(root);
		const activationReceiptPath = join(
			root,
			".flywheel",
			"state",
			"log-janitor",
			"db-retention-activation.json",
		);
		const parsed = parseFly2006Args([
			"activation-receipt",
			"--activation-receipt",
			activationReceiptPath,
			"--approved-by",
			"flywheel-eng-lead",
			"--approved-at",
			NOW,
		]);
		expect(parsed.command).toBe("activation-receipt");
		const result = createFly2139ActivationReceipt({
			homeDir: root,
			activationReceiptPath,
			approvedBy: parsed["--approved-by"],
			approvedAt: parsed["--approved-at"],
		});
		expect(result.status).toBe("complete");
		expect(statSync(activationReceiptPath).mode & 0o777).toBe(0o600);
		expect(
			JSON.parse(readFileSync(activationReceiptPath, "utf8")),
		).toMatchObject({
			issue: "FLY-2139",
			approvedBy: "flywheel-eng-lead",
			approvedAt: NOW,
		});
		expect(() =>
			createFly2139ActivationReceipt({
				homeDir: root,
				activationReceiptPath,
				approvedBy: "flywheel-eng-lead",
				approvedAt: NOW,
			}),
		).toThrow("activation_receipt_exists");
	});

	it("commits more than 200 frozen rows in sealed batches and resumes idempotently", async () => {
		const fixture = createFixture();
		addBulkWorkflowEvents(fixture);
		const inventoryResult = await inventory(fixture);
		const applyResult = await withHealthServer((healthUrl) =>
			executeApply({
				manifestPath: inventoryResult.manifestPath,
				healthUrl,
				healthSampleCount: 1,
				healthTimeoutMs: 250,
				allowFixturePaths: true,
			}),
		);
		expect(applyResult.deleted.workflowRunEvent).toBe(209);
		expect(applyResult.deleted.deadLetterAlerts).toBeUndefined();
		for (const batch of ["0001", "0002"]) {
			const receipt = join(
				fixture.evidenceDir,
				"receipts",
				`workflow_run_event-${batch}.json`,
			);
			expect(existsSync(receipt)).toBe(true);
			expect(existsSync(`${receipt}.sha256`)).toBe(true);
		}
		rmSync(applyResult.applyReceiptPath);
		rmSync(`${applyResult.applyReceiptPath}.sha256`);
		rmSync(
			join(
				fixture.evidenceDir,
				"receipts",
				"workflow_run_event-0001.json.sha256",
			),
		);
		const resumed = await executeApply({
			manifestPath: inventoryResult.manifestPath,
			healthSampleCount: 1,
			healthTimeoutMs: 250,
			allowFixturePaths: true,
		});
		expect(resumed).toMatchObject({ status: "complete" });
		expect(resumed.deleted.workflowRunEvent).toBe(209);
		expect(
			existsSync(
				join(
					fixture.evidenceDir,
					"receipts",
					"workflow_run_event-0001.json.sha256",
				),
			),
		).toBe(true);
	});

	it("records an explicit partial-apply marker when a later batch rolls back", async () => {
		const fixture = createFixture();
		addBulkWorkflowEvents(fixture);
		const db = new Database(fixture.teamleadDbPath);
		db.exec(`
			CREATE TABLE force_second_batch_control (block INTEGER NOT NULL);
			INSERT INTO force_second_batch_control VALUES (1);
			CREATE TRIGGER force_second_batch_failure
			BEFORE DELETE ON workflow_run_event
			WHEN OLD.event_uid='rework_delivery_claimed:bulk-200:1'
			 AND EXISTS (SELECT 1 FROM force_second_batch_control WHERE block=1)
			BEGIN SELECT RAISE(ABORT, 'force second batch rollback'); END;
		`);
		db.close();
		const inventoryResult = await inventory(fixture);
		await expect(
			withHealthServer((healthUrl) =>
				executeApply({
					manifestPath: inventoryResult.manifestPath,
					healthUrl,
					healthSampleCount: 1,
					healthTimeoutMs: 250,
					allowFixturePaths: true,
				}),
			),
		).rejects.toThrow("force second batch rollback");
		const partialPath = join(fixture.evidenceDir, "apply-partial.json");
		expect(existsSync(partialPath)).toBe(true);
		const partial = JSON.parse(readFileSync(partialPath, "utf8")) as {
			status: string;
			committedBatches: number;
		};
		expect(partial.status).toBe("partial");
		expect(partial.committedBatches).toBe(1);
		expect(allEventIds(fixture.teamleadDbPath)).not.toContain(
			fixture.ids.claim,
		);
		const unblock = new Database(fixture.teamleadDbPath);
		unblock.prepare("DELETE FROM force_second_batch_control").run();
		unblock.close();
		const resumed = await withHealthServer((healthUrl) =>
			executeApply({
				manifestPath: inventoryResult.manifestPath,
				healthUrl,
				healthSampleCount: 1,
				healthTimeoutMs: 250,
				allowFixturePaths: true,
			}),
		);
		expect(resumed.deleted.workflowRunEvent).toBe(209);
		expect(resumed.supersedesPartial).toMatchObject({
			path: realpathSync(partialPath),
			committedBatches: 1,
		});
	});

	it("keeps all 20-style health failures as explicit samples", async () => {
		const fixture = createFixture();
		const result = await withHealthServer(
			(healthUrl) =>
				executeInventory({
					teamleadDbPath: fixture.teamleadDbPath,
					commDbPath: fixture.commDbPath,
					evidenceDir: fixture.evidenceDir,
					healthUrl,
					now: NOW,
					healthSampleCount: 3,
					healthTimeoutMs: 250,
					allowFixturePaths: true,
				}),
			503,
		);
		const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
		expect(manifest.measurements.health.samples).toHaveLength(3);
		expect(manifest.measurements.health.successCount).toBe(0);
		expect(
			manifest.measurements.health.samples.map(
				(sample: { status: number }) => sample.status,
			),
		).toEqual([503, 503, 503]);
	});

	it("rotates only with absent launchd job, free port, and zero holders", async () => {
		const fixture = createFixture();
		const inventoryResult = await inventory(fixture);
		const applyResult = await withHealthServer((healthUrl) =>
			executeApply({
				manifestPath: inventoryResult.manifestPath,
				healthUrl,
				healthSampleCount: 1,
				healthTimeoutMs: 250,
				allowFixturePaths: true,
			}),
		);
		const logPath = join(fixture.root, "flywheel-bridge.log");
		writeFileSync(logPath, "current");
		writeFileSync(`${logPath}.1`, "one");
		writeFileSync(`${logPath}.2`, "two");
		const oldInode = statSync(logPath).ino;
		const manifest = JSON.parse(
			readFileSync(inventoryResult.manifestPath, "utf8"),
		) as { healthUrl: string };
		let probedPort: number | undefined;
		const safeHooks = {
			launchctlJobAbsent: async () => true,
			bridgePortReleased: async (port: number) => {
				probedPort = port;
				return true;
			},
			listOpenFileHolders: async () => [] as number[],
		};
		await expect(
			executeRotateLog({
				manifestPath: inventoryResult.manifestPath,
				applyReceiptPath: applyResult.applyReceiptPath,
				bridgeLogPath: logPath,
				allowFixturePaths: true,
				testHooks: { ...safeHooks, launchctlJobAbsent: async () => false },
			}),
		).rejects.toThrow("bridge_launchd_job_loaded");
		await expect(
			executeRotateLog({
				manifestPath: inventoryResult.manifestPath,
				applyReceiptPath: applyResult.applyReceiptPath,
				bridgeLogPath: logPath,
				allowFixturePaths: true,
				testHooks: { ...safeHooks, listOpenFileHolders: async () => [42] },
			}),
		).rejects.toThrow("bridge_log_has_open_holders");
		let currentPathProbes = 0;
		await expect(
			executeRotateLog({
				manifestPath: inventoryResult.manifestPath,
				applyReceiptPath: applyResult.applyReceiptPath,
				bridgeLogPath: logPath,
				allowFixturePaths: true,
				testHooks: {
					...safeHooks,
					listOpenFileHolders: async (path: string) => {
						if (path === logPath && ++currentPathProbes === 2) return [99];
						return [];
					},
				},
			}),
		).rejects.toThrow("bridge_log_has_open_holders");
		expect(readFileSync(logPath, "utf8")).toBe("current");
		const rotated = await executeRotateLog({
			manifestPath: inventoryResult.manifestPath,
			applyReceiptPath: applyResult.applyReceiptPath,
			bridgeLogPath: logPath,
			allowFixturePaths: true,
			testHooks: safeHooks,
		});
		expect(rotated.restoreRequired).toBe(true);
		expect(readFileSync(`${logPath}.1`, "utf8")).toBe("current");
		expect(readFileSync(`${logPath}.2`, "utf8")).toBe("one");
		expect(readFileSync(`${logPath}.3`, "utf8")).toBe("two");
		expect(statSync(`${logPath}.1`).ino).toBe(oldInode);
		expect(statSync(logPath).ino).not.toBe(oldInode);
		expect(statSync(logPath).size).toBe(0);
		expect(lstatSync(logPath).mode & 0o777).toBe(0o600);
		expect(probedPort).toBe(Number(new URL(manifest.healthUrl).port));
	});

	it("fences a partially completed log rotation before any rerun can rotate twice", async () => {
		const fixture = createFixture();
		const inventoryResult = await inventory(fixture);
		const applyResult = await withHealthServer((healthUrl) =>
			executeApply({
				manifestPath: inventoryResult.manifestPath,
				healthUrl,
				healthSampleCount: 1,
				healthTimeoutMs: 250,
				allowFixturePaths: true,
			}),
		);
		const logPath = join(fixture.root, "flywheel-bridge.log");
		writeFileSync(logPath, "current");
		writeFileSync(`${logPath}.1`, "one");
		let generationOneProbes = 0;
		await expect(
			executeRotateLog({
				manifestPath: inventoryResult.manifestPath,
				applyReceiptPath: applyResult.applyReceiptPath,
				bridgeLogPath: logPath,
				allowFixturePaths: true,
				testHooks: {
					launchctlJobAbsent: async () => true,
					bridgePortReleased: async () => true,
					listOpenFileHolders: async (path: string) => {
						if (path === `${logPath}.1` && ++generationOneProbes === 2)
							return [77];
						return [];
					},
				},
			}),
		).rejects.toThrow("rotated_bridge_log_has_open_holders");
		expect(existsSync(join(fixture.evidenceDir, "rotation-started.json"))).toBe(
			true,
		);
		expect(readFileSync(`${logPath}.1`, "utf8")).toBe("current");
		expect(readFileSync(`${logPath}.2`, "utf8")).toBe("one");
		const recovered = await executeRotateLog({
			manifestPath: inventoryResult.manifestPath,
			applyReceiptPath: applyResult.applyReceiptPath,
			bridgeLogPath: logPath,
			allowFixturePaths: true,
			testHooks: {
				launchctlJobAbsent: async () => true,
				bridgePortReleased: async () => true,
				listOpenFileHolders: async () => [],
			},
		});
		expect(recovered.status).toBe("rotated_restore_required");
		expect(recovered.recoveredFromStartedMarker).toBe(true);
		expect(readFileSync(`${logPath}.1`, "utf8")).toBe("current");
		expect(readFileSync(`${logPath}.2`, "utf8")).toBe("one");
		expect(existsSync(`${logPath}.3`)).toBe(false);
	});
});
