/**
 * FLY-2883 — authoritative record + append-only audit for controlled Lead
 * interrupts. Uses StateStore's existing connection (teamlead.db).
 *
 * The audit carries only a body digest, never the body. Every state change is
 * written together with its audit row in one transaction; if the audit insert
 * fails the change rolls back, so "no audit" always means "nothing happened".
 */

import type Database from "better-sqlite3";
import {
	type LeadInterruptBackend,
	leadInterruptDeliveryId,
} from "./lead-interrupt-contract.js";

export type LeadInterruptState =
	| "requested"
	| "queued"
	| "delivered"
	| "replied"
	| "failed";
export type LeadInterruptDisposition =
	| "steered"
	| "queued_turn"
	| "nudged"
	| "mailbox_only";
export type LeadInterruptAuditEvent =
	| "requested"
	| "refused"
	| "enqueued"
	| "enqueue_failed"
	| "dispatch_attempt"
	| "steered"
	| "queued_turn"
	| "steer_failed"
	| "nudge_attempt"
	| "nudged"
	| "nudge_skipped"
	| "nudge_failed"
	| "mailbox_only"
	| "replied"
	| "acked_after_reply";
export type LeadInterruptInitiatorKind = "voice_session";

export interface LeadInterruptRow {
	interruptId: string;
	initiatorKind: LeadInterruptInitiatorKind;
	initiatorRef: string;
	idempotencyKey: string;
	requestDigest: string;
	founderMessageId: string;
	targetProject: string;
	targetLeadId: string;
	targetBackend: LeadInterruptBackend;
	body: string;
	bodyDigest: string;
	deliveryId: string;
	state: LeadInterruptState;
	disposition: LeadInterruptDisposition | null;
	dispositionReason: string | null;
	replyText: string | null;
	replyDigest: string | null;
	repliedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface LeadInterruptAuditRow {
	id: number;
	interruptId: string;
	event: LeadInterruptAuditEvent;
	initiatorKind: string;
	initiatorRef: string;
	founderMessageId: string | null;
	targetProject: string | null;
	targetLeadId: string | null;
	bodyDigest: string | null;
	detail: string | null;
	at: string;
}

export interface CreateLeadInterruptInput {
	interruptId: string;
	initiatorKind: LeadInterruptInitiatorKind;
	initiatorRef: string;
	idempotencyKey: string;
	requestDigest: string;
	founderMessageId: string;
	targetProject: string;
	targetLeadId: string;
	targetBackend: LeadInterruptBackend;
	body: string;
	bodyDigest: string;
	now: string;
}

export class LeadInterruptStateConflictError extends Error {
	constructor(interruptId: string) {
		super(`lead_interrupt_state_conflict: ${interruptId}`);
		this.name = "LeadInterruptStateConflictError";
	}
}

const ROW_SELECT = `interrupt_id AS interruptId, initiator_kind AS initiatorKind,
 initiator_ref AS initiatorRef, idempotency_key AS idempotencyKey,
 request_digest AS requestDigest, founder_message_id AS founderMessageId,
 target_project AS targetProject, target_lead_id AS targetLeadId,
 target_backend AS targetBackend, body, body_digest AS bodyDigest,
 delivery_id AS deliveryId, state, disposition,
 disposition_reason AS dispositionReason, reply_text AS replyText,
 reply_digest AS replyDigest, replied_at AS repliedAt,
 created_at AS createdAt, updated_at AS updatedAt`;

const AUDIT_SELECT = `id, interrupt_id AS interruptId, event,
 initiator_kind AS initiatorKind, initiator_ref AS initiatorRef,
 founder_message_id AS founderMessageId, target_project AS targetProject,
 target_lead_id AS targetLeadId, body_digest AS bodyDigest, detail, at`;

export class LeadInterruptStore {
	constructor(private readonly db: Database.Database) {}

	migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS lead_interrupts (
				interrupt_id TEXT PRIMARY KEY,
				initiator_kind TEXT NOT NULL CHECK (initiator_kind IN ('voice_session')),
				initiator_ref TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				request_digest TEXT NOT NULL,
				founder_message_id TEXT NOT NULL,
				target_project TEXT NOT NULL,
				target_lead_id TEXT NOT NULL,
				target_backend TEXT NOT NULL CHECK (target_backend IN ('claude-code','codex-app-server')),
				body TEXT NOT NULL,
				body_digest TEXT NOT NULL,
				delivery_id TEXT NOT NULL UNIQUE,
				state TEXT NOT NULL CHECK (state IN ('requested','queued','delivered','replied','failed')),
				disposition TEXT CHECK (disposition IS NULL OR disposition IN ('steered','queued_turn','nudged','mailbox_only')),
				disposition_reason TEXT,
				reply_text TEXT,
				reply_digest TEXT,
				replied_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE (initiator_kind, initiator_ref, idempotency_key)
			);
			CREATE INDEX IF NOT EXISTS lead_interrupts_target_open
				ON lead_interrupts(target_project, target_lead_id, state);
			CREATE INDEX IF NOT EXISTS lead_interrupts_initiator_created
				ON lead_interrupts(initiator_kind, initiator_ref, created_at);
			CREATE TABLE IF NOT EXISTS lead_interrupt_audit (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				interrupt_id TEXT NOT NULL,
				event TEXT NOT NULL CHECK (event IN ('requested','refused','enqueued','enqueue_failed',
					'dispatch_attempt','steered','queued_turn','steer_failed','nudge_attempt','nudged',
					'nudge_skipped','nudge_failed','mailbox_only','replied','acked_after_reply')),
				initiator_kind TEXT NOT NULL,
				initiator_ref TEXT NOT NULL,
				founder_message_id TEXT,
				target_project TEXT,
				target_lead_id TEXT,
				body_digest TEXT,
				detail TEXT,
				at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS lead_interrupt_audit_interrupt
				ON lead_interrupt_audit(interrupt_id, id);
			CREATE TRIGGER IF NOT EXISTS lead_interrupt_audit_no_update BEFORE UPDATE ON lead_interrupt_audit
				BEGIN SELECT RAISE(ABORT, 'lead_interrupt_audit is append-only'); END;
			CREATE TRIGGER IF NOT EXISTS lead_interrupt_audit_no_delete BEFORE DELETE ON lead_interrupt_audit
				BEGIN SELECT RAISE(ABORT, 'lead_interrupt_audit is append-only'); END;
			CREATE TRIGGER IF NOT EXISTS lead_interrupt_audit_no_replace BEFORE INSERT ON lead_interrupt_audit
				WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM lead_interrupt_audit WHERE id = NEW.id)
				BEGIN SELECT RAISE(ABORT, 'lead_interrupt_audit is append-only'); END;
		`);
	}

	get(interruptId: string): LeadInterruptRow | undefined {
		return this.db
			.prepare(
				`SELECT ${ROW_SELECT} FROM lead_interrupts WHERE interrupt_id = ?`,
			)
			.get(interruptId) as LeadInterruptRow | undefined;
	}

	getByDeliveryId(deliveryId: string): LeadInterruptRow | undefined {
		return this.db
			.prepare(
				`SELECT ${ROW_SELECT} FROM lead_interrupts WHERE delivery_id = ?`,
			)
			.get(deliveryId) as LeadInterruptRow | undefined;
	}

	getByIdempotencyKey(
		initiatorKind: LeadInterruptInitiatorKind,
		initiatorRef: string,
		idempotencyKey: string,
	): LeadInterruptRow | undefined {
		return this.db
			.prepare(
				`SELECT ${ROW_SELECT} FROM lead_interrupts
				 WHERE initiator_kind = ? AND initiator_ref = ? AND idempotency_key = ?`,
			)
			.get(initiatorKind, initiatorRef, idempotencyKey) as
			| LeadInterruptRow
			| undefined;
	}

	listAudit(interruptId: string): LeadInterruptAuditRow[] {
		return this.db
			.prepare(
				`SELECT ${AUDIT_SELECT} FROM lead_interrupt_audit WHERE interrupt_id = ? ORDER BY id`,
			)
			.all(interruptId) as LeadInterruptAuditRow[];
	}

	hasAuditEvent(interruptId: string, event: LeadInterruptAuditEvent): boolean {
		return Boolean(
			this.db
				.prepare(
					"SELECT 1 FROM lead_interrupt_audit WHERE interrupt_id = ? AND event = ? LIMIT 1",
				)
				.get(interruptId, event),
		);
	}

	/** Open (not yet answered or failed) interrupts from one initiator to one Lead. */
	countOpenForTarget(input: {
		initiatorKind: LeadInterruptInitiatorKind;
		initiatorRef: string;
		targetProject: string;
		targetLeadId: string;
		since: string;
	}): number {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS n FROM lead_interrupts
				 WHERE initiator_kind = ? AND initiator_ref = ?
				   AND target_project = ? AND target_lead_id = ?
				   AND state IN ('requested','queued','delivered')
				   AND created_at >= ?`,
			)
			.get(
				input.initiatorKind,
				input.initiatorRef,
				input.targetProject,
				input.targetLeadId,
				input.since,
			) as { n: number };
		return row.n;
	}

	countRecentForInitiator(input: {
		initiatorKind: LeadInterruptInitiatorKind;
		initiatorRef: string;
		since: string;
	}): number {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS n FROM lead_interrupts
				 WHERE initiator_kind = ? AND initiator_ref = ? AND created_at >= ?`,
			)
			.get(input.initiatorKind, input.initiatorRef, input.since) as {
			n: number;
		};
		return row.n;
	}

	listPendingForLead(
		targetProject: string,
		targetLeadId: string,
	): LeadInterruptRow[] {
		return this.db
			.prepare(
				`SELECT ${ROW_SELECT} FROM lead_interrupts
				 WHERE target_project = ? AND target_lead_id = ?
				   AND state IN ('queued','delivered')
				 ORDER BY created_at, interrupt_id`,
			)
			.all(targetProject, targetLeadId) as LeadInterruptRow[];
	}

	/** Segment 1: the row and its `requested` audit, atomically. */
	createRequested(input: CreateLeadInterruptInput): LeadInterruptRow {
		this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT INTO lead_interrupts (
						interrupt_id, initiator_kind, initiator_ref, idempotency_key,
						request_digest, founder_message_id, target_project, target_lead_id,
						target_backend, body, body_digest, delivery_id, state,
						created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
				)
				.run(
					input.interruptId,
					input.initiatorKind,
					input.initiatorRef,
					input.idempotencyKey,
					input.requestDigest,
					input.founderMessageId,
					input.targetProject,
					input.targetLeadId,
					input.targetBackend,
					input.body,
					input.bodyDigest,
					leadInterruptDeliveryId(input.interruptId),
					input.now,
					input.now,
				);
			this.insertAuditFor(input, "requested", null, input.now);
		})();
		const row = this.get(input.interruptId);
		if (!row)
			throw new Error(
				`lead interrupt insert disappeared: ${input.interruptId}`,
			);
		return row;
	}

	/** Standalone audit (refusals, dispatch attempts, nudge attempts, ...). */
	appendAudit(input: {
		interruptId: string;
		event: LeadInterruptAuditEvent;
		initiatorKind: string;
		initiatorRef: string;
		founderMessageId: string | null;
		targetProject: string | null;
		targetLeadId: string | null;
		bodyDigest: string | null;
		detail: string | null;
		now: string;
	}): void {
		this.db
			.prepare(
				`INSERT INTO lead_interrupt_audit (
					interrupt_id, event, initiator_kind, initiator_ref, founder_message_id,
					target_project, target_lead_id, body_digest, detail, at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.interruptId,
				input.event,
				input.initiatorKind,
				input.initiatorRef,
				input.founderMessageId,
				input.targetProject,
				input.targetLeadId,
				input.bodyDigest,
				input.detail,
				input.now,
			);
	}

	/** Audit an event against an existing interrupt row (fields copied from it). */
	appendEvent(
		interruptId: string,
		event: LeadInterruptAuditEvent,
		detail: string | null,
		now: string,
	): void {
		const row = this.get(interruptId);
		if (!row) throw new Error(`lead interrupt not found: ${interruptId}`);
		this.insertAuditFor(row, event, detail, now);
	}

	/** Guarded state change + audit, atomically. Throws when 0 rows match. */
	transition(input: {
		interruptId: string;
		from: readonly LeadInterruptState[];
		to: LeadInterruptState;
		event: LeadInterruptAuditEvent;
		detail?: string | null;
		disposition?: LeadInterruptDisposition;
		dispositionReason?: string | null;
		now: string;
	}): void {
		this.db.transaction(() => {
			const row = this.get(input.interruptId);
			if (!row || !input.from.includes(row.state)) {
				throw new LeadInterruptStateConflictError(input.interruptId);
			}
			const placeholders = input.from.map(() => "?").join(",");
			const changed = this.db
				.prepare(
					`UPDATE lead_interrupts SET state = ?,
					   disposition = COALESCE(?, disposition),
					   disposition_reason = CASE WHEN ? IS NULL THEN disposition_reason ELSE ? END,
					   updated_at = ?
					 WHERE interrupt_id = ? AND state IN (${placeholders})`,
				)
				.run(
					input.to,
					input.disposition ?? null,
					input.disposition ?? null,
					input.dispositionReason ?? null,
					input.now,
					input.interruptId,
					...input.from,
				).changes;
			if (changed !== 1)
				throw new LeadInterruptStateConflictError(input.interruptId);
			this.insertAuditFor(row, input.event, input.detail ?? null, input.now);
		})();
	}

	/**
	 * Record how the letter reached the Lead. `queued|delivered → delivered`.
	 * A row the Lead already answered keeps `replied` and only gains the
	 * disposition (R2#6). Same disposition replays; a different one is refused.
	 */
	recordDisposition(input: {
		interruptId: string;
		disposition: LeadInterruptDisposition;
		reason: string | null;
		event: LeadInterruptAuditEvent;
		now: string;
	}): "recorded" | "replayed" | "conflict" | "invalid_state" {
		return this.db.transaction(() => {
			const row = this.get(input.interruptId);
			if (!row) return "invalid_state" as const;
			if (row.disposition !== null) {
				if (row.disposition === input.disposition) return "replayed" as const;
				// Fail closed: keep the first disposition, but leave a trail.
				this.insertAuditFor(
					row,
					input.event,
					`disposition_conflict:${row.disposition}${input.reason ? `:${input.reason}` : ""}`,
					input.now,
				);
				return "conflict" as const;
			}
			if (!["queued", "delivered", "replied"].includes(row.state)) {
				return "invalid_state" as const;
			}
			this.db
				.prepare(
					`UPDATE lead_interrupts SET
					   state = CASE WHEN state = 'replied' THEN 'replied' ELSE 'delivered' END,
					   disposition = ?, disposition_reason = ?, updated_at = ?
					 WHERE interrupt_id = ? AND disposition IS NULL`,
				)
				.run(input.disposition, input.reason, input.now, input.interruptId);
			this.insertAuditFor(row, input.event, input.reason, input.now);
			return "recorded" as const;
		})();
	}

	recordReply(input: {
		interruptId: string;
		text: string;
		replyDigest: string;
		now: string;
	}): "replied" | "replayed" | "conflict" | "invalid_state" | "not_found" {
		return this.db.transaction(() => {
			const row = this.get(input.interruptId);
			if (!row) return "not_found" as const;
			if (row.state === "replied") {
				return row.replyDigest === input.replyDigest
					? ("replayed" as const)
					: ("conflict" as const);
			}
			if (row.state !== "queued" && row.state !== "delivered") {
				return "invalid_state" as const;
			}
			this.db
				.prepare(
					`UPDATE lead_interrupts SET state = 'replied', reply_text = ?,
					   reply_digest = ?, replied_at = ?, updated_at = ?
					 WHERE interrupt_id = ? AND state IN ('queued','delivered')`,
				)
				.run(
					input.text,
					input.replyDigest,
					input.now,
					input.now,
					input.interruptId,
				);
			this.insertAuditFor(row, "replied", null, input.now);
			return "replied" as const;
		})();
	}

	private insertAuditFor(
		row: Pick<
			LeadInterruptRow,
			| "interruptId"
			| "initiatorKind"
			| "initiatorRef"
			| "founderMessageId"
			| "targetProject"
			| "targetLeadId"
			| "bodyDigest"
		>,
		event: LeadInterruptAuditEvent,
		detail: string | null,
		now: string,
	): void {
		this.appendAudit({
			interruptId: row.interruptId,
			event,
			initiatorKind: row.initiatorKind,
			initiatorRef: row.initiatorRef,
			founderMessageId: row.founderMessageId,
			targetProject: row.targetProject,
			targetLeadId: row.targetLeadId,
			bodyDigest: row.bodyDigest,
			detail,
			now,
		});
	}
}
