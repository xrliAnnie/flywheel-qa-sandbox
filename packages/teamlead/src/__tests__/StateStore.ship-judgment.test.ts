import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

function raw(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

describe("ship judgment schema", () => {
	it("enforces parent identities, immutable records, and bounded mutable scheduling", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const db = raw(store);
			store.createWorkflowRun({
				runId: "r",
				issueId: "FLY-2399",
				projectName: "flywheel",
				claimsReadEnrolled: true,
			});
			db.prepare(`INSERT INTO workflow_gate_holder(run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,state,created_at,updated_at)
				VALUES ('r','founder_gate',1,?,'execution','q','awaiting_review',?,?)`).run(
				"a".repeat(40),
				"2026-09-11T00:00:00.000Z",
				"2026-09-11T00:00:00.000Z",
			);
			const input =
				db.prepare(`INSERT INTO ship_judgment_input(input_id,project_name,run_id,question_id,card_message_id,thread_id,semantic_ordinal,
				targets_digest,targets_json,sources_json,requirements_json,semantic_digest,policy_version,model_snapshot_digest,model_snapshot_json,requested_at)
				VALUES (?,'flywheel','r',?,'123456789012345678','123456789012345679',?,?,'[]','[]','[]',?,'ship-judgment-v1',?,'{}',?)`);
			const insert = (
				id: string,
				question: string,
				ordinal: number,
				digest: string,
			) =>
				input.run(
					id,
					question,
					ordinal,
					"a".repeat(64),
					digest,
					"b".repeat(64),
					"2026-09-11T00:00:00.000Z",
				);
			expect(() => insert("bad", "missing", 1, "c".repeat(64))).toThrow(
				/FOREIGN KEY/,
			);
			insert("i", "q", 1, "c".repeat(64));
			expect(() => insert("duplicate", "q", 2, "c".repeat(64))).toThrow(
				/UNIQUE/,
			);
			expect(() => insert("fourth", "q", 4, "d".repeat(64))).toThrow(/CHECK/);
			for (const operation of [
				"UPDATE ship_judgment_input SET requested_at='changed'",
				"DELETE FROM ship_judgment_input",
			]) {
				expect(() => db.prepare(operation).run()).toThrow(/immutable/);
			}
			db.prepare(
				"INSERT INTO ship_judgment_job(input_id,state) VALUES ('i','queued')",
			).run();
			expect(
				db
					.prepare(
						"UPDATE ship_judgment_job SET state='running',generation=1 WHERE input_id='i' AND generation=0",
					)
					.run().changes,
			).toBe(1);
			expect(
				db
					.prepare(
						"UPDATE ship_judgment_job SET state='done' WHERE input_id='i' AND generation=0",
					)
					.run().changes,
			).toBe(0);
			expect(() =>
				db.prepare("UPDATE ship_judgment_job SET state='approved'").run(),
			).toThrow(/CHECK/);
			db.prepare(
				"INSERT INTO ship_judgment_project_state(project_name) VALUES ('flywheel')",
			).run();
			expect(() =>
				db
					.prepare(
						"UPDATE ship_judgment_project_state SET api_reserved_times=?",
					)
					.run(JSON.stringify(Array(121).fill(1))),
			).toThrow(/CHECK/);
			expect(() =>
				db
					.prepare(
						"INSERT INTO ship_judgment_project_state(project_name) VALUES ('raya')",
					)
					.run(),
			).toThrow(/CHECK/);
		} finally {
			store.close();
		}
	});
	it("installs ten classified tables and ten immutable guards", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const db = raw(store);
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ship_judgment_%' ORDER BY name",
					)
					.all(),
			).toEqual(
				[
					"clarification",
					"delivery",
					"evaluation",
					"input",
					"job",
					"observation_cursor",
					"observation_pending",
					"opinion",
					"outcome",
					"project_state",
				].map((name) => ({ name: `ship_judgment_${name}` })),
			);
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ship_judgment_%_no_%'",
					)
					.all(),
			).toHaveLength(10);
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM state_store_migration WHERE migration_id='fly-2399-ship-judgment-v1'",
					)
					.get(),
			).toEqual({ n: 1 });
			expect(
				db.prepare("PRAGMA table_info(auto_narrow_opinion_delivery)").all(),
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "legacy_freeze_requested_at",
						notnull: 0,
					}),
					expect.objectContaining({ name: "legacy_frozen_at", notnull: 0 }),
				]),
			);
		} finally {
			store.close();
		}
	});
	it("preserves the migrated schema byte for byte across reopen", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2399-schema-"));
		const path = join(dir, "test.db");
		try {
			const first = await StateStore.create(path);
			const sql =
				"SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'ship_judgment_%' OR name='auto_narrow_opinion_delivery' ORDER BY type,name";
			const before = raw(first).prepare(sql).all();
			const coverageSql =
				"SELECT applied_at FROM state_store_migration WHERE migration_id='fly-2399-delivery-error-audit-v1'";
			expect(raw(first).prepare(coverageSql).get()).toMatchObject({
				applied_at: expect.any(String),
			});
			raw(first)
				.prepare(
					"UPDATE state_store_migration SET applied_at='2026-09-01T00:00:00.000Z' WHERE migration_id='fly-2399-delivery-error-audit-v1'",
				)
				.run();
			raw(first)
				.prepare(
					"INSERT INTO ship_judgment_project_state(project_name,learning_cursor) VALUES ('flywheel',17)",
				)
				.run();
			first.close();
			const second = await StateStore.create(path);
			try {
				expect(raw(second).prepare(sql).all()).toEqual(before);
				expect(raw(second).prepare(coverageSql).get()).toEqual({
					applied_at: "2026-09-01T00:00:00.000Z",
				});
				expect(
					raw(second)
						.prepare(
							"SELECT learning_cursor FROM ship_judgment_project_state WHERE project_name='flywheel'",
						)
						.get(),
				).toEqual({ learning_cursor: 17 });
				expect(raw(second).prepare("PRAGMA foreign_key_check").all()).toEqual(
					[],
				);
			} finally {
				second.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

it("replays freshness and current-mode column migration on an existing delivery table without changing table count", async () => {
	const root = mkdtempSync(join(tmpdir(), "ship-delivery-upgrade-"));
	const path = join(root, "state.db");
	let store = await StateStore.create(path);
	try {
		raw(store).exec(
			"ALTER TABLE ship_judgment_project_state DROP COLUMN learning_cursor",
		);
		const count = raw(store)
			.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
			.get();
		raw(store).exec(
			"ALTER TABLE ship_judgment_delivery DROP COLUMN validated_at",
		);
		raw(store).exec(
			"ALTER TABLE ship_judgment_delivery DROP COLUMN presentation_state_changed_at",
		);
		raw(store).exec(
			"ALTER TABLE ship_judgment_delivery DROP COLUMN validated_presentation_digest",
		);
		raw(store).exec(
			"ALTER TABLE ship_judgment_delivery DROP COLUMN delivery_mode",
		);
		raw(store).exec(
			"ALTER TABLE ship_judgment_delivery DROP COLUMN mode_label",
		);
		store.close();
		store = await StateStore.create(path);
		expect(
			raw(store)
				.prepare("PRAGMA table_info(ship_judgment_project_state)")
				.all(),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "learning_cursor", notnull: 1 }),
			]),
		);
		const columns = raw(store)
			.prepare("PRAGMA table_info(ship_judgment_delivery)")
			.all() as { name: string; notnull: number }[];
		for (const name of [
			"validated_at",
			"validated_presentation_digest",
			"presentation_state_changed_at",
		])
			expect(columns.find((column) => column.name === name)?.notnull).toBe(0);
		for (const name of ["delivery_mode", "mode_label"])
			expect(columns.find((column) => column.name === name)?.notnull).toBe(1);
		expect(
			raw(store)
				.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
				.get(),
		).toEqual(count);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
