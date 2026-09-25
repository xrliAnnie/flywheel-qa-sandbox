import type { Database } from "better-sqlite3";
import {
	AGENDA_LEAD_URGENT_REASONS,
	type AgendaClass,
	type AgendaDispositionRecord,
	type AgendaItem,
	type AgendaLeadUrgentReason,
	type AgendaState,
} from "flywheel-voice-core";

/** FLY-2863 plan §2.2: lead_said messages older than this go unspoken. */
export const DEFAULT_LEAD_SAID_LOOKBACK_MS = 86_400_000;

export interface LeadSaidCandidate {
	itemId: string;
	revision: number;
	projectName: string;
	channelId: string;
	sourceMessageId: string;
	authorId: string;
	text: string;
	sourceCreatedAt: string;
	sourceResolved: boolean;
}

export interface AgendaEpisode {
	issueId: string;
	agendaClass: AgendaClass;
	since: string;
}

function parseState(value: unknown): AgendaState | undefined {
	if (typeof value !== "string") return undefined;
	try {
		return JSON.parse(value) as AgendaState;
	} catch {
		return undefined;
	}
}

/**
 * Durable agenda facts owned by the Bridge. The queue state is one CAS row per
 * session; items, turn bindings and dispositions are server-authored so a
 * voice client can reference them only by key.
 */
export class VoiceAgendaStore {
	constructor(private readonly db: Database) {}

	migrate(now = new Date().toISOString()): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS voice_agenda_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS voice_agenda_state (
				session_id TEXT PRIMARY KEY,
				generation INTEGER NOT NULL CHECK(generation > 0),
				state_version INTEGER NOT NULL CHECK(state_version > 0),
				state_json TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS voice_agenda_items (
				session_id TEXT NOT NULL,
				item_key TEXT NOT NULL,
				item_json TEXT NOT NULL,
				first_seen_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				PRIMARY KEY(session_id, item_key)
			);
			CREATE TABLE IF NOT EXISTS voice_agenda_turns (
				session_id TEXT NOT NULL,
				generation INTEGER NOT NULL CHECK(generation > 0),
				utterance_id TEXT NOT NULL,
				turn_id TEXT NOT NULL,
				item_key TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY(session_id, generation, utterance_id)
			);
			CREATE TABLE IF NOT EXISTS voice_agenda_dispositions (
				session_id TEXT NOT NULL,
				item_key TEXT NOT NULL,
				request_id TEXT NOT NULL,
				disposition TEXT NOT NULL CHECK(disposition IN ('resolved','decision_recorded','deferred')),
				evidence TEXT,
				reason TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY(session_id, item_key, request_id),
				CHECK(disposition <> 'resolved' OR (evidence IS NOT NULL AND length(evidence) > 0))
			);
			CREATE TABLE IF NOT EXISTS voice_agenda_episodes (
				issue_id TEXT NOT NULL,
				agenda_class TEXT NOT NULL CHECK(agenda_class IN ('blocked','awaiting_approval','needs_answer')),
				since TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				ended_at TEXT
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_agenda_open_episode
				ON voice_agenda_episodes(issue_id, agenda_class) WHERE ended_at IS NULL;
			CREATE TABLE IF NOT EXISTS voice_agenda_urgent (
				project_name TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				author_id TEXT NOT NULL,
				reason TEXT NOT NULL CHECK(reason IN ('production_down','data_loss_risk','security','deadline_within_1h','founder_requested')),
				created_at TEXT NOT NULL,
				PRIMARY KEY(channel_id, message_id)
			);
		`);
		// Review R2: an earlier revision stored a body-claimed `lead_id` for U1.
		// Those rows were never authenticated, so they are dropped, not
		// backfilled as authors.
		const urgentColumns = new Set(
			(
				this.db
					.prepare("PRAGMA table_info(voice_agenda_urgent)")
					.all() as Array<{
					name: string;
				}>
			).map((column) => column.name),
		);
		if (!urgentColumns.has("author_id")) {
			this.db.transaction(() => {
				this.db.exec(`
					DROP TABLE voice_agenda_urgent;
					CREATE TABLE voice_agenda_urgent (
						project_name TEXT NOT NULL,
						channel_id TEXT NOT NULL,
						message_id TEXT NOT NULL,
						author_id TEXT NOT NULL,
						reason TEXT NOT NULL CHECK(reason IN ('production_down','data_loss_risk','security','deadline_within_1h','founder_requested')),
						created_at TEXT NOT NULL,
						PRIMARY KEY(channel_id, message_id)
					);
				`);
			})();
		}
		// Plan §2.2: history before the agenda shipped is never spoken.
		this.db
			.prepare(
				"INSERT OR IGNORE INTO voice_agenda_meta(key, value) VALUES ('leadSaidBaselineAt', ?)",
			)
			.run(now);
	}

	leadSaidBaselineAt(): string {
		const row = this.db
			.prepare(
				"SELECT value FROM voice_agenda_meta WHERE key = 'leadSaidBaselineAt'",
			)
			.get() as { value?: string } | undefined;
		if (!row?.value) throw new Error("voice_agenda_baseline_missing");
		return row.value;
	}

	getState(sessionId: string): AgendaState | undefined {
		const row = this.db
			.prepare("SELECT state_json FROM voice_agenda_state WHERE session_id = ?")
			.get(sessionId) as { state_json?: string } | undefined;
		return parseState(row?.state_json);
	}

	/** CAS on stateVersion: 0 creates, otherwise the stored version must match. */
	saveState(input: {
		state: AgendaState;
		expectedVersion: number;
		dispositions: readonly AgendaDispositionRecord[];
		now: string;
	}): { ok: true } | { ok: false; current?: AgendaState } {
		return this.db.transaction(() => {
			const current = this.getState(input.state.sessionId);
			if ((current?.stateVersion ?? 0) !== input.expectedVersion)
				return { ok: false as const, ...(current ? { current } : {}) };
			if (input.state.stateVersion !== input.expectedVersion + 1)
				throw new Error("voice_agenda_state_version_invalid");
			this.db
				.prepare(
					`INSERT INTO voice_agenda_state(session_id, generation, state_version, state_json, updated_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(session_id) DO UPDATE SET
					   generation = excluded.generation,
					   state_version = excluded.state_version,
					   state_json = excluded.state_json,
					   updated_at = excluded.updated_at`,
				)
				.run(
					input.state.sessionId,
					input.state.generation,
					input.state.stateVersion,
					JSON.stringify(input.state),
					input.now,
				);
			// ON CONFLICT (not OR IGNORE): a CHECK violation must fail loudly.
			const insert = this.db.prepare(
				`INSERT INTO voice_agenda_dispositions
				 (session_id, item_key, request_id, disposition, evidence, reason, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id, item_key, request_id) DO NOTHING`,
			);
			for (const record of input.dispositions)
				insert.run(
					input.state.sessionId,
					record.itemKey,
					record.requestId,
					record.disposition,
					record.evidence,
					record.reason,
					record.createdAt,
				);
			return { ok: true as const };
		})();
	}

	/** Items are recorded exactly as the Bridge served them. */
	recordServedItems(
		sessionId: string,
		items: readonly AgendaItem[],
		now: string,
	): void {
		const upsert = this.db.prepare(
			`INSERT INTO voice_agenda_items(session_id, item_key, item_json, first_seen_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(session_id, item_key) DO UPDATE SET
			   item_json = excluded.item_json, last_seen_at = excluded.last_seen_at`,
		);
		this.db.transaction(() => {
			for (const item of items)
				upsert.run(sessionId, item.itemKey, JSON.stringify(item), now, now);
		})();
	}

	getServedItem(sessionId: string, itemKey: string): AgendaItem | undefined {
		const row = this.db
			.prepare(
				"SELECT item_json FROM voice_agenda_items WHERE session_id = ? AND item_key = ?",
			)
			.get(sessionId, itemKey) as { item_json?: string } | undefined;
		return row?.item_json
			? (JSON.parse(row.item_json) as AgendaItem)
			: undefined;
	}

	/** R-T2 step 1: one binding per (session, generation, utterance). */
	bindTurn(input: {
		sessionId: string;
		generation: number;
		utteranceId: string;
		turnId: string;
		itemKey: string;
		now: string;
	}): "bound" | "same" | "conflict" {
		return this.db.transaction(() => {
			const prior = this.getTurn(
				input.sessionId,
				input.generation,
				input.utteranceId,
			);
			if (prior)
				return prior.itemKey === input.itemKey && prior.turnId === input.turnId
					? ("same" as const)
					: ("conflict" as const);
			this.db
				.prepare(
					`INSERT INTO voice_agenda_turns(session_id, generation, utterance_id, turn_id, item_key, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.sessionId,
					input.generation,
					input.utteranceId,
					input.turnId,
					input.itemKey,
					input.now,
				);
			return "bound" as const;
		})();
	}

	getTurn(
		sessionId: string,
		generation: number,
		utteranceId: string,
	): { turnId: string; itemKey: string } | undefined {
		const row = this.db
			.prepare(
				"SELECT turn_id, item_key FROM voice_agenda_turns WHERE session_id = ? AND generation = ? AND utterance_id = ?",
			)
			.get(sessionId, generation, utteranceId) as
			| { turn_id: string; item_key: string }
			| undefined;
		return row ? { turnId: row.turn_id, itemKey: row.item_key } : undefined;
	}

	/** lead_said keys the founder already had resolved (in any session). */
	resolvedItemKeys(itemKeys: readonly string[]): Set<string> {
		if (itemKeys.length === 0) return new Set();
		const resolved = new Set<string>();
		const select = this.db.prepare(
			"SELECT 1 FROM voice_agenda_dispositions WHERE item_key = ? AND disposition = 'resolved' LIMIT 1",
		);
		for (const key of itemKeys) if (select.get(key)) resolved.add(key);
		return resolved;
	}

	/** R1-10: a class episode keeps its identity across restarts and ordinary
	 * updates; a real exit ends it so re-entry is a new item. */
	observeEpisodes(input: {
		present: ReadonlyArray<{ issueId: string; agendaClass: AgendaClass }>;
		/** Issues whose facts were read completely; only they may end episodes. */
		completeIssueIds: ReadonlySet<string>;
		now: string;
	}): AgendaEpisode[] {
		return this.db.transaction(() => {
			const open = this.db
				.prepare(
					"SELECT issue_id, agenda_class, since FROM voice_agenda_episodes WHERE ended_at IS NULL",
				)
				.all() as Array<{
				issue_id: string;
				agenda_class: string;
				since: string;
			}>;
			const presentKeys = new Set(
				input.present.map((entry) => `${entry.issueId}\0${entry.agendaClass}`),
			);
			const end = this.db.prepare(
				"UPDATE voice_agenda_episodes SET ended_at = ? WHERE issue_id = ? AND agenda_class = ? AND ended_at IS NULL",
			);
			for (const row of open)
				if (
					!presentKeys.has(`${row.issue_id}\0${row.agenda_class}`) &&
					input.completeIssueIds.has(row.issue_id)
				)
					end.run(input.now, row.issue_id, row.agenda_class);
			const find = this.db.prepare(
				"SELECT since FROM voice_agenda_episodes WHERE issue_id = ? AND agenda_class = ? AND ended_at IS NULL",
			);
			const touch = this.db.prepare(
				"UPDATE voice_agenda_episodes SET last_seen_at = ? WHERE issue_id = ? AND agenda_class = ? AND ended_at IS NULL",
			);
			const insert = this.db.prepare(
				"INSERT INTO voice_agenda_episodes(issue_id, agenda_class, since, last_seen_at) VALUES (?, ?, ?, ?)",
			);
			return input.present.map((entry) => {
				const row = find.get(entry.issueId, entry.agendaClass) as
					| { since: string }
					| undefined;
				if (row) {
					touch.run(input.now, entry.issueId, entry.agendaClass);
					return { ...entry, since: row.since };
				}
				insert.run(entry.issueId, entry.agendaClass, input.now, input.now);
				return { ...entry, since: input.now };
			});
		})();
	}

	/** U1: recorded by the collector from the message itself (its author is
	 * the Discord-authenticated identity), keyed by the sent message id. */
	recordUrgent(input: {
		projectName: string;
		channelId: string;
		messageId: string;
		authorId: string;
		reason: AgendaLeadUrgentReason;
		now: string;
	}): void {
		if (!AGENDA_LEAD_URGENT_REASONS.includes(input.reason))
			throw new Error("voice_agenda_urgent_reason_invalid");
		this.db
			.prepare(
				`INSERT INTO voice_agenda_urgent(project_name, channel_id, message_id, author_id, reason, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(channel_id, message_id) DO NOTHING`,
			)
			.run(
				input.projectName,
				input.channelId,
				input.messageId,
				input.authorId,
				input.reason,
				input.now,
			);
	}

	getUrgent(
		channelId: string,
		messageId: string,
	): { authorId: string; reason: AgendaLeadUrgentReason } | undefined {
		const row = this.db
			.prepare(
				"SELECT author_id, reason FROM voice_agenda_urgent WHERE channel_id = ? AND message_id = ?",
			)
			.get(channelId, messageId) as
			| { author_id: string; reason: AgendaLeadUrgentReason }
			| undefined;
		return row ? { authorId: row.author_id, reason: row.reason } : undefined;
	}

	/** Latest revision of each lead-authored inbox message in the channels. */
	listLeadSaidCandidates(input: {
		founderUserId: string;
		channelIds: readonly string[];
		createdAfter: string;
	}): LeadSaidCandidate[] {
		if (input.channelIds.length === 0) return [];
		const placeholders = input.channelIds.map(() => "?").join(",");
		const rows = this.db
			.prepare(
				`SELECT i.* FROM voice_headphone_inbox i
				 WHERE i.founder_user_id = ?
				   AND i.channel_id IN (${placeholders})
				   AND i.origin_class = 'lead_authored'
				   AND i.source_created_at > ?
				   AND i.revision = (
				     SELECT MAX(r.revision) FROM voice_headphone_inbox r WHERE r.item_id = i.item_id
				   )
				 ORDER BY i.source_created_at, i.item_id`,
			)
			.all(
				input.founderUserId,
				...input.channelIds,
				input.createdAfter,
			) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			itemId: String(row.item_id),
			revision: Number(row.revision),
			projectName: String(row.project_name),
			channelId: String(row.channel_id),
			sourceMessageId: String(row.source_message_id),
			authorId: String(row.author_id),
			text: String(row.text),
			sourceCreatedAt: String(row.source_created_at),
			sourceResolved: Number(row.source_resolved) === 1,
		}));
	}

	/** Candidate issues: every live main thread (the title exists only there). */
	listLiveIssueThreads(): Array<{
		threadId: string;
		channelId: string;
		issueId: string;
		leadId: string | null;
	}> {
		return (
			this.db
				.prepare(
					`SELECT thread_id, channel_id, issue_id, lead_id FROM chat_threads
					 WHERE issue_id IS NOT NULL AND archived_at IS NULL AND discord_missing_at IS NULL
					 ORDER BY issue_id`,
				)
				.all() as Array<{
				thread_id: string;
				channel_id: string;
				issue_id: string;
				lead_id: string | null;
			}>
		).map((row) => ({
			threadId: row.thread_id,
			channelId: row.channel_id,
			issueId: row.issue_id,
			leadId: row.lead_id,
		}));
	}
}
