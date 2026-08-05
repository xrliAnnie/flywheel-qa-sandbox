import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	cpSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import Database from "better-sqlite3";

export { Database };

import { canonicalJsonString } from "flywheel-config";
import {
	type EnqueueMailboxInput,
	MailboxQueue,
	type MailboxState,
} from "./mailbox-queue.js";
import {
	MAILBOX_CORE_SCHEMA,
	MAILBOX_POISON_VIEWS,
	MAILBOX_SCHEMA_GENERATION,
} from "./mailbox-schema.js";
import { encodeSenderRef } from "./sender-ref.js";

type LegacyRow = Record<string, unknown> & { __rowid: number; id: string };

export type MailboxMigrationFault =
	| "after_source_load"
	| "after_schema"
	| "after_messages"
	| "after_lead_inbox"
	| "after_legacy_drop"
	| "before_completed_marker";

export interface MailboxMigrationResult {
	status: "migrated" | "already_migrated";
	sourceMessages: number;
	sourceLeadInbox: number;
	sourceTrueUnread: number;
}

export type MailboxSwapPhase =
	| "fenced"
	| "backed_up"
	| "sidecars_quarantined"
	| "staging_verified"
	| "canonical_swapped"
	| "dir_fsynced"
	| "verified"
	| "done";

interface MailboxSwapIntent {
	v: 1;
	dbPath: string;
	backupPath: string;
	stagingPath: string;
	phase: MailboxSwapPhase | "aborted";
	originalMode: number;
	createdAt: string;
	sourceMessages: number;
	sourceLeadInbox: number;
	quarantinedSidecars: string[];
}

export interface MailboxSwapResult extends MailboxMigrationResult {
	backupPath: string;
	intentPath: string;
}

export type MailboxRestorePhase =
	| "staged"
	| "refs_swapped"
	| "db_swapped"
	| "verified"
	| "done";

interface MailboxRestoreIntent {
	v: 1;
	dbPath: string;
	backupPath: string;
	dbStage: string;
	refsStage: string;
	refsQuarantine: string;
	phase: MailboxRestorePhase;
	createdAt: string;
}

interface MappedMessage {
	input: EnqueueMailboxInput;
	state: MailboxState;
	ackedAt?: string;
	deadAt?: string;
	deadReason?: string;
	retryCount: number;
	lastError?: string;
	sources: Array<{ table: "messages" | "lead_inbox"; row: LegacyRow }>;
	settlement?: {
		event: "processed" | "disposed";
		at: string;
		evidence: unknown;
	};
}

const RETENTION_MS = 72 * 60 * 60_000;

function tableType(db: Database.Database, name: string): string | undefined {
	return (
		db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(name) as
			| { type?: string }
			| undefined
	)?.type;
}

function text(row: LegacyRow, key: string): string | undefined {
	const value = row[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(row: LegacyRow, key: string): number | undefined {
	const value = row[key];
	return typeof value === "number" && Number.isSafeInteger(value)
		? value
		: undefined;
}

function iso(value: unknown, fallback: string): string {
	if (typeof value !== "string" || !value.trim()) return fallback;
	const normalized = value.includes("T") ? value : value.replace(" ", "T");
	const withZone = normalized.endsWith("Z") ? normalized : `${normalized}Z`;
	const millis = Date.parse(withZone);
	if (!Number.isFinite(millis))
		throw new Error(`invalid legacy timestamp: ${value}`);
	return new Date(millis).toISOString();
}

function optionalIso(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? iso(value, "") : undefined;
}

function recipientKind(
	toAgent: string,
	type: string,
): "lead" | "runner" | "bridge" {
	if (toAgent === "bridge") return "bridge";
	if (type === "question" || toAgent === "lead" || toAgent.endsWith("-lead")) {
		return "lead";
	}
	return "runner";
}

function isMirror(row: LegacyRow): boolean {
	const source = text(row, "source") ?? "";
	return source.startsWith("question:") || source.startsWith("ack_receipt:");
}

function isTrueUnread(row: LegacyRow): boolean {
	return (
		(text(row, "carrier") ?? "inbox") === "inbox" &&
		!text(row, "processed_at") &&
		!text(row, "consumed_at") &&
		!text(row, "delivered_at")
	);
}

function parseEvidence(value: unknown): unknown {
	if (typeof value !== "string" || !value.trim()) return {};
	try {
		return JSON.parse(value);
	} catch {
		return { legacy_evidence: value };
	}
}

function settlement(row: LegacyRow): MappedMessage["settlement"] {
	const processedAt = optionalIso(row.processed_at);
	const disposedAt = optionalIso(row.disposed_at);
	if (processedAt && disposedAt) {
		throw new Error(
			`legacy row has both processed and disposed settlement: ${row.id}`,
		);
	}
	if (processedAt) {
		return {
			event: "processed",
			at: processedAt,
			evidence: parseEvidence(row.processed_evidence),
		};
	}
	if (disposedAt) {
		return {
			event: "disposed",
			at: disposedAt,
			evidence: parseEvidence(row.disposed_evidence),
		};
	}
	return undefined;
}

function classifyLead(
	row: LegacyRow,
	now: string,
): Pick<
	MappedMessage,
	"state" | "ackedAt" | "deadAt" | "deadReason" | "settlement"
> {
	const settled = settlement(row);
	const disposition = text(row, "disposition");
	if (disposition && /frozen|quarantine|dead/i.test(disposition)) {
		return {
			state: "DEAD",
			deadAt:
				optionalIso(row.disposed_at) ??
				optionalIso(row.consumed_at) ??
				optionalIso(row.delivered_at) ??
				now,
			deadReason: disposition,
			settlement: settled,
		};
	}
	if (settled?.event === "disposed") {
		return {
			state: "DEAD",
			deadAt: settled.at,
			deadReason: disposition ?? "disposed",
			settlement: settled,
		};
	}
	if (settled) {
		return { state: "ACKED", ackedAt: settled.at, settlement: settled };
	}
	const consumedAt = optionalIso(row.consumed_at);
	if (consumedAt) return { state: "ACKED", ackedAt: consumedAt };
	const deliveredAt = optionalIso(row.delivered_at);
	if (deliveredAt) {
		if ((text(row, "carrier") ?? "inbox") === "inbox") {
			throw new Error(
				`manual disposition required for delivered-only inbox row: ${row.id}`,
			);
		}
		return { state: "ACKED", ackedAt: deliveredAt };
	}
	return { state: "QUEUED" };
}

function senderRef(row: LegacyRow): string {
	return encodeSenderRef({
		senderLeaseKey: text(row, "sender_lease_key"),
		senderGeneration: integer(row, "sender_generation"),
		senderHolderPid: integer(row, "sender_holder_pid"),
		senderHolderStart: text(row, "sender_holder_start"),
		writerPid: integer(row, "writer_pid"),
		writerStart: text(row, "writer_start"),
	});
}

function mirrorFor(
	message: LegacyRow,
	leadByRef: Map<string, LegacyRow>,
): LegacyRow | undefined {
	const mirror = leadByRef.get(message.id);
	return mirror && isMirror(mirror) ? mirror : undefined;
}

function mapMessage(
	row: LegacyRow,
	mirror: LegacyRow | undefined,
	hasResponse: boolean,
	now: string,
): MappedMessage {
	const type = text(row, "type") ?? "";
	const fromAgent = text(row, "from_agent") ?? "";
	const toAgent = text(row, "to_agent") ?? "";
	const createdAt = iso(row.created_at, now);
	let state: MailboxState = "QUEUED";
	let ackedAt: string | undefined;
	if (type === "question") {
		if (mirror) {
			const classified = classifyLead(mirror, now);
			state = classified.state;
			ackedAt = classified.ackedAt;
		} else if (
			text(row, "resolved_at") ||
			hasResponse ||
			text(row, "relay_state") === "terminal_disposed"
		) {
			state = "ACKED";
			ackedAt =
				optionalIso(row.resolved_at) ??
				optionalIso(row.delivered_at) ??
				createdAt;
		}
	} else if (type === "instruction") {
		if (text(row, "read_at")) {
			state = "ACKED";
			ackedAt = iso(row.read_at, now);
		} else if (text(row, "delivered_at")) {
			state = "LEASED";
		}
	} else if (type === "response" || type === "ack_receipt") {
		if (text(row, "delivered_at") || text(row, "read_at")) {
			state = "ACKED";
			ackedAt = iso(row.delivered_at ?? row.read_at, now);
		}
	} else if (type === "progress") {
		state = "ACKED";
		ackedAt = createdAt;
	}
	const deliveryId =
		text(mirror ?? ({} as LegacyRow), "id") ??
		(type === "question" ? `question:${toAgent}:${row.id}` : row.id);
	const classifiedMirror = mirror ? classifyLead(mirror, now) : undefined;
	return {
		input: {
			id: row.id,
			deliveryId,
			fromAgent,
			toAgent,
			recipientKind: recipientKind(toAgent, type),
			sourceKind: null,
			sourceRef: text(row, "logical_event_id") ?? null,
			type,
			msgClass: type === "ack_receipt" ? "protocol" : "model",
			content: text(row, "content") ?? "",
			contentRef: text(row, "content_ref") ?? null,
			contentType: text(row, "content_type") ?? "text",
			refId: text(row, "parent_id") ?? null,
			kind: text(row, "kind") ?? null,
			checkpoint: text(row, "checkpoint") ?? null,
			deadlineAt: optionalIso(row.deadline_at) ?? null,
			expiresAt: optionalIso(row.expires_at) ?? null,
			relayState:
				(text(row, "relay_state") as EnqueueMailboxInput["relayState"]) ??
				"open",
			resolvedAt: optionalIso(row.resolved_at) ?? null,
			resolvedVia: text(row, "resolved_via") ?? null,
			supersededAt: optionalIso(row.superseded_at) ?? null,
			supersededBy: text(row, "superseded_by") ?? null,
			createdAt,
			carrier:
				(text(mirror ?? ({} as LegacyRow), "carrier") as
					| "inbox"
					| "external") ?? "inbox",
			senderRef: senderRef(row),
			priority:
				(integer(mirror ?? ({} as LegacyRow), "priority") as 0 | 1 | 2 | 3) ??
				(text(row, "kind") === "report" || type === "progress" ? 2 : 1),
		},
		state,
		...(ackedAt ? { ackedAt } : {}),
		retryCount: integer(mirror ?? ({} as LegacyRow), "attempts") ?? 0,
		...(text(mirror ?? ({} as LegacyRow), "last_error")
			? { lastError: text(mirror as LegacyRow, "last_error") }
			: {}),
		sources: [
			{ table: "messages", row },
			...(mirror ? [{ table: "lead_inbox" as const, row: mirror }] : []),
		],
		...(classifiedMirror?.settlement
			? { settlement: classifiedMirror.settlement }
			: {}),
	};
}

function leadFromAgent(row: LegacyRow): string {
	const source = text(row, "source") ?? "";
	if (source === "discord_chat" || source === "founder_reply") return "founder";
	if (
		source.startsWith("lead_event:") ||
		source.startsWith("protocol_quarantine")
	) {
		return "bridge";
	}
	if (source === "discord_cross_department") {
		try {
			const payload = JSON.parse(text(row, "content") ?? "{}") as Record<
				string,
				unknown
			>;
			for (const key of ["fromAgent", "from_agent", "fromLead", "from_lead"]) {
				if (typeof payload[key] === "string" && payload[key])
					return payload[key] as string;
			}
		} catch {
			// The fail-closed error below includes the row id.
		}
		throw new Error(`cross-department sender is missing: ${row.id}`);
	}
	throw new Error(`unknown lead_inbox source family ${source}: ${row.id}`);
}

function mapStandaloneLead(row: LegacyRow, now: string): MappedMessage {
	const classified = classifyLead(row, now);
	const source = text(row, "source") ?? "";
	const toAgent = text(row, "to_lead") ?? "";
	return {
		input: {
			id: row.id,
			deliveryId: row.id,
			fromAgent: leadFromAgent(row),
			toAgent,
			recipientKind: "lead",
			sourceKind: source.startsWith("lead_event:") ? null : source,
			sourceRef: source.startsWith("lead_event:")
				? source.slice("lead_event:".length)
				: (text(row, "ref_message_id") ?? null),
			type: text(row, "type") ?? "message",
			msgClass: (text(row, "msg_class") as "protocol" | "model") ?? "model",
			content: text(row, "content") ?? "",
			refId: text(row, "ref_message_id") ?? null,
			deadlineAt: optionalIso(row.deadline_at) ?? null,
			createdAt: iso(row.created_at, now),
			carrier: (text(row, "carrier") as "inbox" | "external") ?? "inbox",
			senderRef: encodeSenderRef(),
			priority: (integer(row, "priority") as 0 | 1 | 2 | 3) ?? 1,
		},
		state: classified.state,
		...(classified.ackedAt ? { ackedAt: classified.ackedAt } : {}),
		...(classified.deadAt ? { deadAt: classified.deadAt } : {}),
		...(classified.deadReason ? { deadReason: classified.deadReason } : {}),
		retryCount: integer(row, "attempts") ?? 0,
		...(text(row, "last_error") ? { lastError: text(row, "last_error") } : {}),
		sources: [{ table: "lead_inbox", row }],
		...(classified.settlement ? { settlement: classified.settlement } : {}),
	};
}

function orphanFromAgent(db: Database.Database, row: LegacyRow): string {
	const lineage = db
		.prepare(
			"SELECT execution_id FROM receipt_root_lineage WHERE receipt_id = ?",
		)
		.get(row.id) as { execution_id?: string } | undefined;
	if (lineage?.execution_id) return lineage.execution_id;
	const alias = text(row, "legacy_alias");
	const prefix = `${text(row, "to_lead") ?? ""}-`;
	if (alias?.startsWith(prefix)) {
		const remainder = alias.slice(prefix.length);
		const separator = remainder.indexOf("-");
		if (/^\d+$/.test(remainder.slice(0, separator)) && separator > 0) {
			return remainder.slice(separator + 1);
		}
	}
	throw new Error(`orphan question sender cannot be derived: ${row.id}`);
}

function mapOrphanQuestion(
	db: Database.Database,
	row: LegacyRow,
	now: string,
): MappedMessage {
	const classified = classifyLead(row, now);
	return {
		input: {
			id: text(row, "ref_message_id") ?? "",
			deliveryId: row.id,
			fromAgent: orphanFromAgent(db, row),
			toAgent: text(row, "to_lead") ?? "",
			recipientKind: "lead",
			sourceKind: "question_orphan",
			type: "question",
			msgClass: "model",
			content: text(row, "content") ?? "",
			deliveryContent: text(row, "content") ?? "",
			createdAt: iso(row.created_at, now),
			carrier: "inbox",
			senderRef: encodeSenderRef(),
			priority: (integer(row, "priority") as 0 | 1 | 2 | 3) ?? 1,
		},
		state: classified.state,
		...(classified.ackedAt ? { ackedAt: classified.ackedAt } : {}),
		...(classified.deadAt ? { deadAt: classified.deadAt } : {}),
		...(classified.deadReason ? { deadReason: classified.deadReason } : {}),
		retryCount: integer(row, "attempts") ?? 0,
		sources: [{ table: "lead_inbox", row }],
		...(classified.settlement ? { settlement: classified.settlement } : {}),
	};
}

function terminalAt(mapped: MappedMessage): number | undefined {
	const value = mapped.ackedAt ?? mapped.deadAt;
	return value ? Date.parse(value) : undefined;
}

function keepFamily(family: MappedMessage[], now: string): boolean {
	if (
		family.some((item) => item.state === "QUEUED" || item.state === "LEASED")
	) {
		return true;
	}
	const question = family.find((item) => item.input.type === "question");
	const answered = family.some((item) => item.input.type === "response");
	if (
		question &&
		question.input.relayState !== "terminal_disposed" &&
		!answered
	) {
		return true;
	}
	const terminal = family.map(terminalAt);
	return (
		terminal.some((value) => value === undefined) ||
		Math.max(...(terminal as number[])) + RETENTION_MS > Date.parse(now)
	);
}

function insertCoverageLog(
	db: Database.Database,
	mapped: MappedMessage,
	keep: boolean,
	now: string,
): void {
	for (const source of mapped.sources) {
		db.prepare(
			`INSERT INTO mailbox_log
			 (event_id, message_id, event, at, source_table, row_json)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run(
			`migrated:${source.table}:${source.row.id}`,
			mapped.input.id,
			keep ? "migration_snapshot" : "migrated_history",
			now,
			source.table,
			canonicalJsonString(source.row),
		);
	}
}

function persistHistoricalLeadWithoutProjection(
	db: Database.Database,
	row: LegacyRow,
	now: string,
): void {
	const classified = classifyLead(row, now);
	const endedAt = classified.ackedAt ?? classified.deadAt;
	if (
		(classified.state !== "ACKED" && classified.state !== "DEAD") ||
		!endedAt ||
		Date.parse(endedAt) + RETENTION_MS > Date.parse(now)
	) {
		throw new Error(
			`cross-department sender is missing on a live row: ${row.id}`,
		);
	}
	const projectionHash = createHash("sha256")
		.update(`legacy-history:${canonicalJsonString(row)}`)
		.digest("hex");
	db.prepare(
		`INSERT INTO mailbox_identity
		 (id, delivery_id, insert_projection_hash, archived_at) VALUES (?, ?, ?, ?)`,
	).run(row.id, row.id, projectionHash, now);
	db.prepare(
		`INSERT INTO mailbox_log
		 (event_id, message_id, event, at, source_table, row_json)
		 VALUES (?, ?, 'migrated_history', ?, 'lead_inbox', ?)`,
	).run(`migrated:lead_inbox:${row.id}`, row.id, now, canonicalJsonString(row));
	if (classified.settlement) {
		db.prepare(
			`INSERT INTO mailbox_log
			 (event_id, message_id, subject_id, event, at, row_json)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run(
			`settled:${row.id}`,
			row.id,
			row.id,
			classified.settlement.event,
			classified.settlement.at,
			canonicalJsonString(classified.settlement.evidence),
		);
	}
}

function persistMapped(
	db: Database.Database,
	queue: MailboxQueue,
	mapped: MappedMessage,
	keep: boolean,
	now: string,
): void {
	const inserted = queue.enqueue(mapped.input);
	if (inserted.outcome === "archived") {
		throw new Error(
			`unexpected archived migration identity: ${mapped.input.id}`,
		);
	}
	db.prepare(
		`UPDATE mailbox SET state = ?, retry_count = ?, last_error = ?,
		 acked_at = ?, dead_at = ?, dead_reason = ?,
		 claimed_by = CASE WHEN ? = 'LEASED' THEN 'legacy-push' ELSE NULL END,
		 claim_expires_at = CASE WHEN ? = 'LEASED' THEN ? ELSE NULL END
		 WHERE id = ?`,
	).run(
		mapped.state,
		mapped.retryCount,
		mapped.lastError ?? null,
		mapped.ackedAt ?? null,
		mapped.deadAt ?? null,
		mapped.deadReason ?? null,
		mapped.state,
		mapped.state,
		now,
		mapped.input.id,
	);
	if (mapped.settlement) {
		queue.settle({
			messageOrDeliveryId: mapped.input.id,
			event: mapped.settlement.event,
			now: mapped.settlement.at,
			evidence: mapped.settlement.evidence,
		});
	}
	insertCoverageLog(db, mapped, keep, now);
	if (!keep) {
		db.prepare(
			"UPDATE mailbox_identity SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
		).run(now, mapped.input.id);
		db.prepare("DELETE FROM mailbox WHERE id = ?").run(mapped.input.id);
	}
}

function insertOrCompareLineage(
	db: Database.Database,
	input: {
		receiptId: string;
		executionId: string;
		questionId: string;
		leadId: string;
	},
): void {
	db.prepare(
		`INSERT OR IGNORE INTO receipt_root_lineage
		 (receipt_id, execution_id, question_id, root_lead_id) VALUES (?, ?, ?, ?)`,
	).run(input.receiptId, input.executionId, input.questionId, input.leadId);
	const row = db
		.prepare("SELECT * FROM receipt_root_lineage WHERE receipt_id = ?")
		.get(input.receiptId) as
		| {
				execution_id: string;
				question_id: string;
				root_lead_id: string;
		  }
		| undefined;
	if (
		!row ||
		row.execution_id !== input.executionId ||
		row.question_id !== input.questionId ||
		row.root_lead_id !== input.leadId
	) {
		throw new Error(`receipt lineage conflict: ${input.receiptId}`);
	}
}

function fault(
	requested: MailboxMigrationFault | undefined,
	stage: MailboxMigrationFault,
): void {
	if (requested === stage)
		throw new Error(`FLY-1572 fault injection: ${stage}`);
}

export function migrateLegacyDatabaseFile(
	dbPath: string,
	options: { now?: string; faultAt?: MailboxMigrationFault } = {},
): MailboxMigrationResult {
	const now = options.now ?? new Date().toISOString();
	const db = new Database(dbPath);
	try {
		const generation =
			tableType(db, "mailbox_migration_meta") === "table"
				? (
						db
							.prepare(
								"SELECT schema_generation FROM mailbox_migration_meta WHERE singleton=1",
							)
							.get() as { schema_generation?: string } | undefined
					)?.schema_generation
				: undefined;
		if (generation === MAILBOX_SCHEMA_GENERATION) {
			return {
				status: "already_migrated",
				sourceMessages: 0,
				sourceLeadInbox: 0,
				sourceTrueUnread: 0,
			};
		}
		if (
			tableType(db, "messages") !== "table" ||
			tableType(db, "lead_inbox") !== "table"
		) {
			throw new Error(
				`legacy CommDB must contain messages and lead_inbox tables: ${dbPath}`,
			);
		}
		return db
			.transaction((): MailboxMigrationResult => {
				const messages = db
					.prepare("SELECT rowid AS __rowid, * FROM messages")
					.all() as LegacyRow[];
				const leadRows = db
					.prepare("SELECT rowid AS __rowid, * FROM lead_inbox")
					.all() as LegacyRow[];
				const trueUnread = leadRows.filter(isTrueUnread);
				for (const row of leadRows) {
					if (text(row, "candidates_json")) {
						throw new Error(
							`legacy candidates_json requires manual disposition: ${row.id}`,
						);
					}
					if (
						isTrueUnread(row) &&
						(text(row, "batch_id") || text(row, "claimed_by"))
					) {
						throw new Error(
							`pending legacy claim requires quiescence: ${row.id}`,
						);
					}
				}
				const messageIds = new Set(messages.map((row) => row.id));
				const danglingAck = leadRows.find(
					(row) =>
						(text(row, "source") ?? "").startsWith("ack_receipt:") &&
						!messageIds.has(text(row, "ref_message_id") ?? ""),
				);
				if (danglingAck)
					throw new Error(
						`dangling ack mirror requires manual disposition: ${danglingAck.id}`,
					);
				fault(options.faultAt, "after_source_load");

				db.exec(MAILBOX_CORE_SCHEMA);
				db.exec("DROP TRIGGER IF EXISTS mailbox_receipt_root_lineage_insert");
				fault(options.faultAt, "after_schema");
				const queue = new MailboxQueue(db);
				const leadByRef = new Map(
					leadRows
						.filter((row) => text(row, "ref_message_id"))
						.map((row) => [text(row, "ref_message_id") as string, row]),
				);
				const responsesByRoot = new Map<string, LegacyRow[]>();
				for (const row of messages) {
					if (text(row, "type") !== "response" || !text(row, "parent_id"))
						continue;
					const root = text(row, "parent_id") as string;
					responsesByRoot.set(root, [
						...(responsesByRoot.get(root) ?? []),
						row,
					]);
				}
				const mappedById = new Map<string, MappedMessage>();
				for (const row of messages) {
					mappedById.set(
						row.id,
						mapMessage(
							row,
							mirrorFor(row, leadByRef),
							(responsesByRoot.get(row.id)?.length ?? 0) > 0,
							now,
						),
					);
				}
				const handled = new Set<string>();
				for (const row of messages) {
					if (handled.has(row.id)) continue;
					const mapped = mappedById.get(row.id) as MappedMessage;
					const family = [mapped];
					if (text(row, "type") === "question") {
						for (const response of responsesByRoot.get(row.id) ?? []) {
							family.push(mappedById.get(response.id) as MappedMessage);
						}
					}
					const keep = keepFamily(family, now);
					for (const member of family) {
						persistMapped(db, queue, member, keep, now);
						handled.add(member.input.id);
					}
				}
				fault(options.faultAt, "after_messages");

				const folded = new Set(
					messages
						.map((row) => mirrorFor(row, leadByRef)?.id)
						.filter((id): id is string => Boolean(id)),
				);
				for (const row of leadRows) {
					if (folded.has(row.id)) continue;
					let mapped: MappedMessage;
					if ((text(row, "source") ?? "").startsWith("question:")) {
						mapped = mapOrphanQuestion(db, row, now);
					} else {
						try {
							mapped = mapStandaloneLead(row, now);
						} catch (error) {
							if (text(row, "source") !== "discord_cross_department")
								throw error;
							persistHistoricalLeadWithoutProjection(db, row, now);
							continue;
						}
					}
					persistMapped(db, queue, mapped, keepFamily([mapped], now), now);
				}
				fault(options.faultAt, "after_lead_inbox");

				for (const row of db
					.prepare(
						"SELECT id, delivery_id, from_agent, to_agent, source_kind FROM mailbox WHERE type='question'",
					)
					.all() as Array<{
					id: string;
					delivery_id: string;
					from_agent: string;
					to_agent: string;
					source_kind: string | null;
				}>) {
					if (row.source_kind === "question_orphan") continue;
					insertOrCompareLineage(db, {
						receiptId: row.delivery_id,
						executionId: row.from_agent,
						questionId: row.id,
						leadId: row.to_agent,
					});
				}
				db.exec("DROP TABLE messages; DROP TABLE lead_inbox;");
				db.exec(MAILBOX_POISON_VIEWS);
				fault(options.faultAt, "after_legacy_drop");
				db.exec(`
					CREATE TRIGGER mailbox_receipt_root_lineage_insert
					AFTER INSERT ON mailbox
					WHEN NEW.type = 'question' AND NEW.recipient_kind = 'lead'
					BEGIN
					  INSERT INTO receipt_root_lineage
					    (receipt_id, execution_id, question_id, root_lead_id)
					  VALUES (NEW.delivery_id, NEW.from_agent, NEW.id, NEW.to_agent);
					END;
				`);

				const expectedUnread = [...trueUnread.map((row) => row.id)].sort();
				const actualUnread = expectedUnread.filter((deliveryId) =>
					Boolean(
						db
							.prepare(
								"SELECT 1 FROM mailbox WHERE delivery_id = ? AND state='QUEUED' AND carrier='inbox'",
							)
							.get(deliveryId),
					),
				);
				if (
					canonicalJsonString(actualUnread) !==
					canonicalJsonString(expectedUnread)
				) {
					throw new Error(
						`true-unread migration mismatch: expected ${canonicalJsonString(expectedUnread)}, got ${canonicalJsonString(actualUnread)}`,
					);
				}
				fault(options.faultAt, "before_completed_marker");
				db.prepare(
					`INSERT INTO mailbox_migration_meta
					 (singleton, schema_generation, completed_at, source_messages_count,
					  source_lead_inbox_count, source_true_unread_count)
					 VALUES (1, ?, ?, ?, ?, ?)`,
				).run(
					MAILBOX_SCHEMA_GENERATION,
					now,
					messages.length,
					leadRows.length,
					trueUnread.length,
				);
				return {
					status: "migrated",
					sourceMessages: messages.length,
					sourceLeadInbox: leadRows.length,
					sourceTrueUnread: trueUnread.length,
				};
			})
			.immediate();
	} finally {
		db.close();
	}
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifySqlite(path: string): void {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const integrity = db.pragma("integrity_check") as Array<{
			integrity_check: string;
		}>;
		if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
			throw new Error(`SQLite integrity_check failed for ${path}`);
		}
		const foreignKeys = db.pragma("foreign_key_check") as unknown[];
		if (foreignKeys.length > 0) {
			throw new Error(`SQLite foreign_key_check failed for ${path}`);
		}
	} finally {
		db.close();
	}
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function durableJson(path: string, value: unknown): void {
	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, `${canonicalJsonString(value)}\n`, { mode: 0o600 });
	const fd = openSync(temp, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);
	fsyncDirectory(dirname(path));
}

function listFiles(root: string, current = root): string[] {
	if (!existsSync(current)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		const path = join(current, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(root, path));
		else if (entry.isFile()) files.push(relative(root, path));
	}
	return files.sort();
}

function treeBytes(root: string): number {
	return listFiles(root).reduce(
		(total, path) => total + statSync(join(root, path)).size,
		0,
	);
}

function assertMigrationDiskCapacity(dbPath: string): void {
	const sourceBytes =
		statSync(dbPath).size +
		(existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0) +
		treeBytes(join(dirname(dbPath), "refs"));
	const fs = statfsSync(dirname(dbPath));
	const freeBytes = Number(fs.bavail) * Number(fs.bsize);
	const requiredBytes = Math.ceil(sourceBytes * 3);
	if (freeBytes < requiredBytes) {
		throw new Error(
			`insufficient disk for FLY-1572 migration: need ${requiredBytes} free bytes, have ${freeBytes}`,
		);
	}
}

function backupRefs(dbPath: string, backupPath: string): void {
	const source = join(dirname(dbPath), "refs");
	const destination = `${backupPath}.refs`;
	const manifestPath = `${backupPath}.refs-manifest.json`;
	rmSync(destination, { recursive: true, force: true });
	if (existsSync(source)) cpSync(source, destination, { recursive: true });
	const files = listFiles(source).map((path) => ({
		path,
		size: statSync(join(source, path)).size,
		sha256: sha256File(join(source, path)),
	}));
	durableJson(manifestPath, { v: 1, files });
}

function refsManifest(backupPath: string): {
	v: number;
	files: Array<{ path: string; size: number; sha256: string }>;
} {
	const manifestPath = `${backupPath}.refs-manifest.json`;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		v: number;
		files: Array<{ path: string; size: number; sha256: string }>;
	};
	if (manifest.v !== 1 || !Array.isArray(manifest.files)) {
		throw new Error(`invalid refs backup manifest: ${manifestPath}`);
	}
	return manifest;
}

function verifyRefsTree(
	root: string,
	manifest: ReturnType<typeof refsManifest>,
): void {
	const actual = listFiles(root);
	const expected = manifest.files.map((file) => file.path).sort();
	if (canonicalJsonString(actual) !== canonicalJsonString(expected)) {
		throw new Error(`refs file-set verification failed: ${root}`);
	}
	for (const file of manifest.files) {
		const path = join(root, file.path);
		if (
			!existsSync(path) ||
			statSync(path).size !== file.size ||
			sha256File(path) !== file.sha256
		) {
			throw new Error(`refs backup verification failed: ${file.path}`);
		}
	}
}

function verifyRefsBackup(backupPath: string): void {
	verifyRefsTree(`${backupPath}.refs`, refsManifest(backupPath));
}

export async function backupCommDb(
	dbPath: string,
	backupPath = `${dbPath}.pre-fly1572-${Date.now()}`,
): Promise<string> {
	if (existsSync(backupPath)) {
		verifySqlite(backupPath);
		if (!existsSync(`${backupPath}.refs-manifest.json`)) {
			backupRefs(dbPath, backupPath);
		}
		verifyRefsBackup(backupPath);
		return backupPath;
	}
	const temp = `${backupPath}.tmp-${randomUUID()}`;
	const source = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		await source.backup(temp);
	} finally {
		source.close();
	}
	try {
		chmodSync(temp, 0o600);
		verifySqlite(temp);
		renameSync(temp, backupPath);
		fsyncDirectory(dirname(backupPath));
		backupRefs(dbPath, backupPath);
		verifyRefsBackup(backupPath);
		return backupPath;
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

function readIntent(path: string): MailboxSwapIntent | undefined {
	return existsSync(path)
		? (JSON.parse(readFileSync(path, "utf8")) as MailboxSwapIntent)
		: undefined;
}

function countLegacyRows(dbPath: string): {
	messages: number;
	leadInbox: number;
} {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		return {
			messages: (
				db.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
					count: number;
				}
			).count,
			leadInbox: (
				db.prepare("SELECT COUNT(*) AS count FROM lead_inbox").get() as {
					count: number;
				}
			).count,
		};
	} finally {
		db.close();
	}
}

function verifyMigratedDatabase(dbPath: string): MailboxMigrationResult {
	verifySqlite(dbPath);
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const meta = db
			.prepare("SELECT * FROM mailbox_migration_meta WHERE singleton=1")
			.get() as
			| {
					schema_generation: string;
					source_messages_count: number;
					source_lead_inbox_count: number;
					source_true_unread_count: number;
			  }
			| undefined;
		if (meta?.schema_generation !== MAILBOX_SCHEMA_GENERATION) {
			throw new Error(`mailbox migration marker missing: ${dbPath}`);
		}
		return {
			status: "migrated",
			sourceMessages: meta.source_messages_count,
			sourceLeadInbox: meta.source_lead_inbox_count,
			sourceTrueUnread: meta.source_true_unread_count,
		};
	} finally {
		db.close();
	}
}

function afterSwapPhase(
	faultAfter: MailboxSwapPhase | undefined,
	phase: MailboxSwapPhase,
): void {
	if (faultAfter === phase) {
		throw new Error(`FLY-1572 swap fault injection after ${phase}`);
	}
}

export async function migrateCommDbWithSwap(
	dbPath: string,
	options: { now?: string; faultAfter?: MailboxSwapPhase } = {},
): Promise<MailboxSwapResult> {
	const now = options.now ?? new Date().toISOString();
	const intentPath = `${dbPath}.migration-swap-intent.json`;
	let intent = readIntent(intentPath);
	if (!intent) {
		const db = new Database(dbPath, { readonly: true, fileMustExist: true });
		try {
			if (tableType(db, "mailbox_migration_meta") === "table") {
				const migrated = verifyMigratedDatabase(dbPath);
				return {
					...migrated,
					status: "already_migrated",
					backupPath: "",
					intentPath,
				};
			}
		} finally {
			db.close();
		}
		assertMigrationDiskCapacity(dbPath);
		const counts = countLegacyRows(dbPath);
		const stagingDir = join(dirname(dbPath), `.fly1572-${randomUUID()}`);
		intent = {
			v: 1,
			dbPath,
			backupPath: `${dbPath}.pre-fly1572-${now.replaceAll(":", "-")}`,
			stagingPath: join(stagingDir, basename(dbPath)),
			phase: "fenced",
			originalMode: statSync(dbPath).mode & 0o777,
			createdAt: now,
			sourceMessages: counts.messages,
			sourceLeadInbox: counts.leadInbox,
			quarantinedSidecars: [],
		};
		durableJson(intentPath, intent);
		for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
			if (existsSync(path)) chmodSync(path, 0o444);
		}
		durableJson(intentPath, intent);
		afterSwapPhase(options.faultAfter, "fenced");
	}
	if (intent.phase === "aborted") {
		throw new Error(
			`mailbox migration was aborted; archive ${intentPath} before retrying`,
		);
	}

	const phases: MailboxSwapPhase[] = [
		"fenced",
		"backed_up",
		"sidecars_quarantined",
		"staging_verified",
		"canonical_swapped",
		"dir_fsynced",
		"verified",
		"done",
	];
	const reached = (phase: MailboxSwapPhase): boolean =>
		phases.indexOf((intent as MailboxSwapIntent).phase as MailboxSwapPhase) >=
		phases.indexOf(phase);
	const advance = (phase: MailboxSwapPhase): void => {
		intent = { ...(intent as MailboxSwapIntent), phase };
		durableJson(intentPath, intent);
		afterSwapPhase(options.faultAfter, phase);
	};
	if (!reached("canonical_swapped")) {
		try {
			verifyMigratedDatabase(dbPath);
			advance("canonical_swapped");
		} catch {
			for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
				if (existsSync(path)) chmodSync(path, 0o444);
			}
		}
	}

	if (!reached("backed_up")) {
		await backupCommDb(dbPath, intent.backupPath);
		advance("backed_up");
	}
	if (!reached("sidecars_quarantined")) {
		const quarantined = [...intent.quarantinedSidecars];
		for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
			const target = `${sidecar}.fly1572-quarantine`;
			if (existsSync(sidecar)) renameSync(sidecar, target);
			if (existsSync(target) && !quarantined.includes(target)) {
				quarantined.push(target);
			}
		}
		intent = { ...intent, quarantinedSidecars: quarantined };
		advance("sidecars_quarantined");
	}
	if (!reached("staging_verified")) {
		mkdirSync(dirname(intent.stagingPath), { recursive: true, mode: 0o700 });
		if (
			statSync(dirname(intent.stagingPath)).dev !==
			statSync(dirname(dbPath)).dev
		) {
			throw new Error(
				"mailbox staging path must be on the canonical filesystem",
			);
		}
		copyFileSync(intent.backupPath, intent.stagingPath);
		chmodSync(intent.stagingPath, 0o600);
		migrateLegacyDatabaseFile(intent.stagingPath, { now });
		verifyMigratedDatabase(intent.stagingPath);
		advance("staging_verified");
	}
	if (!reached("canonical_swapped")) {
		renameSync(intent.stagingPath, dbPath);
		chmodSync(dbPath, 0o600);
		advance("canonical_swapped");
	}
	if (!reached("dir_fsynced")) {
		fsyncDirectory(dirname(dbPath));
		advance("dir_fsynced");
	}
	const migrated = verifyMigratedDatabase(dbPath);
	if (!reached("verified")) advance("verified");
	if (!reached("done")) advance("done");
	return { ...migrated, backupPath: intent.backupPath, intentPath };
}

function afterRestorePhase(
	faultAfter: MailboxRestorePhase | undefined,
	phase: MailboxRestorePhase,
): void {
	if (faultAfter === phase) {
		throw new Error(`FLY-1572 restore fault injection after ${phase}`);
	}
}

export function rollbackMailboxMigration(
	dbPath: string,
	options: { faultAfter?: MailboxRestorePhase } = {},
): MailboxSwapResult {
	const intentPath = `${dbPath}.migration-swap-intent.json`;
	let intent = readIntent(intentPath);
	if (!intent)
		throw new Error(`mailbox migration intent not found: ${intentPath}`);
	if (!existsSync(intent.backupPath)) {
		if (intent.phase === "fenced") {
			chmodSync(dbPath, intent.originalMode);
			intent = { ...intent, phase: "aborted" };
			durableJson(intentPath, intent);
			return {
				status: "already_migrated",
				sourceMessages: intent.sourceMessages,
				sourceLeadInbox: intent.sourceLeadInbox,
				sourceTrueUnread: 0,
				backupPath: intent.backupPath,
				intentPath,
			};
		}
		throw new Error(
			`verified migration backup is missing: ${intent.backupPath}`,
		);
	}
	verifySqlite(intent.backupPath);
	verifyRefsBackup(intent.backupPath);
	const restoreIntentPath = `${dbPath}.restore-intent.json`;
	let restoreIntent = existsSync(restoreIntentPath)
		? (JSON.parse(
				readFileSync(restoreIntentPath, "utf8"),
			) as MailboxRestoreIntent)
		: undefined;
	if (!restoreIntent) {
		const stageDir = join(dirname(dbPath), `.fly1572-restore-${randomUUID()}`);
		mkdirSync(stageDir, { mode: 0o700 });
		const dbStage = join(stageDir, basename(dbPath));
		const refsStage = join(stageDir, "refs");
		copyFileSync(intent.backupPath, dbStage);
		chmodSync(dbStage, 0o600);
		mkdirSync(refsStage, { mode: 0o700 });
		if (existsSync(`${intent.backupPath}.refs`)) {
			cpSync(`${intent.backupPath}.refs`, refsStage, { recursive: true });
		}
		verifySqlite(dbStage);
		verifyRefsTree(refsStage, refsManifest(intent.backupPath));
		restoreIntent = {
			v: 1,
			dbPath,
			backupPath: intent.backupPath,
			dbStage,
			refsStage,
			refsQuarantine: `${join(dirname(dbPath), "refs")}.fly1572-rollback-quarantine-${randomUUID()}`,
			phase: "staged",
			createdAt: new Date().toISOString(),
		};
		durableJson(restoreIntentPath, restoreIntent);
		afterRestorePhase(options.faultAfter, "staged");
	}
	const restorePhases: MailboxRestorePhase[] = [
		"staged",
		"refs_swapped",
		"db_swapped",
		"verified",
		"done",
	];
	const restoreReached = (phase: MailboxRestorePhase): boolean =>
		restorePhases.indexOf((restoreIntent as MailboxRestoreIntent).phase) >=
		restorePhases.indexOf(phase);
	const advanceRestore = (phase: MailboxRestorePhase): void => {
		restoreIntent = { ...(restoreIntent as MailboxRestoreIntent), phase };
		durableJson(restoreIntentPath, restoreIntent);
		afterRestorePhase(options.faultAfter, phase);
	};
	const canonicalRefs = join(dirname(dbPath), "refs");
	if (!restoreReached("refs_swapped")) {
		try {
			verifyRefsTree(canonicalRefs, refsManifest(intent.backupPath));
			advanceRestore("refs_swapped");
		} catch {
			if (!existsSync(restoreIntent.refsStage)) {
				throw new Error("rollback refs staging image is missing");
			}
			if (
				existsSync(canonicalRefs) &&
				!existsSync(restoreIntent.refsQuarantine)
			) {
				renameSync(canonicalRefs, restoreIntent.refsQuarantine);
			}
			renameSync(restoreIntent.refsStage, canonicalRefs);
			fsyncDirectory(dirname(dbPath));
			verifyRefsTree(canonicalRefs, refsManifest(intent.backupPath));
			advanceRestore("refs_swapped");
		}
	}
	if (!restoreReached("db_swapped")) {
		if (sha256File(dbPath) !== sha256File(intent.backupPath)) {
			if (!existsSync(restoreIntent.dbStage)) {
				throw new Error("rollback database staging image is missing");
			}
			for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
				if (existsSync(sidecar)) {
					renameSync(
						sidecar,
						`${sidecar}.fly1572-rollback-quarantine-${randomUUID()}`,
					);
				}
			}
			renameSync(restoreIntent.dbStage, dbPath);
		}
		chmodSync(dbPath, intent.originalMode);
		fsyncDirectory(dirname(dbPath));
		if (sha256File(dbPath) !== sha256File(intent.backupPath)) {
			throw new Error("rollback database hash verification failed");
		}
		advanceRestore("db_swapped");
	}
	verifySqlite(dbPath);
	const counts = countLegacyRows(dbPath);
	if (
		counts.messages !== intent.sourceMessages ||
		counts.leadInbox !== intent.sourceLeadInbox
	) {
		throw new Error("rollback row-count verification failed");
	}
	verifyRefsTree(canonicalRefs, refsManifest(intent.backupPath));
	if (!restoreReached("verified")) advanceRestore("verified");
	if (!restoreReached("done")) advanceRestore("done");
	intent = { ...intent, phase: "aborted" };
	durableJson(intentPath, intent);
	return {
		status: "already_migrated",
		sourceMessages: counts.messages,
		sourceLeadInbox: counts.leadInbox,
		sourceTrueUnread: 0,
		backupPath: intent.backupPath,
		intentPath,
	};
}
