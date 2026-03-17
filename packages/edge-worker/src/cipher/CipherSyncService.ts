/**
 * CipherSyncService — one-way sync from local SQLite cipher.db to Supabase.
 *
 * Reads all 8 CIPHER tables from the local sql.js database and upserts them
 * into Supabase Postgres tables (prefixed with `cipher_`). This is a read-only
 * mirror for CEO dashboard viewing.
 *
 * Sync strategy: full-table upsert after dreaming completes.
 * Each table is synced independently with ON CONFLICT upsert.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database as SqlJsDatabase } from "sql.js";

export interface CipherSyncConfig {
	supabaseUrl: string;
	supabaseKey: string;
	/** Identifier for this machine (default: "local") */
	sourceId?: string;
}

/** Table mapping: SQLite table → Supabase table */
const TABLE_MAP = {
	decision_snapshots: "cipher_decision_snapshots",
	decision_reviews: "cipher_decision_reviews",
	decision_patterns: "cipher_decision_patterns",
	review_pattern_keys: "cipher_review_pattern_keys",
	pattern_summary_cache: "cipher_pattern_summary_cache",
	cipher_skills: "cipher_skills",
	cipher_principles: "cipher_principles",
	cipher_questions: "cipher_questions",
} as const;

type SqliteTable = keyof typeof TABLE_MAP;

export class CipherSyncService {
	private supabase: SupabaseClient;
	private sourceId: string;

	constructor(config: CipherSyncConfig) {
		this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
		this.sourceId = config.sourceId ?? "local";
	}

	/**
	 * Sync all 8 CIPHER tables from SQLite to Supabase.
	 * Called after dreaming completes.
	 */
	async syncAll(db: SqlJsDatabase): Promise<{ totalRows: number; errors: string[] }> {
		const errors: string[] = [];
		let totalRows = 0;

		const tables: SqliteTable[] = [
			// Order matters: parents before children (FK constraints)
			"decision_snapshots",
			"decision_reviews",
			"decision_patterns",
			"review_pattern_keys",
			"pattern_summary_cache",
			"cipher_skills",
			"cipher_principles",
			"cipher_questions",
		];

		for (const table of tables) {
			try {
				const count = await this.syncTable(db, table);
				totalRows += count;
			} catch (err) {
				const msg = `[CipherSync] Failed to sync ${table}: ${err instanceof Error ? err.message : String(err)}`;
				console.error(msg);
				errors.push(msg);
			}
		}

		// Update sync metadata
		try {
			await this.supabase
				.from("cipher_sync_metadata")
				.upsert({
					source_id: this.sourceId,
					last_synced_at: new Date().toISOString(),
					rows_synced: totalRows,
				});
		} catch {
			// Non-critical — don't fail the sync for metadata
		}

		console.log(`[CipherSync] Synced ${totalRows} rows to Supabase (${errors.length} errors)`);
		return { totalRows, errors };
	}

	/**
	 * Sync a single table from SQLite to Supabase via batch upsert.
	 */
	private async syncTable(db: SqlJsDatabase, sqliteTable: SqliteTable): Promise<number> {
		const supabaseTable = TABLE_MAP[sqliteTable];
		const queryResult = db.exec(`SELECT * FROM ${sqliteTable}`);

		if (queryResult.length === 0 || queryResult[0]!.values.length === 0) {
			return 0;
		}

		const columns = queryResult[0]!.columns;
		const rows = queryResult[0]!.values;

		// Convert rows to objects
		const objects = rows.map((row) => {
			const obj: Record<string, unknown> = {};
			for (let i = 0; i < columns.length; i++) {
				obj[columns[i]!] = row[i];
			}
			return obj;
		});

		// Batch upsert in chunks of 500 (Supabase limit)
		const BATCH_SIZE = 500;
		for (let i = 0; i < objects.length; i += BATCH_SIZE) {
			const batch = objects.slice(i, i + BATCH_SIZE);
			const { error } = await this.supabase
				.from(supabaseTable)
				.upsert(batch, { onConflict: this.getPrimaryKey(sqliteTable) });

			if (error) {
				throw new Error(`Upsert failed for ${supabaseTable}: ${error.message}`);
			}
		}

		return objects.length;
	}

	/**
	 * Get the primary key column(s) for ON CONFLICT matching.
	 */
	private getPrimaryKey(table: SqliteTable): string {
		switch (table) {
			case "decision_snapshots":
				return "execution_id";
			case "decision_reviews":
				return "id";
			case "decision_patterns":
				return "pattern_key";
			case "review_pattern_keys":
				return "review_id,pattern_key";
			case "pattern_summary_cache":
				return "id";
			case "cipher_skills":
				return "id";
			case "cipher_principles":
				return "id";
			case "cipher_questions":
				return "id";
		}
	}
}
