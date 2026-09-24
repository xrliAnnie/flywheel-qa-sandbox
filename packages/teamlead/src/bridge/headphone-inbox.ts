import { createHash, randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";

export interface HeadphoneInboxItemRecord {
	itemId: string;
	revision: number;
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
}

export interface HeadphoneInboxClaimRecord {
	item: HeadphoneInboxItemRecord;
	claimToken: string;
	leaseExpiresAt: string;
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
}

export interface HeadphoneInboxUpsertInput {
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
	};
}

export class HeadphoneInboxStore {
	constructor(private readonly db: Database) {}

	migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS voice_headphone_inbox (
				item_id TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK(revision > 0),
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
				PRIMARY KEY(item_id, revision),
				FOREIGN KEY(item_id, revision) REFERENCES voice_headphone_inbox(item_id, revision)
			);
			CREATE TABLE IF NOT EXISTS voice_headphone_ack (
				item_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				request_digests_json TEXT NOT NULL,
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
		`);
	}

	upsert(input: {
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
	}): HeadphoneInboxItemRecord {
		if (
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
				`${input.projectName}\0${input.founderUserId}\0${input.channelId}\0${input.sourceMessageId}`,
			)
			.digest("hex");
		const existing = this.db
			.prepare(
				"SELECT * FROM voice_headphone_inbox WHERE item_id = ? ORDER BY revision DESC LIMIT 1",
			)
			.get(itemId) as Record<string, unknown> | undefined;
		if (existing?.source_revision === input.sourceRevision)
			return itemFromRow(existing);
		const revision = existing ? Number(existing.revision) + 1 : 1;
		this.db
			.prepare(
				`INSERT INTO voice_headphone_inbox
				 (item_id, revision, project_name, founder_user_id, channel_id,
				  source_message_id, source_revision, author_id, needs_decision,
				  text, speech_brief_json, source_created_at, source_resolved, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				itemId,
				revision,
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
				new Date().toISOString(),
			);
		return itemFromRow(
			this.db
				.prepare(
					"SELECT * FROM voice_headphone_inbox WHERE item_id = ? AND revision = ?",
				)
				.get(itemId, revision) as Record<string, unknown>,
		);
	}

	list(input: {
		projectName: string;
		founderUserId: string;
		limit: number;
	}): HeadphoneInboxItemRecord[] {
		if (
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 100
		)
			throw new Error("headphone_inbox_limit_invalid");
		return (
			this.db
				.prepare(
					`SELECT i.* FROM voice_headphone_inbox i
					 WHERE i.project_name = ? AND i.founder_user_id = ?
					   AND i.source_resolved = 0
					   AND i.revision = (SELECT MAX(i2.revision) FROM voice_headphone_inbox i2 WHERE i2.item_id = i.item_id)
					   AND NOT EXISTS (
					     SELECT 1 FROM voice_headphone_ack a
					     WHERE a.item_id = i.item_id AND a.revision = i.revision
					   )
					 ORDER BY i.needs_decision DESC, i.source_created_at, i.item_id LIMIT ?`,
				)
				.all(input.projectName, input.founderUserId, input.limit) as Record<
				string,
				unknown
			>[]
		).map(itemFromRow);
	}

	claim(input: {
		itemId: string;
		revision: number;
		sessionId: string;
		generation: number;
		leaseToken: string;
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
					"SELECT * FROM voice_headphone_inbox WHERE item_id = ? AND revision = ?",
				)
				.get(input.itemId, input.revision) as
				| Record<string, unknown>
				| undefined;
			if (!row || row.project_name !== session.project_name) return undefined;
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
					"DELETE FROM voice_headphone_claim WHERE item_id = ? AND revision = ? AND lease_expires_at <= ?",
				)
				.run(input.itemId, input.revision, input.now);
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
						}
					: undefined;
			}
			const claimToken = randomBytes(32).toString("hex");
			const leaseExpiresAt = new Date(
				Date.parse(input.now) + (input.claimTtlMs ?? 60_000),
			).toISOString();
			this.db
				.prepare(
					`INSERT INTO voice_headphone_claim
					 (item_id, revision, session_id, generation, claim_token, lease_expires_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.itemId,
					input.revision,
					input.sessionId,
					input.generation,
					claimToken,
					leaseExpiresAt,
				);
			return { item, claimToken, leaseExpiresAt };
		})();
	}

	ack(input: {
		itemId: string;
		revision: number;
		sessionId: string;
		generation: number;
		claimToken: string;
		requestDigests: readonly string[];
		ackedAt: string;
	}): boolean {
		if (
			input.requestDigests.length < 1 ||
			input.requestDigests.some((digest) => !/^[a-f0-9]{64}$/.test(digest)) ||
			!Number.isFinite(Date.parse(input.ackedAt))
		)
			throw new Error("headphone_inbox_ack_invalid");
		return this.db.transaction(() => {
			const claim = this.db
				.prepare(
					`SELECT 1 FROM voice_headphone_claim
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
				);
			if (!claim) return false;
			this.db
				.prepare(
					`INSERT OR IGNORE INTO voice_headphone_ack
					 (item_id, revision, session_id, generation, request_digests_json, acked_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.itemId,
					input.revision,
					input.sessionId,
					input.generation,
					JSON.stringify(input.requestDigests),
					input.ackedAt,
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
	}): void {
		this.db
			.prepare(
				`INSERT INTO voice_headphone_source
				 (project_name, founder_user_id, channel_id, cursor, high_watermark,
				  bootstrap_complete, health, health_reason, next_allowed_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(project_name, founder_user_id, channel_id) DO UPDATE SET
				 cursor=excluded.cursor, high_watermark=excluded.high_watermark,
				 bootstrap_complete=excluded.bootstrap_complete, health=excluded.health,
				 health_reason=excluded.health_reason, next_allowed_at=excluded.next_allowed_at,
				 updated_at=excluded.updated_at`,
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
				 bootstrap_complete, health, health_reason, next_allowed_at, updated_at
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
	}): void {
		this.db.transaction(() => {
			for (const item of input.items) this.upsert(item);
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
				 bootstrap_complete, health, health_reason, next_allowed_at, updated_at
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
		};
	}
}
