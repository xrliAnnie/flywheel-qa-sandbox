import type Database from "better-sqlite3";
import { z } from "zod";

const text = z.string().min(1).max(512);
const iso = z.string().datetime();
export const epicIntakeInputSchema = z
	.object({
		issueUuid: text,
		identifier: z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/),
		startedAt: iso,
		intakeAt: iso,
		observedAt: iso,
		projectName: text,
		leadId: text,
		bindingDigest: text,
		sourceSpanIds: z.array(text).min(1).max(500),
		backfill: z.boolean(),
		active: z.boolean(),
		hasChildIssues: z.boolean(),
	})
	.strict();
export type EpicIntakeInput = z.infer<typeof epicIntakeInputSchema>;
export const epicIntakeEventSchema = epicIntakeInputSchema
	.omit({ hasChildIssues: true, observedAt: true })
	.extend({ eventUid: text })
	.refine(
		(value) =>
			value.eventUid === `epic_intake:${value.issueUuid}:${value.startedAt}`,
		"Epic intake UID mismatch",
	);
export type EpicIntakeEvent = z.infer<typeof epicIntakeEventSchema>;
export interface EpicIntakeRecord
	extends Omit<EpicIntakeInput, "hasChildIssues"> {
	eventUid: string;
	workState: "pending" | "complete" | "needs_founder" | "superseded";
	leadEventSeq: number;
	pageDirty: boolean;
	result: unknown;
}

export interface EpicIntakeScan {
	bootstrapStartedAt: string;
	bootstrapCompleted: boolean;
	lastSuccessfulScanStartedAt: string | null;
}

export function beginEpicIntakeScan(
	db: Database.Database,
	projectName: string,
	startedAt: string,
): EpicIntakeScan {
	text.parse(projectName);
	iso.parse(startedAt);
	db.prepare(
		"INSERT OR IGNORE INTO epic_intake_scan(project_name,bootstrap_started_at) VALUES (?,?)",
	).run(projectName, startedAt);
	const row = db
		.prepare("SELECT * FROM epic_intake_scan WHERE project_name=?")
		.get(projectName) as Record<string, unknown>;
	return {
		bootstrapStartedAt: iso.parse(row.bootstrap_started_at),
		bootstrapCompleted: row.bootstrap_completed === 1,
		lastSuccessfulScanStartedAt: iso
			.nullable()
			.parse(row.last_successful_scan_started_at),
	};
}

export function completeEpicIntakeScan(
	db: Database.Database,
	projectName: string,
	startedAt: string,
): void {
	text.parse(projectName);
	iso.parse(startedAt);
	db.prepare(`UPDATE epic_intake_scan SET bootstrap_completed=1,last_successful_scan_started_at=?
		WHERE project_name=? AND (last_successful_scan_started_at IS NULL OR last_successful_scan_started_at<?)`).run(
		startedAt,
		projectName,
		startedAt,
	);
}

export function migrateEpicIntakes(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS epic_intake_scan (
			project_name TEXT PRIMARY KEY,
			bootstrap_started_at TEXT NOT NULL,
			bootstrap_completed INTEGER NOT NULL DEFAULT 0,
			last_successful_scan_started_at TEXT
		);
		CREATE TABLE IF NOT EXISTS epic_intakes (
			event_uid TEXT PRIMARY KEY,
			issue_uuid TEXT NOT NULL,
			started_at TEXT NOT NULL,
			project_name TEXT NOT NULL,
			lead_id TEXT NOT NULL,
			binding_digest TEXT NOT NULL,
			identifier TEXT NOT NULL,
			intake_at TEXT NOT NULL,
			observed_at TEXT NOT NULL,
			source_span_ids TEXT NOT NULL,
			backfill INTEGER NOT NULL CHECK(backfill IN (0,1)),
			active INTEGER NOT NULL CHECK(active IN (0,1)),
			work_state TEXT NOT NULL CHECK(work_state IN ('pending','complete','needs_founder','superseded')),
			lead_event_seq INTEGER NOT NULL,
			result_json TEXT,
			page_dirty INTEGER NOT NULL DEFAULT 1,
			UNIQUE(issue_uuid,started_at)
		);
		CREATE INDEX IF NOT EXISTS epic_intakes_pending ON epic_intakes(project_name,lead_id,work_state);
	`);
	const columns = new Set(
		(
			db.prepare("PRAGMA table_info(epic_intake_scan)").all() as Array<{
				name: string;
			}>
		).map((row) => row.name),
	);
	if (!columns.has("page_refresh_failures"))
		db.exec(
			"ALTER TABLE epic_intake_scan ADD COLUMN page_refresh_failures INTEGER NOT NULL DEFAULT 0",
		);
	if (!columns.has("page_refresh_retry_at"))
		db.exec(
			"ALTER TABLE epic_intake_scan ADD COLUMN page_refresh_retry_at TEXT",
		);
}

export function readEpicIntakeRefreshState(
	db: Database.Database,
	projectName: string,
) {
	const row = db
		.prepare(
			"SELECT page_refresh_failures,page_refresh_retry_at FROM epic_intake_scan WHERE project_name=?",
		)
		.get(text.parse(projectName)) as
		| { page_refresh_failures: number; page_refresh_retry_at: string | null }
		| undefined;
	const failures = z
		.number()
		.int()
		.min(0)
		.max(3)
		.parse(row?.page_refresh_failures ?? 0);
	return {
		failures,
		retryAt: iso.nullable().parse(row?.page_refresh_retry_at ?? null),
		notRefreshable: failures >= 3,
	};
}

export function recordEpicIntakeRefreshResult(
	db: Database.Database,
	projectName: string,
	successful: boolean,
	at: string,
) {
	text.parse(projectName);
	iso.parse(at);
	return db.transaction(() => {
		if (successful) {
			db.prepare(
				"UPDATE epic_intake_scan SET page_refresh_failures=0,page_refresh_retry_at=NULL WHERE project_name=?",
			).run(projectName);
		} else {
			beginEpicIntakeScan(db, projectName, at);
			const failures = Math.min(
				3,
				readEpicIntakeRefreshState(db, projectName).failures + 1,
			);
			const retryAt =
				failures >= 3
					? null
					: new Date(
							Date.parse(at) + (failures === 1 ? 60_000 : 300_000),
						).toISOString();
			db.prepare(
				"UPDATE epic_intake_scan SET page_refresh_failures=?,page_refresh_retry_at=? WHERE project_name=?",
			).run(failures, retryAt, projectName);
		}
		return readEpicIntakeRefreshState(db, projectName);
	})();
}

export function readEpicIntake(
	db: Database.Database,
	eventUid: string,
): EpicIntakeRecord | null {
	const row = db
		.prepare("SELECT * FROM epic_intakes WHERE event_uid=?")
		.get(eventUid) as Record<string, unknown> | undefined;
	if (!row) return null;
	const input = epicIntakeInputSchema.parse({
		issueUuid: row.issue_uuid,
		identifier: row.identifier,
		startedAt: row.started_at,
		intakeAt: row.intake_at,
		observedAt: row.observed_at,
		projectName: row.project_name,
		leadId: row.lead_id,
		bindingDigest: row.binding_digest,
		sourceSpanIds: JSON.parse(String(row.source_span_ids)),
		backfill: row.backfill === 1,
		active: row.active === 1,
		hasChildIssues: false,
	});
	const { hasChildIssues: _unused, ...record } = input;
	return {
		...record,
		eventUid: String(row.event_uid),
		workState: z
			.enum(["pending", "complete", "needs_founder", "superseded"])
			.parse(row.work_state),
		leadEventSeq: z.number().int().positive().safe().parse(row.lead_event_seq),
		pageDirty: row.page_dirty === 1,
		result:
			row.result_json === null ? null : JSON.parse(String(row.result_json)),
	};
}

export function hasEpicDispatchRecord(
	db: Database.Database,
	projectName: string,
	issueUuid: string,
	identifier: string,
): boolean {
	for (const value of [projectName, issueUuid, identifier]) text.parse(value);
	return Boolean(
		db
			.prepare(`
		SELECT 1 FROM sessions WHERE project_name=? AND (issue_id IN (?,?) OR issue_identifier IN (?,?))
		UNION ALL
		SELECT 1 FROM workflow_run run WHERE project_name=? AND
		(run.issue_id IN (?,?) OR EXISTS (SELECT 1 FROM workflow_run_issue_alias alias WHERE alias.run_id=run.run_id AND alias.issue_alias IN (?,?)))
		LIMIT 1
	`)
			.get(
				projectName,
				issueUuid,
				identifier,
				issueUuid,
				identifier,
				projectName,
				issueUuid,
				identifier,
				issueUuid,
				identifier,
			),
	);
}

/** Admission and its journal append share the StateStore SQLite transaction. */
export function recordEpicIntake(
	db: Database.Database,
	input: EpicIntakeInput,
	hasDispatch: () => boolean,
	append: (
		leadId: string,
		eventId: string,
		eventType: string,
		payload: string,
		sessionKey: string,
	) => number,
): EpicIntakeRecord | null {
	const value = epicIntakeInputSchema.parse(input);
	const eventUid = `epic_intake:${value.issueUuid}:${value.startedAt}`;
	return db.transaction(() => {
		const existing = readEpicIntake(db, eventUid);
		if (existing) return existing;
		if (!value.hasChildIssues && hasDispatch()) return null;
		const {
			hasChildIssues: _unused,
			observedAt: _observedAt,
			...episode
		} = value;
		const seq = append(
			value.leadId,
			eventUid,
			"epic_intake",
			JSON.stringify({
				event_type: "epic_intake",
				project_name: value.projectName,
				issue_id: value.identifier,
				execution_id: `system:epic_intake:${value.issueUuid}`,
				epic_intake: { ...episode, eventUid },
			}),
			`system:epic_intake:${value.projectName}:${value.issueUuid}`,
		);
		if (!Number.isSafeInteger(seq) || seq <= 0)
			throw new Error("Invalid Epic intake journal sequence");
		db.prepare(`INSERT INTO epic_intakes (
			event_uid,issue_uuid,started_at,project_name,lead_id,binding_digest,identifier,
			intake_at,observed_at,source_span_ids,backfill,active,work_state,lead_event_seq
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(
			eventUid,
			value.issueUuid,
			value.startedAt,
			value.projectName,
			value.leadId,
			value.bindingDigest,
			value.identifier,
			value.intakeAt,
			value.observedAt,
			JSON.stringify(value.sourceSpanIds),
			Number(value.backfill),
			Number(value.active),
			seq,
		);
		return readEpicIntake(db, eventUid);
	})();
}
