import { createHash, randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
	VoiceHandoffRequest,
	VoiceHandoffResultEvent,
	VoiceHandoffResultKind,
	VoiceHandoffState,
} from "flywheel-voice-core";

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
	request: VoiceHandoffRequest;
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
		request: JSON.parse(String(row.request_json)) as VoiceHandoffRequest,
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
		createdAt: String(row.created_at),
	};
}

function resultDigest(input: {
	requestDigest: string;
	sourceLeadId: string;
	sourceDeliveryId: string;
	resultKind: VoiceHandoffResultKind;
	text: string;
	createdAt: string;
}): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

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
				result_kind TEXT NOT NULL CHECK(result_kind IN ('lead_reply','progress','completed','failed')),
				text TEXT NOT NULL,
				payload_digest TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY(handoff_id, result_event_id),
				UNIQUE(handoff_id, seq),
				FOREIGN KEY(handoff_id) REFERENCES voice_handoffs(handoff_id)
			);
		`);
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
					  provider_operation_id,request_json,created_at,updated_at)
					 VALUES (?,?,?,?,?,?,?,?,'authorized',?,?,?,?,?)`,
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
					input.now,
					input.now,
				);
			return this.get(input.request.handoffId)!;
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
					  source_delivery_id,result_kind,text,payload_digest,created_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?)`,
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
