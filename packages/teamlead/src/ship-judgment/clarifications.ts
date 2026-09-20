import type Database from "better-sqlite3";
import { z } from "zod";
import { canonicalDigest } from "./contract.js";
import { discordId, discordMessage } from "./discord-message.js";
import { ShipJudgmentLearning } from "./learning.js";

const referenceSchema = z.object({
	threadId: discordId,
	messageId: discordId,
	replyToMessageId: discordId.optional(),
});
const replySchema = discordMessage.extend({
	message_reference: z.object({
		message_id: discordId,
		channel_id: discordId.optional(),
	}),
});
export interface ReplySource {
	canonicalFounderId(): string | undefined;
	/** Server-owned authenticated fetch. Callers supply a reference, never authorship or reply text. */
	fetchMessage(
		reference: z.infer<typeof referenceSchema>,
		signal: AbortSignal,
	): Promise<unknown>;
}
type ObserveResult =
	| { status: "recorded" | "existing"; clarificationId: string }
	| { status: "ignored" | "unavailable" };

type EnsureResult =
	| { status: "created" | "existing"; clarificationId: string }
	| { status: "inactive" | "ineligible" };

/** Learning questions only. Creating an intent never creates or changes approval authority. */
export class ShipJudgmentClarifications {
	constructor(
		private readonly db: Database.Database,
		private readonly readMode: () => string,
		private readonly source?: ReplySource,
	) {}
	replyThreads(after?: string): { threadId: string; questionId: string }[] {
		if (this.readMode() === "off") return [];
		if (after !== undefined) discordId.parse(after);
		const query =
			this.db.prepare(`SELECT d.thread_id AS threadId,MIN(d.question_id) AS questionId FROM ship_judgment_delivery d
 JOIN ship_judgment_clarification c ON c.clarification_id=d.subject_id AND c.supersedes IS NULL
 JOIN ship_judgment_opinion o ON o.opinion_id=c.opinion_id JOIN ship_judgment_input i ON i.input_id=o.input_id
 WHERE d.purpose='clarification' AND d.state='delivered' AND d.posted_id=c.clarification_id
 AND d.question_id=i.question_id AND d.thread_id=i.thread_id AND d.card_message_id=i.card_message_id
 AND (length(d.thread_id)>length(?) OR (length(d.thread_id)=length(?) AND d.thread_id>?))
 GROUP BY d.thread_id ORDER BY length(d.thread_id),d.thread_id LIMIT 25`);
		const cursor = after ?? "0";
		const rows = query.all(cursor, cursor, cursor) as {
			threadId: string;
			questionId: string;
		}[];
		return rows.length || !after
			? rows
			: (query.all("0", "0", "0") as {
					threadId: string;
					questionId: string;
				}[]);
	}
	replyTarget(
		threadId: string,
		messageId: string,
	): { questionId: string } | undefined {
		if (this.readMode() === "off") return undefined;
		if (
			!discordId.safeParse(threadId).success ||
			!discordId.safeParse(messageId).success
		)
			return undefined;
		const rows = this.db
			.prepare(`SELECT d.question_id AS questionId FROM ship_judgment_delivery d
 JOIN ship_judgment_clarification c ON c.clarification_id=d.subject_id AND c.supersedes IS NULL
 WHERE d.purpose='clarification' AND d.state='delivered' AND d.posted_id=c.clarification_id
 AND d.thread_id=? AND d.message_id=? LIMIT 2`)
			.all(threadId, messageId) as { questionId: string }[];
		return rows.length === 1 ? rows[0] : undefined;
	}

	/** Append-only outcomes retain their local row order; commit questions and cursor together. */
	sweep(): number {
		const deadline = performance.now() + 25;
		return this.db
			.transaction(() => {
				if (!["dry_run", "auto"].includes(this.readMode())) return 0;
				this.db
					.prepare(
						"INSERT OR IGNORE INTO ship_judgment_project_state(project_name) VALUES ('flywheel')",
					)
					.run();
				const cursor = this.db
					.prepare(
						"SELECT learning_cursor FROM ship_judgment_project_state WHERE project_name='flywheel'",
					)
					.get() as { learning_cursor: number };
				const rows = this.db
					.prepare(
						"SELECT rowid AS ordinal,outcome_id FROM ship_judgment_outcome WHERE rowid>? ORDER BY rowid LIMIT 16",
					)
					.all(cursor.learning_cursor) as {
					ordinal: number;
					outcome_id: string;
				}[];
				let inspected = 0;
				for (const row of rows) {
					if (
						performance.now() >= deadline ||
						!["dry_run", "auto"].includes(this.readMode())
					)
						break;
					this.ensure(row.outcome_id);
					inspected++;
				}
				if (inspected)
					this.db
						.prepare(
							"UPDATE ship_judgment_project_state SET learning_cursor=? WHERE project_name='flywheel'",
						)
						.run(rows[inspected - 1]!.ordinal);
				return inspected;
			})
			.immediate();
	}

	ensure(outcomeId: string): EnsureResult {
		return this.db.transaction((): EnsureResult => {
			if (!["dry_run", "auto"].includes(this.readMode()))
				return { status: "inactive" };
			const pair = new ShipJudgmentLearning(this.db).pair(outcomeId);
			if (pair.status !== "paired" || pair.relation !== "divergent")
				return { status: "ineligible" };
			const clarificationId = canonicalDigest([
				"question",
				pair.opinionId,
				outcomeId,
			]);
			if (
				this.db
					.prepare(
						"SELECT 1 FROM ship_judgment_clarification WHERE clarification_id=?",
					)
					.get(clarificationId)
			)
				return { status: "existing", clarificationId };
			// Use immutable input identity: later heads and the current gate cannot retarget an old question.
			const original = this.db
				.prepare(`SELECT i.question_id,i.thread_id,i.card_message_id
 FROM ship_judgment_opinion o JOIN ship_judgment_input i ON i.input_id=o.input_id WHERE o.opinion_id=?`)
				.get(pair.opinionId) as {
				question_id: string;
				thread_id: string;
				card_message_id: string;
			};
			this.db
				.prepare(`INSERT INTO ship_judgment_clarification
 (clarification_id,opinion_id,outcome_id,resolution) VALUES (?,?,?,'pending')`)
				.run(clarificationId, pair.opinionId, outcomeId);
			this.db
				.prepare(`INSERT INTO ship_judgment_delivery
 (purpose,subject_id,question_id,thread_id,card_message_id,desired_id,state,marker)
 VALUES ('clarification',?,?,?,?,?,'pending',?)`)
				.run(
					clarificationId,
					original.question_id,
					original.thread_id,
					original.card_message_id,
					clarificationId,
					`ship-judgment:clarification:${clarificationId}`,
				);
			return { status: "created", clarificationId };
		})();
	}

	async observe(
		value: unknown,
		now: number,
		signal: AbortSignal,
	): Promise<ObserveResult> {
		if (this.readMode() === "off") return { status: "ignored" };
		const reference = referenceSchema.safeParse(value);
		const founder = this.source?.canonicalFounderId();
		if (
			!reference.success ||
			!discordId.safeParse(founder).success ||
			!this.source
		)
			return { status: "ignored" };
		const verifiedAt = new Date(now).toISOString();
		const controller = new AbortController();
		let rejectAbort: (reason: Error) => void = () => {};
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		const abort = () => {
			controller.abort();
			rejectAbort(new Error("clarification_fetch_aborted"));
		};
		signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(abort, 10_000);
		let raw: unknown;
		try {
			if (signal.aborted) abort();
			raw = await Promise.race([
				Promise.resolve().then(() => {
					controller.signal.throwIfAborted();
					return this.source!.fetchMessage(reference.data, controller.signal);
				}),
				aborted,
			]);
		} catch {
			return { status: "unavailable" };
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		}
		if (this.readMode() === "off") return { status: "ignored" };
		const parsed = replySchema.safeParse(raw);
		if (
			!parsed.success ||
			signal.aborted ||
			founder !== this.source.canonicalFounderId()
		)
			return { status: "ignored" };
		const message = parsed.data,
			sent = Date.parse(message.timestamp),
			edited = Date.parse(message.edited_timestamp ?? message.timestamp);
		if (
			message.author.id !== founder ||
			message.author.bot ||
			message.id !== reference.data.messageId ||
			message.channel_id !== reference.data.threadId ||
			(reference.data.replyToMessageId !== undefined &&
				message.message_reference.message_id !==
					reference.data.replyToMessageId) ||
			(message.message_reference.channel_id &&
				message.message_reference.channel_id !== reference.data.threadId) ||
			sent > now ||
			edited < sent ||
			edited > now ||
			!message.content.trim()
		)
			return { status: "ignored" };
		return this.db.transaction((): ObserveResult => {
			const root = this.db
				.prepare(`SELECT c.clarification_id,c.opinion_id,c.outcome_id,d.question_id,d.thread_id,d.card_message_id,d.visible_at
 FROM ship_judgment_clarification c JOIN ship_judgment_delivery d ON d.purpose='clarification' AND d.subject_id=c.clarification_id
 WHERE c.supersedes IS NULL AND d.state='delivered' AND d.posted_id=c.clarification_id AND d.thread_id=? AND d.message_id=? LIMIT 1`)
				.get(reference.data.threadId, message.message_reference.message_id) as
				| {
						clarification_id: string;
						opinion_id: string;
						outcome_id: string;
						question_id: string;
						thread_id: string;
						card_message_id: string;
						visible_at: string;
				  }
				| undefined;
			if (
				!root ||
				!Number.isFinite(Date.parse(root.visible_at)) ||
				Date.parse(root.visible_at) > sent
			)
				return { status: "ignored" };
			const sourceId = `discord:${message.channel_id}:${message.id}`;
			const digest = canonicalDigest([
				message.content,
				new Date(sent).toISOString(),
				new Date(edited).toISOString(),
			]);
			const clarificationId = canonicalDigest([
				"reply",
				root.clarification_id,
				sourceId,
				digest,
			]);
			if (
				this.db
					.prepare(
						"SELECT 1 FROM ship_judgment_clarification WHERE clarification_id=?",
					)
					.get(clarificationId)
			)
				return { status: "existing", clarificationId };
			this.db
				.prepare(`INSERT INTO ship_judgment_clarification
 (clarification_id,opinion_id,outcome_id,reply_source_id,reply_text,reply_digest,founder_id,verified_at,resolution,supersedes)
 VALUES (?,?,?,?,?,?,?,?,'explained',?)`)
				.run(
					clarificationId,
					root.opinion_id,
					root.outcome_id,
					sourceId,
					message.content,
					digest,
					founder,
					verifiedAt,
					root.clarification_id,
				);
			this.db
				.prepare(`INSERT INTO ship_judgment_delivery
 (purpose,subject_id,question_id,thread_id,card_message_id,desired_id,state,marker)
 VALUES ('ack',?,?,?,?,?,'pending',?)`)
				.run(
					clarificationId,
					root.question_id,
					root.thread_id,
					root.card_message_id,
					clarificationId,
					`ship-judgment:ack:${clarificationId}`,
				);
			return { status: "recorded", clarificationId };
		})();
	}
}
