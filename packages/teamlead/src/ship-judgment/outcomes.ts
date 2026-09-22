import type Database from "better-sqlite3";
import { z } from "zod";
import {
	canonicalDigest,
	JUDGMENT_VISIBLE_EVENT,
	targetSchema,
} from "./contract.js";
import {
	evidenceLedgerSchema,
	evidenceTargetDigest,
} from "./evidence-ledger.js";
import {
	type CloseoutPair,
	type ObservationPageStats,
	observeCloseoutPage,
	observeVerdictPage,
	type VerdictPageStats,
} from "./observation-cursor.js";

type Authorship = "founder_verified" | "lead_proxy" | "auto" | "unknown";
interface VerdictRow {
	recorded_ms: number;
	verdict_id: string;
	source_event_id: string;
	run_id: string;
	question_id: string;
	gate_node_id: string;
	attempt: number;
	verdict: "approved" | "rework";
	repo_identity: string;
	repo_slug: string;
	pr_number: number;
	head_sha: string;
	founder_authored: number;
	author_evidence_json: string;
	recorded_at: string;
	card_message_id: string | null;
	holder_run_id: string;
	holder_attempt: number;
	holder_node_id: string;
}
const identity = z.string().min(1).max(200);
const capture = z.object({
	kind: z.literal("gate_response"),
	actor: identity,
	founder_id_at_capture: identity,
	source_event_id: identity,
});
const founderMessage = z.object({
	kind: z.literal("founder_message"),
	channel_id: identity,
	message_id: identity,
	card_message_id: identity,
	author_user_id: identity,
	founder_id_at_capture: identity,
	question_id: identity,
	head_sha: z.string().regex(/^[a-f0-9]{40}$/),
	message_ts: z.string().datetime({ offset: true }),
	card_message_ts: z.string().datetime({ offset: true }),
	verified_at: z.string().datetime({ offset: true }),
});
function attribution(row: VerdictRow, evidence: unknown): Authorship {
	const value = evidence as Record<string, unknown> | null;
	if (
		(value?.kind === "auto_narrow_gate" ||
			value?.kind === "ship_judgment_auto") &&
		value.source_event_id === row.source_event_id
	)
		return "auto";
	if (value?.kind === "operator" && identity.safeParse(value.principal).success)
		return "lead_proxy";
	if (row.founder_authored !== 1) return "unknown";
	const gate = capture.safeParse(value);
	if (
		gate.success &&
		gate.data.actor === gate.data.founder_id_at_capture &&
		gate.data.source_event_id === row.source_event_id
	)
		return "founder_verified";
	const message = founderMessage.safeParse(value);
	if (message.success) {
		const m = message.data;
		if (
			m.author_user_id === m.founder_id_at_capture &&
			m.question_id === row.question_id &&
			m.head_sha === row.head_sha &&
			m.card_message_id === row.card_message_id &&
			Date.parse(m.card_message_ts) <= Date.parse(m.message_ts) &&
			Date.parse(m.message_ts) <= Date.parse(m.verified_at) &&
			Date.parse(m.verified_at) <= row.recorded_ms
		)
			return "founder_verified";
	}
	return "unknown";
}

export function refreshHistoryAt(
	delivery:
		| {
				dirty_since: string | null;
				delivery_mode: string;
				presentation_state_changed_at: string | null;
		  }
		| undefined,
	decidedAt: string,
): "clear" | "pending" | "inactive" | "unknown" {
	const decided = Date.parse(decidedAt),
		changed = Date.parse(delivery?.presentation_state_changed_at ?? ""),
		dirty = Date.parse(delivery?.dirty_since ?? "");
	if (!Number.isFinite(decided)) return "unknown";
	if (Number.isFinite(changed) && changed < decided) {
		if (delivery?.delivery_mode === "off") return "inactive";
		if (!delivery || !["dry_run", "auto"].includes(delivery.delivery_mode))
			return "unknown";
		if (Number.isFinite(dirty) && dirty < decided) return "pending";
		return delivery.dirty_since ? "unknown" : "clear";
	}
	return Number.isFinite(dirty) && dirty < decided ? "pending" : "unknown";
}

/** Sole read-only B2 consumer added by FLY-2399: writes only append-only learning outcomes, never approval state. */
export class ShipJudgmentOutcomes {
	constructor(private readonly db: Database.Database) {}
	private lastPage: ObservationPageStats = {
		sourceCandidates: 0,
		holderCandidates: 0,
		outcomes: 0,
		elapsedMs: 0,
		cursorBefore: 0,
		cursorAfter: 0,
		deferred: 0,
	};
	pageStats(): ObservationPageStats {
		return { ...this.lastPage };
	}
	/** Lead ruling: consume each source identity once, including terminal holders. */
	observeCancellations(now: string): number {
		z.string().datetime().parse(now);
		this.lastPage = observeCloseoutPage(this.db, now, (row) =>
			this.recordCancellation(row, now),
		);
		return this.lastPage.outcomes;
	}
	private recordCancellation(row: CloseoutPair, now: string): void {
		const sourceId = `${row.id}:${row.question_id}`;
		const payload =
			Buffer.byteLength(row.payload) <= 65536 ? JSON.parse(row.payload) : {};
		const observations = this.db
			.prepare(`SELECT l.* FROM linear_state_observations l JOIN workflow_run r ON r.run_id=?
 WHERE l.project=r.project_name AND (l.issue_uuid=r.issue_id OR EXISTS (SELECT 1 FROM workflow_run_issue_alias a WHERE a.run_id=r.run_id AND a.issue_alias=l.issue_uuid)) LIMIT 2`)
			.all(row.run_id) as {
			issue_uuid: string;
			last_state_type: string;
			last_linear_updated_at: string;
			observed_at: string;
			terminal_authorized: number;
		}[];
		const observation = observations.length === 1 ? observations[0] : undefined;
		const rootMatches =
			typeof payload.rootKey === "string" &&
			this.db
				.prepare(`SELECT 1 FROM workflow_run r WHERE r.run_id=?
 AND (r.issue_id=? OR EXISTS (SELECT 1 FROM workflow_run_issue_alias a WHERE a.run_id=r.run_id AND a.issue_alias=?))`)
				.get(row.run_id, payload.rootKey, payload.rootKey);
		const closed = row.closed_ms,
			changed = Date.parse(observation?.last_linear_updated_at ?? ""),
			observed = Date.parse(observation?.observed_at ?? "");
		const matchingRuns = this.db
			.prepare(`SELECT r.run_id FROM workflow_run r WHERE r.project_name='flywheel'
 AND (r.issue_id=? OR EXISTS (SELECT 1 FROM workflow_run_issue_alias a WHERE a.run_id=r.run_id AND a.issue_alias=?))
 AND julianday(r.created_at)<=julianday(?) LIMIT 2`)
			.all(row.issue_id, row.issue_id, row.ts);

		const verified =
			!!rootMatches &&
			matchingRuns.length === 1 &&
			observation?.last_state_type === "canceled" &&
			observation.terminal_authorized === 1 &&
			Number.isFinite(changed) &&
			Number.isFinite(observed) &&
			row.run_ms <= changed &&
			row.card_ms <= changed &&
			changed <= observed &&
			observed <= closed;
		const decidedAt = new Date(verified ? changed : closed).toISOString();
		const frozen = this.db
			.prepare(
				`SELECT mechanical_json FROM ship_judgment_opinion WHERE question_id=? AND created_at<=? ORDER BY created_at DESC,ordinal DESC LIMIT 1`,
			)
			.get(row.question_id, decidedAt) as
			| { mechanical_json: string }
			| undefined;
		let context: { inputId: string | null; targetsDigest: string } | undefined;
		try {
			const target = z
				.object({
					repo_identity: identity,
					repo_slug: identity,
					pr_number: z.number().int().positive(),
					head_sha: z.string().regex(/^[a-f0-9]{40}$/),
				})
				.parse(
					JSON.parse(frozen?.mechanical_json ?? "{}").binding?.targets?.[0],
				);
			context = this.frozenTargetContext({ ...row, ...target }, decidedAt);
		} catch {
			/* No usable frozen target context remains explicitly unresolved. */
		}
		const delivery = this.db
			.prepare(
				"SELECT dirty_since,delivery_mode,presentation_state_changed_at FROM ship_judgment_delivery WHERE purpose='opinion' AND question_id=?",
			)
			.get(row.question_id) as Parameters<typeof refreshHistoryAt>[0];
		this.db
			.prepare(`INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,evidence_json)
 VALUES (?,'closeout',?,?,?,?,?,?,'canceled',?,?,?)`)
			.run(
				canonicalDigest(["closeout", sourceId]),
				sourceId,
				row.question_id,
				row.run_id,
				row.card_message_id ?? "",
				context?.targetsDigest ??
					canonicalDigest({ unresolved: true, sourceId }),
				verified ? "founder_verified" : "unknown",
				decidedAt,
				now,
				JSON.stringify({
					source_event_id: row.event_id,
					source_recorded_at: row.ts,
					linear_observation: observation ?? null,
					closeout: payload,
					attribution_policy: "linear-canceled-closeout-run-v1",
					run_mapping_ambiguous: matchingRuns.length !== 1,
					binding_status: context ? "resolved" : "unresolved",
					input_id: context?.inputId ?? null,
					delivery_at_observation: delivery,
					refresh_history: refreshHistoryAt(delivery, decidedAt),
				}),
			);
	}

	private frozenTargetContext(
		row: Pick<
			VerdictRow,
			| "run_id"
			| "question_id"
			| "card_message_id"
			| "repo_identity"
			| "repo_slug"
			| "pr_number"
			| "head_sha"
		>,
		decidedAt: string,
	): { inputId: string | null; targetsDigest: string } | undefined {
		let frozen = this.db
			.prepare(`SELECT i.input_id,i.targets_json,i.targets_digest,i.requested_at,o.mechanical_json FROM ship_judgment_opinion o
		JOIN ship_judgment_input i ON i.input_id=o.input_id
		WHERE o.question_id=? AND o.created_at<=? ORDER BY o.created_at DESC,o.ordinal DESC LIMIT 1`)
			.get(row.question_id, decidedAt) as
			| {
					input_id: string | null;
					targets_json: string | null;
					targets_digest: string;
					requested_at: string;
					mechanical_json: string;
			  }
			| undefined;
		try {
			if (!frozen) {
				const opinion = this.db
					.prepare(`SELECT o.evidence_json,o.mechanical_json,o.created_at FROM ship_judgment_opinion o
					JOIN workflow_run_event e ON e.run_id=? AND e.kind=?
					AND json_extract(e.payload,'$.opinion_id')=o.opinion_id AND json_extract(e.payload,'$.question_id')=o.question_id
					WHERE o.question_id=? AND o.input_id IS NULL AND o.evidence_json IS NOT NULL
					AND julianday(o.created_at)<=julianday(?) AND julianday(json_extract(e.payload,'$.receipt_time'))<=julianday(?)
					AND julianday(COALESCE(json_extract(e.payload,'$.observed_at'),e.at))<=julianday(?)
					ORDER BY julianday(json_extract(e.payload,'$.receipt_time')) DESC,o.ordinal DESC LIMIT 1`)
					.get(
						row.run_id,
						JUDGMENT_VISIBLE_EVENT,
						row.question_id,
						decidedAt,
						decidedAt,
						decidedAt,
					) as
					| {
							evidence_json: string;
							mechanical_json: string;
							created_at: string;
					  }
					| undefined;
				if (!opinion) return undefined;
				const ledger = evidenceLedgerSchema.parse(
					JSON.parse(opinion.evidence_json),
				);
				frozen = {
					input_id: null,
					targets_json: JSON.stringify(
						ledger.targets.map((t) => ({
							repo_identity: t.r,
							pr_number: t.p,
							head_sha: t.h,
							diff_base_sha: t.b,
						})),
					),
					targets_digest: ledger.targetsDigest,
					requested_at: opinion.created_at,
					mechanical_json: opinion.mechanical_json,
				};
			}
			if (!frozen.targets_json || frozen.requested_at > decidedAt)
				return undefined;
			const targets = z
				.array(
					targetSchema.extend({
						diff_base_sha: targetSchema.shape.diff_base_sha.nullable(),
					}),
				)
				.min(1)
				.max(200)
				.parse(JSON.parse(frozen.targets_json));
			const binding = z
				.object({
					runId: identity,
					questionId: identity,
					cardMessageId: identity,
					manifestRevision: z.number().int().nonnegative(),
					targets: z
						.array(
							z.object({
								repo_identity: identity,
								repo_slug: identity,
								pr_number: z.number().int().positive(),
								head_sha: z.string().regex(/^[a-f0-9]{40}$/),
							}),
						)
						.min(1)
						.max(200),
				})
				.parse(JSON.parse(frozen.mechanical_json).binding);
			if (
				binding.runId !== row.run_id ||
				binding.questionId !== row.question_id ||
				binding.cardMessageId !== row.card_message_id
			)
				return undefined;
			if (
				!binding.targets.some(
					(t) =>
						t.repo_identity === row.repo_identity &&
						t.repo_slug.toLowerCase() === row.repo_slug.toLowerCase() &&
						t.pr_number === row.pr_number &&
						t.head_sha === row.head_sha,
				)
			)
				return undefined;
			const keys = (
				items: { repo_identity: string; pr_number: number; head_sha: string }[],
			) =>
				items
					.map((t) =>
						canonicalDigest([t.repo_identity, t.pr_number, t.head_sha]),
					)
					.sort();
			if (
				canonicalDigest(keys(targets)) !==
				canonicalDigest(keys(binding.targets))
			)
				return undefined;
			const latest = this.db
				.prepare(
					"SELECT MAX(revision) AS revision FROM workflow_declared_pr WHERE run_id=? AND declared_at<=?",
				)
				.get(row.run_id, decidedAt) as { revision: number | null };
			if ((latest.revision ?? 0) !== binding.manifestRevision) return undefined;
			if (binding.manifestRevision > 0) {
				const declared = this.db
					.prepare(
						"SELECT repo_identity,pr_number,frozen_head_sha AS head_sha FROM workflow_declared_pr WHERE run_id=? AND revision=? AND declared_at<=?",
					)
					.all(row.run_id, binding.manifestRevision, decidedAt) as {
					repo_identity: string;
					pr_number: number;
					head_sha: string;
				}[];
				if (
					canonicalDigest(keys(declared)) !==
					canonicalDigest(keys(binding.targets))
				)
					return undefined;
			} else if (
				this.db
					.prepare(
						"SELECT 1 FROM workflow_pr_manifest WHERE run_id=? AND created_at<=?",
					)
					.get(row.run_id, decidedAt)
			)
				return undefined;
			const rebound = this.db
				.prepare(
					"SELECT target_repo_identity AS repo_identity,pr_number,head_sha FROM workflow_node_pr_binding WHERE run_id=? AND bound_at>? AND bound_at<=?",
				)
				.all(row.run_id, frozen.requested_at, decidedAt) as {
				repo_identity: string;
				pr_number: number;
				head_sha: string;
			}[];
			const expected = new Set(keys(binding.targets));
			if (keys(rebound).some((key) => !expected.has(key))) return undefined;
			if (
				evidenceTargetDigest(
					targets.map((t) => ({
						r: t.repo_identity,
						p: t.pr_number,
						h: t.head_sha,
						b: t.diff_base_sha,
					})),
					binding.manifestRevision,
				) !== frozen.targets_digest
			)
				return undefined;
			return { inputId: frozen.input_id, targetsDigest: frozen.targets_digest };
		} catch {
			return undefined;
		}
	}
	private lastVerdictPage: VerdictPageStats = {
		sourceCandidates: 0,
		holderCandidates: 0,
		outcomes: 0,
		elapsedMs: 0,
		reconciled: 0,
	};
	verdictPageStats(): VerdictPageStats {
		return { ...this.lastVerdictPage };
	}
	observeVerdicts(now: string): number {
		z.string().datetime().parse(now);
		this.lastVerdictPage = observeVerdictPage(
			this.db,
			now,
			(id, recordedMs) => {
				const row = this.db
					.prepare(`SELECT v.*,h.card_message_id,h.run_id AS holder_run_id,h.attempt AS holder_attempt,h.gate_node_id AS holder_node_id
 FROM workflow_founder_gate_verdict v JOIN workflow_gate_holder h ON h.question_id=v.question_id WHERE v.verdict_id=?`)
					.get(id) as VerdictRow | undefined;
				if (!row) return false;
				row.recorded_ms = recordedMs;
				this.recordVerdict(row, now);
				return true;
			},
		);
		return this.lastVerdictPage.outcomes;
	}
	private recordVerdict(row: VerdictRow, now: string): void {
		const evidence =
			Buffer.byteLength(row.author_evidence_json) <= 65536
				? JSON.parse(row.author_evidence_json)
				: {
						kind: "oversize",
						digest: canonicalDigest(row.author_evidence_json),
					};
		const consistent =
			row.holder_run_id === row.run_id &&
			row.holder_attempt === row.attempt &&
			row.holder_node_id === row.gate_node_id;
		const authorship = consistent ? attribution(row, evidence) : "unknown";
		const target = {
			repo_identity: row.repo_identity,
			repo_slug: row.repo_slug,
			pr_number: row.pr_number,
			head_sha: row.head_sha,
		};
		const original = founderMessage.safeParse(evidence);
		const decidedAt =
			authorship === "founder_verified" && original.success
				? new Date(original.data.message_ts).toISOString()
				: new Date(row.recorded_ms).toISOString();
		const context = consistent
			? this.frozenTargetContext(row, decidedAt)
			: undefined;
		const targetsDigest =
			context?.targetsDigest ??
			canonicalDigest({ unresolved: true, source_target: target });
		const delivery = this.db
			.prepare(
				"SELECT dirty_since,latest_candidate_digest,delivery_mode,presentation_state_changed_at FROM ship_judgment_delivery WHERE purpose='opinion' AND question_id=?",
			)
			.get(row.question_id) as
			| {
					dirty_since: string | null;
					latest_candidate_digest: string | null;
					delivery_mode: string;
					presentation_state_changed_at: string | null;
			  }
			| undefined;
		this.db
			.prepare(`INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,verdict_id,evidence_json)
 VALUES (?,'b2',?,?,?,?,?,?,?,?,?,?,?)`)
			.run(
				canonicalDigest(["b2", row.verdict_id]),
				row.verdict_id,
				row.question_id,
				row.run_id,
				row.card_message_id ?? "",
				targetsDigest,
				authorship,
				row.verdict,
				decidedAt,
				now,
				row.verdict_id,
				JSON.stringify({
					source_event_id: row.source_event_id,
					source_target: target,
					source_evidence: evidence,
					binding_status: context ? "resolved" : "unresolved",
					input_id: context?.inputId ?? null,
					delivery_at_observation: delivery,
					refresh_history: refreshHistoryAt(delivery, decidedAt),
					source_recorded_at: row.recorded_at,
				}),
			);
	}
}
