import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { NotificationAuditStore } from "../notification-audit-store.js";

const dbs: Database.Database[] = [];
function fixture() {
	const db = new Database(":memory:");
	dbs.push(db);
	db.exec(`CREATE TABLE lead_events(seq INTEGER PRIMARY KEY,event_id TEXT,lead_id TEXT,event_type TEXT,payload TEXT,delivery_disposition TEXT);
	 CREATE TABLE workflow_terminal_archive(source_table TEXT,source_identity TEXT,row_json TEXT,row_sha256 TEXT);
	 CREATE TABLE sessions(execution_id TEXT,project_name TEXT);
	 CREATE TABLE workflow_run(run_id TEXT,project_name TEXT);`);
	const audit = new NotificationAuditStore(db);
	return { db, audit };
}
function add(
	db: Database.Database,
	seq: number,
	payload: unknown = { project_name: "p", execution_id: "exec-exact" },
	lead = "lead",
) {
	db.prepare("INSERT INTO lead_events VALUES(?,?,?,?,?,?)").run(
		seq,
		`e-${seq}`,
		lead,
		"stage_changed",
		JSON.stringify(payload),
		"audit_only",
	);
}
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});

it("counts the complete multi-page range while representatives and later inserts remain bounded", () => {
	const { db, audit } = fixture();
	audit.install();
	for (let seq = 1; seq <= 151; seq++) add(db, seq);
	const first = audit.snapshot({ projectName: "p", leadId: "lead" });
	expect(first).toMatchObject({
		total: 151,
		counts: { stage_changed: 151 },
		throughSeq: 151,
	});
	expect(first.representatives).toHaveLength(1);
	add(db, 152);
	const second = audit.snapshot(
		{ projectName: "p", leadId: "lead" },
		{
			storeEpoch: first.generation,
			offeredThroughSeq: first.throughSeq,
			anchorEventId: first.anchorEventId,
		},
	);
	expect(second).toMatchObject({ total: 1, fromSeq: 151, throughSeq: 152 });
	// A rebuilt CommDB supplies no cursor: replay from the durable migration boundary.
	expect(audit.snapshot({ projectName: "p", leadId: "lead" }).total).toBe(152);
});

it("initializes one durable boundary before new audits and preserves it on reopen", () => {
	const { db, audit } = fixture();
	add(db, 10);
	audit.install();
	const first = audit.generation();
	expect(first).toMatchObject({
		startSeq: 10,
		startEventId: "e-10",
		recovered: false,
	});
	add(db, 11);
	const second = new NotificationAuditStore(db);
	second.install();
	expect(second.generation()).toEqual(first);
});
it("reads only exact project and lead, including authoritative missing-project bindings", () => {
	const { db, audit } = fixture();
	audit.install();
	add(db, 1);
	add(db, 2, { project_name: "other" });
	add(db, 3, { project_name: "p" }, "another-lead");
	db.prepare("INSERT INTO sessions VALUES(?,?)").run("bound", "p");
	add(db, 4, { execution_id: "bound" });
	add(db, 5, { execution_id: "missing" });
	db.prepare("INSERT INTO workflow_run VALUES(?,?)").run("wf", "p");
	add(db, 6, { workflow_run_id: "wf" });
	expect(
		audit
			.page({ projectName: "p", leadId: "lead", afterSeq: 0, throughSeq: 6 })
			.items.map((r) => r.seq),
	).toEqual([6, 4, 1]);
});
it("merges verified cold rows without losing pagination or double counting restored rows", () => {
	const { db, audit } = fixture();
	audit.install();
	add(db, 1);
	add(db, 2);
	add(db, 3);
	const row = db.prepare("SELECT * FROM lead_events WHERE seq=2").get();
	const json = JSON.stringify(row);
	db.prepare("INSERT INTO workflow_terminal_archive VALUES(?,?,?,?)").run(
		"lead_events",
		"2",
		json,
		createHash("sha256").update(json).digest("hex"),
	);
	expect(
		audit.page({
			projectName: "p",
			leadId: "lead",
			afterSeq: 0,
			throughSeq: 3,
			limit: 2,
		}),
	).toMatchObject({ items: [{ seq: 3 }, { seq: 2 }], nextCursor: "2" });
	db.prepare("DELETE FROM lead_events WHERE seq=2").run();
	expect(audit.anchor(2)).toBe("e-2");
	expect(
		audit
			.page({
				projectName: "p",
				leadId: "lead",
				afterSeq: 0,
				throughSeq: 3,
				beforeSeq: 2,
			})
			.items.map((r) => r.seq),
	).toEqual([1]);
	db.prepare("UPDATE workflow_terminal_archive SET row_sha256=?").run(
		"0".repeat(64),
	);
	expect(() =>
		audit.page({
			projectName: "p",
			leadId: "lead",
			afterSeq: 0,
			throughSeq: 3,
		}),
	).toThrow("archive_digest_invalid");
});
it("detects rollback/anchor replacement and starts a repeat-marked epoch without skipping surviving audits", () => {
	const { db, audit } = fixture();
	add(db, 5);
	audit.install();
	const first = audit.generation();
	add(db, 6);
	const cursor = { offeredThroughSeq: 6, anchorEventId: "e-6" };
	db.prepare("DELETE FROM lead_events WHERE seq=6").run();
	const next = audit.reconcile(cursor);
	expect(next.generation).not.toBe(first.generation);
	expect(next).toMatchObject({ startSeq: 5, recovered: true });
	db.prepare("UPDATE lead_events SET event_id='different' WHERE seq=5").run();
	expect(audit.reconcile()).toMatchObject({
		startSeq: 0,
		startEventId: null,
		recovered: true,
	});
});
it("missing generation and corrupt boundary never reset to current max and lose rows", () => {
	const { db, audit } = fixture();
	audit.install();
	add(db, 9);
	db.exec("DELETE FROM notification_audit_generation");
	expect(audit.reconcile()).toMatchObject({
		startSeq: 0,
		startEventId: null,
		recovered: true,
	});
	expect(() =>
		audit.page({
			projectName: "p",
			leadId: "lead",
			afterSeq: 10,
			throughSeq: 9,
		}),
	).toThrow("invalid_audit_page");
	expect(() =>
		audit.page({ projectName: "p", leadId: "lead", storeEpoch: "old" }),
	).toThrow("audit_store_epoch_mismatch");
});
