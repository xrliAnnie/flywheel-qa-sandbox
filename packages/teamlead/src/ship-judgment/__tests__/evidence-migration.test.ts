import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { migrateEvidenceLedger } from "../evidence-migration.js";
import { bindingFixture } from "./binding-fixture.js";

function legacyFixture(withRows = true, path = ":memory:"): Database.Database {
	const db = new Database(path);
	db.pragma("foreign_keys=ON");
	db.exec(`CREATE TABLE workflow_run(run_id TEXT PRIMARY KEY,project_name TEXT);
		CREATE TABLE workflow_gate_holder(question_id TEXT PRIMARY KEY,run_id TEXT REFERENCES workflow_run(run_id));
		CREATE TABLE ship_judgment_input(input_id TEXT PRIMARY KEY);
		CREATE TABLE ship_judgment_evaluation(evaluation_id TEXT PRIMARY KEY);
		CREATE TABLE state_store_migration(migration_id TEXT PRIMARY KEY,applied_at TEXT);
		CREATE TABLE ship_judgment_project_state(project_name TEXT PRIMARY KEY,history_dirty INTEGER);
		CREATE TABLE ship_judgment_opinion (
			opinion_id TEXT PRIMARY KEY,question_id TEXT NOT NULL REFERENCES workflow_gate_holder(question_id),
			input_id TEXT REFERENCES ship_judgment_input(input_id),evaluation_id TEXT REFERENCES ship_judgment_evaluation(evaluation_id),
			ordinal INTEGER NOT NULL CHECK(ordinal>0),mechanical_json TEXT NOT NULL CHECK(json_valid(mechanical_json)),
			mechanical_digest TEXT NOT NULL,presentation_digest TEXT NOT NULL,
			alignment TEXT NOT NULL CHECK(alignment IN ('pass','fail','undetermined')),conflict TEXT NOT NULL CHECK(conflict IN ('pass','fail','undetermined')),
			coverage TEXT NOT NULL CHECK(coverage IN ('pass','fail','undetermined')),overall TEXT NOT NULL CHECK(overall IN ('can','cannot','recommend_reject','undetermined')),
			status TEXT NOT NULL CHECK(status IN ('complete','undetermined','stale')),reason TEXT NOT NULL,created_at TEXT NOT NULL,
			CHECK((input_id IS NOT NULL AND evaluation_id IS NOT NULL) OR overall='undetermined'),UNIQUE(question_id,ordinal));
		CREATE INDEX ship_judgment_opinion_question ON ship_judgment_opinion(question_id,created_at);
		CREATE TABLE ship_judgment_clarification(clarification_id TEXT PRIMARY KEY,opinion_id TEXT REFERENCES ship_judgment_opinion(opinion_id));
		CREATE TRIGGER ship_judgment_opinion_no_update BEFORE UPDATE ON ship_judgment_opinion BEGIN SELECT RAISE(ABORT,'ship_judgment_opinion is immutable'); END;
		CREATE TRIGGER ship_judgment_opinion_no_delete BEFORE DELETE ON ship_judgment_opinion BEGIN SELECT RAISE(ABORT,'ship_judgment_opinion is immutable'); END;
		CREATE TRIGGER ship_judgment_opinion_history_dirty AFTER INSERT ON ship_judgment_opinion
			WHEN EXISTS(SELECT 1 FROM workflow_gate_holder h JOIN workflow_run r ON r.run_id=h.run_id WHERE h.question_id=NEW.question_id AND r.project_name='flywheel')
			BEGIN INSERT INTO ship_judgment_project_state VALUES ('flywheel',1) ON CONFLICT(project_name) DO UPDATE SET history_dirty=1; END;
		CREATE TRIGGER ship_judgment_clarification_history_dirty AFTER INSERT ON ship_judgment_clarification
			WHEN EXISTS(SELECT 1 FROM ship_judgment_opinion WHERE opinion_id=NEW.opinion_id)
			BEGIN UPDATE ship_judgment_project_state SET history_dirty=1; END;
		INSERT INTO workflow_run VALUES ('r','flywheel'); INSERT INTO workflow_gate_holder VALUES ('q','r');`);
	if (withRows) {
		for (let n = 1; n <= 3; n++)
			db.prepare(
				"INSERT INTO ship_judgment_opinion VALUES (?, 'q',NULL,NULL,?,'{}','digest','presentation','undetermined','pass','undetermined','undetermined','undetermined','missing','2026-09-14T20:00:00Z')",
			).run(`opinion-${n}`, n);
		db.exec(
			"INSERT INTO ship_judgment_clarification VALUES ('clarification','opinion-1')",
		);
	}
	return db;
}

it("StateStore starts with a pre-existing unrelated foreign-key violation", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly-2560-unrelated-fk-"));
	const path = join(root, "fixture.db");
	let store: StateStore | undefined;
	const seed = new Database(path);
	seed.pragma("foreign_keys=OFF");
	seed.exec(`CREATE TABLE unrelated_parent(id TEXT PRIMARY KEY);
		CREATE TABLE unrelated_child(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES unrelated_parent(id));
		INSERT INTO unrelated_child VALUES ('historical-orphan','missing');`);
	const baseline = seed.pragma("foreign_key_check");
	seed.close();
	try {
		store = await StateStore.create(path);
		const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		expect(db.pragma("foreign_key_check")).toEqual(baseline);
		expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
		expect(db.pragma("table_info(ship_judgment_opinion)")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "evidence_json" }),
			]),
		);
	} finally {
		store?.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it.each([false, true])(
	"migrates legacy rows and clarification foreign keys, idempotently (%s)",
	(withRows) => {
		const db = legacyFixture(withRows);
		try {
			const triggers = db
				.prepare(
					"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='ship_judgment_opinion' ORDER BY name",
				)
				.all();
			migrateEvidenceLedger(db);
			migrateEvidenceLedger(db);
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
			expect(db.pragma("foreign_key_check")).toEqual([]);
			expect(
				db.pragma("foreign_key_list(ship_judgment_clarification)"),
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ table: "ship_judgment_opinion" }),
				]),
			);
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM ship_judgment_opinion WHERE evidence_json IS NULL",
					)
					.get(),
			).toEqual({ n: withRows ? 3 : 0 });
			expect(
				db
					.prepare(
						"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='ship_judgment_opinion' ORDER BY name",
					)
					.all(),
			).toEqual(triggers);
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='ship_judgment_opinion_question'",
					)
					.get(),
			).toEqual({ n: 1 });
			db.exec("UPDATE ship_judgment_project_state SET history_dirty=0");
			db.prepare(`INSERT INTO ship_judgment_opinion(opinion_id,question_id,ordinal,mechanical_json,mechanical_digest,presentation_digest,alignment,conflict,coverage,overall,status,reason,created_at,evidence_json)
			VALUES ('new','q',4,'{}','digest','presentation','pass','pass','pass','can','complete','evidence','now','{}')`).run();
			expect(
				db
					.prepare("SELECT history_dirty FROM ship_judgment_project_state")
					.get(),
			).toEqual({ history_dirty: 1 });
			expect(() =>
				db.exec(
					"UPDATE ship_judgment_opinion SET reason='changed' WHERE opinion_id='new'",
				),
			).toThrow("immutable");
			expect(() =>
				db.exec("DELETE FROM ship_judgment_opinion WHERE opinion_id='new'"),
			).toThrow("immutable");
		} finally {
			db.close();
		}
	},
);

it("rolls back a foreign-key-invalid migration and restores PRAGMAs", () => {
	const db = legacyFixture();
	try {
		db.pragma("foreign_keys=OFF");
		db.exec("INSERT INTO ship_judgment_clarification VALUES ('bad','missing')");
		db.pragma("foreign_keys=ON");
		expect(() => migrateEvidenceLedger(db)).toThrow(
			"evidence_migration_foreign_key_check",
		);
		expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
		expect(
			(
				db.pragma("table_info(ship_judgment_opinion)") as { name: string }[]
			).some((c) => c.name === "evidence_json"),
		).toBe(false);
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM state_store_migration").get(),
		).toEqual({ n: 0 });
	} finally {
		db.close();
	}
});

it("StateStore startup runs the migration on a fresh database", async () => {
	const { store, db } = await bindingFixture();
	try {
		expect(
			(
				db.pragma("table_info(ship_judgment_opinion)") as { name: string }[]
			).some((c) => c.name === "evidence_json"),
		).toBe(true);
		expect(
			db
				.prepare(
					"SELECT migration_id FROM state_store_migration WHERE migration_id='fly-2560-evidence-ledger-v1'",
				)
				.get(),
		).toBeTruthy();
	} finally {
		store.close();
	}
});

it("preserves the migrated ledger, foreign keys and immutable triggers after closing and reopening a real file", () => {
	const root = mkdtempSync(join(tmpdir(), "fly-2560-migration-")),
		path = join(root, "fixture.db");
	let db: Database.Database | undefined;
	try {
		db = legacyFixture(true, path);
		migrateEvidenceLedger(db);
		const markers = db.prepare("SELECT * FROM state_store_migration").all();
		const triggers = db
			.prepare(
				"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='ship_judgment_opinion' ORDER BY name",
			)
			.all();
		db.close();
		db = new Database(path);
		db.pragma("foreign_keys=ON");
		migrateEvidenceLedger(db);
		expect(db.prepare("SELECT * FROM state_store_migration").all()).toEqual(
			markers,
		);
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_opinion").get(),
		).toEqual({ n: 3 });
		expect(
			db
				.prepare(
					"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='ship_judgment_opinion' ORDER BY name",
				)
				.all(),
		).toEqual(triggers);
		expect(db.pragma("foreign_key_check")).toEqual([]);
		expect(() =>
			db!
				.prepare(
					"UPDATE ship_judgment_opinion SET reason='changed' WHERE opinion_id='opinion-1'",
				)
				.run(),
		).toThrow("immutable");
	} finally {
		db?.close();
		rmSync(root, { recursive: true, force: true });
	}
});
