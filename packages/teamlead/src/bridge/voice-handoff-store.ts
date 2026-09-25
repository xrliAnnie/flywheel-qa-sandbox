import { createHash, randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
	AgendaBriefPurpose,
	VoiceAgendaResultPayload,
	VoiceHandoffRequest,
	VoiceHandoffResultEvent,
	VoiceHandoffResultKind,
	VoiceHandoffState,
} from "flywheel-voice-core";

export type VoiceHandoffRequestKind = "user_handoff" | "agenda_brief";

/** FLY-2863: server-derived agenda facts of one handoff row. A user handoff
 * gains a turn binding only from voice_agenda_turns; an agenda brief is a
 * server-authored request to the Lead, never a founder transcript. */
export type VoiceHandoffAgenda =
	| {
			kind: "turn";
			turnId: string;
			itemKey: string;
			itemState: "active" | "closed";
			/** Delivered only in this Lead's mailbox; `voice agenda say|close`
			 * must present it (FLY-2863 review R1). */
			answerKey: string;
	  }
	| {
			kind: "brief";
			purpose: AgendaBriefPurpose;
			itemKey: string | null;
			clientRequestId: string;
			/** Snowflake the brief is delivered as (a voice/Bridge bot, never
			 * the founder). */
			authorId: string;
			/** Delivered only in the brief text in this Lead's mailbox. */
			answerKey: string;
			brief: Record<string, unknown>;
			text: string;
	  };

export interface VoiceHandoffRecord {
	handoffId: string;
	idempotencyKey: string;
	requestDigest: string;
	projectName: string;
	founderUserId: string;
	targetLeadId: string;
	sessionId: string;
	generation: number;
	state: VoiceHandoffState;
	messageId: string;
	providerOperationId: string;
	attemptToken: string | null;
	stateVersion: number;
	requestKind: VoiceHandoffRequestKind;
	/** For agenda_brief rows this is a synthetic shape; read `agenda`. */
	request: VoiceHandoffRequest;
	agenda: VoiceHandoffAgenda | null;
	terminalReason: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface VoiceHandoffAuthorizeInput {
	request: VoiceHandoffRequest;
	projectName: string;
	founderUserId: string;
	targetLeadId: string;
	messageId: string;
	providerOperationId: string;
	/** Server-derived agenda turn binding (never taken from the client). */
	agenda?: Extract<VoiceHandoffAgenda, { kind: "turn" }>;
	now: string;
}

export interface VoiceAgendaBriefAuthorizeInput {
	handoffId: string;
	idempotencyKey: string;
	requestDigest: string;
	projectName: string;
	founderUserId: string;
	targetLeadId: string;
	sessionId: string;
	generation: number;
	messageId: string;
	providerOperationId: string;
	agenda: Extract<VoiceHandoffAgenda, { kind: "brief" }>;
	now: string;
}

function recordFromRow(row: Record<string, unknown>): VoiceHandoffRecord {
	return {
		handoffId: String(row.handoff_id),
		idempotencyKey: String(row.idempotency_key),
		requestDigest: String(row.request_digest),
		projectName: String(row.project_name),
		founderUserId: String(row.founder_user_id),
		targetLeadId: String(row.target_lead_id),
		sessionId: String(row.session_id),
		generation: Number(row.generation),
		state: row.state as VoiceHandoffState,
		messageId: String(row.message_id),
		providerOperationId: String(row.provider_operation_id),
		attemptToken: (row.attempt_token as string | null) ?? null,
		stateVersion: Number(row.state_version),
		requestKind:
			row.request_kind === "agenda_brief" ? "agenda_brief" : "user_handoff",
		request: JSON.parse(String(row.request_json)) as VoiceHandoffRequest,
		agenda:
			typeof row.agenda_json === "string"
				? (JSON.parse(row.agenda_json) as VoiceHandoffAgenda)
				: null,
		terminalReason: (row.terminal_reason as string | null) ?? null,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function resultFromRow(row: Record<string, unknown>): VoiceHandoffResultEvent {
	return {
		resultEventId: String(row.result_event_id),
		seq: Number(row.seq),
		handoffId: String(row.handoff_id),
		requestDigest: String(row.request_digest),
		sourceLeadId: String(row.source_lead_id),
		sourceDeliveryId: String(row.source_delivery_id),
		resultKind: row.result_kind as VoiceHandoffResultKind,
		text: String(row.text),
		...(typeof row.agenda_json === "string"
			? { agenda: JSON.parse(row.agenda_json) as VoiceAgendaResultPayload }
			: {}),
		createdAt: String(row.created_at),
	};
}

function resultDigest(input: {
	requestDigest: string;
	sourceLeadId: string;
	sourceDeliveryId: string;
	resultKind: VoiceHandoffResultKind;
	text: string;
	agenda?: VoiceAgendaResultPayload;
	createdAt: string;
}): string {
	const { agenda, ...legacy } = input;
	// Pre-agenda results keep their original digest bytes.
	return createHash("sha256")
		.update(JSON.stringify(agenda ? { ...legacy, agenda } : legacy))
		.digest("hex");
}

const RESULT_KIND_CHECK =
	"result_kind IN ('lead_reply','progress','completed','failed','agenda_say','agenda_close')";
const REQUEST_KIND_CHECK =
	"request_kind IN ('user_handoff','agenda_brief') AND (request_kind='agenda_brief' OR json_extract(request_json,'$.transcriptId') IS NOT NULL)";

export class VoiceHandoffStore {
	constructor(private readonly db: Database) {}

	migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS voice_handoffs (
				handoff_id TEXT PRIMARY KEY,
				idempotency_key TEXT NOT NULL UNIQUE,
				request_digest TEXT NOT NULL,
				project_name TEXT NOT NULL,
				founder_user_id TEXT NOT NULL,
				target_lead_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				generation INTEGER NOT NULL CHECK(generation > 0),
				state TEXT NOT NULL CHECK(state IN ('authorized','dispatching','committed','rejected','ambiguous','needs_human')),
				message_id TEXT NOT NULL UNIQUE,
				provider_operation_id TEXT NOT NULL UNIQUE,
				attempt_token TEXT,
				state_version INTEGER NOT NULL DEFAULT 1,
				request_json TEXT NOT NULL,
				request_kind TEXT NOT NULL DEFAULT 'user_handoff' CHECK(${REQUEST_KIND_CHECK}),
				agenda_json TEXT,
				terminal_reason TEXT,
				reconcile_count INTEGER NOT NULL DEFAULT 0,
				last_reconcile_at TEXT,
				next_reconcile_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS voice_handoff_results (
				handoff_id TEXT NOT NULL,
				result_event_id TEXT NOT NULL,
				seq INTEGER NOT NULL CHECK(seq > 0),
				request_digest TEXT NOT NULL,
				source_lead_id TEXT NOT NULL,
				source_delivery_id TEXT NOT NULL,
				result_kind TEXT NOT NULL CHECK(${RESULT_KIND_CHECK}),
				text TEXT NOT NULL,
				agenda_json TEXT,
				payload_digest TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY(handoff_id, result_event_id),
				UNIQUE(handoff_id, seq),
				FOREIGN KEY(handoff_id) REFERENCES voice_handoffs(handoff_id)
			);
		`);
		this.migrateAgendaColumns();
	}

	/** FLY-2863 additive migration for tables created before agendas. */
	private migrateAgendaColumns(): void {
		const columns = (table: string) =>
			new Set(
				(
					this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
						name: string;
					}>
				).map((column) => column.name),
			);
		const handoffs = columns("voice_handoffs");
		if (!handoffs.has("request_kind"))
			this.db.exec(
				`ALTER TABLE voice_handoffs ADD COLUMN request_kind TEXT NOT NULL DEFAULT 'user_handoff' CHECK(${REQUEST_KIND_CHECK})`,
			);
		if (!handoffs.has("agenda_json"))
			this.db.exec("ALTER TABLE voice_handoffs ADD COLUMN agenda_json TEXT");
		const resultSql = String(
			(
				this.db
					.prepare(
						"SELECT sql FROM sqlite_master WHERE type='table' AND name='voice_handoff_results'",
					)
					.get() as { sql?: string } | undefined
			)?.sql ?? "",
		);
		if (resultSql.includes("agenda_say")) return;
		// SQLite cannot widen a CHECK in place: rebuild once, rows unchanged.
		this.db.transaction(() => {
			this.db.exec(`
				CREATE TABLE voice_handoff_results_fly2863 (
					handoff_id TEXT NOT NULL,
					result_event_id TEXT NOT NULL,
					seq INTEGER NOT NULL CHECK(seq > 0),
					request_digest TEXT NOT NULL,
					source_lead_id TEXT NOT NULL,
					source_delivery_id TEXT NOT NULL,
					result_kind TEXT NOT NULL CHECK(${RESULT_KIND_CHECK}),
					text TEXT NOT NULL,
					agenda_json TEXT,
					payload_digest TEXT NOT NULL,
					created_at TEXT NOT NULL,
					PRIMARY KEY(handoff_id, result_event_id),
					UNIQUE(handoff_id, seq),
					FOREIGN KEY(handoff_id) REFERENCES voice_handoffs(handoff_id)
				);
				INSERT INTO voice_handoff_results_fly2863
				 (handoff_id,result_event_id,seq,request_digest,source_lead_id,
				  source_delivery_id,result_kind,text,payload_digest,created_at)
				 SELECT handoff_id,result_event_id,seq,request_digest,source_lead_id,
				  source_delivery_id,result_kind,text,payload_digest,created_at
				 FROM voice_handoff_results;
				DROP TABLE voice_handoff_results;
				ALTER TABLE voice_handoff_results_fly2863 RENAME TO voice_handoff_results;
			`);
		})();
	}

	listAmbiguous(now: string, limit = 20): VoiceHandoffRecord[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new Error("voice_handoff_reconcile_limit_invalid");
		return (
			this.db
				.prepare(
					`SELECT * FROM voice_handoffs
					 WHERE state='ambiguous' AND (next_reconcile_at IS NULL OR next_reconcile_at<=?)
					 ORDER BY updated_at,handoff_id LIMIT ?`,
				)
				.all(now, limit) as Record<string, unknown>[]
		).map(recordFromRow);
	}

	/** FLY-2863 review R4: a dispatch that outlived its process (the Bridge
	 * stopped between the mailbox write and finishDispatch) is an unknown
	 * outcome, so it joins the read-only mailbox reconciliation instead of
	 * staying `dispatching` forever. A late finishDispatch then fails its
	 * attempt-token fence. */
	promoteStaleDispatching(now: string, staleMs: number): number {
		if (!Number.isSafeInteger(staleMs) || staleMs < 1)
			throw new Error("voice_handoff_stale_dispatch_ms_invalid");
		const cutoff = new Date(Date.parse(now) - staleMs).toISOString();
		return this.db
			.prepare(
				`UPDATE voice_handoffs
				 SET state='ambiguous', attempt_token=NULL, terminal_reason='dispatch_interrupted',
				     next_reconcile_at=NULL, state_version=state_version+1, updated_at=?
				 WHERE state='dispatching' AND updated_at<=?`,
			)
			.run(now, cutoff).changes;
	}

	recordReconcile(input: {
		handoffId: string;
		found: boolean;
		now: string;
	}): VoiceHandoffRecord | undefined {
		return this.db.transaction(() => {
			const current = this.db
				.prepare(
					"SELECT reconcile_count FROM voice_handoffs WHERE handoff_id=? AND state='ambiguous'",
				)
				.get(input.handoffId) as { reconcile_count: number } | undefined;
			if (!current) return undefined;
			const count = Number(current.reconcile_count) + 1;
			const state = input.found
				? "committed"
				: count >= 5
					? "needs_human"
					: "ambiguous";
			const backoffMs = [1_000, 5_000, 30_000, 120_000, 600_000][
				Math.min(count - 1, 4)
			]!;
			this.db
				.prepare(
					`UPDATE voice_handoffs
					 SET state=?, reconcile_count=?, last_reconcile_at=?, next_reconcile_at=?,
					     terminal_reason=?, state_version=state_version+1, updated_at=?
					 WHERE handoff_id=? AND state='ambiguous'`,
				)
				.run(
					state,
					count,
					input.now,
					state === "ambiguous"
						? new Date(Date.parse(input.now) + backoffMs).toISOString()
						: null,
					state === "needs_human" ? "provider_outcome_unconfirmed" : null,
					input.now,
					input.handoffId,
				);
			return this.get(input.handoffId);
		})();
	}

	get(handoffId: string): VoiceHandoffRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM voice_handoffs WHERE handoff_id = ?")
			.get(handoffId) as Record<string, unknown> | undefined;
		return row ? recordFromRow(row) : undefined;
	}

	authorize(input: VoiceHandoffAuthorizeInput): VoiceHandoffRecord {
		return this.db.transaction(() => {
			const prior = this.db
				.prepare(
					"SELECT * FROM voice_handoffs WHERE handoff_id = ? OR idempotency_key = ?",
				)
				.get(input.request.handoffId, input.request.idempotencyKey) as
				| Record<string, unknown>
				| undefined;
			if (prior) {
				const record = recordFromRow(prior);
				if (
					record.handoffId !== input.request.handoffId ||
					record.idempotencyKey !== input.request.idempotencyKey ||
					record.requestDigest !== input.request.requestDigest
				)
					throw new Error("voice_handoff_identity_conflict");
				return record;
			}
			this.db
				.prepare(
					`INSERT INTO voice_handoffs
					 (handoff_id,idempotency_key,request_digest,project_name,founder_user_id,
					  target_lead_id,session_id,generation,state,message_id,
					  provider_operation_id,request_json,agenda_json,created_at,updated_at)
					 VALUES (?,?,?,?,?,?,?,?,'authorized',?,?,?,?,?,?)`,
				)
				.run(
					input.request.handoffId,
					input.request.idempotencyKey,
					input.request.requestDigest,
					input.projectName,
					input.founderUserId,
					input.targetLeadId,
					input.request.sessionId,
					input.request.generation,
					input.messageId,
					input.providerOperationId,
					JSON.stringify(input.request),
					input.agenda ? JSON.stringify(input.agenda) : null,
					input.now,
					input.now,
				);
			return this.get(input.request.handoffId)!;
		})();
	}

	/** FLY-2863 §3.1: a server-authored agenda request rides the same durable
	 * delivery and result stream, but carries no founder transcript. */
	authorizeAgendaBrief(
		input: VoiceAgendaBriefAuthorizeInput,
	): VoiceHandoffRecord {
		return this.db.transaction(() => {
			const prior = this.db
				.prepare(
					"SELECT * FROM voice_handoffs WHERE handoff_id = ? OR idempotency_key = ?",
				)
				.get(input.handoffId, input.idempotencyKey) as
				| Record<string, unknown>
				| undefined;
			if (prior) {
				const record = recordFromRow(prior);
				if (
					record.requestKind !== "agenda_brief" ||
					record.idempotencyKey !== input.idempotencyKey ||
					record.requestDigest !== input.requestDigest
				)
					throw new Error("voice_agenda_request_identity_conflict");
				return record;
			}
			this.db
				.prepare(
					`INSERT INTO voice_handoffs
					 (handoff_id,idempotency_key,request_digest,project_name,founder_user_id,
					  target_lead_id,session_id,generation,state,message_id,
					  provider_operation_id,request_json,request_kind,agenda_json,
					  created_at,updated_at)
					 VALUES (?,?,?,?,?,?,?,?,'authorized',?,?,?,'agenda_brief',?,?,?)`,
				)
				.run(
					input.handoffId,
					input.idempotencyKey,
					input.requestDigest,
					input.projectName,
					input.founderUserId,
					input.targetLeadId,
					input.sessionId,
					input.generation,
					input.messageId,
					input.providerOperationId,
					JSON.stringify({
						kind: "agenda_brief",
						handoffId: input.handoffId,
						sessionId: input.sessionId,
						generation: input.generation,
					}),
					JSON.stringify(input.agenda),
					input.now,
					input.now,
				);
			return this.get(input.handoffId)!;
		})();
	}

	beginDispatch(
		handoffId: string,
		now: string,
	): VoiceHandoffRecord | undefined {
		return this.db.transaction(() => {
			const attemptToken = randomBytes(32).toString("hex");
			const changed = this.db
				.prepare(
					`UPDATE voice_handoffs
					 SET state='dispatching', attempt_token=?, state_version=state_version+1, updated_at=?
					 WHERE handoff_id=? AND state='authorized'`,
				)
				.run(attemptToken, now, handoffId).changes;
			return changed === 1 ? this.get(handoffId) : undefined;
		})();
	}

	finishDispatch(input: {
		handoffId: string;
		attemptToken: string;
		state: "committed" | "rejected" | "ambiguous";
		reason?: string;
		now: string;
	}): VoiceHandoffRecord | undefined {
		return this.db.transaction(() => {
			const changed = this.db
				.prepare(
					`UPDATE voice_handoffs
					 SET state=?, terminal_reason=?, attempt_token=NULL,
					     state_version=state_version+1, updated_at=?
					 WHERE handoff_id=? AND state='dispatching' AND attempt_token=?`,
				)
				.run(
					input.state,
					input.reason ?? null,
					input.now,
					input.handoffId,
					input.attemptToken,
				).changes;
			return changed === 1 ? this.get(input.handoffId) : undefined;
		})();
	}

	appendResult(input: {
		handoffId: string;
		resultEventId: string;
		requestDigest: string;
		sourceLeadId: string;
		sourceDeliveryId: string;
		resultKind: VoiceHandoffResultKind;
		text: string;
		agenda?: VoiceAgendaResultPayload;
		createdAt: string;
	}): VoiceHandoffResultEvent {
		return this.db.transaction(() => {
			const handoff = this.get(input.handoffId);
			if (
				!handoff ||
				handoff.requestDigest !== input.requestDigest ||
				handoff.targetLeadId !== input.sourceLeadId
			)
				throw new Error("voice_handoff_result_unauthorized");
			const agendaKind =
				input.resultKind === "agenda_say" ||
				input.resultKind === "agenda_close";
			if (
				agendaKind !== Boolean(input.agenda) ||
				(input.resultKind === "agenda_say" && input.agenda?.kind !== "say") ||
				(input.resultKind === "agenda_close" && input.agenda?.kind !== "close")
			)
				throw new Error("voice_handoff_result_agenda_invalid");
			const digest = resultDigest(input);
			const prior = this.db
				.prepare(
					"SELECT * FROM voice_handoff_results WHERE handoff_id=? AND result_event_id=?",
				)
				.get(input.handoffId, input.resultEventId) as
				| Record<string, unknown>
				| undefined;
			if (prior) {
				if (prior.payload_digest !== digest)
					throw new Error("voice_handoff_result_conflict");
				return resultFromRow(prior);
			}
			const row = this.db
				.prepare(
					"SELECT COALESCE(MAX(seq),0)+1 AS seq FROM voice_handoff_results WHERE handoff_id=?",
				)
				.get(input.handoffId) as { seq: number };
			this.db
				.prepare(
					`INSERT INTO voice_handoff_results
					 (handoff_id,result_event_id,seq,request_digest,source_lead_id,
					  source_delivery_id,result_kind,text,agenda_json,payload_digest,created_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
				)
				.run(
					input.handoffId,
					input.resultEventId,
					row.seq,
					input.requestDigest,
					input.sourceLeadId,
					input.sourceDeliveryId,
					input.resultKind,
					input.text,
					input.agenda ? JSON.stringify(input.agenda) : null,
					digest,
					input.createdAt,
				);
			return resultFromRow(
				this.db
					.prepare(
						"SELECT * FROM voice_handoff_results WHERE handoff_id=? AND result_event_id=?",
					)
					.get(input.handoffId, input.resultEventId) as Record<string, unknown>,
			);
		})();
	}

	getResult(
		handoffId: string,
		resultEventId: string,
	): VoiceHandoffResultEvent | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM voice_handoff_results WHERE handoff_id=? AND result_event_id=?",
			)
			.get(handoffId, resultEventId) as Record<string, unknown> | undefined;
		return row ? resultFromRow(row) : undefined;
	}

	listResults(
		handoffId: string,
		after: number,
		limit: number,
	): {
		events: VoiceHandoffResultEvent[];
		highWatermark: number;
		nextCursor: number;
	} {
		if (
			!Number.isSafeInteger(after) ||
			after < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 100
		)
			throw new Error("voice_handoff_result_cursor_invalid");
		const highWatermark = Number(
			(
				this.db
					.prepare(
						"SELECT COALESCE(MAX(seq),0) AS seq FROM voice_handoff_results WHERE handoff_id=?",
					)
					.get(handoffId) as { seq: number }
			).seq,
		);
		const events = (
			this.db
				.prepare(
					`SELECT * FROM voice_handoff_results
					 WHERE handoff_id=? AND seq>? AND seq<=?
					 ORDER BY seq LIMIT ?`,
				)
				.all(handoffId, after, highWatermark, limit) as Record<
				string,
				unknown
			>[]
		).map(resultFromRow);
		return {
			events,
			highWatermark,
			nextCursor: events.at(-1)?.seq ?? after,
		};
	}
}
