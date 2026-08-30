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
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import Database from "better-sqlite3";

export { Database };

import { canonicalJsonString } from "flywheel-config";
import {
	type EnqueueMailboxInput,
	MailboxQueue,
	type MailboxState,
} from "./mailbox-queue.js";
import {
	dropReceiptLedgerSchema,
	installMailboxRelayInvariantTriggers,
	MAILBOX_CORE_SCHEMA,
	MAILBOX_POISON_VIEWS,
	MAILBOX_SCHEMA_GENERATION,
} from "./mailbox-schema.js";
import { encodeSenderRef } from "./sender-ref.js";

type LegacyRow = Record<string, unknown> & { __rowid: number; id: string };

type LegacyLeadSourceFamily =
	| "question"
	| "ack_receipt"
	| "discord_chat"
	| "founder_reply"
	| "discord_cross_department"
	| "lead_event"
	| "protocol_quarantine"
	| "receipt_resend"
	| "model_quarantine";

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

export type MailboxSwapFault =
	| MailboxSwapPhase
	| "after_stale_intent_archived"
	| "after_stale_intent_dir_fsynced"
	| "after_fresh_intent_durable"
	| "after_main_fenced"
	| "after_wal_fenced";

interface MailboxSwapIntentBase {
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

interface MailboxSwapIntentV1 extends MailboxSwapIntentBase {
	v: 1;
}

interface MailboxSwapIntentV2 extends MailboxSwapIntentBase {
	v: 2;
	sourceBinding: {
		mainSha256: string;
		walSha256: string | null;
	};
	backupSha256?: string;
	refsManifestSha256?: string;
	stagingSha256?: string;
}

export type MailboxSwapIntent = MailboxSwapIntentV1 | MailboxSwapIntentV2;

export type MailboxDbState = "legacy" | "migrated" | "mixed" | "unknown";

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
	quarantinedSidecars?: string[];
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
const SWAP_PHASES: MailboxSwapPhase[] = [
	"fenced",
	"backed_up",
	"sidecars_quarantined",
	"staging_verified",
	"canonical_swapped",
	"dir_fsynced",
	"verified",
	"done",
];
const SWAP_PHASE_VALUES = new Set<string>([...SWAP_PHASES, "aborted"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function swapPhaseAtLeast(
	phase: MailboxSwapIntent["phase"],
	minimum: MailboxSwapPhase,
): boolean {
	if (phase === "aborted") return false;
	return SWAP_PHASES.indexOf(phase) >= SWAP_PHASES.indexOf(minimum);
}

function tableType(db: Database.Database, name: string): string | undefined {
	return (
		db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(name) as
			| { type?: string }
			| undefined
	)?.type;
}

export function classifyMailboxDatabase(dbPath: string): MailboxDbState {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const messages = tableType(db, "messages");
		const leadInbox = tableType(db, "lead_inbox");
		const hasLegacyTables = messages === "table" || leadInbox === "table";
		if (tableType(db, "mailbox_migration_meta") === "table") {
			const generation = db
				.prepare(
					"SELECT schema_generation FROM mailbox_migration_meta WHERE singleton=1",
				)
				.get() as { schema_generation?: string } | undefined;
			if (generation?.schema_generation !== MAILBOX_SCHEMA_GENERATION) {
				return "unknown";
			}
			return hasLegacyTables ? "mixed" : "migrated";
		}
		if (messages === "table" && leadInbox === "table") return "legacy";
		return "unknown";
	} finally {
		db.close();
	}
}

function classifyCanonicalMainImage(dbPath: string): MailboxDbState {
	const scratch = join(dirname(dbPath), `.fly1572-classify-${randomUUID()}`);
	const snapshot = join(scratch, basename(dbPath));
	mkdirSync(scratch, { mode: 0o700 });
	try {
		copyFileSync(dbPath, snapshot);
		chmodSync(snapshot, 0o600);
		return classifyMailboxDatabase(snapshot);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
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

function leadSourceFamily(source: string): LegacyLeadSourceFamily | undefined {
	if (source.startsWith("question:")) return "question";
	if (source.startsWith("ack_receipt:")) return "ack_receipt";
	if (source.startsWith("lead_event:")) return "lead_event";
	if (source.startsWith("protocol_quarantine")) return "protocol_quarantine";
	if (source.startsWith("receipt_resend:")) return "receipt_resend";
	if (source.startsWith("model_quarantine:")) return "model_quarantine";
	if (
		source === "discord_chat" ||
		source === "founder_reply" ||
		source === "discord_cross_department"
	) {
		return source;
	}
	return undefined;
}

function assertKnownLeadSourceFamilies(
	db: Database.Database,
	now: string,
): void {
	const unknown = (
		db
			.prepare(
				"SELECT source, COUNT(*) AS count FROM lead_inbox GROUP BY source ORDER BY source",
			)
			.all() as Array<{ source: string; count: number }>
	).filter((row) => !leadSourceFamily(row.source));
	if (unknown.length > 0) {
		throw new Error(
			`unknown lead_inbox source families: ${unknown
				.map((row) => `${row.source || "<empty>"} (${row.count})`)
				.join(", ")}`,
		);
	}
	const blockedCrossDepartment = (
		db
			.prepare(
				"SELECT rowid AS __rowid, * FROM lead_inbox WHERE source = 'discord_cross_department' ORDER BY id",
			)
			.all() as LegacyRow[]
	).flatMap((row) => {
		if (crossDepartmentSender(row) || isBridgeCrossDepartmentAlert(row)) {
			return [];
		}
		const classified = classifyLead(row, now);
		const endedAt = classified.ackedAt ?? classified.deadAt;
		const retentionExpiresAt = endedAt
			? new Date(Date.parse(endedAt) + RETENTION_MS).toISOString()
			: "none_nonterminal";
		if (endedAt && Date.parse(retentionExpiresAt) <= Date.parse(now)) {
			return [];
		}
		return [`${row.id} [retention_expires_at=${retentionExpiresAt}]`];
	});
	if (blockedCrossDepartment.length > 0) {
		throw new Error(
			`cross-department sender is missing on live rows: ${blockedCrossDepartment.join(", ")}`,
		);
	}
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
			sourceKind: type === "question" && mirror ? "question" : null,
			sourceRef: text(row, "logical_event_id") ?? null,
			type,
			msgClass: type === "ack_receipt" ? "protocol" : "model",
			content: text(row, "content") ?? "",
			deliveryContent:
				type === "question" && mirror ? (text(mirror, "content") ?? "") : null,
			contentRef: text(row, "content_ref") ?? null,
			contentType: text(row, "content_type") ?? "text",
			refId: text(row, "parent_id") ?? null,
			kind: text(row, "kind") ?? null,
			checkpoint: text(row, "checkpoint") ?? null,
			deadlineAt: optionalIso(row.deadline_at) ?? null,
			expiresAt: optionalIso(row.expires_at) ?? null,
			relayState:
				type === "question"
					? ((text(row, "relay_state") as EnqueueMailboxInput["relayState"]) ??
						"open")
					: "terminal_disposed",
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

function crossDepartmentSender(row: LegacyRow): string | undefined {
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
		// A malformed legacy payload is handled by the fail-closed caller.
	}
	return undefined;
}

function isBridgeCrossDepartmentAlert(row: LegacyRow): boolean {
	const content = text(row, "content");
	if (
		text(row, "source") !== "discord_cross_department" ||
		!content ||
		!text(row, "delivered_at") ||
		!text(row, "consumed_at")
	) {
		return false;
	}
	try {
		JSON.parse(content);
		return false;
	} catch {
		return true;
	}
}

function leadFromAgent(row: LegacyRow): string {
	const source = text(row, "source") ?? "";
	const family = leadSourceFamily(source);
	if (family === "discord_chat" || family === "founder_reply") return "founder";
	if (
		family === "lead_event" ||
		family === "protocol_quarantine" ||
		family === "receipt_resend" ||
		family === "model_quarantine"
	) {
		return "bridge";
	}
	if (family === "discord_cross_department") {
		const sender = crossDepartmentSender(row);
		if (sender) return sender;
		if (isBridgeCrossDepartmentAlert(row)) return "bridge";
		throw new Error(`cross-department sender is missing: ${row.id}`);
	}
	throw new Error(`unknown lead_inbox source family ${source}: ${row.id}`);
}

function mapStandaloneLead(row: LegacyRow, now: string): MappedMessage {
	const classified = classifyLead(row, now);
	const source = text(row, "source") ?? "";
	const family = leadSourceFamily(source);
	const toAgent = text(row, "to_lead") ?? "";
	const type = text(row, "type") ?? "message";
	return {
		input: {
			id: row.id,
			deliveryId: row.id,
			fromAgent: leadFromAgent(row),
			toAgent,
			recipientKind: "lead",
			sourceKind:
				family === "lead_event"
					? null
					: family === "receipt_resend" || family === "model_quarantine"
						? family
						: source,
			sourceRef:
				family === "lead_event" ||
				family === "receipt_resend" ||
				family === "model_quarantine"
					? source.slice(`${family}:`.length)
					: (text(row, "ref_message_id") ?? null),
			type,
			relayState: type === "question" ? "open" : "terminal_disposed",
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

function orphanFromAgent(row: LegacyRow): string {
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

function mapOrphanQuestion(row: LegacyRow, now: string): MappedMessage {
	const classified = classifyLead(row, now);
	return {
		input: {
			id: text(row, "ref_message_id") ?? "",
			deliveryId: row.id,
			fromAgent: orphanFromAgent(row),
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
		const retentionExpiresAt = endedAt
			? new Date(Date.parse(endedAt) + RETENTION_MS).toISOString()
			: "none_nonterminal";
		throw new Error(
			`cross-department sender is missing on live rows: ${row.id} [retention_expires_at=${retentionExpiresAt}]`,
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
		insertOrCompareHistoricalSettlement(db, row.id, classified.settlement);
	}
}

function persistMapped(
	db: Database.Database,
	queue: MailboxQueue,
	mapped: MappedMessage,
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
		insertOrCompareHistoricalSettlement(db, mapped.input.id, mapped.settlement);
	}
}

function mappedFamilyCanArchive(family: MappedMessage[]): boolean {
	if (
		family.some(
			(member) =>
				(member.state !== "ACKED" && member.state !== "DEAD") ||
				terminalAt(member) === undefined,
		)
	) {
		return false;
	}
	const question = family.find((member) => member.input.type === "question");
	return !(
		question &&
		question.input.relayState !== "terminal_disposed" &&
		!family.some((member) => member.input.type === "response")
	);
}

function resolvedMailboxFamilyIds(
	db: Database.Database,
	memberId: string,
): string[] {
	const member = db
		.prepare("SELECT id, type, ref_id FROM mailbox WHERE id = ?")
		.get(memberId) as
		| { id: string; type: string; ref_id: string | null }
		| undefined;
	if (!member) throw new Error(`migration mailbox row not found: ${memberId}`);
	const rootId =
		member.type === "response" &&
		member.ref_id &&
		db
			.prepare("SELECT 1 FROM mailbox WHERE id = ? AND type = 'question'")
			.get(member.ref_id)
			? member.ref_id
			: member.id;
	const root = db
		.prepare("SELECT type FROM mailbox WHERE id = ?")
		.get(rootId) as { type: string } | undefined;
	if (!root)
		throw new Error(`migration mailbox family root not found: ${rootId}`);
	if (root.type !== "question") return [rootId];
	return db
		.prepare(
			`SELECT id FROM mailbox
			  WHERE id = ? OR (type = 'response' AND ref_id = ?)
			  ORDER BY id`,
		)
		.pluck()
		.all(rootId, rootId) as string[];
}

function sameIds(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((id, index) => id === right[index]);
}

function persistMappedFamily(
	db: Database.Database,
	queue: MailboxQueue,
	family: MappedMessage[],
	requestedKeep: boolean,
	now: string,
): void {
	for (const member of family) persistMapped(db, queue, member, now);
	const expectedIds = family.map((member) => member.input.id).sort();
	const resolvedIds = resolvedMailboxFamilyIds(db, family[0]!.input.id);
	const keep =
		requestedKeep ||
		!mappedFamilyCanArchive(family) ||
		!sameIds(expectedIds, resolvedIds);
	for (const member of family) insertCoverageLog(db, member, keep, now);
	if (keep) return;
	const outcome = queue.archiveFamily({
		id: family[0]!.input.id,
		now,
		retentionMs: 0,
		maxFamilyBytes: Number.MAX_SAFE_INTEGER,
	});
	if (outcome !== "archived") {
		throw new Error(
			`migration_mailbox_archive_failed:${family[0]!.input.id}:${outcome}`,
		);
	}
}

function insertOrCompareHistoricalSettlement(
	db: Database.Database,
	messageId: string,
	settled: NonNullable<MappedMessage["settlement"]>,
): void {
	const eventId = `settled:${messageId}`;
	const rowJson = canonicalJsonString(settled.evidence);
	db.prepare(
		`INSERT OR IGNORE INTO mailbox_log
		 (event_id, message_id, subject_id, event, at, row_json)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(eventId, messageId, messageId, settled.event, settled.at, rowJson);
	const row = db
		.prepare(
			"SELECT message_id, subject_id, event, at, row_json FROM mailbox_log WHERE event_id = ?",
		)
		.get(eventId) as
		| {
				message_id: string;
				subject_id: string | null;
				event: string;
				at: string;
				row_json: string;
		  }
		| undefined;
	if (
		!row ||
		row.message_id !== messageId ||
		row.subject_id !== messageId ||
		row.event !== settled.event ||
		row.at !== settled.at ||
		row.row_json !== rowJson
	) {
		throw new Error(`historical settlement conflict: ${messageId}`);
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
			db.transaction(() => {
				dropReceiptLedgerSchema(db);
				installMailboxRelayInvariantTriggers(db);
			}).immediate();
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
		assertKnownLeadSourceFamilies(db, now);
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
				dropReceiptLedgerSchema(db);
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
					persistMappedFamily(db, queue, family, keep, now);
					for (const member of family) handled.add(member.input.id);
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
						mapped = mapOrphanQuestion(row, now);
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
					const family = leadSourceFamily(text(row, "source") ?? "");
					if (
						family === "receipt_resend" &&
						(mapped.state === "QUEUED" || mapped.state === "LEASED")
					) {
						throw new Error(
							`live receipt_resend copy requires manual disposition: ${row.id}`,
						);
					}
					persistMappedFamily(
						db,
						queue,
						[mapped],
						family === "receipt_resend" ? false : keepFamily([mapped], now),
						now,
					);
				}
				fault(options.faultAt, "after_lead_inbox");

				db.exec("DROP TABLE messages; DROP TABLE lead_inbox;");
				db.exec(MAILBOX_POISON_VIEWS);
				fault(options.faultAt, "after_legacy_drop");
				installMailboxRelayInvariantTriggers(db);

				const expectedUnread = [...trueUnread.map((row) => row.id)].sort();
				const actualUnread = (
					db
						.prepare(
							`SELECT DISTINCT mailbox.delivery_id
							   FROM mailbox
							   JOIN mailbox_log
							     ON mailbox_log.message_id = mailbox.id
							    AND mailbox_log.source_table = 'lead_inbox'
							    AND mailbox_log.event = 'migration_snapshot'
							  WHERE mailbox.state = 'QUEUED' AND mailbox.carrier = 'inbox'
							  ORDER BY mailbox.delivery_id`,
						)
						.pluck()
						.all() as string[]
				).sort();
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
	cleanupBackupTemps(backupPath);
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
	} finally {
		cleanupBackupTemps(backupPath);
	}
}

function cleanupBackupTemps(backupPath: string): void {
	const stalePrefix = `${basename(backupPath)}.tmp-`;
	for (const entry of readdirSync(dirname(backupPath), {
		withFileTypes: true,
	})) {
		if (!entry.isFile() || !entry.name.startsWith(stalePrefix)) continue;
		const suffix = entry.name.slice(stalePrefix.length);
		if (
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:-journal|-wal|-shm)?$/i.test(
				suffix,
			)
		) {
			rmSync(join(dirname(backupPath), entry.name), { force: true });
		}
	}
}

function invalidSwapIntent(path: string, reason: string): never {
	throw new Error(`invalid mailbox swap intent: ${path}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredIntentString(
	intentPath: string,
	value: unknown,
	field: string,
): string {
	if (typeof value !== "string" || value.length === 0) {
		invalidSwapIntent(intentPath, `${field} must be a non-empty string`);
	}
	return value;
}

function requiredIntentCount(
	intentPath: string,
	value: unknown,
	field: string,
): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		invalidSwapIntent(intentPath, `${field} must be a non-negative integer`);
	}
	return value as number;
}

function validateSha256(
	intentPath: string,
	value: unknown,
	field: string,
): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		invalidSwapIntent(intentPath, `${field} must be a lowercase sha256`);
	}
	return value;
}

export function inspectMailboxSwapIntent(
	intentPath: string,
): MailboxSwapIntent | undefined {
	if (!existsSync(intentPath)) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(intentPath, "utf8"));
	} catch (error) {
		invalidSwapIntent(
			intentPath,
			`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(value)) invalidSwapIntent(intentPath, "root must be an object");
	if (value.v !== 1 && value.v !== 2) {
		invalidSwapIntent(intentPath, "v must be 1 or 2");
	}
	const phase = requiredIntentString(intentPath, value.phase, "phase");
	if (!SWAP_PHASE_VALUES.has(phase)) {
		invalidSwapIntent(intentPath, `unknown phase ${phase}`);
	}
	const dbPath = requiredIntentString(intentPath, value.dbPath, "dbPath");
	const backupPath = requiredIntentString(
		intentPath,
		value.backupPath,
		"backupPath",
	);
	const stagingPath = requiredIntentString(
		intentPath,
		value.stagingPath,
		"stagingPath",
	);
	for (const [field, path] of [
		["dbPath", dbPath],
		["backupPath", backupPath],
		["stagingPath", stagingPath],
	] as const) {
		if (!isAbsolute(path)) {
			invalidSwapIntent(intentPath, `${field} must be absolute`);
		}
	}
	if (
		resolve(dirname(backupPath)) !== resolve(dirname(dbPath)) ||
		!backupPath.startsWith(`${dbPath}.pre-fly1572-`) ||
		backupPath === `${dbPath}.pre-fly1572-`
	) {
		invalidSwapIntent(
			intentPath,
			"backupPath must be a pre-fly1572 neighbor of dbPath",
		);
	}
	const stagingDirectory = dirname(stagingPath);
	if (
		resolve(dirname(stagingDirectory)) !== resolve(dirname(dbPath)) ||
		!basename(stagingDirectory).startsWith(".fly1572-") ||
		basename(stagingDirectory) === ".fly1572-" ||
		basename(stagingPath) !== basename(dbPath)
	) {
		invalidSwapIntent(
			intentPath,
			"stagingPath must be inside a neighboring .fly1572-* directory",
		);
	}
	const originalMode = requiredIntentCount(
		intentPath,
		value.originalMode,
		"originalMode",
	);
	const createdAt = requiredIntentString(
		intentPath,
		value.createdAt,
		"createdAt",
	);
	const sourceMessages = requiredIntentCount(
		intentPath,
		value.sourceMessages,
		"sourceMessages",
	);
	const sourceLeadInbox = requiredIntentCount(
		intentPath,
		value.sourceLeadInbox,
		"sourceLeadInbox",
	);
	if (!Array.isArray(value.quarantinedSidecars)) {
		invalidSwapIntent(intentPath, "quarantinedSidecars must be an array");
	}
	const allowedQuarantines = new Set([
		`${dbPath}-wal.fly1572-quarantine`,
		`${dbPath}-shm.fly1572-quarantine`,
	]);
	const quarantinedSidecars = value.quarantinedSidecars.map(
		(sidecar, index) => {
			const path = requiredIntentString(
				intentPath,
				sidecar,
				`quarantinedSidecars[${index}]`,
			);
			if (!allowedQuarantines.has(path)) {
				invalidSwapIntent(
					intentPath,
					`quarantinedSidecars[${index}] is outside the canonical sidecar layout`,
				);
			}
			return path;
		},
	);
	const base: MailboxSwapIntentBase = {
		dbPath,
		backupPath,
		stagingPath,
		phase: phase as MailboxSwapIntent["phase"],
		originalMode,
		createdAt,
		sourceMessages,
		sourceLeadInbox,
		quarantinedSidecars,
	};
	if (value.v === 1) return { ...base, v: 1 };
	if (!isRecord(value.sourceBinding)) {
		invalidSwapIntent(intentPath, "sourceBinding is required for v2");
	}
	const sourceBinding = {
		mainSha256: validateSha256(
			intentPath,
			value.sourceBinding.mainSha256,
			"sourceBinding.mainSha256",
		),
		walSha256:
			value.sourceBinding.walSha256 === null
				? null
				: validateSha256(
						intentPath,
						value.sourceBinding.walSha256,
						"sourceBinding.walSha256",
					),
	};
	const intent: MailboxSwapIntentV2 = { ...base, v: 2, sourceBinding };
	if (value.backupSha256 !== undefined) {
		intent.backupSha256 = validateSha256(
			intentPath,
			value.backupSha256,
			"backupSha256",
		);
	}
	if (value.refsManifestSha256 !== undefined) {
		intent.refsManifestSha256 = validateSha256(
			intentPath,
			value.refsManifestSha256,
			"refsManifestSha256",
		);
	}
	if (value.stagingSha256 !== undefined) {
		intent.stagingSha256 = validateSha256(
			intentPath,
			value.stagingSha256,
			"stagingSha256",
		);
	}
	const typedPhase = phase as MailboxSwapIntent["phase"];
	if (typedPhase !== "aborted" && swapPhaseAtLeast(typedPhase, "backed_up")) {
		if (!intent.backupSha256 || !intent.refsManifestSha256) {
			invalidSwapIntent(
				intentPath,
				"backupSha256 and refsManifestSha256 are required after backup",
			);
		}
	}
	if (
		typedPhase !== "aborted" &&
		swapPhaseAtLeast(typedPhase, "staging_verified")
	) {
		if (!intent.stagingSha256) {
			invalidSwapIntent(
				intentPath,
				"stagingSha256 is required after staging verification",
			);
		}
	}
	return intent;
}

function staleSwapIntent(intentPath: string, detail: string): never {
	throw new Error(
		`mailbox swap intent is stale: ${detail}; canonical or artifacts diverged from the fenced source/artifacts; resuming would replay an old backup/staging over newer data; archive ${intentPath} (and any .fly1572-* staging/backup) explicitly before retrying`,
	);
}

function assertBoundHash(
	intentPath: string,
	path: string,
	expected: string,
	label: string,
): void {
	if (!existsSync(path) || sha256File(path) !== expected) {
		staleSwapIntent(intentPath, `${label} hash mismatch at ${path}`);
	}
}

function assertNoWriteBits(intentPath: string, path: string): void {
	if (!existsSync(path)) return;
	const mode = statSync(path).mode & 0o777;
	if ((mode & 0o222) !== 0) {
		staleSwapIntent(
			intentPath,
			`${path} regained write permission (mode ${mode.toString(8)}) after fencing`,
		);
	}
}

function verifyBoundBackup(
	intentPath: string,
	intent: MailboxSwapIntentV2,
): void {
	if (!intent.backupSha256 || !intent.refsManifestSha256) {
		staleSwapIntent(intentPath, "backup artifacts are not bound");
	}
	assertBoundHash(intentPath, intent.backupPath, intent.backupSha256, "backup");
	assertBoundHash(
		intentPath,
		`${intent.backupPath}.refs-manifest.json`,
		intent.refsManifestSha256,
		"refs manifest",
	);
	try {
		verifyRefsBackup(intent.backupPath);
	} catch (error) {
		staleSwapIntent(
			intentPath,
			`refs backup verification failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function verifyLegacyPreSwapResume(
	dbPath: string,
	intentPath: string,
	intent: MailboxSwapIntent,
): { walAlreadyQuarantined: boolean } {
	if (intent.v !== 2) {
		staleSwapIntent(intentPath, "a v1 pre-swap intent has no source binding");
	}
	assertBoundHash(
		intentPath,
		dbPath,
		intent.sourceBinding.mainSha256,
		"canonical database",
	);
	const walPath = `${dbPath}-wal`;
	const walQuarantine = `${walPath}.fly1572-quarantine`;
	const expectedWal = intent.sourceBinding.walSha256;
	let walAlreadyQuarantined = false;
	if (intent.phase === "fenced") {
		if (existsSync(walQuarantine)) {
			staleSwapIntent(
				intentPath,
				"WAL quarantine exists while phase is fenced",
			);
		}
		if (expectedWal === null) {
			if (existsSync(walPath)) {
				staleSwapIntent(intentPath, "an unbound WAL appeared after fencing");
			}
		} else {
			assertBoundHash(intentPath, walPath, expectedWal, "canonical WAL");
		}
	} else if (intent.phase === "backed_up") {
		if (expectedWal === null) {
			if (existsSync(walPath) || existsSync(walQuarantine)) {
				staleSwapIntent(intentPath, "an unbound WAL appeared after backup");
			}
		} else if (existsSync(walPath) && !existsSync(walQuarantine)) {
			assertBoundHash(intentPath, walPath, expectedWal, "canonical WAL");
		} else if (!existsSync(walPath) && existsSync(walQuarantine)) {
			assertBoundHash(
				intentPath,
				walQuarantine,
				expectedWal,
				"quarantined WAL",
			);
			walAlreadyQuarantined = true;
		} else {
			staleSwapIntent(
				intentPath,
				"WAL source/quarantine state is contradictory after backup",
			);
		}
	} else {
		if (existsSync(walPath)) {
			staleSwapIntent(intentPath, "a canonical WAL appeared after quarantine");
		}
		if (expectedWal === null) {
			if (existsSync(walQuarantine)) {
				staleSwapIntent(intentPath, "an unbound WAL quarantine exists");
			}
		} else {
			assertBoundHash(
				intentPath,
				walQuarantine,
				expectedWal,
				"quarantined WAL",
			);
			walAlreadyQuarantined = true;
		}
	}
	if (intent.phase !== "fenced") {
		assertNoWriteBits(intentPath, dbPath);
		assertNoWriteBits(intentPath, walPath);
	}
	if (swapPhaseAtLeast(intent.phase, "backed_up")) {
		verifyBoundBackup(intentPath, intent);
	}
	if (intent.phase === "staging_verified") {
		assertBoundHash(
			intentPath,
			intent.stagingPath,
			intent.stagingSha256 as string,
			"staging database",
		);
	}
	return { walAlreadyQuarantined };
}

function assertNoUnboundBackupAdoption(
	intentPath: string,
	intent: MailboxSwapIntent,
): void {
	if (
		intent.phase === "fenced" &&
		existsSync(intent.backupPath) &&
		(intent.v !== 2 || !intent.backupSha256)
	) {
		staleSwapIntent(
			intentPath,
			`unbound backup already exists at ${intent.backupPath}`,
		);
	}
}

function afterSwapFault(
	faultAfter: MailboxSwapFault | undefined,
	point: MailboxSwapFault,
): void {
	if (faultAfter === point) {
		throw new Error(`FLY-1572 swap fault injection after ${point}`);
	}
}

function archiveConclusiveStaleIntent(
	dbPath: string,
	intentPath: string,
	intent: MailboxSwapIntent,
	faultAfter: MailboxSwapFault | undefined,
): void {
	const contradictory = [
		intent.stagingPath,
		...intent.quarantinedSidecars,
	].find((path) => existsSync(path));
	if (contradictory) {
		throw new Error(
			`stale mailbox swap intent has contradictory artifact ${contradictory}; refusing automatic recovery`,
		);
	}
	const archivePath = `${intentPath}.stale-${new Date()
		.toISOString()
		.replaceAll(":", "-")}-${randomUUID()}`;
	if (existsSync(archivePath)) {
		throw new Error(
			`stale mailbox intent archive already exists: ${archivePath}`,
		);
	}
	renameSync(intentPath, archivePath);
	afterSwapFault(faultAfter, "after_stale_intent_archived");
	fsyncDirectory(dirname(intentPath));
	afterSwapFault(faultAfter, "after_stale_intent_dir_fsynced");
	console.error(
		canonicalJsonString({
			event: "mailbox_swap_intent_reconciled",
			reason: "stale_post_swap_intent",
			dbPath,
			oldPhase: intent.phase,
			oldCreatedAt: intent.createdAt,
			archivePath,
		}),
	);
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

export function verifyMigratedDatabase(dbPath: string): MailboxMigrationResult {
	verifySqlite(dbPath);
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		if (tableType(db, "mailbox_migration_meta") !== "table") {
			throw new Error(`mailbox migration marker missing: ${dbPath}`);
		}
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

export function ensureCanonicalDbWritable(dbPath: string): boolean {
	const mode = statSync(dbPath).mode & 0o777;
	if ((mode & 0o200) !== 0) return false;
	chmodSync(dbPath, 0o600);
	return true;
}

function afterSwapPhase(
	faultAfter: MailboxSwapFault | undefined,
	phase: MailboxSwapPhase,
): void {
	afterSwapFault(faultAfter, phase);
}

export async function migrateCommDbWithSwap(
	dbPath: string,
	options: { now?: string; faultAfter?: MailboxSwapFault } = {},
): Promise<MailboxSwapResult> {
	const now = options.now ?? new Date().toISOString();
	const intentPath = `${dbPath}.migration-swap-intent.json`;
	let intent = inspectMailboxSwapIntent(intentPath);
	let renameAlreadyLanded = false;
	if (intent && resolve(intent.dbPath) !== resolve(dbPath)) {
		throw new Error(
			`mailbox migration intent belongs to a different database: ${intent.dbPath} (requested ${dbPath})`,
		);
	}
	if (intent?.phase === "aborted") {
		throw new Error(
			`mailbox migration was aborted; archive ${intentPath} before retrying`,
		);
	}
	if (intent) {
		const postSwap = swapPhaseAtLeast(intent.phase, "canonical_swapped");
		const reality = postSwap
			? classifyMailboxDatabase(dbPath)
			: classifyCanonicalMainImage(dbPath);
		if (postSwap) {
			if (reality === "legacy") {
				archiveConclusiveStaleIntent(
					dbPath,
					intentPath,
					intent,
					options.faultAfter,
				);
				intent = undefined;
			} else if (reality !== "migrated") {
				staleSwapIntent(
					intentPath,
					`post-swap phase ${intent.phase} contradicts canonical state ${reality}`,
				);
			}
		} else if (reality === "legacy") {
			verifyLegacyPreSwapResume(dbPath, intentPath, intent);
			if (intent.phase === "fenced") {
				chmodSync(dbPath, 0o444);
				if (existsSync(`${dbPath}-wal`)) chmodSync(`${dbPath}-wal`, 0o444);
			}
		} else if (reality === "migrated") {
			if (
				intent.v !== 2 ||
				intent.phase !== "staging_verified" ||
				!intent.stagingSha256 ||
				sha256File(dbPath) !== intent.stagingSha256
			) {
				staleSwapIntent(
					intentPath,
					`pre-swap phase ${intent.phase} cannot own a migrated canonical`,
				);
			}
			verifyBoundBackup(intentPath, intent);
			renameAlreadyLanded = true;
		} else {
			staleSwapIntent(
				intentPath,
				`pre-swap phase ${intent.phase} contradicts canonical state ${reality}`,
			);
		}
	}
	if (!intent) {
		const reality = classifyMailboxDatabase(dbPath);
		if (reality === "migrated") {
			ensureCanonicalDbWritable(dbPath);
			const migrated = verifyMigratedDatabase(dbPath);
			return {
				...migrated,
				status: "already_migrated",
				backupPath: "",
				intentPath,
			};
		}
		if (reality !== "legacy") {
			throw new Error(
				`legacy CommDB has unsupported schema state ${reality}: ${dbPath}`,
			);
		}
		assertMigrationDiskCapacity(dbPath);
		const counts = countLegacyRows(dbPath);
		const stagingDir = join(dirname(dbPath), `.fly1572-${randomUUID()}`);
		intent = {
			v: 2,
			dbPath,
			backupPath: `${dbPath}.pre-fly1572-${now.replaceAll(":", "-")}`,
			stagingPath: join(stagingDir, basename(dbPath)),
			phase: "fenced",
			originalMode: statSync(dbPath).mode & 0o777,
			createdAt: now,
			sourceMessages: counts.messages,
			sourceLeadInbox: counts.leadInbox,
			quarantinedSidecars: [],
			sourceBinding: {
				mainSha256: sha256File(dbPath),
				walSha256: existsSync(`${dbPath}-wal`)
					? sha256File(`${dbPath}-wal`)
					: null,
			},
		};
		durableJson(intentPath, intent);
		afterSwapFault(options.faultAfter, "after_fresh_intent_durable");
		chmodSync(dbPath, 0o444);
		afterSwapFault(options.faultAfter, "after_main_fenced");
		if (existsSync(`${dbPath}-wal`)) chmodSync(`${dbPath}-wal`, 0o444);
		afterSwapFault(options.faultAfter, "after_wal_fenced");
		durableJson(intentPath, intent);
		afterSwapPhase(options.faultAfter, "fenced");
	}
	const reached = (phase: MailboxSwapPhase): boolean =>
		SWAP_PHASES.indexOf(
			(intent as MailboxSwapIntent).phase as MailboxSwapPhase,
		) >= SWAP_PHASES.indexOf(phase);
	const advance = (
		phase: MailboxSwapPhase,
		updates: Partial<MailboxSwapIntentV2> = {},
	): void => {
		const current = intent as MailboxSwapIntent;
		intent =
			current.v === 2
				? { ...current, ...updates, phase }
				: { ...current, phase };
		durableJson(intentPath, intent);
		afterSwapPhase(options.faultAfter, phase);
	};
	if (!reached("canonical_swapped")) {
		if (renameAlreadyLanded) {
			verifyMigratedDatabase(dbPath);
			advance("canonical_swapped");
		} else {
			for (const path of [dbPath, `${dbPath}-wal`]) {
				if (existsSync(path)) chmodSync(path, 0o444);
			}
		}
	}

	if (!reached("backed_up")) {
		assertNoUnboundBackupAdoption(intentPath, intent);
		await backupCommDb(dbPath, intent.backupPath);
		advance("backed_up", {
			backupSha256: sha256File(intent.backupPath),
			refsManifestSha256: sha256File(`${intent.backupPath}.refs-manifest.json`),
		});
	}
	if (!reached("sidecars_quarantined")) {
		const quarantined = [...intent.quarantinedSidecars];
		for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
			const target = `${sidecar}.fly1572-quarantine`;
			if (existsSync(sidecar) && existsSync(target)) {
				staleSwapIntent(
					intentPath,
					`sidecar source and quarantine both exist for ${sidecar}`,
				);
			}
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
		if (existsSync(intent.stagingPath)) {
			staleSwapIntent(
				intentPath,
				`unbound staging database already exists at ${intent.stagingPath}`,
			);
		}
		copyFileSync(intent.backupPath, intent.stagingPath);
		chmodSync(intent.stagingPath, 0o600);
		migrateLegacyDatabaseFile(intent.stagingPath, { now });
		verifyMigratedDatabase(intent.stagingPath);
		advance("staging_verified", {
			stagingSha256: sha256File(intent.stagingPath),
		});
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
	ensureCanonicalDbWritable(dbPath);
	if (!reached("verified")) advance("verified");
	if (!reached("done")) advance("done");
	for (const path of intent.quarantinedSidecars) {
		rmSync(path, { force: true });
	}
	cleanupBackupTemps(intent.backupPath);
	fsyncDirectory(dirname(dbPath));
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
	let intent = inspectMailboxSwapIntent(intentPath);
	if (!intent)
		throw new Error(`mailbox migration intent not found: ${intentPath}`);
	const initialIntent = intent;
	if (resolve(intent.dbPath) !== resolve(dbPath)) {
		throw new Error(
			`mailbox migration intent belongs to a different database: ${intent.dbPath} (requested ${dbPath})`,
		);
	}
	const rollbackRefused = (detail: string): never => {
		throw new Error(
			`rollback refused: canonical ${dbPath} does not match the migration intent (${detail}); resolve manually`,
		);
	};
	const canonicalRefs = join(dirname(dbPath), "refs");
	const refsMatchBackup = (): boolean => {
		try {
			verifyRefsTree(canonicalRefs, refsManifest(initialIntent.backupPath));
			return true;
		} catch {
			return false;
		}
	};
	if (!existsSync(intent.backupPath)) {
		if (intent.phase === "fenced") {
			if (intent.v === 2) {
				if (classifyCanonicalMainImage(dbPath) !== "legacy") {
					rollbackRefused("fenced canonical is not legacy");
				}
				verifyLegacyPreSwapResume(dbPath, intentPath, intent);
			}
			chmodSync(dbPath, intent.originalMode);
			ensureCanonicalDbWritable(dbPath);
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
		if (intent.phase === "aborted") {
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
	if (intent.v === 2) verifyBoundBackup(intentPath, intent);
	const preSwap = !swapPhaseAtLeast(intent.phase, "canonical_swapped");
	const walHasCommittedBytes =
		existsSync(`${dbPath}-wal`) && statSync(`${dbPath}-wal`).size > 0;
	const restoredBytesAndRefs =
		!walHasCommittedBytes &&
		sha256File(dbPath) === sha256File(intent.backupPath) &&
		refsMatchBackup();
	const reality = restoredBytesAndRefs
		? "legacy"
		: preSwap
			? classifyCanonicalMainImage(dbPath)
			: classifyMailboxDatabase(dbPath);
	const alreadyRestored = reality === "legacy" && restoredBytesAndRefs;
	if (intent.phase === "aborted") {
		if (!alreadyRestored) rollbackRefused("aborted intent has diverged");
		return {
			status: "already_migrated",
			sourceMessages: intent.sourceMessages,
			sourceLeadInbox: intent.sourceLeadInbox,
			sourceTrueUnread: 0,
			backupPath: intent.backupPath,
			intentPath,
		};
	}
	if (alreadyRestored) {
		// A previous restore rename landed before its restore-intent phase.
	} else if (reality === "migrated") {
		// Explicit rollback of a canonical that is still on the migrated side.
	} else if (reality === "legacy" && preSwap && intent.v === 2) {
		verifyLegacyPreSwapResume(dbPath, intentPath, intent);
		assertNoUnboundBackupAdoption(intentPath, intent);
		if (!refsMatchBackup()) {
			rollbackRefused("canonical refs differ from the bound backup manifest");
		}
	} else {
		rollbackRefused(
			`phase ${intent.phase} contradicts canonical state ${reality}`,
		);
	}
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
			quarantinedSidecars: [],
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
					const prefix = `${sidecar}.fly1572-rollback-quarantine-`;
					let target: string | undefined = (
						restoreIntent.quarantinedSidecars ?? []
					).find((path) => path.startsWith(prefix));
					if (!target) {
						target = `${prefix}${randomUUID()}`;
						restoreIntent = {
							...restoreIntent,
							quarantinedSidecars: [
								...(restoreIntent.quarantinedSidecars ?? []),
								target,
							],
						};
						durableJson(restoreIntentPath, restoreIntent);
					}
					if (existsSync(target)) {
						throw new Error(
							`rollback sidecar quarantine already exists: ${target}`,
						);
					}
					renameSync(sidecar, target);
				}
			}
			renameSync(restoreIntent.dbStage, dbPath);
		}
		chmodSync(dbPath, intent.originalMode);
		ensureCanonicalDbWritable(dbPath);
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
	for (const path of [
		restoreIntent.refsQuarantine,
		...(restoreIntent.quarantinedSidecars ?? []),
		...intent.quarantinedSidecars,
	]) {
		rmSync(path, { recursive: true, force: true });
	}
	rmSync(restoreIntentPath, { force: true });
	fsyncDirectory(dirname(dbPath));
	return {
		status: "already_migrated",
		sourceMessages: counts.messages,
		sourceLeadInbox: counts.leadInbox,
		sourceTrueUnread: 0,
		backupPath: intent.backupPath,
		intentPath,
	};
}
