import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	AUTO_MERGE_SHADOW_DECLARATION_V2_MIGRATION,
	migrateAutoMergeShadowDeclarationV2,
} from "../auto-merge-shadow-declaration-migration.js";

describe("auto-merge shadow declaration v2 migration", () => {
	it("preserves historical Discord evidence, child FKs, pragmas, and immutability", () => {
		const db = new Database(":memory:");
		db.pragma("foreign_keys=ON");
		db.pragma("legacy_alter_table=OFF");
		db.exec(`
			CREATE TABLE state_store_migration (
				migration_id TEXT PRIMARY KEY,
				applied_at TEXT NOT NULL
			);
			CREATE TABLE workflow_run (run_id TEXT PRIMARY KEY);
			CREATE TABLE workflow_gate_holder (question_id TEXT PRIMARY KEY);
			INSERT INTO workflow_run VALUES ('run-1');
			INSERT INTO workflow_gate_holder VALUES ('question-1');
			CREATE TABLE auto_merge_shadow_declaration (
				declaration_id TEXT PRIMARY KEY,
				question_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				declared_class TEXT NOT NULL,
				declared_by TEXT NOT NULL,
				discord_channel_id TEXT NOT NULL,
				discord_message_id TEXT NOT NULL UNIQUE,
				discord_author_user_id TEXT NOT NULL,
				message_ts TEXT NOT NULL,
				declaration_seq INTEGER NOT NULL,
				declared_at TEXT NOT NULL,
				UNIQUE (question_id, declaration_seq),
				FOREIGN KEY (question_id) REFERENCES workflow_gate_holder(question_id),
				FOREIGN KEY (run_id) REFERENCES workflow_run(run_id)
			);
			CREATE TRIGGER auto_merge_shadow_declaration_no_update
				BEFORE UPDATE ON auto_merge_shadow_declaration
				BEGIN SELECT RAISE(ABORT, 'auto_merge_shadow_declaration is immutable'); END;
			CREATE TRIGGER auto_merge_shadow_declaration_no_delete
				BEFORE DELETE ON auto_merge_shadow_declaration
				BEGIN SELECT RAISE(ABORT, 'auto_merge_shadow_declaration is immutable'); END;
			CREATE TABLE auto_narrow_opinion_snapshot (
				id TEXT PRIMARY KEY,
				declaration_id TEXT NOT NULL,
				FOREIGN KEY (declaration_id)
					REFERENCES auto_merge_shadow_declaration(declaration_id)
			);
			CREATE TABLE auto_narrow_decision_audit (
				id TEXT PRIMARY KEY,
				declaration_id TEXT NOT NULL,
				FOREIGN KEY (declaration_id)
					REFERENCES auto_merge_shadow_declaration(declaration_id)
			);
			INSERT INTO auto_merge_shadow_declaration VALUES (
				'11111111-1111-4111-8111-111111111111', 'question-1', 'run-1',
				'pure_docs', 'flywheel-eng-lead', '12345678901234567',
				'22345678901234567', '32345678901234567',
				'2026-09-08T12:01:00.000Z', 1, '2026-09-08T12:02:00.000Z'
			);
			INSERT INTO auto_narrow_opinion_snapshot VALUES (
				'opinion-1', '11111111-1111-4111-8111-111111111111'
			);
			INSERT INTO auto_narrow_decision_audit VALUES (
				'audit-1', '11111111-1111-4111-8111-111111111111'
			);
		`);

		migrateAutoMergeShadowDeclarationV2(db);

		expect(
			db
				.prepare(
					`SELECT evidence_kind, lead_identity_digest, lead_auth_method,
				        discord_message_id
				   FROM auto_merge_shadow_declaration`,
				)
				.get(),
		).toEqual({
			evidence_kind: "discord_message",
			lead_identity_digest: null,
			lead_auth_method: null,
			discord_message_id: "22345678901234567",
		});
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM state_store_migration WHERE migration_id = ?",
				)
				.get(AUTO_MERGE_SHADOW_DECLARATION_V2_MIGRATION),
		).toEqual({ count: 1 });
		expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
		expect(db.pragma("legacy_alter_table", { simple: true })).toBe(0);
		for (const table of [
			"auto_narrow_opinion_snapshot",
			"auto_narrow_decision_audit",
		]) {
			expect(
				(db.pragma(`foreign_key_list(${table})`) as { table: string }[])[0]
					?.table,
			).toBe("auto_merge_shadow_declaration");
		}
		expect(() =>
			db
				.prepare(
					"UPDATE auto_merge_shadow_declaration SET declared_class='other_code'",
				)
				.run(),
		).toThrow(/immutable/);
		expect(() => migrateAutoMergeShadowDeclarationV2(db)).not.toThrow();
		db.close();
	});

	it("compares the scoped foreign-key baseline instead of rejecting old residue", () => {
		const db = new Database(":memory:");
		db.pragma("foreign_keys=OFF");
		db.exec(`
			CREATE TABLE state_store_migration (
				migration_id TEXT PRIMARY KEY,
				applied_at TEXT NOT NULL
			);
			CREATE TABLE workflow_run (run_id TEXT PRIMARY KEY);
			CREATE TABLE workflow_gate_holder (question_id TEXT PRIMARY KEY);
			CREATE TABLE auto_merge_shadow_declaration (
				declaration_id TEXT PRIMARY KEY,
				question_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				declared_class TEXT NOT NULL,
				declared_by TEXT NOT NULL,
				discord_channel_id TEXT NOT NULL,
				discord_message_id TEXT NOT NULL UNIQUE,
				discord_author_user_id TEXT NOT NULL,
				message_ts TEXT NOT NULL,
				declaration_seq INTEGER NOT NULL,
				declared_at TEXT NOT NULL,
				FOREIGN KEY (question_id) REFERENCES workflow_gate_holder(question_id),
				FOREIGN KEY (run_id) REFERENCES workflow_run(run_id)
			);
			CREATE TRIGGER auto_merge_shadow_declaration_no_update
				BEFORE UPDATE ON auto_merge_shadow_declaration
				BEGIN SELECT RAISE(ABORT, 'auto_merge_shadow_declaration is immutable'); END;
			CREATE TRIGGER auto_merge_shadow_declaration_no_delete
				BEFORE DELETE ON auto_merge_shadow_declaration
				BEGIN SELECT RAISE(ABORT, 'auto_merge_shadow_declaration is immutable'); END;
			CREATE TABLE auto_narrow_opinion_snapshot (
				id TEXT PRIMARY KEY,
				declaration_id TEXT NOT NULL,
				FOREIGN KEY (declaration_id)
					REFERENCES auto_merge_shadow_declaration(declaration_id)
			);
			CREATE TABLE auto_narrow_decision_audit (
				id TEXT PRIMARY KEY,
				declaration_id TEXT NOT NULL,
				FOREIGN KEY (declaration_id)
					REFERENCES auto_merge_shadow_declaration(declaration_id)
			);
			INSERT INTO auto_narrow_opinion_snapshot VALUES (
				'old-orphan', '11111111-1111-4111-8111-111111111111'
			);
		`);
		const before = db.pragma(
			"foreign_key_check(auto_narrow_opinion_snapshot)",
		) as unknown[];
		expect(before).toHaveLength(1);
		db.pragma("foreign_keys=ON");

		expect(() => migrateAutoMergeShadowDeclarationV2(db)).not.toThrow();

		expect(
			db.pragma("foreign_key_check(auto_narrow_opinion_snapshot)"),
		).toEqual(before);
		db.close();
	});
});
