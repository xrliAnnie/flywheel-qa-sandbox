import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";

export interface NotificationAuditGeneration {
	generation: string;
	startSeq: number;
	startEventId: string | null;
	recovered: boolean;
}
export interface NotificationAuditRange {
	projectName: string;
	leadId: string;
	afterSeq?: number;
	throughSeq?: number;
	beforeSeq?: number;
	limit?: number;
	storeEpoch?: string;
}
type Row = Record<string, unknown> & {
	seq: number;
	event_id: string;
	payload: string;
	event_type: string;
};
type Cursor = {
	offeredThroughSeq: number;
	anchorEventId: string | null;
	storeEpoch?: string;
};

/** The retained journal is the authority; CommDB cursors are only presentation receipts. */
export class NotificationAuditStore {
	constructor(private readonly db: Database) {}
	install(): void {
		this.db.transaction(() => {
			const existed = this.db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_audit_generation'",
				)
				.get();
			this.db.exec(`CREATE TABLE IF NOT EXISTS notification_audit_generation (
			 singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL,
			 start_seq INTEGER NOT NULL CHECK(start_seq>=0), start_event_id TEXT,
			 recovered INTEGER NOT NULL DEFAULT 0 CHECK(recovered IN (0,1)));
			 CREATE INDEX IF NOT EXISTS idx_lead_events_notification_range ON lead_events(lead_id,delivery_disposition,seq);`);
			if (!existed) {
				const seq = this.maxSeq();
				this.replace(seq, this.anchor(seq), false);
			}
		})();
	}
	private replace(
		seq: number,
		eventId: string | null,
		recovered: boolean,
	): NotificationAuditGeneration {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO notification_audit_generation VALUES(1,?,?,?,?)",
			)
			.run(randomUUID(), seq, eventId, Number(recovered));
		return this.generation()!;
	}
	generation(): NotificationAuditGeneration | undefined {
		const row = this.db
			.prepare(
				"SELECT generation,start_seq AS startSeq,start_event_id AS startEventId,recovered FROM notification_audit_generation WHERE singleton=1",
			)
			.get() as
			| (Omit<NotificationAuditGeneration, "recovered"> & { recovered: number })
			| undefined;
		return row ? { ...row, recovered: row.recovered === 1 } : undefined;
	}
	private verified(row: { row_json: string; row_sha256: string }): Row {
		if (
			createHash("sha256").update(row.row_json).digest("hex") !== row.row_sha256
		)
			throw new Error("archive_digest_invalid");
		return JSON.parse(row.row_json) as Row;
	}
	maxSeq(): number {
		const row = this.db
			.prepare(`SELECT MAX(seq) AS seq FROM (
		 SELECT MAX(seq) AS seq FROM lead_events UNION ALL
		 SELECT MAX(CAST(json_extract(row_json,'$.seq') AS INTEGER)) AS seq FROM workflow_terminal_archive WHERE source_table='lead_events')`)
			.get() as { seq: number | null };
		return row.seq ?? 0;
	}
	anchor(seq: number): string | null {
		if (seq === 0) return null;
		const hot = this.db
			.prepare("SELECT event_id FROM lead_events WHERE seq=?")
			.get(seq) as { event_id: string } | undefined;
		const cold = this.db
			.prepare(
				"SELECT row_json,row_sha256 FROM workflow_terminal_archive WHERE source_table='lead_events' AND source_identity=?",
			)
			.all(String(seq)) as Array<{ row_json: string; row_sha256: string }>;
		const ids = new Set(cold.map((row) => this.verified(row).event_id));
		if (hot) ids.add(hot.event_id);
		if (ids.size > 1) throw new Error("audit_anchor_conflict");
		return [...ids][0] ?? null;
	}
	reconcile(cursor?: Cursor): NotificationAuditGeneration {
		return this.db.transaction(() => {
			const state = this.generation();
			const valid =
				state &&
				state.startSeq <= this.maxSeq() &&
				this.anchor(state.startSeq) === state.startEventId &&
				(state.startSeq === 0 || state.startEventId !== null);
			if (!valid) return this.replace(0, null, true);
			if (
				cursor &&
				(!cursor.storeEpoch || cursor.storeEpoch === state.generation) &&
				(cursor.offeredThroughSeq > this.maxSeq() ||
					cursor.offeredThroughSeq < state.startSeq ||
					this.anchor(cursor.offeredThroughSeq) !== cursor.anchorEventId ||
					(cursor.offeredThroughSeq > 0 && !cursor.anchorEventId))
			)
				return this.replace(state.startSeq, state.startEventId, true);
			return state;
		})();
	}
	page(input: NotificationAuditRange): {
		items: Row[];
		nextCursor: string | null;
		storeEpoch: string;
	} {
		const after = input.afterSeq ?? 0,
			through = input.throughSeq ?? Number.MAX_SAFE_INTEGER,
			before = input.beforeSeq ?? Number.MAX_SAFE_INTEGER,
			limit = input.limit ?? 50;
		if (
			![after, through, before, limit].every(Number.isSafeInteger) ||
			after < 0 ||
			through < after ||
			before < 1 ||
			limit < 1 ||
			limit > 50
		)
			throw new Error("invalid_audit_page");
		const epoch = this.generation()?.generation;
		if (!epoch) throw new Error("audit_generation_missing");
		if (input.storeEpoch !== undefined && input.storeEpoch !== epoch)
			throw new Error("audit_store_epoch_mismatch");
		// Explicit project identity wins. Missing identity is admitted only by an exact
		// durable execution/run binding, never by lead name or a string prefix.
		const scope = (payload: string) => `json_valid(${payload}) AND (
		 json_extract(${payload},'$.project_name')=? OR
		 (json_extract(${payload},'$.project_name') IS NULL AND (
		 EXISTS (SELECT 1 FROM sessions s WHERE s.execution_id=json_extract(${payload},'$.execution_id') AND s.project_name=?) OR
		 EXISTS (SELECT 1 FROM workflow_run w WHERE w.run_id=json_extract(${payload},'$.workflow_run_id') AND w.project_name=?))))`;
		const params = [
			input.leadId,
			after,
			through,
			before,
			input.projectName,
			input.projectName,
			input.projectName,
			limit + 1,
		];
		const hot = this.db
			.prepare(
				`SELECT * FROM lead_events WHERE lead_id=? AND delivery_disposition='audit_only' AND seq>? AND seq<=? AND seq<? AND ${scope("payload")} ORDER BY seq DESC LIMIT ?`,
			)
			.all(...params) as Row[];
		const cold = this.db
			.prepare(`SELECT row_json,row_sha256 FROM workflow_terminal_archive WHERE source_table='lead_events'
		 AND json_extract(row_json,'$.lead_id')=? AND json_extract(row_json,'$.delivery_disposition')='audit_only'
		 AND CAST(json_extract(row_json,'$.seq') AS INTEGER)>? AND CAST(json_extract(row_json,'$.seq') AS INTEGER)<=? AND CAST(json_extract(row_json,'$.seq') AS INTEGER)<?
		 AND ${scope("json_extract(row_json,'$.payload')")} ORDER BY CAST(json_extract(row_json,'$.seq') AS INTEGER) DESC LIMIT ?`)
			.all(...params) as Array<{ row_json: string; row_sha256: string }>;
		const rows = new Map<number, Row>();
		for (const raw of cold) {
			const row = this.verified(raw);
			rows.set(row.seq, row);
		}
		for (const row of hot) {
			if (rows.has(row.seq) && rows.get(row.seq)!.event_id !== row.event_id)
				throw new Error("audit_anchor_conflict");
			rows.set(row.seq, row);
		}
		const sorted = [...rows.values()].sort((a, b) => b.seq - a.seq),
			items = sorted.slice(0, limit);
		return {
			items,
			nextCursor: sorted.length > limit ? String(items.at(-1)!.seq) : null,
			storeEpoch: epoch,
		};
	}
	snapshot(input: { projectName: string; leadId: string }, cursor?: Cursor) {
		return this.db.transaction(() => {
			const generation = this.reconcile(cursor);
			const fromSeq =
				cursor?.storeEpoch === generation.generation
					? cursor.offeredThroughSeq
					: generation.startSeq;
			const throughSeq = this.maxSeq(),
				anchorEventId = this.anchor(throughSeq);
			let beforeSeq = Number.MAX_SAFE_INTEGER,
				total = 0;
			const counts: Record<string, number> = {},
				representatives: Row[] = [],
				seen = new Set<string>();
			while (true) {
				const page = this.page({
					...input,
					afterSeq: fromSeq,
					throughSeq,
					beforeSeq,
				});
				for (const row of page.items) {
					total++;
					counts[row.event_type] = (counts[row.event_type] ?? 0) + 1;
					const payload = JSON.parse(row.payload) as Record<string, unknown>;
					const key = JSON.stringify([
						row.event_type,
						payload.execution_id ?? row.event_id,
					]);
					if (representatives.length < 8 && !seen.has(key)) {
						representatives.push(row);
						seen.add(key);
					}
				}
				if (!page.nextCursor) break;
				beforeSeq = Number(page.nextCursor);
			}
			return {
				...generation,
				fromSeq,
				throughSeq,
				anchorEventId,
				total,
				counts,
				representatives,
			};
		})();
	}
}
