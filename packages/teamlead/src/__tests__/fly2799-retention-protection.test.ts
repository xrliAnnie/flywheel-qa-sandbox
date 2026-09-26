import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { RETENTION_TARGET_POLICIES } from "../../../../scripts/lib/fly-2006-retention-engine.mjs";
import { TEAMLEAD_TABLE_CLASSIFICATION } from "../../../../scripts/lib/fly-2006-retention-registry.mjs";

const CUTOFF = "2026-09-01T00:00:00.000Z";

function candidateIds(
	db: Database.Database,
	key: string,
	table: string,
	id: string,
): string[] {
	const policy = RETENTION_TARGET_POLICIES.find((item) => item.key === key);
	const candidate = policy?.candidate({ cutoff14: CUTOFF });
	return db
		.prepare(
			`SELECT t.${id} AS id FROM ${table} t WHERE ${candidate?.sql} ORDER BY id`,
		)
		.all(...(candidate?.params ?? []))
		.map((row) => (row as { id: string }).id);
}

describe("FLY-2799 voice authority retention", () => {
	it("classifies both new tables as explicit deletion targets", () => {
		expect(TEAMLEAD_TABLE_CLASSIFICATION.deleteTarget).toEqual(
			expect.arrayContaining(["voice_handoffs", "voice_utterances"]),
		);
	});

	it("only inventories old final handoffs and unreferenced terminal-session utterances", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE voice_sessions(
					session_id TEXT PRIMARY KEY,
					state TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE TABLE voice_utterances(
					session_id TEXT NOT NULL,
					transcript_id TEXT NOT NULL,
					PRIMARY KEY(session_id,transcript_id)
				);
				CREATE TABLE voice_handoffs(
					handoff_id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					transcript_id TEXT NOT NULL,
					state TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
			`);
			const session = db.prepare("INSERT INTO voice_sessions VALUES (?,?,?)");
			session.run("terminal", "ended", "2000-01-01T00:00:00.000Z");
			session.run("live", "live", "2000-01-01T00:00:00.000Z");
			const utterance = db.prepare("INSERT INTO voice_utterances VALUES (?,?)");
			utterance.run("terminal", "free-old");
			utterance.run("terminal", "referenced");
			utterance.run("live", "live-old");
			const handoff = db.prepare(
				"INSERT INTO voice_handoffs VALUES (?,?,?,?,?)",
			);
			handoff.run(
				"committed-old",
				"terminal",
				"referenced",
				"committed",
				"2000-01-01T00:00:00.000Z",
			);
			handoff.run(
				"rejected-old",
				"terminal",
				"referenced",
				"rejected",
				"2000-01-01T00:00:00.000Z",
			);
			handoff.run(
				"ambiguous-old",
				"terminal",
				"referenced",
				"ambiguous",
				"2000-01-01T00:00:00.000Z",
			);
			handoff.run(
				"needs-human-old",
				"terminal",
				"referenced",
				"needs_human",
				"2000-01-01T00:00:00.000Z",
			);
			handoff.run(
				"committed-recent",
				"terminal",
				"referenced",
				"committed",
				"2026-09-10T00:00:00.000Z",
			);

			expect(
				candidateIds(db, "voiceHandoffs", "voice_handoffs", "handoff_id"),
			).toEqual(["committed-old", "rejected-old"]);
			expect(
				candidateIds(
					db,
					"voiceUtterances",
					"voice_utterances",
					"transcript_id",
				),
			).toEqual(["free-old"]);
		} finally {
			db.close();
		}
	});
});
