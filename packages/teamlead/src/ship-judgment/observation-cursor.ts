import type Database from "better-sqlite3";

export const OBSERVATION_MIGRATION_ID = "fly-2563-observation-budget-v1";
export type ObservationStorageState =
	| { status: "ready"; reason: null }
	| {
			status: "unavailable";
			reason: "not_initialized" | "schema_drift" | "migration_failed";
	  };

const objects = [
	[
		"idx_fly2563_closeout_cursor",
		`CREATE INDEX IF NOT EXISTS idx_fly2563_closeout_cursor
	 ON session_events(project_name,source,id)
	 WHERE event_type='closeout_report'
	 AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.disposition')='canceled'`,
	],
	[
		"idx_fly2563_verdict_cursor",
		`CREATE INDEX IF NOT EXISTS idx_fly2563_verdict_cursor
	 ON workflow_founder_gate_verdict(recorded_at,verdict_id)`,
	],
	[
		"idx_fly2563_holder_run_question",
		`CREATE INDEX IF NOT EXISTS idx_fly2563_holder_run_question
	 ON workflow_gate_holder(run_id,question_id)`,
	],
	[
		"idx_fly2563_run_issue",
		`CREATE INDEX IF NOT EXISTS idx_fly2563_run_issue
	 ON workflow_run(project_name,issue_id,run_id)`,
	],
	[
		"ship_judgment_observation_cursor",
		`CREATE TABLE IF NOT EXISTS ship_judgment_observation_cursor (
	 project_name TEXT NOT NULL,
	 source_kind TEXT NOT NULL CHECK(source_kind IN ('closeout','b2')),
	 last_event_id INTEGER NOT NULL DEFAULT 0 CHECK(last_event_id>=0),
	 last_recorded_at TEXT NOT NULL DEFAULT '',
	 last_verdict_id TEXT NOT NULL DEFAULT '',
	 reconcile_recorded_at TEXT NOT NULL DEFAULT '',
	 reconcile_verdict_id TEXT NOT NULL DEFAULT '',
	 reconcile_ceiling_at TEXT NOT NULL DEFAULT '',
	 reconcile_ceiling_id TEXT NOT NULL DEFAULT '',
	 reconcile_next_at TEXT,
	 updated_at TEXT NOT NULL,
	 PRIMARY KEY(project_name,source_kind)
	)`,
	],
	[
		"ship_judgment_observation_pending",
		`CREATE TABLE IF NOT EXISTS ship_judgment_observation_pending (
	 project_name TEXT NOT NULL,
	 source_kind TEXT NOT NULL CHECK(source_kind IN ('closeout','b2')),
	 source_id TEXT NOT NULL,
	 run_after TEXT NOT NULL DEFAULT '',
	 question_after TEXT NOT NULL DEFAULT '',
	 reason TEXT NOT NULL CHECK(reason IN ('partial','future','restore_replay','dependency','invalid_source')),
	 next_attempt_at TEXT,
	 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
	 updated_at TEXT NOT NULL,
	 PRIMARY KEY(project_name,source_kind,source_id)
	)`,
	],
	[
		"idx_fly2563_pending_due",
		`CREATE INDEX IF NOT EXISTS idx_fly2563_pending_due
	 ON ship_judgment_observation_pending(project_name,source_kind,next_attempt_at,source_id)`,
	],
] as const;

/** Compare schema templates without changing quoted literals or expressions. */
function normalizedDefinition(sql: string): string {
	return sql
		.replace(/\bIF\s+NOT\s+EXISTS\s+/gi, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/;$/, "");
}

export class ObservationSchemaDrift extends Error {
	constructor() {
		super("observation_schema_drift");
	}
}

/** Learning-side only: callers isolate failure without reverting authority schema. */
export function installObservationStorage(db: Database.Database): {
	elapsedMs: number;
} {
	const started = performance.now();
	db.transaction(() => {
		for (const [name, sql] of objects) {
			db.exec(sql);
			const actual = db
				.prepare("SELECT sql FROM sqlite_master WHERE name=?")
				.get(name) as { sql: string } | undefined;
			if (
				!actual ||
				normalizedDefinition(actual.sql) !== normalizedDefinition(sql)
			)
				throw new ObservationSchemaDrift();
		}
		const now = new Date().toISOString();
		const insert = db.prepare(
			`INSERT OR IGNORE INTO ship_judgment_observation_cursor(project_name,source_kind,updated_at) VALUES ('flywheel',?,?)`,
		);
		insert.run("closeout", now);
		insert.run("b2", now);
		db.prepare(
			"INSERT OR IGNORE INTO state_store_migration(migration_id,applied_at) VALUES (?,?)",
		).run(OBSERVATION_MIGRATION_ID, now);
	}).immediate();
	return { elapsedMs: performance.now() - started };
}

export interface CloseoutPair {
	id: number;
	event_id: string;
	issue_id: string;
	ts: string;
	payload: string;
	run_id: string;
	run_created: string;
	question_id: string;
	card_message_id: string | null;
	card_created: string;
	closed_ms: number;
	run_ms: number;
	card_ms: number;
}
export interface ObservationPageStats {
	sourceCandidates: number;
	holderCandidates: number;
	outcomes: number;
	elapsedMs: number;
	cursorBefore: number;
	cursorAfter: number;
	deferred: number;
}
const closeoutPredicate = `project_name='flywheel' AND source='bridge.lifecycle-closeout' AND event_type='closeout_report'
 AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.disposition')='canceled'`;
const utcMs = (column: string) =>
	`CAST(round((julianday(${column})-2440587.5)*86400000) AS INTEGER)`;

/** Materialize source identities before touching holders; all progress shares the outcome transaction. */
export function observeCloseoutPage(
	db: Database.Database,
	now: string,
	consume: (pair: CloseoutPair) => void,
): ObservationPageStats {
	const started = performance.now();
	const deadline = started + 25;
	const stats: ObservationPageStats = {
		sourceCandidates: 0,
		holderCandidates: 0,
		outcomes: 0,
		elapsedMs: 0,
		cursorBefore: 0,
		cursorAfter: 0,
		deferred: 0,
	};
	db.transaction(() => {
		const cursor = db
			.prepare(
				"SELECT last_event_id FROM ship_judgment_observation_cursor WHERE project_name='flywheel' AND source_kind='closeout'",
			)
			.get() as { last_event_id: number } | undefined;
		if (
			!cursor ||
			!Number.isSafeInteger(cursor.last_event_id) ||
			cursor.last_event_id < 0
		)
			throw new Error("observation_cursor_invalid");
		stats.cursorBefore = stats.cursorAfter = cursor.last_event_id;
		const pending =
			db.prepare(`INSERT INTO ship_judgment_observation_pending(project_name,source_kind,source_id,run_after,question_after,reason,next_attempt_at,updated_at)
		 VALUES ('flywheel','closeout',?,?,?,?,?,?) ON CONFLICT(project_name,source_kind,source_id) DO UPDATE SET
		 run_after=excluded.run_after,question_after=excluded.question_after,reason=excluded.reason,next_attempt_at=CASE WHEN ship_judgment_observation_pending.attempts>=9 AND excluded.reason='dependency' THEN NULL ELSE excluded.next_attempt_at END,updated_at=excluded.updated_at,attempts=ship_judgment_observation_pending.attempts+1`);
		const clear = db.prepare(
			"DELETE FROM ship_judgment_observation_pending WHERE project_name='flywheel' AND source_kind='closeout' AND source_id=?",
		);
		const defer = (
			id: number,
			run: string,
			question: string,
			reason: string,
			next: string | null,
		) => {
			pending.run(String(id), run, question, reason, next, now);
			stats.deferred++;
		};
		const processSource = (
			id: number,
			runAfter: string,
			questionAfter: string,
			pairLimit: number,
			sourceDeadline = deadline,
		) => {
			stats.sourceCandidates++;
			const source = db
				.prepare(`SELECT id,event_id,issue_id,ts,length(CAST(payload AS BLOB)) AS payload_bytes,${utcMs("ts")} AS closed_ms
			 FROM session_events WHERE id=? AND project_name='flywheel' AND source='bridge.lifecycle-closeout' AND event_type='closeout_report'`)
				.get(id) as
				| {
						id: number;
						event_id: string;
						issue_id: string;
						ts: string;
						payload_bytes: number;
						closed_ms: number | null;
				  }
				| undefined;
			if (!source) {
				defer(
					id,
					runAfter,
					questionAfter,
					"dependency",
					new Date(Date.parse(now) + 60_000).toISOString(),
				);
				return;
			}
			if (source.closed_ms === null || source.payload_bytes > 65536) {
				defer(id, runAfter, questionAfter, "invalid_source", null);
				return;
			}
			if (source.closed_ms > Date.parse(now)) {
				defer(
					id,
					runAfter,
					questionAfter,
					"future",
					new Date(source.closed_ms).toISOString(),
				);
				return;
			}
			const payload = (
				db.prepare("SELECT payload FROM session_events WHERE id=?").get(id) as {
					payload: string;
				}
			).payload;
			try {
				if (JSON.parse(payload)?.disposition !== "canceled") {
					clear.run(String(id));
					return;
				}
			} catch {
				defer(id, runAfter, questionAfter, "invalid_source", null);
				return;
			}
			// Both candidate lists are independently indexed and bounded before merging.
			const comparison = questionAfter ? ">=" : ">";
			const direct = db
				.prepare(
					`SELECT run_id FROM workflow_run INDEXED BY idx_fly2563_run_issue WHERE project_name='flywheel' AND issue_id=? AND run_id${comparison}? ORDER BY run_id LIMIT 16`,
				)
				.all(source.issue_id, runAfter) as { run_id: string }[];
			const aliases = db
				.prepare(
					`SELECT run_id FROM workflow_run_issue_alias WHERE issue_alias=? AND run_id${comparison}? ORDER BY run_id LIMIT 16`,
				)
				.all(source.issue_id, runAfter) as { run_id: string }[];
			const runs = [...new Set([...direct, ...aliases].map((r) => r.run_id))]
				.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
				.slice(0, 16);
			let lastRun = runAfter,
				lastQuestion = questionAfter;
			for (const runId of runs) {
				if (
					performance.now() >= sourceDeadline ||
					stats.holderCandidates >= pairLimit
				) {
					defer(id, lastRun, lastQuestion, "partial", now);
					return;
				}
				const run = db
					.prepare(
						`SELECT created_at AS run_created,${utcMs("created_at")} AS run_ms FROM workflow_run WHERE run_id=? AND project_name='flywheel'`,
					)
					.get(runId) as
					| { run_created: string; run_ms: number | null }
					| undefined;
				if (!run || run.run_ms === null || run.run_ms > source.closed_ms) {
					lastRun = runId;
					lastQuestion = "";
					continue;
				}
				const after = runId === runAfter ? questionAfter : "";
				const holders = db
					.prepare(
						"SELECT question_id FROM workflow_gate_holder INDEXED BY idx_fly2563_holder_run_question WHERE run_id=? AND question_id>? ORDER BY question_id LIMIT 16",
					)
					.all(runId, after) as { question_id: string }[];
				for (const { question_id } of holders) {
					if (
						performance.now() >= sourceDeadline ||
						stats.holderCandidates >= pairLimit
					) {
						defer(id, lastRun, lastQuestion, "partial", now);
						return;
					}
					stats.holderCandidates++;
					const holder = db
						.prepare(
							`SELECT card_message_id,created_at AS card_created,${utcMs("created_at")} AS card_ms FROM workflow_gate_holder WHERE question_id=? AND run_id=?`,
						)
						.get(question_id, runId) as {
						card_message_id: string | null;
						card_created: string;
						card_ms: number | null;
					};
					if (
						holder.card_ms !== null &&
						holder.card_ms <= source.closed_ms &&
						!db
							.prepare(
								"SELECT 1 FROM ship_judgment_outcome WHERE source_kind='closeout' AND source_id=?",
							)
							.get(`${id}:${question_id}`)
					) {
						consume({
							...source,
							...run,
							...holder,
							closed_ms: source.closed_ms,
							run_ms: run.run_ms,
							card_ms: holder.card_ms,
							payload,
							run_id: runId,
							question_id,
						});
						stats.outcomes++;
					}
					lastRun = runId;
					lastQuestion = question_id;
				}
				if (holders.length === 16) {
					defer(id, lastRun, lastQuestion, "partial", now);
					return;
				}
				lastRun = runId;
				lastQuestion = "";
			}
			if (runs.length === 16) defer(id, lastRun, lastQuestion, "partial", now);
			else clear.run(String(id));
		};
		const due = db
			.prepare(
				`SELECT source_id,run_after,question_after FROM ship_judgment_observation_pending WHERE project_name='flywheel' AND source_kind='closeout' AND next_attempt_at<=? ORDER BY next_attempt_at,source_id LIMIT 8`,
			)
			.all(now) as {
			source_id: string;
			run_after: string;
			question_after: string;
		}[];
		const pendingDeadline = started + 12.5;
		for (const item of due) {
			if (stats.holderCandidates >= 8 || performance.now() >= pendingDeadline)
				break;
			const id = Number(item.source_id);
			if (!Number.isSafeInteger(id) || id <= 0)
				throw new Error("observation_pending_invalid");
			processSource(
				id,
				item.run_after,
				item.question_after,
				8,
				pendingDeadline,
			);
		}
		if (performance.now() < deadline && stats.holderCandidates < 16) {
			const page = db
				.prepare(
					`SELECT id FROM session_events INDEXED BY idx_fly2563_closeout_cursor WHERE ${closeoutPredicate} AND id>? ORDER BY id LIMIT 32`,
				)
				.all(cursor.last_event_id) as { id: number }[];
			for (const { id } of page) {
				if (performance.now() >= deadline || stats.holderCandidates >= 16)
					break;
				processSource(id, "", "", 16);
				stats.cursorAfter = id;
			}
		}
		if (stats.cursorAfter !== stats.cursorBefore)
			db.prepare(
				"UPDATE ship_judgment_observation_cursor SET last_event_id=?,updated_at=? WHERE project_name='flywheel' AND source_kind='closeout'",
			).run(stats.cursorAfter, now);
	}).immediate();
	stats.elapsedMs = performance.now() - started;
	return stats;
}

export interface VerdictPageStats {
	sourceCandidates: number;
	holderCandidates: number;
	outcomes: number;
	elapsedMs: number;
	reconciled: number;
}

export type ObservationReplayReceipt =
	| { status: "enqueued"; sourceId: string }
	| { status: "unavailable"; reason: "replay_enqueue_failed" };

/** Call only after an exact terminal-row restore has returned its success receipt. */
export function enqueueRestoredObservation(
	db: Database.Database,
	input: { sourceTable: string; sourceIdentity: string },
): ObservationReplayReceipt | undefined {
	if (input.sourceTable !== "session_events") return;
	try {
		const id = Number(input.sourceIdentity);
		if (
			!Number.isSafeInteger(id) ||
			id <= 0 ||
			String(id) !== input.sourceIdentity
		)
			throw new Error("invalid_restore_identity");
		const source = db
			.prepare(
				"SELECT id FROM session_events WHERE id=? AND project_name='flywheel' AND source='bridge.lifecycle-closeout' AND event_type='closeout_report'",
			)
			.get(id);
		if (!source) return;
		db.prepare(`INSERT INTO ship_judgment_observation_pending(project_name,source_kind,source_id,reason,next_attempt_at,updated_at)
		 VALUES ('flywheel','closeout',?,'restore_replay','',?) ON CONFLICT(project_name,source_kind,source_id) DO NOTHING`).run(
			input.sourceIdentity,
			new Date().toISOString(),
		);
		return { status: "enqueued", sourceId: input.sourceIdentity };
	} catch {
		// The source restore has already committed; its caller must retain both receipts.
		return { status: "unavailable", reason: "replay_enqueue_failed" };
	}
}
interface VerdictCursor {
	last_recorded_at: string;
	last_verdict_id: string;
	reconcile_recorded_at: string;
	reconcile_verdict_id: string;
	reconcile_ceiling_at: string;
	reconcile_ceiling_id: string;
	reconcile_next_at: string | null;
}

/** B2 uses its public ordering key; backfilled timestamps have a separate bounded reconciliation lane. */
export function observeVerdictPage(
	db: Database.Database,
	now: string,
	consume: (verdictId: string, recordedMs: number) => boolean,
): VerdictPageStats {
	const started = performance.now(),
		deadline = started + 25;
	const stats: VerdictPageStats = {
		sourceCandidates: 0,
		holderCandidates: 0,
		outcomes: 0,
		elapsedMs: 0,
		reconciled: 0,
	};
	db.transaction(() => {
		const cursor = db
			.prepare(
				"SELECT * FROM ship_judgment_observation_cursor WHERE project_name='flywheel' AND source_kind='b2'",
			)
			.get() as VerdictCursor | undefined;
		if (
			!cursor ||
			[
				cursor.last_recorded_at,
				cursor.last_verdict_id,
				cursor.reconcile_recorded_at,
				cursor.reconcile_verdict_id,
				cursor.reconcile_ceiling_at,
				cursor.reconcile_ceiling_id,
			].some((value) => typeof value !== "string")
		)
			throw new Error("observation_cursor_invalid");
		if (
			cursor.reconcile_next_at !== null &&
			!Number.isFinite(Date.parse(cursor.reconcile_next_at))
		)
			throw new Error("observation_cursor_invalid");
		const clear = db.prepare(
			"DELETE FROM ship_judgment_observation_pending WHERE project_name='flywheel' AND source_kind='b2' AND source_id=?",
		);
		const pending = db.prepare(
			"SELECT reason,next_attempt_at,attempts FROM ship_judgment_observation_pending WHERE project_name='flywheel' AND source_kind='b2' AND source_id=?",
		);
		const defer = (id: string, reason: string, next: string | null) => {
			db.prepare(`INSERT INTO ship_judgment_observation_pending(project_name,source_kind,source_id,reason,next_attempt_at,updated_at)
			 VALUES ('flywheel','b2',?,?,?,?) ON CONFLICT(project_name,source_kind,source_id) DO UPDATE SET
			 reason=excluded.reason,next_attempt_at=CASE WHEN ship_judgment_observation_pending.attempts>=9 AND excluded.reason='dependency' THEN NULL ELSE excluded.next_attempt_at END,
			 attempts=ship_judgment_observation_pending.attempts+1,updated_at=excluded.updated_at`).run(
				id,
				reason,
				next,
				now,
			);
		};
		const processSource = (id: string) => {
			stats.sourceCandidates++;
			if (
				db
					.prepare(
						"SELECT 1 FROM ship_judgment_outcome WHERE source_kind='b2' AND source_id=?",
					)
					.get(id)
			) {
				clear.run(id);
				return;
			}
			const held = pending.get(id) as
				| { next_attempt_at: string | null }
				| undefined;
			if (held && (held.next_attempt_at === null || held.next_attempt_at > now))
				return;
			const source = db
				.prepare(
					`SELECT run_id,length(CAST(author_evidence_json AS BLOB)) AS payload_bytes,${utcMs("recorded_at")} AS recorded_ms FROM workflow_founder_gate_verdict WHERE verdict_id=?`,
				)
				.get(id) as
				| { run_id: string; payload_bytes: number; recorded_ms: number | null }
				| undefined;
			if (!source) {
				defer(
					id,
					"dependency",
					new Date(Date.parse(now) + 60_000).toISOString(),
				);
				return;
			}
			if (source.recorded_ms === null || source.payload_bytes > 65536) {
				defer(id, "invalid_source", null);
				return;
			}
			if (source.recorded_ms > Date.parse(now)) {
				defer(id, "future", new Date(source.recorded_ms).toISOString());
				return;
			}
			const run = db
				.prepare("SELECT project_name FROM workflow_run WHERE run_id=?")
				.get(source.run_id) as { project_name: string } | undefined;
			if (run && run.project_name !== "flywheel") {
				clear.run(id);
				return;
			}
			stats.holderCandidates++;
			if (run && consume(id, source.recorded_ms)) {
				stats.outcomes++;
				clear.run(id);
			} else
				defer(
					id,
					"dependency",
					new Date(Date.parse(now) + 60_000).toISOString(),
				);
		};
		const due = db
			.prepare(
				`SELECT source_id FROM ship_judgment_observation_pending WHERE project_name='flywheel' AND source_kind='b2' AND next_attempt_at<=? ORDER BY next_attempt_at,source_id LIMIT 8`,
			)
			.all(now) as { source_id: string }[];
		for (const row of due) {
			if (performance.now() >= started + 12.5 || stats.holderCandidates >= 8)
				break;
			processSource(row.source_id);
		}
		const reconcileDue =
			cursor.reconcile_next_at === null || cursor.reconcile_next_at <= now;
		const normalLimit = reconcileDue ? 12 : 16;
		const page = db
			.prepare(`SELECT recorded_at,verdict_id FROM workflow_founder_gate_verdict INDEXED BY idx_fly2563_verdict_cursor
		 WHERE (recorded_at,verdict_id)>(?,?) ORDER BY recorded_at,verdict_id LIMIT 16`)
			.all(cursor.last_recorded_at, cursor.last_verdict_id) as {
			recorded_at: string;
			verdict_id: string;
		}[];
		for (const row of page) {
			if (
				performance.now() >= deadline ||
				stats.holderCandidates >= normalLimit
			)
				break;
			processSource(row.verdict_id);
			cursor.last_recorded_at = row.recorded_at;
			cursor.last_verdict_id = row.verdict_id;
		}
		if (
			reconcileDue &&
			performance.now() < deadline &&
			stats.holderCandidates < 16
		) {
			if (!cursor.reconcile_ceiling_id) {
				cursor.reconcile_ceiling_at = cursor.last_recorded_at;
				cursor.reconcile_ceiling_id = cursor.last_verdict_id;
				cursor.reconcile_recorded_at = cursor.reconcile_verdict_id = "";
			}
			const history = db
				.prepare(`SELECT recorded_at,verdict_id FROM workflow_founder_gate_verdict INDEXED BY idx_fly2563_verdict_cursor
			 WHERE (recorded_at,verdict_id)>(?,?) AND (recorded_at,verdict_id)<=(?,?) ORDER BY recorded_at,verdict_id LIMIT 16`)
				.all(
					cursor.reconcile_recorded_at,
					cursor.reconcile_verdict_id,
					cursor.reconcile_ceiling_at,
					cursor.reconcile_ceiling_id,
				) as { recorded_at: string; verdict_id: string }[];
			let inspected = 0;
			for (const row of history) {
				if (performance.now() >= deadline || stats.holderCandidates >= 16)
					break;
				processSource(row.verdict_id);
				cursor.reconcile_recorded_at = row.recorded_at;
				cursor.reconcile_verdict_id = row.verdict_id;
				inspected++;
				stats.reconciled++;
			}
			if (inspected === history.length && history.length < 16) {
				cursor.reconcile_ceiling_at = cursor.reconcile_ceiling_id = "";
				cursor.reconcile_recorded_at = cursor.reconcile_verdict_id = "";
			}
			cursor.reconcile_next_at = new Date(
				Date.parse(now) + 60_000,
			).toISOString();
		}
		db.prepare(
			`UPDATE ship_judgment_observation_cursor SET last_recorded_at=?,last_verdict_id=?,reconcile_recorded_at=?,reconcile_verdict_id=?,reconcile_ceiling_at=?,reconcile_ceiling_id=?,reconcile_next_at=?,updated_at=? WHERE project_name='flywheel' AND source_kind='b2'`,
		).run(
			cursor.last_recorded_at,
			cursor.last_verdict_id,
			cursor.reconcile_recorded_at,
			cursor.reconcile_verdict_id,
			cursor.reconcile_ceiling_at,
			cursor.reconcile_ceiling_id,
			cursor.reconcile_next_at,
			now,
		);
	}).immediate();
	stats.elapsedMs = performance.now() - started;
	return stats;
}
