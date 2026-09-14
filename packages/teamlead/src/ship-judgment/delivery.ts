import type Database from "better-sqlite3";
import { z } from "zod";
import {
	canonicalDigest,
	JUDGMENT_DELIVERY_ERROR_EVENT,
	JUDGMENT_VISIBLE_EVENT,
	type OpinionCandidate,
	type OverallVerdict,
	opinionCandidateSchema,
	overallSchema,
	type PointVerdict,
	type ShipJudgmentBinding,
	verdictSchema,
} from "./contract.js";

export interface DeliveryView {
	opinionId: string;
	questionId: string;
	threadId: string;
	cardMessageId: string;
	marker: string;
	overall: OverallVerdict;
	alignment: PointVerdict;
	conflict: PointVerdict;
	coverage: PointVerdict;
	mechanical: OpinionCandidate["mechanical"];
	evaluation: unknown;
}
interface DeliveryRow {
	delivery_mode: "dry_run" | "auto" | "off";
	mode_label: "current" | "history";
	validated_presentation_digest: string | null;
	validated_at: string | null;
	subject_id: string;
	question_id: string;
	desired_id: string | null;
	posted_id: string | null;
	message_id: string | null;
	state: string;
	generation: number;
	lease_owner: string | null;
	expires_at: string | null;
	retry_after: string | null;
	post_reserved_times: string;
	patch_reserved_times: string;
	attempt: number;
	first_zero_scan_at: string | null;
	scan_frontier: string | null;
}
export interface DeliveryClaim {
	status: "claimed";
	questionId: string;
	owner: string;
	generation: number;
	opinionId: string;
	action: "post" | "patch" | "scan" | "history";
	messageId: string | null;
}
type ClaimResult =
	| DeliveryClaim
	| {
			status:
				| "missing"
				| "inactive"
				| "busy"
				| "settled"
				| "stale"
				| "rate_limited";
	  };
const id = z.string().min(1).max(200);
const message = z.string().regex(/^[0-9]{17,20}$/);
function iso(now: number): string {
	z.number().int().nonnegative().safe().parse(now);
	return new Date(now).toISOString();
}

/** Persistence for the new sender only; never reads or adopts legacy auto-narrow message IDs. */
export class ShipJudgmentDelivery {
	constructor(
		private readonly db: Database.Database,
		private readonly binding: (
			questionId: string,
			channelId: string,
		) => ShipJudgmentBinding | undefined,
		private readonly appendAudit: (event: {
			runId: string;
			eventUid: string;
			kind: string;
			payload: unknown;
		}) => unknown,
	) {}
	setMode(mode: "dry_run" | "auto" | "off", now: number): void {
		z.enum(["dry_run", "auto", "off"]).parse(mode);
		iso(now);
		this.db
			.prepare(`UPDATE ship_judgment_delivery SET delivery_mode=?,presentation_state_changed_at=?,generation=generation+1,
 lease_owner=NULL,expires_at=NULL,retry_after=NULL,validated_at=NULL,validated_presentation_digest=NULL,
 state=CASE WHEN ?='dry_run' AND message_id IS NOT NULL AND state NOT IN ('gone','unavailable') THEN 'pending' ELSE state END
 WHERE purpose='opinion' AND delivery_mode<>?`)
			.run(mode, iso(now), mode, mode);
	}
	historyWork(now = Date.now()): string[] {
		const at = iso(now);
		return (
			this.db
				.prepare(`SELECT question_id FROM ship_judgment_delivery WHERE purpose='opinion'
 AND delivery_mode<>'dry_run' AND mode_label='current' AND (message_id IS NOT NULL OR state IN ('posting','uncertain'))
 AND state NOT IN ('gone','unavailable') AND (retry_after IS NULL OR retry_after<=?)
 AND (expires_at IS NULL OR expires_at<=?) ORDER BY COALESCE(retry_after,''),question_id LIMIT 20`)
				.all(at, at) as { question_id: string }[]
		).map((row) => row.question_id);
	}
	deferHistory(questionId: string, now: number): void {
		id.parse(questionId);
		this.db
			.prepare(`UPDATE ship_judgment_delivery SET retry_after=?,last_error='history_owner_unavailable'
		WHERE purpose='opinion' AND subject_id=? AND delivery_mode<>'dry_run' AND (expires_at IS NULL OR expires_at<=?)`)
			.run(iso(now + 3_600_000), questionId, iso(now));
	}
	claimHistory(questionId: string, owner: string, now: number): ClaimResult {
		id.parse(questionId);
		id.parse(owner);
		const at = iso(now);
		return this.db
			.transaction((): ClaimResult => {
				const row = this.db
					.prepare(
						"SELECT * FROM ship_judgment_delivery WHERE purpose='opinion' AND subject_id=?",
					)
					.get(questionId) as DeliveryRow | undefined;
				if (
					!row?.desired_id ||
					(!row.message_id && !["posting", "uncertain"].includes(row.state)) ||
					row.delivery_mode === "dry_run" ||
					row.mode_label === "history" ||
					["gone", "unavailable"].includes(row.state)
				)
					return { status: "inactive" };
				if (
					(row.expires_at && row.expires_at > at) ||
					(row.retry_after && row.retry_after > at)
				)
					return { status: "busy" };
				const slots = (JSON.parse(row.patch_reserved_times) as number[]).filter(
					(time) => time > now - 3_600_000,
				);
				if (row.message_id && slots.length >= 6) {
					this.db
						.prepare(
							"UPDATE ship_judgment_delivery SET retry_after=? WHERE purpose='opinion' AND subject_id=? AND generation=?",
						)
						.run(
							iso(Math.min(...slots) + 3_600_000),
							questionId,
							row.generation,
						);
					return { status: "rate_limited" };
				}
				if (row.message_id) slots.push(now);
				this.db
					.prepare(`UPDATE ship_judgment_delivery SET state='posting',generation=generation+1,
 lease_owner=?,expires_at=?,patch_reserved_times=?,attempt=attempt+1
 WHERE purpose='opinion' AND subject_id=? AND generation=?`)
					.run(
						owner,
						iso(now + 30_000),
						JSON.stringify(slots),
						questionId,
						row.generation,
					);
				return {
					status: "claimed",
					questionId,
					owner,
					generation: row.generation + 1,
					opinionId: row.desired_id,
					action: row.message_id ? "history" : "scan",
					messageId: row.message_id,
				};
			})
			.immediate();
	}
	confirmHistory(claim: DeliveryClaim, now: number): boolean {
		if (claim.action !== "history") return false;
		const at = iso(now);
		return this.db
			.transaction(() => {
				const row = this.current(claim, at);
				if (
					!row ||
					row.delivery_mode === "dry_run" ||
					row.message_id !== claim.messageId
				)
					return false;
				this.db
					.prepare(`UPDATE ship_judgment_delivery SET state='delivered',mode_label='history',presentation_state_changed_at=?,
 lease_owner=NULL,expires_at=NULL,retry_after=NULL,attempt=0,last_error=NULL
 WHERE purpose='opinion' AND subject_id=? AND generation=?`)
					.run(at, claim.questionId, claim.generation);
				return true;
			})
			.immediate();
	}

	scanSince(questionId: string): string | undefined {
		id.parse(questionId);
		const row = this.db
			.prepare(
				"SELECT MIN(created_at) AS since FROM ship_judgment_opinion WHERE question_id=?",
			)
			.get(questionId) as { since: string | null };
		return row.since ?? undefined;
	}
	legacySummary(questionId: string): string {
		id.parse(questionId);
		const row = this.db
			.prepare(`SELECT s.gate1,s.gate2,s.gate3,s.sample_n,s.agree_n FROM auto_narrow_opinion_snapshot s
		WHERE s.question_id=? ORDER BY s.ordinal DESC LIMIT 1`)
			.get(questionId) as
			| {
					gate1: number;
					gate2: number;
					gate3: number;
					sample_n: number;
					agree_n: number;
			  }
			| undefined;
		return row
			? `三闸 ${row.gate1}/${row.gate2}/${row.gate3}；旧样本 ${row.sample_n}，一致 ${row.agree_n}`
			: "暂不可得";
	}
	view(questionId: string, opinionId?: string): DeliveryView | undefined {
		id.parse(questionId);
		if (opinionId) id.parse(opinionId);
		const row = this.db
			.prepare(`SELECT o.*,d.thread_id,d.card_message_id,d.marker,e.result_json
			FROM ship_judgment_delivery d JOIN ship_judgment_opinion o ON o.opinion_id=d.desired_id
			LEFT JOIN ship_judgment_evaluation e ON e.evaluation_id=o.evaluation_id
			WHERE d.purpose='opinion' AND d.subject_id=? AND (? IS NULL OR o.opinion_id=?)`)
			.get(questionId, opinionId ?? null, opinionId ?? null) as
			| Record<string, unknown>
			| undefined;
		if (!row) return undefined;
		const { binding: _binding, ...mechanical } = JSON.parse(
			String(row.mechanical_json),
		);
		return {
			opinionId: String(row.opinion_id),
			questionId,
			threadId: String(row.thread_id),
			cardMessageId: String(row.card_message_id),
			marker: String(row.marker),
			overall: overallSchema.parse(row.overall),
			alignment: verdictSchema.parse(row.alignment),
			conflict: verdictSchema.parse(row.conflict),
			coverage: verdictSchema.parse(row.coverage),
			mechanical: opinionCandidateSchema.shape.mechanical.parse(mechanical),
			evaluation: row.result_json ? JSON.parse(String(row.result_json)) : null,
		};
	}
	claim(
		questionId: string,
		channelId: string,
		owner: string,
		now: number,
	): ClaimResult {
		id.parse(questionId);
		id.parse(channelId);
		id.parse(owner);
		const at = iso(now);
		return this.db
			.transaction((): ClaimResult => {
				const row = this.db
					.prepare(
						"SELECT * FROM ship_judgment_delivery WHERE purpose='opinion' AND subject_id=?",
					)
					.get(questionId) as DeliveryRow | undefined;
				if (!row?.desired_id) return { status: "missing" };
				if (row.delivery_mode !== "dry_run") return { status: "inactive" };
				if (row.state === "gone" || row.state === "unavailable")
					return { status: "inactive" };
				if (row.state === "delivered" && row.posted_id === row.desired_id)
					return { status: "settled" };
				if (
					(row.expires_at && row.expires_at > at) ||
					(row.retry_after && row.retry_after > at)
				)
					return { status: "busy" };
				const opinion = this.db
					.prepare(
						"SELECT mechanical_json,presentation_digest FROM ship_judgment_opinion WHERE opinion_id=? AND question_id=?",
					)
					.get(row.desired_id, questionId) as
					| { mechanical_json: string; presentation_digest: string }
					| undefined;
				const current = this.binding(questionId, channelId);
				if (!opinion || !current) return { status: "inactive" };
				const mechanical = JSON.parse(opinion.mechanical_json) as {
					binding: ShipJudgmentBinding;
					checkedAt: string;
				};
				if (canonicalDigest(mechanical.binding) !== canonicalDigest(current))
					return { status: "inactive" };
				const action = row.message_id
					? "patch"
					: row.state === "uncertain" || row.state === "posting"
						? "scan"
						: "post";
				if (
					action !== "scan" &&
					(!row.validated_at ||
						row.validated_presentation_digest !== opinion.presentation_digest ||
						!Number.isFinite(Date.parse(row.validated_at)) ||
						now - Date.parse(row.validated_at) > 60_000 ||
						now < Date.parse(row.validated_at))
				)
					return { status: "stale" };
				const posts = (JSON.parse(row.post_reserved_times) as number[]).filter(
					(time) => time > now - 3_600_000,
				);
				const patches = (
					JSON.parse(row.patch_reserved_times) as number[]
				).filter((time) => time > now - 3_600_000);
				if (
					(action === "post" && posts.length >= 2) ||
					(action === "patch" && patches.length >= 6)
				)
					return { status: "rate_limited" };
				if (action === "post") posts.push(now);
				if (action === "patch") patches.push(now);
				const generation = row.generation + 1;
				const changed = this.db
					.prepare(`UPDATE ship_judgment_delivery SET state=?,generation=?,lease_owner=?,expires_at=?,retry_after=NULL,
    post_reserved_times=?,patch_reserved_times=?,attempt=attempt+1 WHERE purpose='opinion' AND subject_id=? AND generation=?`)
					.run(
						action === "scan" ? "uncertain" : "posting",
						generation,
						owner,
						iso(now + 30_000),
						JSON.stringify(posts),
						JSON.stringify(patches),
						questionId,
						row.generation,
					).changes;
				return changed
					? {
							status: "claimed",
							questionId,
							owner,
							generation,
							opinionId: row.desired_id,
							action,
							messageId: row.message_id,
						}
					: { status: "busy" };
			})
			.immediate();
	}
	confirm(
		claim: DeliveryClaim,
		messageId: string,
		visibleAt: string,
		now: number,
		opinionId = claim.opinionId,
	): boolean {
		message.parse(messageId);
		z.string().datetime().parse(visibleAt);
		const at = iso(now);
		if (visibleAt > at) return false;
		return this.db
			.transaction(() => {
				const row = this.current(claim, at);
				if (
					!row ||
					(row.delivery_mode !== "dry_run" && claim.action !== "scan") ||
					claim.action === "history"
				)
					return false;
				if (claim.action !== "scan" && opinionId !== claim.opinionId)
					return false;
				if (claim.action === "patch" && row.message_id !== messageId)
					return false;
				if (
					!this.db
						.prepare(
							"SELECT 1 FROM ship_judgment_opinion WHERE opinion_id=? AND question_id=?",
						)
						.get(opinionId, claim.questionId)
				)
					return false;
				this.db
					.prepare(`UPDATE ship_judgment_delivery SET state=CASE WHEN desired_id=? THEN 'delivered' ELSE 'pending' END,
    message_id=?,posted_id=?,visible_at=?,presentation_state_changed_at=?,mode_label='current',lease_owner=NULL,expires_at=NULL,retry_after=NULL,attempt=0,last_error=NULL,
    first_zero_scan_at=NULL,scan_frontier=NULL,dirty_since=CASE WHEN desired_id=? AND latest_candidate_json IS NULL THEN NULL ELSE dirty_since END
    WHERE purpose='opinion' AND subject_id=? AND generation=?`)
					.run(
						opinionId,
						messageId,
						opinionId,
						visibleAt,
						at,
						opinionId,
						claim.questionId,
						claim.generation,
					);
				// Non-authoritative visibility audit, authorized by Lead ruling 4388ee31-b720-43d3-bc33-cced30d51bec.
				// Append inside the receipt CAS transaction; bounded by the existing opinion and PATCH rate caps.
				const holder = this.db
					.prepare(
						"SELECT run_id FROM workflow_gate_holder WHERE question_id=?",
					)
					.get(claim.questionId) as { run_id: string };
				const uid = `${JUDGMENT_VISIBLE_EVENT}:${canonicalDigest([holder.run_id, opinionId, messageId])}`;
				this.appendAudit({
					runId: holder.run_id,
					eventUid: uid,
					kind: JUDGMENT_VISIBLE_EVENT,
					payload: {
						opinion_id: opinionId,
						question_id: claim.questionId,
						message_id: messageId,
						receipt_time: visibleAt,
						observed_at: at,
					},
				});
				return true;
			})
			.immediate();
	}
	failed(
		claim: DeliveryClaim,
		code: string,
		now: number,
		uncertain: boolean,
		retryAt?: number,
	): boolean {
		id.parse(code);
		const at = iso(now);
		return this.db
			.transaction(() => {
				const row = this.current(claim, at);
				if (!row) return false;
				const delay =
					row.attempt <= 5
						? 60_000 * 2 ** Math.max(0, row.attempt - 1)
						: 3_600_000;
				this.db
					.prepare(`UPDATE ship_judgment_delivery SET state=?,lease_owner=NULL,expires_at=NULL,last_error=?,retry_after=?
    WHERE purpose='opinion' AND subject_id=? AND generation=?`)
					.run(
						!row.message_id && (uncertain || claim.action === "scan")
							? "uncertain"
							: "pending",
						code,
						iso(Math.max(now + delay, retryAt ?? 0)),
						claim.questionId,
						claim.generation,
					);
				const holder = this.db
					.prepare(
						"SELECT run_id FROM workflow_gate_holder WHERE question_id=?",
					)
					.get(claim.questionId) as { run_id: string };
				this.appendAudit({
					runId: holder.run_id,
					eventUid: `${JUDGMENT_DELIVERY_ERROR_EVENT}:${canonicalDigest([claim.questionId, claim.generation, claim.action])}`,
					kind: JUDGMENT_DELIVERY_ERROR_EVENT,
					payload: {
						question_id: claim.questionId,
						opinion_id: claim.opinionId,
						action: claim.action,
						code,
						certainty:
							uncertain || claim.action === "scan" ? "unknown" : "failed",
						observed_at: at,
					},
				});
				return true;
			})
			.immediate();
	}
	emptyScan(claim: DeliveryClaim, frontier: string, now: number): boolean {
		id.parse(frontier);
		const at = iso(now);
		if (claim.action !== "scan") return false;
		return this.db
			.transaction(() => {
				const row = this.current(claim, at);
				if (!row) return false;
				const confirmed =
					row.scan_frontier === frontier &&
					row.first_zero_scan_at !== null &&
					now - Date.parse(row.first_zero_scan_at) >= 30_000;
				this.db
					.prepare(`UPDATE ship_judgment_delivery SET state=?,first_zero_scan_at=?,scan_frontier=?,retry_after=?,lease_owner=NULL,expires_at=NULL,attempt=0,last_error=NULL
    WHERE purpose='opinion' AND subject_id=? AND generation=?`)
					.run(
						confirmed ? "pending" : "uncertain",
						confirmed
							? null
							: row.scan_frontier === frontier
								? (row.first_zero_scan_at ?? at)
								: at,
						confirmed ? null : frontier,
						confirmed ? null : iso(now + 30_000),
						claim.questionId,
						claim.generation,
					);
				return true;
			})
			.immediate();
	}
	private current(claim: DeliveryClaim, at: string): DeliveryRow | undefined {
		return this.db
			.prepare(`SELECT * FROM ship_judgment_delivery WHERE purpose='opinion' AND subject_id=? AND generation=? AND lease_owner=?
   AND desired_id=? AND expires_at>? AND state IN ('posting','uncertain')`)
			.get(
				claim.questionId,
				claim.generation,
				claim.owner,
				claim.opinionId,
				at,
			) as DeliveryRow | undefined;
	}
}
