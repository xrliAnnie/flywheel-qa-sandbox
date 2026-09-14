import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { BetaReleaseStore } from "../beta-release-store.js";

const binding = {
	projectName: "test",
	repositoryId: 1,
	canonicalRepo: "test/repo",
	workflowId: 2,
	defaultBranch: "main",
	bindingRevision: "r",
};
it("freezes source origin and rejects invalid origins before reserving", () => {
	const db = new Database(":memory:");
	try {
		const store = new BetaReleaseStore(db);
		store.migrate();
		store.bind(binding, 0, 100);
		expect(() =>
			store.reserve("test", 100, "a".repeat(40), 100, "invalid" as never),
		).toThrow("source origin");
		expect(store.active("test")).toBeNull();
		const occurrence = store.reserve(
			"test",
			100,
			"a".repeat(40),
			100,
			"local_deployed_sha",
		);
		expect(occurrence?.sourceOrigin).toBe("local_deployed_sha");
		expect(new BetaReleaseStore(db).active("test")).toEqual(occurrence);
		expect(
			store.reserve("test", 100, "b".repeat(40), 100, "default_branch_head"),
		).toBeNull();
		expect(store.active("test")).toEqual(occurrence);
	} finally {
		db.close();
	}
});
it("migrates a pre-origin occurrence twice and preserves its historical null origin", () => {
	const db = new Database(":memory:");
	try {
		// Persisted producer schema before FLY-2508, including a live reservation.
		db.exec(`CREATE TABLE beta_schedule_occurrences (
   occurrence_id TEXT PRIMARY KEY, project_name TEXT NOT NULL,
   binding_revision TEXT NOT NULL, scheduled_at_ms INTEGER NOT NULL, source_commit TEXT NOT NULL,
   state TEXT NOT NULL, run_ids_json TEXT NOT NULL, attempt_count INTEGER NOT NULL,
   retry_at_ms INTEGER, last_error TEXT, result_json TEXT, created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER,
   UNIQUE(project_name,binding_revision,scheduled_at_ms));
  INSERT INTO beta_schedule_occurrences VALUES (
   'old','test','r',100,'${"a".repeat(40)}','prepared','[]',0,NULL,NULL,NULL,100,NULL);`);
		const store = new BetaReleaseStore(db);
		store.migrate();
		store.bind(binding, 0, 100);
		db.prepare(
			"UPDATE beta_schedule_lanes SET active_occurrence_id=? WHERE project_name=?",
		).run("old", "test");
		store.migrate();
		expect(store.active("test")).toMatchObject({
			occurrenceId: "old",
			sourceOrigin: null,
			sourceCommit: "a".repeat(40),
		});
		// The additive column leaves the old binary's explicit-column read usable.
		expect(
			db.prepare("SELECT source_commit FROM beta_schedule_occurrences").get(),
		).toEqual({ source_commit: "a".repeat(40) });
	} finally {
		db.close();
	}
});
