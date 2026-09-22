import type Database from "better-sqlite3";

export const AUTO_MERGE_SHADOW_DECLARATION_V2_MIGRATION =
	"fly-2692-shadow-lead-auth-v2";

const EXPECTED_TRIGGERS = [
	"auto_merge_shadow_declaration_no_delete",
	"auto_merge_shadow_declaration_no_update",
];
const FOREIGN_KEY_TABLES = [
	"auto_merge_shadow_declaration",
	"auto_narrow_opinion_snapshot",
	"auto_narrow_decision_audit",
] as const;

function scopedForeignKeyBaseline(db: Database.Database): string {
	return JSON.stringify(
		FOREIGN_KEY_TABLES.map((table) => [
			table,
			(db.pragma(`foreign_key_check(${table})`) as Record<string, unknown>[])
				.map((row) => JSON.stringify(row))
				.sort(),
		]),
	);
}

function hasExpectedTriggers(db: Database.Database): boolean {
	const triggers = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='auto_merge_shadow_declaration' ORDER BY name",
		)
		.all() as { name: string }[];
	return (
		triggers.length === EXPECTED_TRIGGERS.length &&
		triggers.every(
			(trigger, index) => trigger.name === EXPECTED_TRIGGERS[index],
		)
	);
}

function hasV2Schema(db: Database.Database): boolean {
	const columns = db.pragma("table_info(auto_merge_shadow_declaration)") as {
		name: string;
	}[];
	const names = new Set(columns.map((column) => column.name));
	const schema = db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name='auto_merge_shadow_declaration'",
		)
		.get() as { sql: string } | undefined;
	return (
		names.has("evidence_kind") &&
		names.has("lead_identity_digest") &&
		names.has("lead_auth_method") &&
		Boolean(schema?.sql.includes("evidence_kind = 'lead_authenticated'")) &&
		hasExpectedTriggers(db)
	);
}

export function migrateAutoMergeShadowDeclarationV2(
	db: Database.Database,
): void {
	const applied = db
		.prepare("SELECT 1 FROM state_store_migration WHERE migration_id = ?")
		.get(AUTO_MERGE_SHADOW_DECLARATION_V2_MIGRATION);
	const v2 = hasV2Schema(db);
	if (applied && v2) return;
	if (applied || v2) throw new Error("shadow_declaration_v2_schema_mismatch");

	const schema = db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name='auto_merge_shadow_declaration'",
		)
		.get() as { sql: string } | undefined;
	if (!schema?.sql.includes("discord_channel_id TEXT NOT NULL")) {
		throw new Error("shadow_declaration_v2_legacy_schema_unknown");
	}
	if (!hasExpectedTriggers(db)) {
		throw new Error("shadow_declaration_v2_triggers_unknown");
	}
	const foreignKeyBaseline = scopedForeignKeyBaseline(db);

	const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }));
	const legacyAlter = Number(db.pragma("legacy_alter_table", { simple: true }));
	db.pragma("foreign_keys=OFF");
	db.pragma("legacy_alter_table=ON");
	try {
		db.transaction(() => {
			for (const trigger of EXPECTED_TRIGGERS) {
				db.exec(`DROP TRIGGER ${trigger}`);
			}
			db.exec(`
				CREATE TABLE auto_merge_shadow_declaration_v2 (
					declaration_id TEXT PRIMARY KEY CHECK (
						declaration_id GLOB
						'[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
					),
					question_id TEXT NOT NULL CHECK (length(question_id) > 0),
					run_id TEXT NOT NULL CHECK (length(run_id) > 0),
					declared_class TEXT NOT NULL CHECK (
						declared_class IN ('pure_docs','config_only','single_point_change','other_code')
					),
					declared_by TEXT NOT NULL CHECK (
						length(declared_by) BETWEEN 1 AND 64
						AND declared_by NOT GLOB '*[^A-Za-z0-9._-]*'
					),
					discord_channel_id TEXT CHECK (
						discord_channel_id IS NULL OR (
							length(discord_channel_id) BETWEEN 1 AND 32
							AND discord_channel_id NOT GLOB '*[^0-9]*'
						)
					),
					discord_message_id TEXT UNIQUE CHECK (
						discord_message_id IS NULL OR (
							length(discord_message_id) BETWEEN 1 AND 32
							AND discord_message_id NOT GLOB '*[^0-9]*'
						)
					),
					discord_author_user_id TEXT CHECK (
						discord_author_user_id IS NULL OR (
							length(discord_author_user_id) BETWEEN 1 AND 32
							AND discord_author_user_id NOT GLOB '*[^0-9]*'
						)
					),
					message_ts TEXT,
					evidence_kind TEXT NOT NULL DEFAULT 'discord_message' CHECK (
						evidence_kind IN ('discord_message','lead_authenticated')
					),
					lead_identity_digest TEXT CHECK (
						lead_identity_digest IS NULL OR (
							length(lead_identity_digest) = 64
							AND lead_identity_digest NOT GLOB '*[^0-9a-f]*'
						)
					),
					lead_auth_method TEXT CHECK (
						lead_auth_method IS NULL OR
						lead_auth_method IN ('lead_hmac','carrier_passthrough')
					),
					declaration_seq INTEGER NOT NULL CHECK (declaration_seq > 0),
					declared_at TEXT NOT NULL,
					CHECK (
						(evidence_kind = 'discord_message'
						 AND discord_channel_id IS NOT NULL
						 AND discord_message_id IS NOT NULL
						 AND discord_author_user_id IS NOT NULL
						 AND message_ts IS NOT NULL
						 AND lead_identity_digest IS NULL
						 AND lead_auth_method IS NULL)
						OR
						(evidence_kind = 'lead_authenticated'
						 AND discord_channel_id IS NULL
						 AND discord_message_id IS NULL
						 AND discord_author_user_id IS NULL
						 AND message_ts IS NULL
						 AND lead_identity_digest IS NOT NULL
						 AND lead_auth_method IS NOT NULL)
					),
					UNIQUE (question_id, declaration_seq),
					FOREIGN KEY (question_id) REFERENCES workflow_gate_holder(question_id),
					FOREIGN KEY (run_id) REFERENCES workflow_run(run_id)
				);
				INSERT INTO auto_merge_shadow_declaration_v2
					(declaration_id, question_id, run_id, declared_class, declared_by,
					 discord_channel_id, discord_message_id, discord_author_user_id,
					 message_ts, evidence_kind, lead_identity_digest, lead_auth_method,
					 declaration_seq, declared_at)
				SELECT declaration_id, question_id, run_id, declared_class, declared_by,
				       discord_channel_id, discord_message_id, discord_author_user_id,
				       message_ts, 'discord_message', NULL, NULL,
				       declaration_seq, declared_at
				  FROM auto_merge_shadow_declaration;
				DROP TABLE auto_merge_shadow_declaration;
				ALTER TABLE auto_merge_shadow_declaration_v2
					RENAME TO auto_merge_shadow_declaration;
				CREATE TRIGGER auto_merge_shadow_declaration_no_update
					BEFORE UPDATE ON auto_merge_shadow_declaration
					BEGIN SELECT RAISE(ABORT, 'auto_merge_shadow_declaration is immutable'); END;
				CREATE TRIGGER auto_merge_shadow_declaration_no_delete
					BEFORE DELETE ON auto_merge_shadow_declaration
					BEGIN SELECT RAISE(ABORT, 'auto_merge_shadow_declaration is immutable'); END;
			`);
			if (scopedForeignKeyBaseline(db) !== foreignKeyBaseline) {
				throw new Error("shadow_declaration_v2_foreign_key_check");
			}
			db.prepare(
				"INSERT INTO state_store_migration(migration_id, applied_at) VALUES (?, ?)",
			).run(
				AUTO_MERGE_SHADOW_DECLARATION_V2_MIGRATION,
				new Date().toISOString(),
			);
		}).immediate();
	} finally {
		db.pragma(`legacy_alter_table=${legacyAlter}`);
		db.pragma(`foreign_keys=${foreignKeys}`);
	}
}
