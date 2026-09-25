import { createHash, randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import {
	renderSpeechBrief,
	type SpeakReceipt,
	speakRequestDigest,
	splitSpeechText,
	validateSpeechBrief,
} from "flywheel-voice-core";

const MIN_CLAIM_TTL_MS = 60_000;
const MAX_CLAIM_TTL_MS = 15 * 60_000;
const CLAIM_TTL_PER_CODE_POINT_MS = 250;

function claimTtlMsForItem(item: HeadphoneInboxItemRecord): number {
	const brief = validateSpeechBrief(item.speechBrief ?? undefined);
	const speechText = brief.ok
		? renderSpeechBrief(item.speechBrief!)
		: item.text;
	return Math.min(
		MAX_CLAIM_TTL_MS,
		MIN_CLAIM_TTL_MS +
			Array.from(speechText).length * CLAIM_TTL_PER_CODE_POINT_MS,
	);
}

/** FLY-2863 §2.3: who a collected message speaks for. Computed once at
 * collection from the author and the shared prefix constants. */
export const HEADPHONE_ORIGIN_CLASSES = [
	"lead_authored",
	"automation",
	"voice_echo",
	"founder",
	"other",
] as const;
export type HeadphoneOriginClass = (typeof HEADPHONE_ORIGIN_CLASSES)[number];

export interface HeadphoneInboxItemRecord {
	itemId: string;
	revision: number;
	questionId: string | null;
	projectName: string;
	founderUserId: string;
	channelId: string;
	sourceMessageId: string;
	sourceRevision: string;
	authorId: string;
	needsDecision: boolean;
	text: string;
	speechBrief: { what: string; why: string; next: string } | null;
	sourceCreatedAt: string;
	sourceResolved: boolean;
	contentDigest: string;
	seq: number;
	/** Null for rows collected before FLY-2863. */
	originClass: HeadphoneOriginClass | null;
}

export interface HeadphoneInboxClaimRecord {
	item: HeadphoneInboxItemRecord;
	claimToken: string;
	leaseExpiresAt: string;
	attempt: number;
	pendingKey: string;
}

export interface HeadphoneInboxSnapshot {
	snapshotId: string;
	highWatermark: number;
	sourceStatus: HeadphoneInboxSourceState[];
	nextCursor: string | null;
	items: HeadphoneInboxItemRecord[];
}

export interface HeadphoneInboxSourceState {
	projectName: string;
	founderUserId: string;
	channelId: string;
	cursor: string | null;
	highWatermark: string | null;
	bootstrapComplete: boolean;
	health: "healthy" | "recovering" | "rate_limited" | "source_gap";
	healthReason: string | null;
	nextAllowedAt: string | null;
	updatedAt: string;
	/** Latest founder message seen in this channel (reply watermark). */
	founderLastMessageAt: string | null;
	/** FLY-2863 F1: history pages read so far by this source's backfill. */
	bootstrapPages: number;
}

export interface HeadphoneInboxUpsertInput {
	questionId?: string;
	projectName: string;
	founderUserId: string;
	channelId: string;
	sourceMessageId: string;
	sourceRevision: string;
	authorId: string;
	needsDecision: boolean;
	text: string;
	speechBrief?: { what: string; why: string; next: string };
	sourceCreatedAt: string;
	sourceResolved?: boolean;
	originClass?: HeadphoneOriginClass;
}

function itemFromRow(row: Record<string, unknown>): HeadphoneInboxItemRecord {
	let speechBrief: HeadphoneInboxItemRecord["speechBrief"] = null;
	if (typeof row.speech_brief_json === "string") {
		try {
			const value = JSON.parse(row.speech_brief_json) as Record<
				string,
				unknown
			>;
			if (
				typeof value.what === "string" &&
				typeof value.why === "string" &&
				typeof value.next === "string"
			)
				speechBrief = {
					what: value.what,
					why: value.why,
					next: value.next,
				};
		} catch {
			// Optional corrupt brief falls back to immutable source text.
		}
	}
	return {
		itemId: String(row.item_id),
		revision: Number(row.revision),
		questionId: typeof row.question_id === "string" ? row.question_id : null,
		projectName: String(row.project_name),
		founderUserId: String(row.founder_user_id),
		channelId: String(row.channel_id),
		sourceMessageId: String(row.source_message_id),
		sourceRevision: String(row.source_revision),
		authorId: String(row.author_id),
		needsDecision: Number(row.needs_decision) === 1,
		text: String(row.text),
		speechBrief,
		sourceCreatedAt: String(row.source_created_at),
		sourceResolved: Number(row.source_resolved) === 1,
		contentDigest: String(row.content_digest),
		seq: Number(row.seq),
		originClass: HEADPHONE_ORIGIN_CLASSES.includes(
			row.origin_class as HeadphoneOriginClass,
		)
			? (row.origin_class as HeadphoneOriginClass)
			: null,
	};
}

function contentDigest(input: HeadphoneInboxUpsertInput): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				questionId: input.questionId ?? null,
				projectName: input.projectName,
				founderUserId: input.founderUserId,
				channelId: input.channelId,
				sourceMessageId: input.sourceMessageId,
				sourceRevision: input.sourceRevision,
				authorId: input.authorId,
				needsDecision: input.needsDecision,
				text: input.text,
				speechBrief: input.speechBrief ?? null,
				sourceCreatedAt: input.sourceCreatedAt,
			}),
		)
		.digest("hex");
}

type SnapshotCursor = {
	v: 1;
	snapshotId: string;
	highWatermark: number;
	needsDecision: 0 | 1;
	seq: number;
	itemId: string;
};

function encodeCursor(cursor: SnapshotCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): SnapshotCursor {
	try {
		const parsed = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as SnapshotCursor;
		if (
			parsed.v !== 1 ||
			typeof parsed.snapshotId !== "string" ||
			!Number.isSafeInteger(parsed.highWatermark) ||
			(parsed.needsDecision !== 0 && parsed.needsDecision !== 1) ||
			!Number.isSafeInteger(parsed.seq) ||
			typeof parsed.itemId !== "string" ||
			!parsed.itemId
		)
			throw new Error("invalid");
		return parsed;
	} catch {
		throw new Error("headphone_inbox_cursor_invalid");
	}
}

export class HeadphoneInboxStore {
	constructor(private readonly db: Database) {}

	migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS voice_headphone_inbox (
				item_id TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK(revision > 0),
				question_id TEXT,
				project_name TEXT NOT NULL,
				founder_user_id TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				source_message_id TEXT NOT NULL,
				source_revision TEXT NOT NULL,
				author_id TEXT NOT NULL,
				needs_decision INTEGER NOT NULL CHECK(needs_decision IN (0,1)),
				text TEXT NOT NULL,
				speech_brief_json TEXT,
				source_created_at TEXT NOT NULL,
				source_resolved INTEGER NOT NULL DEFAULT 0 CHECK(source_resolved IN (0,1)),
				content_digest TEXT NOT NULL,
				seq INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY(item_id, revision),
				UNIQUE(project_name, founder_user_id, channel_id, source_message_id, source_revision)
			);
			CREATE TABLE IF NOT EXISTS voice_headphone_claim (
				item_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				claim_token TEXT NOT NULL,
				lease_expires_at TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 2),
				pending_key TEXT NOT NULL,
				PRIMARY KEY(item_id, revision),
				FOREIGN KEY(item_id, revision) REFERENCES voice_headphone_inbox(item_id, revision)
			);
			CREATE TABLE IF NOT EXISTS voice_headphone_ack (
				item_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				request_digests_json TEXT NOT NULL,
				receipts_json TEXT,
				acked_at TEXT NOT NULL,
				PRIMARY KEY(item_id, revision),
				FOREIGN KEY(item_id, revision) REFERENCES voice_headphone_inbox(item_id, revision)
			);
			CREATE TABLE IF NOT EXISTS voice_headphone_source (
				project_name TEXT NOT NULL,
				founder_user_id TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				cursor TEXT,
				high_watermark TEXT,
				bootstrap_complete INTEGER NOT NULL DEFAULT 0 CHECK(bootstrap_complete IN (0,1)),
				health TEXT NOT NULL DEFAULT 'recovering' CHECK(health IN ('healthy','recovering','rate_limited','source_gap')),
				health_reason TEXT,
				next_allowed_at TEXT,
				updated_at TEXT NOT NULL,
				PRIMARY KEY(project_name, founder_user_id, channel_id)
			);
			CREATE TABLE IF NOT EXISTS voice_headphone_delivery (
				item_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),
				next_at TEXT,
				claim_token TEXT,
				claim_expires_at TEXT,
				pending_key TEXT,
				state_version INTEGER NOT NULL DEFAULT 0,
				receipts_json TEXT,
				PRIMARY KEY(item_id, revision, session_id),
				FOREIGN KEY(item_id, revision) REFERENCES voice_headphone_inbox(item_id, revision)
			);
		`);
		const columns = (table: string): Set<string> =>
			new Set(
				(
					this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
						name: string;
					}>
				).map((column) => column.name),
			);
		const inboxColumns = columns("voice_headphone_inbox");
		const addedQuestionId = !inboxColumns.has("question_id");
		if (addedQuestionId)
			this.db.exec(
				"ALTER TABLE voice_headphone_inbox ADD COLUMN question_id TEXT",
			);
		if (!inboxColumns.has("content_digest"))
			this.db.exec(
				"ALTER TABLE voice_headphone_inbox ADD COLUMN content_digest TEXT NOT NULL DEFAULT ''",
			);
		if (!inboxColumns.has("seq"))
			this.db.exec(
				"ALTER TABLE voice_headphone_inbox ADD COLUMN seq INTEGER NOT NULL DEFAULT 0",
			);
		if (addedQuestionId)
			this.db.exec("UPDATE voice_headphone_inbox SET content_digest = ''");
		if (!columns("voice_headphone_inbox").has("origin_class"))
			this.db.exec(
				`ALTER TABLE voice_headphone_inbox ADD COLUMN origin_class TEXT CHECK(origin_class IS NULL OR origin_class IN (${HEADPHONE_ORIGIN_CLASSES.map((value) => `'${value}'`).join(",")}))`,
			);
		const sourceColumns = columns("voice_headphone_source");
		if (!sourceColumns.has("founder_last_message_at"))
			this.db.exec(
				"ALTER TABLE voice_headphone_source ADD COLUMN founder_last_message_at TEXT",
			);
		if (!sourceColumns.has("bootstrap_pages"))
			this.db.exec(
				"ALTER TABLE voice_headphone_source ADD COLUMN bootstrap_pages INTEGER NOT NULL DEFAULT 0 CHECK(bootstrap_pages >= 0)",
			);
		const claimColumns = columns("voice_headphone_claim");
		if (!claimColumns.has("attempt"))
			this.db.exec(
				"ALTER TABLE voice_headphone_claim ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1",
			);
		if (!claimColumns.has("pending_key"))
			this.db.exec(
				"ALTER TABLE voice_headphone_claim ADD COLUMN pending_key TEXT NOT NULL DEFAULT ''",
			);
		const ackColumns = columns("voice_headphone_ack");
		if (!ackColumns.has("receipts_json"))
			this.db.exec(
				"ALTER TABLE voice_headphone_ack ADD COLUMN receipts_json TEXT",
			);
		const oldRows = this.db
			.prepare(
				"SELECT rowid, * FROM voice_headphone_inbox WHERE seq = 0 OR content_digest = '' ORDER BY rowid",
			)
			.all() as Record<string, unknown>[];
		for (const row of oldRows) {
			const old = itemFromRow(row);
			const digest = contentDigest({
				...(old.questionId ? { questionId: old.questionId } : {}),
				projectName: String(row.project_name),
				founderUserId: String(row.founder_user_id),
				channelId: String(row.channel_id),
				sourceMessageId: String(row.source_message_id),
				sourceRevision: String(row.source_revision),
				authorId: String(row.author_id),
				needsDecision: Number(row.needs_decision) === 1,
				text: String(row.text),
				...(old.speechBrief ? { speechBrief: old.speechBrief } : {}),
				sourceCreatedAt: String(row.source_created_at),
			});
			this.db
				.prepare(
					"UPDATE voice_headphone_inbox SET seq = CASE WHEN seq = 0 THEN ? ELSE seq END, content_digest = CASE WHEN content_digest = '' THEN ? ELSE content_digest END WHERE rowid = ?",
				)
				.run(Number(row.rowid), digest, row.rowid);
		}
		this.db.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_headphone_inbox_seq ON voice_headphone_inbox(seq)",
		);
	}

	upsert(input: HeadphoneInboxUpsertInput): HeadphoneInboxItemRecord {
		if (
			(input.questionId !== undefined && !input.questionId) ||
			!input.projectName ||
			!input.founderUserId ||
			!input.channelId ||
			!input.sourceMessageId ||
			!input.sourceRevision ||
			!input.authorId ||
			!input.text.trim() ||
			!Number.isFinite(Date.parse(input.sourceCreatedAt))
		)
			throw new Error("headphone_inbox_item_invalid");
		const itemId = createHash("sha256")
			.update(
				`${input.projectName}\0${input.founderUserId}\0${input.questionId ? `question:${input.questionId}` : `${input.channelId}\0${input.sourceMessageId}`}`,
			)
			.digest("hex");
		const digest = contentDigest(input);
		const source = this.db
			.prepare(
				`SELECT * FROM voice_headphone_inbox
				 WHERE project_name = ? AND founder_user_id = ? AND channel_id = ?
				   AND source_message_id = ? AND source_revision = ?`,
			)
			.get(
				input.projectName,
				input.founderUserId,
				input.channelId,
				input.sourceMessageId,
				input.sourceRevision,
			) as Record<string, unknown> | undefined;
		if (source) {
			if (source.content_digest !== digest)
				throw new Error("headphone_inbox_revision_conflict");
			if (input.sourceResolved && Number(source.source_resolved) !== 1)
				this.db
					.prepare(
						"UPDATE voice_headphone_inbox SET source_resolved = 1 WHERE item_id = ? AND revision = ?",
					)
					.run(source.item_id, source.revision);
			return itemFromRow(
				this.db
					.prepare(
						"SELECT * FROM voice_headphone_inbox WHERE item_id = ? ORDER BY revision DESC LIMIT 1",
					)
					.get(source.item_id) as Record<string, unknown>,
			);
		}
		const existing = this.db
			.prepare(
				"SELECT * FROM voice_headphone_inbox WHERE item_id = ? ORDER BY revision DESC LIMIT 1",
			)
			.get(itemId) as Record<string, unknown> | undefined;
		if (
			input.questionId &&
			input.sourceMessageId === input.questionId &&
			existing &&
			existing.source_message_id !== input.sourceMessageId
		)
			return itemFromRow(existing);
		const revision = existing ? Number(existing.revision) + 1 : 1;
		const seq = Number(
			(
				this.db
					.prepare(
						"SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM voice_headphone_inbox",
					)
					.get() as { seq: number }
			).seq,
		);
		this.db
			.prepare(
				`INSERT INTO voice_headphone_inbox
				 (item_id, revision, question_id, project_name, founder_user_id, channel_id,
				  source_message_id, source_revision, author_id, needs_decision,
				  text, speech_brief_json, source_created_at, source_resolved,
				  content_digest, seq, created_at, origin_class)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				itemId,
				revision,
				input.questionId ?? null,
				input.projectName,
				input.founderUserId,
				input.channelId,
				input.sourceMessageId,
				input.sourceRevision,
				input.authorId,
				input.needsDecision ? 1 : 0,
				input.text,
				input.speechBrief ? JSON.stringify(input.speechBrief) : null,
				input.sourceCreatedAt,
				input.sourceResolved ? 1 : 0,
				digest,
				seq,
				new Date().toISOString(),
				input.originClass ?? null,
			);
		return itemFromRow(
			this.db
				.prepare(
					"SELECT * FROM voice_headphone_inbox WHERE item_id = ? AND revision = ?",
				)
				.get(itemId, revision) as Record<string, unknown>,
		);
	}

	reconcileQuestionAuthority(input: {
		projectName: string;
		founderUserId: string;
		openQuestionIds: readonly string[];
	}): void {
		if (
			!input.projectName ||
			!input.founderUserId ||
			input.openQuestionIds.some((questionId) => !questionId)
		)
			throw new Error("headphone_inbox_question_authority_invalid");
		const open = [...new Set(input.openQuestionIds)];
		this.db.transaction(() => {
			this.db
				.prepare(
					`UPDATE voice_headphone_inbox SET source_resolved = 1
					 WHERE project_name = ? AND founder_user_id = ?
					   AND question_id IS NOT NULL`,
				)
				.run(input.projectName, input.founderUserId);
			for (let offset = 0; offset < open.length; offset += 500) {
				const page = open.slice(offset, offset + 500);
				const placeholders = page.map(() => "?").join(",");
				this.db
					.prepare(
						`UPDATE voice_headphone_inbox SET source_resolved = 0
						 WHERE project_name = ? AND founder_user_id = ?
						   AND question_id IN (${placeholders})`,
					)
					.run(input.projectName, input.founderUserId, ...page);
			}
		})();
	}

	snapshot(input: {
		projectName: string;
		founderUserId: string;
		limit: number;
		cursor?: string;
	}): HeadphoneInboxSnapshot {
		if (
			!input.projectName ||
			!input.founderUserId ||
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 100
		)
			throw new Error("headphone_inbox_limit_invalid");
		const prior = input.cursor ? decodeCursor(input.cursor) : undefined;
		const highWatermark =
			prior?.highWatermark ??
			Number(
				(
					this.db
						.prepare(
							"SELECT COALESCE(MAX(seq), 0) AS high_watermark FROM voice_headphone_inbox WHERE project_name = ? AND founder_user_id = ?",
						)
						.get(input.projectName, input.founderUserId) as {
						high_watermark: number;
					}
				).high_watermark,
			);
		const snapshotId = createHash("sha256")
			.update(`${input.projectName}\0${input.founderUserId}\0${highWatermark}`)
			.digest("hex");
		if (prior && prior.snapshotId !== snapshotId)
			throw new Error("headphone_inbox_cursor_invalid");
		const rows = this.db
			.prepare(
				`SELECT i.* FROM voice_headphone_inbox i
					 WHERE i.project_name = ? AND i.founder_user_id = ?
					   AND i.seq <= ?
					   AND i.source_resolved = 0
					   AND i.revision = (
					     SELECT MAX(i2.revision) FROM voice_headphone_inbox i2
					     WHERE i2.item_id = i.item_id AND i2.seq <= ?
					   )
					   AND NOT EXISTS (
					     SELECT 1 FROM voice_headphone_ack a
					     WHERE a.item_id = i.item_id AND a.revision = i.revision
					   )
					   ${
								prior
									? `AND (
							       i.needs_decision < ? OR
							       (i.needs_decision = ? AND (
							         i.seq > ? OR (i.seq = ? AND i.item_id > ?)
							       ))
							     )`
									: ""
							}
					 ORDER BY i.needs_decision DESC, i.seq, i.item_id LIMIT ?`,
			)
			.all(
				input.projectName,
				input.founderUserId,
				highWatermark,
				highWatermark,
				...(prior
					? [
							prior.needsDecision,
							prior.needsDecision,
							prior.seq,
							prior.seq,
							prior.itemId,
						]
					: []),
				input.limit + 1,
			) as Record<string, unknown>[];
		const items = rows.slice(0, input.limit).map(itemFromRow);
		const last = items.at(-1);
		return {
			snapshotId,
			highWatermark,
			sourceStatus: this.listSourceState(
				input.projectName,
				input.founderUserId,
			),
			nextCursor:
				rows.length > input.limit && last
					? encodeCursor({
							v: 1,
							snapshotId,
							highWatermark,
							needsDecision: last.needsDecision ? 1 : 0,
							seq: last.seq,
							itemId: last.itemId,
						})
					: null,
			items,
		};
	}

	list(input: {
		projectName: string;
		founderUserId: string;
		limit: number;
	}): HeadphoneInboxItemRecord[] {
		return this.snapshot(input).items;
	}

	claim(input: {
		itemId: string;
		revision: number;
		sessionId: string;
		generation: number;
		leaseToken: string;
		founderUserId: string;
		now: string;
		claimTtlMs?: number;
	}): HeadphoneInboxClaimRecord | undefined {
		if (!Number.isFinite(Date.parse(input.now)))
			throw new Error("headphone_inbox_claim_time_invalid");
		return this.db.transaction(() => {
			const session = this.db
				.prepare("SELECT * FROM voice_sessions WHERE session_id = ?")
				.get(input.sessionId) as Record<string, unknown> | undefined;
			if (
				!session ||
				Number(session.session_generation) !== input.generation ||
				session.lease_token !== input.leaseToken ||
				typeof session.lease_expires_at !== "string" ||
				Date.parse(session.lease_expires_at) <= Date.parse(input.now) ||
				!(["warming", "live"] as unknown[]).includes(session.state)
			)
				throw new Error("headphone_inbox_session_unauthorized");
			const row = this.db
				.prepare(
					`SELECT * FROM voice_headphone_inbox
					 WHERE item_id = ? AND revision = ? AND source_resolved = 0
					   AND revision = (
					     SELECT MAX(i2.revision) FROM voice_headphone_inbox i2
					     WHERE i2.item_id = voice_headphone_inbox.item_id
					   )`,
				)
				.get(input.itemId, input.revision) as
				| Record<string, unknown>
				| undefined;
			if (
				!row ||
				row.project_name !== session.project_name ||
				row.founder_user_id !== input.founderUserId
			)
				return undefined;
			if (
				this.db
					.prepare(
						"SELECT 1 FROM voice_headphone_ack WHERE item_id = ? AND revision = ?",
					)
					.get(input.itemId, input.revision)
			)
				return undefined;
			this.db
				.prepare(
					`DELETE FROM voice_headphone_claim
					 WHERE item_id = ? AND revision = ?
					   AND (lease_expires_at <= ? OR (session_id = ? AND generation <> ?))`,
				)
				.run(
					input.itemId,
					input.revision,
					input.now,
					input.sessionId,
					input.generation,
				);
			const prior = this.db
				.prepare(
					"SELECT * FROM voice_headphone_claim WHERE item_id = ? AND revision = ?",
				)
				.get(input.itemId, input.revision) as
				| Record<string, unknown>
				| undefined;
			const item = itemFromRow(row);
			if (prior) {
				return prior.session_id === input.sessionId &&
					Number(prior.generation) === input.generation
					? {
							item,
							claimToken: String(prior.claim_token),
							leaseExpiresAt: String(prior.lease_expires_at),
							attempt: Number(prior.attempt),
							pendingKey: String(prior.pending_key),
						}
					: undefined;
			}
			const delivery = this.db
				.prepare(
					`SELECT * FROM voice_headphone_delivery
					 WHERE item_id = ? AND revision = ? AND session_id = ?`,
				)
				.get(input.itemId, input.revision, input.sessionId) as
				| Record<string, unknown>
				| undefined;
			const attempts = Number(delivery?.attempts ?? 0);
			if (
				attempts >= 2 ||
				(typeof delivery?.next_at === "string" &&
					Date.parse(delivery.next_at) > Date.parse(input.now))
			)
				return undefined;
			const attempt = attempts + 1;
			const claimToken = randomBytes(32).toString("hex");
			const retryMs = input.claimTtlMs ?? claimTtlMsForItem(item);
			if (
				!Number.isSafeInteger(retryMs) ||
				retryMs < 1 ||
				retryMs > MAX_CLAIM_TTL_MS
			)
				throw new Error("headphone_inbox_claim_ttl_invalid");
			const leaseExpiresAt = new Date(
				Date.parse(input.now) + retryMs,
			).toISOString();
			const nextAt = new Date(Date.parse(input.now) + 60_000).toISOString();
			const pendingKey = `inbox:${input.itemId}:${input.revision}:${input.sessionId}:${input.generation}:${attempt}`;
			this.db
				.prepare(
					`INSERT INTO voice_headphone_claim
					 (item_id, revision, session_id, generation, claim_token, lease_expires_at,
					  attempt, pending_key)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.itemId,
					input.revision,
					input.sessionId,
					input.generation,
					claimToken,
					leaseExpiresAt,
					attempt,
					pendingKey,
				);
			this.db
				.prepare(
					`INSERT INTO voice_headphone_delivery
					 (item_id, revision, session_id, generation, attempts, next_at,
					  claim_token, claim_expires_at, pending_key, state_version)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
					 ON CONFLICT(item_id, revision, session_id) DO UPDATE SET
					 generation=excluded.generation, attempts=excluded.attempts,
					 next_at=excluded.next_at, claim_token=excluded.claim_token,
					 claim_expires_at=excluded.claim_expires_at,
					 pending_key=excluded.pending_key,
					 state_version=voice_headphone_delivery.state_version + 1`,
				)
				.run(
					input.itemId,
					input.revision,
					input.sessionId,
					input.generation,
					attempt,
					nextAt,
					claimToken,
					leaseExpiresAt,
					pendingKey,
				);
			return { item, claimToken, leaseExpiresAt, attempt, pendingKey };
		})();
	}

	ack(input: {
		itemId: string;
		revision: number;
		sessionId: string;
		generation: number;
		leaseToken: string;
		founderUserId: string;
		claimToken: string;
		receipts: readonly SpeakReceipt[];
		ackedAt: string;
	}): boolean {
		if (
			input.receipts.length < 1 ||
			input.receipts.length > 100 ||
			input.receipts.some(
				(receipt) =>
					receipt.outcome !== "completed" ||
					!receipt.pendingKey ||
					!/^[a-f0-9]{64}$/.test(receipt.requestDigest) ||
					(receipt.contentProof !== "deterministic_tts" &&
						receipt.contentProof !== "transcript_equivalent") ||
					(receipt.transport !== "submitted" &&
						receipt.transport !== "playback_drained"),
			) ||
			!Number.isFinite(Date.parse(input.ackedAt))
		)
			throw new Error("headphone_inbox_ack_invalid");
		return this.db.transaction(() => {
			const session = this.db
				.prepare("SELECT * FROM voice_sessions WHERE session_id = ?")
				.get(input.sessionId) as Record<string, unknown> | undefined;
			if (
				!session ||
				Number(session.session_generation) !== input.generation ||
				session.lease_token !== input.leaseToken ||
				typeof session.lease_expires_at !== "string" ||
				Date.parse(session.lease_expires_at) <= Date.parse(input.ackedAt) ||
				!(session.state === "warming" || session.state === "live")
			)
				return false;
			const row = this.db
				.prepare(
					`SELECT * FROM voice_headphone_inbox
					 WHERE item_id = ? AND revision = ?
					   AND revision = (
					     SELECT MAX(i2.revision) FROM voice_headphone_inbox i2
					     WHERE i2.item_id = voice_headphone_inbox.item_id
					   )`,
				)
				.get(input.itemId, input.revision) as
				| Record<string, unknown>
				| undefined;
			if (
				!row ||
				row.project_name !== session.project_name ||
				row.founder_user_id !== input.founderUserId
			)
				return false;
			const requestDigests = input.receipts.map(
				(receipt) => receipt.requestDigest,
			);
			const priorAck = this.db
				.prepare(
					"SELECT * FROM voice_headphone_ack WHERE item_id = ? AND revision = ?",
				)
				.get(input.itemId, input.revision) as
				| Record<string, unknown>
				| undefined;
			if (priorAck)
				return (
					priorAck.session_id === input.sessionId &&
					Number(priorAck.generation) === input.generation &&
					priorAck.request_digests_json === JSON.stringify(requestDigests)
				);
			const claim = this.db
				.prepare(
					`SELECT * FROM voice_headphone_claim
					 WHERE item_id = ? AND revision = ? AND session_id = ?
					   AND generation = ? AND claim_token = ? AND lease_expires_at > ?`,
				)
				.get(
					input.itemId,
					input.revision,
					input.sessionId,
					input.generation,
					input.claimToken,
					input.ackedAt,
				) as Record<string, unknown> | undefined;
			if (!claim) return false;
			const item = itemFromRow(row);
			const brief = validateSpeechBrief(item.speechBrief ?? undefined);
			const chunks = splitSpeechText(
				brief.ok ? renderSpeechBrief(item.speechBrief!) : item.text,
				500,
			);
			if (chunks.length !== input.receipts.length) return false;
			const kind = item.needsDecision ? "question" : "brief";
			for (const [index, chunk] of chunks.entries()) {
				const receipt = input.receipts[index]!;
				const pendingKey = `${String(claim.pending_key)}:${index}`;
				if (
					receipt.pendingKey !== pendingKey ||
					receipt.requestDigest !==
						speakRequestDigest({
							sessionId: input.sessionId,
							generation: input.generation,
							text: chunk,
							kind,
							verification: "required",
						})
				)
					return false;
			}
			this.db
				.prepare(
					`INSERT OR IGNORE INTO voice_headphone_ack
					 (item_id, revision, session_id, generation, request_digests_json,
					  receipts_json, acked_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.itemId,
					input.revision,
					input.sessionId,
					input.generation,
					JSON.stringify(requestDigests),
					JSON.stringify(input.receipts),
					input.ackedAt,
				);
			this.db
				.prepare(
					`UPDATE voice_headphone_delivery SET receipts_json = ?, state_version = state_version + 1
					 WHERE item_id = ? AND revision = ? AND session_id = ?`,
				)
				.run(
					JSON.stringify(input.receipts),
					input.itemId,
					input.revision,
					input.sessionId,
				);
			this.db
				.prepare(
					"DELETE FROM voice_headphone_claim WHERE item_id = ? AND revision = ? AND claim_token = ?",
				)
				.run(input.itemId, input.revision, input.claimToken);
			return true;
		})();
	}

	setSourceState(input: {
		projectName: string;
		founderUserId: string;
		channelId: string;
		cursor?: string;
		highWatermark?: string;
		bootstrapComplete: boolean;
		health: "healthy" | "recovering" | "rate_limited" | "source_gap";
		healthReason?: string;
		nextAllowedAt?: string;
		updatedAt: string;
		founderLastMessageAt?: string;
		/** Omitted keeps the stored count (0 for a new source). */
		bootstrapPages?: number;
	}): void {
		const founderLastMessageAt =
			input.founderLastMessageAt === undefined
				? null
				: new Date(input.founderLastMessageAt).toISOString();
		this.db
			.prepare(
				`INSERT INTO voice_headphone_source
				 (project_name, founder_user_id, channel_id, cursor, high_watermark,
				  bootstrap_complete, health, health_reason, next_allowed_at, updated_at,
				  founder_last_message_at, bootstrap_pages)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0))
				 ON CONFLICT(project_name, founder_user_id, channel_id) DO UPDATE SET
				 cursor=excluded.cursor, high_watermark=excluded.high_watermark,
				 bootstrap_pages=COALESCE(?, bootstrap_pages),
				 bootstrap_complete=excluded.bootstrap_complete, health=excluded.health,
				 health_reason=excluded.health_reason, next_allowed_at=excluded.next_allowed_at,
				 updated_at=excluded.updated_at,
				 founder_last_message_at=CASE
				   WHEN excluded.founder_last_message_at IS NULL THEN founder_last_message_at
				   WHEN founder_last_message_at IS NULL OR excluded.founder_last_message_at > founder_last_message_at
				     THEN excluded.founder_last_message_at
				   ELSE founder_last_message_at END`,
			)
			.run(
				input.projectName,
				input.founderUserId,
				input.channelId,
				input.cursor ?? null,
				input.highWatermark ?? null,
				input.bootstrapComplete ? 1 : 0,
				input.health,
				input.healthReason ?? null,
				input.nextAllowedAt ?? null,
				input.updatedAt,
				founderLastMessageAt,
				input.bootstrapPages ?? null,
				input.bootstrapPages ?? null,
			);
	}

	getSourceState(
		projectName: string,
		founderUserId: string,
		channelId: string,
	): HeadphoneInboxSourceState | undefined {
		const row = this.db
			.prepare(
				`SELECT project_name, founder_user_id, channel_id, cursor, high_watermark,
				 bootstrap_complete, health, health_reason, next_allowed_at, updated_at,
				 founder_last_message_at, bootstrap_pages
				 FROM voice_headphone_source
				 WHERE project_name = ? AND founder_user_id = ? AND channel_id = ?`,
			)
			.get(projectName, founderUserId, channelId) as
			| Record<string, unknown>
			| undefined;
		return row ? this.sourceStateFromRow(row) : undefined;
	}

	ingestPage(input: {
		items: readonly HeadphoneInboxUpsertInput[];
		source: Parameters<HeadphoneInboxStore["setSourceState"]>[0];
		/** FLY-2863: writes that must commit with the page and its cursor. */
		withinPage?: () => void;
	}): void {
		this.db.transaction(() => {
			for (const item of input.items) this.upsert(item);
			input.withinPage?.();
			this.setSourceState(input.source);
		})();
	}

	listSourceState(
		projectName: string,
		founderUserId: string,
	): HeadphoneInboxSourceState[] {
		return (
			this.db
				.prepare(
					`SELECT project_name, founder_user_id, channel_id, cursor, high_watermark,
				 bootstrap_complete, health, health_reason, next_allowed_at, updated_at,
				 founder_last_message_at, bootstrap_pages
				 FROM voice_headphone_source WHERE project_name = ? AND founder_user_id = ?
				 ORDER BY channel_id`,
				)
				.all(projectName, founderUserId) as Record<string, unknown>[]
		).map((row) => this.sourceStateFromRow(row));
	}

	private sourceStateFromRow(
		row: Record<string, unknown>,
	): HeadphoneInboxSourceState {
		return {
			projectName: String(row.project_name),
			founderUserId: String(row.founder_user_id),
			channelId: String(row.channel_id),
			cursor: typeof row.cursor === "string" ? row.cursor : null,
			highWatermark:
				typeof row.high_watermark === "string" ? row.high_watermark : null,
			bootstrapComplete: Number(row.bootstrap_complete) === 1,
			health: row.health as HeadphoneInboxSourceState["health"],
			healthReason:
				typeof row.health_reason === "string" ? row.health_reason : null,
			nextAllowedAt:
				typeof row.next_allowed_at === "string" ? row.next_allowed_at : null,
			updatedAt: String(row.updated_at),
			founderLastMessageAt:
				typeof row.founder_last_message_at === "string"
					? row.founder_last_message_at
					: null,
			bootstrapPages: Number(row.bootstrap_pages ?? 0),
		};
	}
}
