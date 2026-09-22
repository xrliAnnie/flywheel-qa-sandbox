import type Database from "better-sqlite3";
import { z } from "zod";
import { JUDGMENT_VISIBLE_EVENT } from "./contract.js";
import { discordId } from "./discord-message.js";
import { renderLearningMessage } from "./learning-render.js";

const purposeSchema = z.enum(["clarification", "ack"]);
type Purpose = z.infer<typeof purposeSchema>;
const id = z.string().min(1).max(200);
function iso(now: number): string {
	z.number().int().nonnegative().safe().parse(now);
	return new Date(now).toISOString();
}
interface Row {
	subject_id: string;
	question_id: string;
	thread_id: string;
	card_message_id: string;
	desired_id: string;
	marker: string;
	state: string;
	generation: number;
	lease_owner: string | null;
	expires_at: string | null;
	retry_after: string | null;
	post_reserved_times: string;
	attempt: number;
	first_zero_scan_at: string | null;
	scan_frontier: string | null;
}
export interface LearningClaim {
	status: "claimed";
	purpose: Purpose;
	subjectId: string;
	owner: string;
	generation: number;
	action: "post" | "scan";
	questionId: string;
	threadId: string;
	cardMessageId: string;
	desiredId: string;
	marker: string;
}
/** Immutable question/receipt messages: never PATCH, adopt opinion messages, or touch approval authority. */
export class LearningDelivery {
	constructor(
		private readonly db: Database.Database,
		private readonly mode: () => string,
	) {}
	defer(purpose: Purpose, subjectId: string, code: string, now: number): void {
		purposeSchema.parse(purpose);
		id.parse(subjectId);
		id.parse(code);
		const at = iso(now);
		this.db
			.prepare(`UPDATE ship_judgment_delivery SET last_error=?,retry_after=? WHERE purpose=? AND subject_id=?
 AND state IN ('pending','posting','uncertain') AND (expires_at IS NULL OR expires_at<=?) AND (retry_after IS NULL OR retry_after<=?)`)
			.run(code, iso(now + 3_600_000), purpose, subjectId, at, at);
	}
	view(
		purpose: Purpose,
		subjectId: string,
		guildId: string,
	): { content: string; replyTo: string; since: string } | undefined {
		purposeSchema.parse(purpose);
		id.parse(subjectId);
		discordId.parse(guildId);
		return this.db.transaction(() => {
			const row = this.db
				.prepare(`SELECT c.supersedes,c.reply_source_id,c.verified_at,o.opinion_id,o.overall,u.decision,u.decided_at,u.evidence_json,
 i.run_id,i.question_id,i.thread_id,i.card_message_id FROM ship_judgment_clarification c
 JOIN ship_judgment_opinion o ON o.opinion_id=c.opinion_id JOIN ship_judgment_outcome u ON u.outcome_id=c.outcome_id
 JOIN ship_judgment_input i ON i.input_id=o.input_id
 JOIN ship_judgment_delivery d ON d.purpose=? AND d.subject_id=c.clarification_id AND d.desired_id=c.clarification_id
 AND d.question_id=i.question_id AND d.thread_id=i.thread_id AND d.card_message_id=i.card_message_id
 WHERE c.clarification_id=?`)
				.get(purpose, subjectId) as
				| {
						supersedes: string | null;
						reply_source_id: string | null;
						verified_at: string | null;
						opinion_id: string;
						overall: string;
						decision: string;
						decided_at: string;
						evidence_json: string;
						run_id: string;
						question_id: string;
						thread_id: string;
						card_message_id: string;
				  }
				| undefined;
			if (!row) return undefined;
			try {
				const base = {
					purpose,
					subjectId,
					guildId,
					threadId: row.thread_id,
					cardMessageId: row.card_message_id,
				};
				if (purpose === "ack") {
					const source = /^discord:([0-9]{17,20}):([0-9]{17,20})$/.exec(
						row.reply_source_id ?? "",
					);
					if (!row.supersedes || !source || source[1] !== row.thread_id)
						return undefined;
					const since = z.string().datetime().parse(row.verified_at);
					return {
						...renderLearningMessage({ ...base, replyMessageId: source[2] }),
						since,
					};
				}
				if (row.supersedes) return undefined;
				const visible = this.db
					.prepare(`SELECT json_extract(payload,'$.message_id') AS message_id FROM workflow_run_event
 WHERE run_id=? AND kind=? AND json_valid(payload)
 AND json_extract(payload,'$.opinion_id')=? AND json_extract(payload,'$.question_id')=?
 AND json_extract(payload,'$.receipt_time')<? ORDER BY json_extract(payload,'$.receipt_time') DESC LIMIT 1`)
					.get(
						row.run_id,
						JUDGMENT_VISIBLE_EVENT,
						row.opinion_id,
						row.question_id,
						row.decided_at,
					) as { message_id: string } | undefined;
				if (!visible) return undefined;
				const evidence = JSON.parse(row.evidence_json).source_evidence;
				const decisionMessageId =
					evidence?.kind === "founder_message" &&
					evidence.channel_id === row.thread_id &&
					discordId.safeParse(evidence.message_id).success
						? evidence.message_id
						: undefined;
				return {
					...renderLearningMessage({
						...base,
						opinionMessageId: visible.message_id,
						decisionMessageId,
						overall: row.overall,
						decision: row.decision,
					}),
					since: z.string().datetime().parse(row.decided_at),
				};
			} catch {
				return undefined;
			}
		})();
	}
	work(now: number): {
		purpose: Purpose;
		subjectId: string;
		questionId: string;
		threadId: string;
	}[] {
		if (this.mode() === "off") return [];
		const at = iso(now);
		return this.db
			.prepare(`SELECT purpose,subject_id AS subjectId,question_id AS questionId,thread_id AS threadId
 FROM ship_judgment_delivery WHERE purpose IN ('clarification','ack') AND state IN ('pending','posting','uncertain')
 AND (expires_at IS NULL OR expires_at<=?) AND (retry_after IS NULL OR retry_after<=?)
 AND (purpose='ack' OR state IN ('posting','uncertain') OR ?='dry_run')
 ORDER BY COALESCE(retry_after,?),purpose,subject_id LIMIT 20`)
			.all(at, at, this.mode(), at) as {
			purpose: Purpose;
			subjectId: string;
			questionId: string;
			threadId: string;
		}[];
	}
	claim(
		purpose: Purpose,
		subjectId: string,
		owner: string,
		now: number,
	):
		| LearningClaim
		| { status: "missing" | "inactive" | "settled" | "busy" | "rate_limited" } {
		if (this.mode() === "off") return { status: "inactive" };
		purposeSchema.parse(purpose);
		id.parse(subjectId);
		id.parse(owner);
		const at = iso(now);
		return this.db
			.transaction(() => {
				const row = this.db
					.prepare(
						"SELECT * FROM ship_judgment_delivery WHERE purpose=? AND subject_id=?",
					)
					.get(purpose, subjectId) as Row | undefined;
				if (!row?.desired_id) return { status: "missing" } as const;
				if (row.state === "gone" || row.state === "unavailable")
					return { status: "inactive" } as const;
				if (row.state === "delivered") return { status: "settled" } as const;
				if (
					(row.expires_at && row.expires_at > at) ||
					(row.retry_after && row.retry_after > at)
				)
					return { status: "busy" } as const;
				const action =
					row.state === "posting" || row.state === "uncertain"
						? "scan"
						: "post";
				if (
					purpose === "clarification" &&
					action === "post" &&
					!["dry_run", "auto"].includes(this.mode())
				)
					return { status: "inactive" } as const;
				const posts = (JSON.parse(row.post_reserved_times) as number[]).filter(
					(time) => time > now - 3_600_000,
				);
				if (action === "post" && posts.length >= 2) {
					this.db
						.prepare(
							"UPDATE ship_judgment_delivery SET retry_after=? WHERE purpose=? AND subject_id=?",
						)
						.run(iso(Math.min(...posts) + 3_600_000), purpose, subjectId);
					return { status: "rate_limited" } as const;
				}
				if (action === "post") posts.push(now);
				const generation = row.generation + 1;
				this.db
					.prepare(
						`UPDATE ship_judgment_delivery SET state=?,generation=?,lease_owner=?,expires_at=?,retry_after=NULL,attempt=attempt+1,post_reserved_times=? WHERE purpose=? AND subject_id=?`,
					)
					.run(
						action === "post" ? "posting" : "uncertain",
						generation,
						owner,
						iso(now + 30_000),
						JSON.stringify(posts),
						purpose,
						subjectId,
					);
				return {
					status: "claimed",
					purpose,
					subjectId,
					owner,
					generation,
					action,
					questionId: row.question_id,
					threadId: row.thread_id,
					cardMessageId: row.card_message_id,
					desiredId: row.desired_id,
					marker: row.marker,
				} as LearningClaim;
			})
			.immediate();
	}
	private current(claim: LearningClaim, now: number): Row | undefined {
		return this.db
			.prepare(
				`SELECT * FROM ship_judgment_delivery WHERE purpose=? AND subject_id=? AND generation=? AND lease_owner=? AND desired_id=? AND expires_at>? AND state IN ('posting','uncertain')`,
			)
			.get(
				claim.purpose,
				claim.subjectId,
				claim.generation,
				claim.owner,
				claim.desiredId,
				iso(now),
			) as Row | undefined;
	}
	unavailable(claim: LearningClaim, code: string, now: number): boolean {
		id.parse(code);
		return this.db
			.transaction(() => {
				if (!this.current(claim, now)) return false;
				this.db
					.prepare(`UPDATE ship_judgment_delivery SET state='unavailable',last_error=?,lease_owner=NULL,expires_at=NULL,retry_after=NULL
 WHERE purpose=? AND subject_id=?`)
					.run(code, claim.purpose, claim.subjectId);
				return true;
			})
			.immediate();
	}
	emptyScan(claim: LearningClaim, frontier: string, now: number): boolean {
		id.parse(frontier);
		if (claim.action !== "scan") return false;
		return this.db
			.transaction(() => {
				const row = this.current(claim, now);
				if (!row) return false;
				const stable = row.scan_frontier === frontier;
				const confirmed =
					stable &&
					row.first_zero_scan_at !== null &&
					now - Date.parse(row.first_zero_scan_at) >= 30_000;
				this.db
					.prepare(`UPDATE ship_judgment_delivery SET state=?,first_zero_scan_at=?,scan_frontier=?,retry_after=?,
 lease_owner=NULL,expires_at=NULL,attempt=0,last_error=NULL WHERE purpose=? AND subject_id=?`)
					.run(
						confirmed ? "pending" : "uncertain",
						confirmed
							? null
							: stable
								? (row.first_zero_scan_at ?? iso(now))
								: iso(now),
						confirmed ? null : frontier,
						confirmed ? null : iso(now + 30_000),
						claim.purpose,
						claim.subjectId,
					);
				return true;
			})
			.immediate();
	}
	confirm(
		claim: LearningClaim,
		messageId: string,
		visibleAt: string,
		now: number,
	): boolean {
		discordId.parse(messageId);
		z.string().datetime({ offset: true }).parse(visibleAt);
		if (Date.parse(visibleAt) > now) return false;
		return this.db
			.transaction(() => {
				if (!this.current(claim, now)) return false;
				this.db
					.prepare(
						`UPDATE ship_judgment_delivery SET state='delivered',posted_id=desired_id,message_id=?,visible_at=?,lease_owner=NULL,expires_at=NULL,retry_after=NULL,last_error=NULL WHERE purpose=? AND subject_id=?`,
					)
					.run(
						messageId,
						new Date(visibleAt).toISOString(),
						claim.purpose,
						claim.subjectId,
					);
				return true;
			})
			.immediate();
	}
	fail(
		claim: LearningClaim,
		now: number,
		code: string,
		uncertain: boolean,
		retryAt?: number,
	): boolean {
		id.parse(code);
		if (retryAt !== undefined) iso(retryAt);
		return this.db
			.transaction(() => {
				const row = this.current(claim, now);
				if (!row) return false;
				const delay =
					row.attempt <= 5
						? 60_000 * 2 ** Math.max(0, row.attempt - 1)
						: 3_600_000;
				this.db
					.prepare(
						`UPDATE ship_judgment_delivery SET state=?,last_error=?,retry_after=?,lease_owner=NULL,expires_at=NULL WHERE purpose=? AND subject_id=?`,
					)
					.run(
						uncertain || claim.action === "scan" ? "uncertain" : "pending",
						code,
						iso(Math.max(now + delay, retryAt ?? 0)),
						claim.purpose,
						claim.subjectId,
					);
				return true;
			})
			.immediate();
	}
}
