import { createHash } from "node:crypto";
import type { Database as BetterDb } from "better-sqlite3";

export const TERMINAL_ROW_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MAX_TERMINAL_ARCHIVE_BATCH = 100;
export const MAX_TERMINAL_ARCHIVE_DURATION_MS = 50;
export const MAX_TERMINAL_ARCHIVE_PAGE_DURATION_MS = 25;
export const MAX_TERMINAL_ARCHIVE_PAGES_PER_CALL = 2;
const TERMINAL_ARCHIVE_SELECT_PAGE_SIZE = 64;

const SESSION_EVENT_TYPES = [
	"issue_thread_infra_notify_skipped",
	"issue_thread_infra_notify_failed",
	"founder_ship_reply_wake_skipped",
	"runner_wake_failed",
	"stage_changed",
	"worktree_reconcile_skip",
	"lifecycle_sweep_worktree_skip",
	"founder_reply_read_failed",
	"issue_thread_infra_notified",
	"state_transition",
	"session_started",
	"session_completed",
	"runner_recovery_nudge",
	"lead_close_runner",
	"chat_thread_archived",
	"closeout_report",
	"closeout_issue_items_blocked",
	"detection_escalation_disposition",
	"lead_close_runner_finalized",
	"worktree_reconcile_gh_unavailable",
	"lifecycle_sweep_failed",
	"tmux_closed",
	"worktree_cleanup_done",
	"lifecycle_sweep_worktree_removed",
	"chat_thread_archive_failed",
	"lifecycle_sweep_gh_unavailable",
	"lead_close_runner_failed",
	"bridge_boot_stale_checkout",
	"detection_suspicious",
] as const;

const LEAD_EVENT_TYPES = [
	"detection_escalation",
	"detection_page_undeliverable",
	"runner_idle_detected",
	"pane_hash_stuck",
	"session_started",
	"session_completed",
	"session_failed",
	"session_stuck",
	"session_monitoring_lost",
	"session_monitoring_reestablished",
	"session_stale_completed",
	"session_orphaned",
	"auto_qa_stuck",
	"rate_limit",
	"runner_park_notice",
	"zombie_session_backlog",
	"runner_stuck_escalation",
	"bridge_abnormal_exit",
	"checkpoint_park_nudge",
] as const;

const WORKFLOW_EVENT_TYPES = [
	"rework_delivery_claimed",
	"rework_delivery_released",
	"workflow_engine_alert_enqueued",
	"workflow_engine_alert_posted",
] as const;

const SESSION_EVENT_TYPES_SQL = SESSION_EVENT_TYPES.map(
	(eventType) => `'${eventType}'`,
).join(",");
const LEAD_EVENT_TYPES_SQL = LEAD_EVENT_TYPES.map(
	(eventType) => `'${eventType}'`,
).join(",");
const WORKFLOW_EVENT_TYPES_SQL = WORKFLOW_EVENT_TYPES.map(
	(eventType) => `'${eventType}'`,
).join(",");

const TERMINAL_ARCHIVE_TABLES = [
	"session_events",
	"workflow_run_event",
	"lead_events",
] as const;
export type TerminalArchiveTable = (typeof TERMINAL_ARCHIVE_TABLES)[number];

const TERMINAL_ARCHIVE_LOOKUPS = {
	session_events: {
		indexName: "idx_workflow_terminal_archive_session_event_id",
		expressions: ["json_extract(row_json,'$.event_id')"],
	},
	workflow_run_event: {
		indexName: "idx_workflow_terminal_archive_workflow_event_uid",
		expressions: ["json_extract(row_json,'$.event_uid')"],
	},
	lead_events: {
		indexName: "idx_workflow_terminal_archive_lead_event_id",
		expressions: [
			"json_extract(row_json,'$.lead_id')",
			"json_extract(row_json,'$.event_id')",
		],
	},
} as const satisfies Record<
	TerminalArchiveTable,
	{ indexName: string; expressions: readonly string[] }
>;

const WORKFLOW_RUN_EVENT_SEQUENCE_LOOKUP = {
	sourceTable: "workflow_run_event",
	indexName: "idx_workflow_terminal_archive_workflow_run_seq",
	runExpression: "json_extract(row_json,'$.run_id')",
	seqExpression: "CAST(json_extract(row_json,'$.seq') AS INTEGER)",
} as const;

const ARCHIVE_INDEX_DEFINITIONS = [
	{
		name: "idx_session_events_archive_keyset",
		sql: `CREATE INDEX IF NOT EXISTS idx_session_events_archive_keyset
			ON session_events(julianday(ts), id)
			WHERE event_type IN (${SESSION_EVENT_TYPES_SQL})`,
	},
	{
		name: "idx_workflow_run_event_archive_keyset",
		sql: `CREATE INDEX IF NOT EXISTS idx_workflow_run_event_archive_keyset
			ON workflow_run_event(julianday(at), id)
			WHERE kind IN (${WORKFLOW_EVENT_TYPES_SQL})`,
	},
	{
		name: "idx_lead_events_archive_keyset",
		sql: `CREATE INDEX IF NOT EXISTS idx_lead_events_archive_keyset
			ON lead_events(julianday(created_at), seq)
			WHERE event_type IN (${LEAD_EVENT_TYPES_SQL})`,
	},
	...Object.entries(TERMINAL_ARCHIVE_LOOKUPS).map(
		([sourceTable, { indexName, expressions }]) => ({
			name: indexName,
			sql: `CREATE INDEX IF NOT EXISTS ${indexName}
				ON workflow_terminal_archive(${expressions.join(", ")})
				WHERE source_table='${sourceTable}'`,
		}),
	),
	{
		name: WORKFLOW_RUN_EVENT_SEQUENCE_LOOKUP.indexName,
		sql: `CREATE INDEX IF NOT EXISTS ${WORKFLOW_RUN_EVENT_SEQUENCE_LOOKUP.indexName}
			ON workflow_terminal_archive(
				${WORKFLOW_RUN_EVENT_SEQUENCE_LOOKUP.runExpression},
				${WORKFLOW_RUN_EVENT_SEQUENCE_LOOKUP.seqExpression} DESC
			)
			WHERE source_table='${WORKFLOW_RUN_EVENT_SEQUENCE_LOOKUP.sourceTable}'`,
	},
] as const;

type ArchiveCursor = {
	sourceCreatedAt: string;
	sourceIdentity: unknown;
};

const archiveCursors = new WeakMap<
	BetterDb,
	Partial<Record<TerminalArchiveTable, ArchiveCursor>>
>();
const archiveStartTables = new WeakMap<BetterDb, TerminalArchiveTable>();

type ArchivePolicy = {
	table: TerminalArchiveTable;
	primaryKey: "id" | "seq";
	timeColumn: "ts" | "at" | "created_at";
	select: (
		limit: number,
		cursor?: ArchiveCursor,
	) => { sql: string; params: unknown[] };
};

type ActiveSnapshot = {
	executionIds: string[];
	issueIds: string[];
	scalars: string[];
};

export type TerminalArchiveInput = {
	now: string;
	limit?: number;
	activeExecutionIds?: readonly string[];
	activeIssueIds?: readonly string[];
	sourceTable?: TerminalArchiveTable;
};

function placeholders(values: readonly unknown[]): string {
	return values.map(() => "?").join(",");
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizedIndexSql(sql: string): string {
	return sql
		.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([(),=])\s*/g, "$1")
		.trim();
}

function installAndVerifyArchiveIndexes(db: BetterDb): void {
	for (const definition of ARCHIVE_INDEX_DEFINITIONS) {
		const existing = db
			.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
			.get(definition.name) as { sql: string } | undefined;
		if (
			existing &&
			normalizedIndexSql(existing.sql) !== normalizedIndexSql(definition.sql)
		) {
			db.exec(`DROP INDEX ${definition.name}`);
		}
		db.exec(definition.sql);
		const installed = db
			.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
			.get(definition.name) as { sql: string } | undefined;
		if (
			!installed ||
			normalizedIndexSql(installed.sql) !== normalizedIndexSql(definition.sql)
		) {
			throw new Error(`terminal_archive_index_schema_drift:${definition.name}`);
		}
	}
}

export function findArchivedTerminalRow(
	db: BetterDb,
	sourceTable: TerminalArchiveTable,
	values: readonly unknown[],
): Record<string, unknown> | undefined {
	const lookup = TERMINAL_ARCHIVE_LOOKUPS[sourceTable];
	if (values.length !== lookup.expressions.length) {
		throw new Error("invalid_terminal_archive_lookup");
	}
	const archived = db
		.prepare(`SELECT row_json FROM workflow_terminal_archive INDEXED BY ${lookup.indexName}
			WHERE source_table='${sourceTable}'
			  AND ${lookup.expressions.map((expression) => `${expression}=?`).join(" AND ")}
			LIMIT 1`)
		.get(...values) as { row_json: string } | undefined;
	return archived
		? (JSON.parse(archived.row_json) as Record<string, unknown>)
		: undefined;
}

export function maxArchivedWorkflowRunEventSeq(
	db: BetterDb,
	runId: string,
): number {
	const lookup = WORKFLOW_RUN_EVENT_SEQUENCE_LOOKUP;
	const archived = db
		.prepare(`SELECT ${lookup.seqExpression} AS seq
			FROM workflow_terminal_archive INDEXED BY ${lookup.indexName}
			WHERE source_table='${lookup.sourceTable}'
			  AND ${lookup.runExpression}=?
			ORDER BY ${lookup.seqExpression} DESC
			LIMIT 1`)
		.get(runId) as { seq: number } | undefined;
	const seq = archived?.seq ?? 0;
	if (!Number.isSafeInteger(seq) || seq < 0) {
		throw new Error("invalid_archived_workflow_event_seq");
	}
	return seq;
}

function assertNow(now: string): void {
	if (!Number.isFinite(Date.parse(now))) throw new Error("invalid_archive_now");
}

function sortedUnique(values: readonly unknown[]): string[] {
	return [
		...new Set(
			values.filter(
				(value): value is string =>
					typeof value === "string" && value.length > 0,
			),
		),
	].sort();
}

function activeSnapshot(
	db: BetterDb,
	input: TerminalArchiveInput,
): ActiveSnapshot {
	const sessions = db
		.prepare(`SELECT execution_id,issue_id FROM sessions
			WHERE status IN ('pending','running','ship_parked','awaiting_review','design_done','approved_to_ship')`)
		.all() as Array<{ execution_id: string; issue_id: string }>;
	const runs = db
		.prepare(
			"SELECT run_id,issue_id FROM workflow_run WHERE status IN ('active','held')",
		)
		.all() as Array<{ run_id: string; issue_id: string }>;
	const nodes = db
		.prepare(`SELECT node.execution_id FROM workflow_run_node node
			JOIN workflow_run run ON run.run_id=node.run_id
			WHERE run.status IN ('active','held') AND node.execution_id IS NOT NULL`)
		.all() as Array<{ execution_id: string }>;
	const executionIds = sortedUnique([
		...sessions.map(({ execution_id }) => execution_id),
		...nodes.map(({ execution_id }) => execution_id),
		...(input.activeExecutionIds ?? []),
	]);
	const issueIds = sortedUnique([
		...sessions.map(({ issue_id }) => issue_id),
		...runs.map(({ issue_id }) => issue_id),
		...(input.activeIssueIds ?? []),
	]);
	return {
		executionIds,
		issueIds,
		scalars: sortedUnique([
			...executionIds,
			...issueIds,
			...runs.map(({ run_id }) => run_id),
		]),
	};
}

function notActive(
	alias: string,
	payloadColumn: string,
	active: ActiveSnapshot,
	columns: { execution?: string; issue?: string } = {},
): { sql: string; params: string[] } {
	const clauses: string[] = [];
	const params: string[] = [];
	for (const [column, values] of [
		[columns.execution, active.executionIds],
		[columns.issue, active.issueIds],
	] as const) {
		if (!column || values.length === 0) continue;
		clauses.push(`${alias}.${column} NOT IN (${placeholders(values)})`);
		params.push(...values);
	}
	if (active.scalars.length === 0) {
		clauses.push(
			`(${alias}.${payloadColumn} IS NULL OR json_valid(${alias}.${payloadColumn}))`,
		);
	} else {
		clauses.push(`(${alias}.${payloadColumn} IS NULL OR (
			json_valid(${alias}.${payloadColumn}) AND NOT EXISTS (
				SELECT 1 FROM json_tree(${alias}.${payloadColumn}) active_value
				WHERE active_value.atom IN (${placeholders(active.scalars)})
			)))`);
		params.push(...active.scalars);
	}
	return { sql: clauses.join(" AND "), params };
}

export function installTerminalRowArchiveSchema(db: BetterDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS workflow_terminal_archive (
			source_table TEXT NOT NULL CHECK(source_table IN ('session_events','workflow_run_event','lead_events')),
			source_identity TEXT NOT NULL,
			source_created_at TEXT NOT NULL,
			archived_at TEXT NOT NULL,
			row_json TEXT NOT NULL CHECK(json_valid(row_json)),
			row_sha256 TEXT NOT NULL CHECK(length(row_sha256) = 64),
			PRIMARY KEY(source_table, source_identity)
		);
		CREATE INDEX IF NOT EXISTS idx_workflow_terminal_archive_time
			ON workflow_terminal_archive(source_table, source_created_at);
		CREATE TRIGGER IF NOT EXISTS workflow_terminal_archive_no_update
			BEFORE UPDATE ON workflow_terminal_archive
			BEGIN SELECT RAISE(ABORT, 'workflow_terminal_archive is immutable'); END;
		CREATE TRIGGER IF NOT EXISTS workflow_terminal_archive_no_delete
			BEFORE DELETE ON workflow_terminal_archive
			BEGIN SELECT RAISE(ABORT, 'workflow_terminal_archive is immutable'); END;

		DROP TRIGGER IF EXISTS workflow_run_event_no_delete;
		CREATE TRIGGER workflow_run_event_no_delete
			BEFORE DELETE ON workflow_run_event
			WHEN NOT EXISTS (
				SELECT 1 FROM workflow_terminal_archive cold
				WHERE cold.source_table='workflow_run_event'
				  AND cold.source_identity=CAST(OLD.id AS TEXT)
				  AND cold.source_created_at IS OLD.at
				  AND json_type(cold.row_json,'$.id') IS NOT NULL
				  AND json_extract(cold.row_json,'$.id') IS OLD.id
				  AND json_type(cold.row_json,'$.run_id') IS NOT NULL
				  AND json_extract(cold.row_json,'$.run_id') IS OLD.run_id
				  AND json_type(cold.row_json,'$.seq') IS NOT NULL
				  AND json_extract(cold.row_json,'$.seq') IS OLD.seq
				  AND json_type(cold.row_json,'$.event_uid') IS NOT NULL
				  AND json_extract(cold.row_json,'$.event_uid') IS OLD.event_uid
				  AND json_type(cold.row_json,'$.kind') IS NOT NULL
				  AND json_extract(cold.row_json,'$.kind') IS OLD.kind
				  AND json_type(cold.row_json,'$.node_id') IS NOT NULL
				  AND json_extract(cold.row_json,'$.node_id') IS OLD.node_id
				  AND json_type(cold.row_json,'$.edge_id') IS NOT NULL
				  AND json_extract(cold.row_json,'$.edge_id') IS OLD.edge_id
				  AND json_type(cold.row_json,'$.execution_id') IS NOT NULL
				  AND json_extract(cold.row_json,'$.execution_id') IS OLD.execution_id
				  AND json_type(cold.row_json,'$.payload') IS NOT NULL
				  AND json_extract(cold.row_json,'$.payload') IS OLD.payload
				  AND json_type(cold.row_json,'$.at') IS NOT NULL
				  AND json_extract(cold.row_json,'$.at') IS OLD.at
			)
			BEGIN SELECT RAISE(ABORT, 'workflow_run_event is append-only'); END;

		DROP INDEX IF EXISTS idx_session_events_archive_window;
		DROP INDEX IF EXISTS idx_workflow_run_event_archive_window;
		DROP INDEX IF EXISTS idx_lead_events_archive_window;
	`);
	installAndVerifyArchiveIndexes(db);
}

function policies(cutoff: string, active: ActiveSnapshot): ArchivePolicy[] {
	const sessionInactive = notActive("e", "payload", active, {
		execution: "execution_id",
		issue: "issue_id",
	});
	const workflowInactive = notActive("e", "payload", active);
	const leadInactive = notActive("e", "payload", active);
	return [
		{
			table: "session_events",
			primaryKey: "id",
			timeColumn: "ts",
			select: (limit, cursor) => ({
				sql: `SELECT e.* FROM session_events e INDEXED BY idx_session_events_archive_keyset
					JOIN sessions s ON s.execution_id=e.execution_id
					WHERE e.event_type IN (${SESSION_EVENT_TYPES_SQL})
					  AND julianday(e.ts) IS NOT NULL AND julianday(e.ts) < julianday(?)
					  ${cursor ? "AND (julianday(e.ts) > julianday(?) OR (julianday(e.ts) = julianday(?) AND e.id > ?))" : ""}
					  AND s.status IN ('completed','terminated','failed','blocked','timeout','canceled','cancelled','rejected','deferred','shelved','approved')
					  AND ${sessionInactive.sql}
					ORDER BY julianday(e.ts), e.id LIMIT ?`,
				params: [
					cutoff,
					...(cursor
						? [
								cursor.sourceCreatedAt,
								cursor.sourceCreatedAt,
								cursor.sourceIdentity,
							]
						: []),
					...sessionInactive.params,
					limit,
				],
			}),
		},
		{
			table: "workflow_run_event",
			primaryKey: "id",
			timeColumn: "at",
			select: (limit, cursor) => ({
				sql: `SELECT e.* FROM workflow_run_event e INDEXED BY idx_workflow_run_event_archive_keyset
					JOIN workflow_run r ON r.run_id=e.run_id
					WHERE e.kind IN (${WORKFLOW_EVENT_TYPES_SQL})
					  AND julianday(e.at) IS NOT NULL AND julianday(e.at) < julianday(?)
					  ${cursor ? "AND (julianday(e.at) > julianday(?) OR (julianday(e.at) = julianday(?) AND e.id > ?))" : ""}
					  AND r.status IN ('completed','terminated','canceled','cancelled')
					  AND ${workflowInactive.sql}
					ORDER BY julianday(e.at), e.id LIMIT ?`,
				params: [
					cutoff,
					...(cursor
						? [
								cursor.sourceCreatedAt,
								cursor.sourceCreatedAt,
								cursor.sourceIdentity,
							]
						: []),
					...workflowInactive.params,
					limit,
				],
			}),
		},
		{
			table: "lead_events",
			primaryKey: "seq",
			timeColumn: "created_at",
			select: (limit, cursor) => ({
				sql: `SELECT e.* FROM lead_events e INDEXED BY idx_lead_events_archive_keyset
					WHERE e.event_type IN (${LEAD_EVENT_TYPES_SQL})
					  AND julianday(e.created_at) IS NOT NULL
					  AND julianday(e.created_at) < julianday(?)
					  ${cursor ? "AND (julianday(e.created_at) > julianday(?) OR (julianday(e.created_at) = julianday(?) AND e.seq > ?))" : ""}
					  AND e.delivered_at IS NOT NULL
					  AND (e.ack_required=0 OR e.acked_at IS NOT NULL OR e.ack_retired_at IS NOT NULL
					       OR (e.dead_lettered_at IS NOT NULL AND e.ingress_disposed_at IS NOT NULL))
					  AND NOT EXISTS (SELECT 1 FROM lead_event_delivery_attempts child WHERE child.event_seq=e.seq)
					  AND NOT EXISTS (SELECT 1 FROM legacy_cutover_quarantine child WHERE child.seq=e.seq)
					  AND NOT EXISTS (SELECT 1 FROM legacy_render_fallback child WHERE child.seq=e.seq)
					  AND NOT EXISTS (SELECT 1 FROM legacy_stock_suppressed child WHERE child.seq=e.seq)
					  AND ${leadInactive.sql}
					ORDER BY julianday(e.created_at), e.seq LIMIT ?`,
				params: [
					cutoff,
					...(cursor
						? [
								cursor.sourceCreatedAt,
								cursor.sourceCreatedAt,
								cursor.sourceIdentity,
							]
						: []),
					...leadInactive.params,
					limit,
				],
			}),
		},
	];
}

export type TerminalArchiveResult = {
	archived: number;
	byTable: Record<TerminalArchiveTable, number>;
};

export function archiveTerminalRows(
	db: BetterDb,
	input: TerminalArchiveInput,
): TerminalArchiveResult {
	assertNow(input.now);
	const limit = input.limit ?? MAX_TERMINAL_ARCHIVE_BATCH;
	if (
		!Number.isSafeInteger(limit) ||
		limit <= 0 ||
		limit > MAX_TERMINAL_ARCHIVE_BATCH
	) {
		throw new Error("invalid_archive_limit");
	}
	const callDeadline = performance.now() + MAX_TERMINAL_ARCHIVE_DURATION_MS;
	const cutoff = new Date(
		Date.parse(input.now) - TERMINAL_ROW_RETENTION_MS,
	).toISOString();
	const nextCursors = { ...(archiveCursors.get(db) ?? {}) };
	const eligiblePolicies = policies(cutoff, activeSnapshot(db, input)).filter(
		(policy) => !input.sourceTable || policy.table === input.sourceTable,
	);
	const startTable = !input.sourceTable
		? archiveStartTables.get(db)
		: undefined;
	const startIndex = startTable
		? eligiblePolicies.findIndex(({ table }) => table === startTable)
		: 0;
	const orderedPolicies =
		startIndex > 0
			? [
					...eligiblePolicies.slice(startIndex),
					...eligiblePolicies.slice(0, startIndex),
				]
			: eligiblePolicies;
	let lastVisitedTable: TerminalArchiveTable | undefined;
	const result = db
		.transaction(() => {
			let pages = 0;
			const result: TerminalArchiveResult = {
				archived: 0,
				byTable: { session_events: 0, workflow_run_event: 0, lead_events: 0 },
			};
			archiveLoop: for (const policy of orderedPolicies) {
				let cursor = nextCursors[policy.table];
				while (result.archived < limit) {
					const pageStartedAt = performance.now();
					if (
						pages >= MAX_TERMINAL_ARCHIVE_PAGES_PER_CALL ||
						pageStartedAt + MAX_TERMINAL_ARCHIVE_PAGE_DURATION_MS > callDeadline
					) {
						break archiveLoop;
					}
					pages++;
					lastVisitedTable = policy.table;
					const pageDeadline =
						pageStartedAt + MAX_TERMINAL_ARCHIVE_PAGE_DURATION_MS;
					const pageLimit = Math.min(
						TERMINAL_ARCHIVE_SELECT_PAGE_SIZE,
						limit - result.archived,
					);
					const candidate = policy.select(pageLimit, cursor);
					const rows = db
						.prepare(candidate.sql)
						.all(...candidate.params) as Array<Record<string, unknown>>;
					if (rows.length === 0) {
						if (cursor) {
							cursor = undefined;
							nextCursors[policy.table] = undefined;
							if (performance.now() < pageDeadline) continue;
						}
						if (performance.now() >= pageDeadline) break archiveLoop;
						break;
					}
					for (const row of rows) {
						const sourceIdentity = String(row[policy.primaryKey]);
						const rowJson = JSON.stringify(row);
						const rowSha256 = digest(rowJson);
						const existing = db
							.prepare(`SELECT row_sha256 FROM workflow_terminal_archive
							WHERE source_table=? AND source_identity=?`)
							.get(policy.table, sourceIdentity) as
							| { row_sha256: string }
							| undefined;
						if (existing && existing.row_sha256 !== rowSha256) {
							throw new Error(
								`archive_digest_conflict:${policy.table}:${sourceIdentity}`,
							);
						}
						if (!existing) {
							db.prepare(`INSERT INTO workflow_terminal_archive
							(source_table,source_identity,source_created_at,archived_at,row_json,row_sha256)
							VALUES(?,?,?,?,?,?)`).run(
								policy.table,
								sourceIdentity,
								String(row[policy.timeColumn]),
								input.now,
								rowJson,
								rowSha256,
							);
						}
						const deleted = db
							.prepare(
								`DELETE FROM ${policy.table} WHERE ${policy.primaryKey}=?`,
							)
							.run(row[policy.primaryKey]);
						if (deleted.changes !== 1) {
							throw new Error(
								`archive_source_changed:${policy.table}:${sourceIdentity}`,
							);
						}
						result.archived++;
						result.byTable[policy.table]++;
						cursor = {
							sourceCreatedAt: String(row[policy.timeColumn]),
							sourceIdentity: row[policy.primaryKey],
						};
						nextCursors[policy.table] = cursor;
					}
					if (
						performance.now() >= pageDeadline ||
						pages >= MAX_TERMINAL_ARCHIVE_PAGES_PER_CALL
					) {
						break archiveLoop;
					}
					if (rows.length < pageLimit) break;
				}
			}
			return result;
		})
		.immediate();
	archiveCursors.set(db, nextCursors);
	if (!input.sourceTable && lastVisitedTable) {
		const visitedIndex = TERMINAL_ARCHIVE_TABLES.indexOf(lastVisitedTable);
		archiveStartTables.set(
			db,
			TERMINAL_ARCHIVE_TABLES[
				(visitedIndex + 1) % TERMINAL_ARCHIVE_TABLES.length
			]!,
		);
	}
	return result;
}

const RESTORE_PRIMARY_KEYS: Record<TerminalArchiveTable, "id" | "seq"> = {
	session_events: "id",
	workflow_run_event: "id",
	lead_events: "seq",
};

export function restoreTerminalRow(
	db: BetterDb,
	input: { sourceTable: TerminalArchiveTable; sourceIdentity: string },
): { outcome: "restored" | "idempotent" } {
	const primaryKey = RESTORE_PRIMARY_KEYS[input.sourceTable];
	if (!primaryKey || !input.sourceIdentity)
		throw new Error("invalid_restore_key");
	return db
		.transaction(() => {
			const archived = db
				.prepare(`SELECT row_json,row_sha256 FROM workflow_terminal_archive
					WHERE source_table=? AND source_identity=?`)
				.get(input.sourceTable, input.sourceIdentity) as
				| { row_json: string; row_sha256: string }
				| undefined;
			if (!archived) throw new Error("archive_row_not_found");
			if (digest(archived.row_json) !== archived.row_sha256) {
				throw new Error("archive_digest_invalid");
			}
			const row = JSON.parse(archived.row_json) as Record<string, unknown>;
			if (String(row[primaryKey]) !== input.sourceIdentity) {
				throw new Error("archive_identity_invalid");
			}
			const existing = db
				.prepare(`SELECT * FROM ${input.sourceTable} WHERE ${primaryKey}=?`)
				.get(row[primaryKey]) as Record<string, unknown> | undefined;
			if (existing) {
				if (JSON.stringify(existing) !== archived.row_json) {
					throw new Error("restore_hot_conflict");
				}
				return { outcome: "idempotent" as const };
			}
			const columns = Object.keys(row);
			if (columns.length === 0) throw new Error("archive_row_invalid");
			const knownColumns = new Set(
				(
					db.prepare(`PRAGMA table_info(${input.sourceTable})`).all() as Array<{
						name: string;
					}>
				).map(({ name }) => name),
			);
			if (columns.some((column) => !knownColumns.has(column))) {
				throw new Error("archive_schema_mismatch");
			}
			db.prepare(
				`INSERT INTO ${input.sourceTable} (${columns.map((column) => `"${column}"`).join(",")})
				 VALUES (${placeholders(columns)})`,
			).run(...columns.map((column) => row[column]));
			return { outcome: "restored" as const };
		})
		.immediate();
}
