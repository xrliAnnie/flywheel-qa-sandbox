import { CommDB } from "flywheel-comm/db";
import type { AutoQaRecord, Session, StateStore } from "../StateStore.js";
import { type ReviewHoldReason, reviewHoldReason } from "./auto-qa-held.js";
import type { DetectionEscalationInput } from "./detection-escalation.js";

export const PARK_KIND_PREFIX = "park:";
export const LEAD_ONLY_PARK_KINDS = new Set([
	"park:qa_hold_healthy",
	"park:qa_hold_orphaned",
	"park:runner_or_ci",
	"park:review_hold",
]);

const REVIEW_HOLD_NOTICE: Record<
	ReviewHoldReason,
	{ reason: string; nextStep: string }
> = {
	merge_block: {
		reason: "review hold(merge_block):当前 head 缺少可验证的合并授权",
		nextStep: "Lead 处理 same-head approval recovery;hold 清除前不呈 founder",
	},
	codex_pending: {
		reason:
			"review hold(codex_pending):cross-family code review 未形成有效记录",
		nextStep: "Lead 检查 review job/记录投递并重驱;hold 清除前不呈 founder",
	},
	qa_not_green: {
		reason: "review hold(qa_not_green):独立 QA 尚未通过",
		nextStep: "Lead 巡检 QA/retest/recovery;hold 清除前不呈 founder",
	},
	qa_evidence_missing: {
		reason:
			"review hold(qa_evidence_missing):ship-relevant head 缺少 QA PASS 证据",
		nextStep: "Lead 触发或修复独立 QA 证据链;hold 清除前不呈 founder",
	},
	qa_evidence_unknown: {
		reason: "review hold(qa_evidence_unknown):PR head 或 QA 证据无法可靠判定",
		nextStep: "Lead 修复 head/evidence 读取并重新判定;hold 清除前不呈 founder",
	},
	no_qualified_reviewer: {
		reason:
			"review hold(no_qualified_reviewer):没有合格的 cross-family reviewer",
		nextStep: "Lead 补充或重派合格 reviewer;hold 清除前不呈 founder",
	},
};

export function reviewHoldParkNotice(reason: ReviewHoldReason): {
	kind: "park:review_hold";
	reason: string;
	nextStep: string;
} {
	return { kind: "park:review_hold", ...REVIEW_HOLD_NOTICE[reason] };
}

export interface ParkWatchOptions {
	store: Pick<
		StateStore,
		| "listParkWatchSessions"
		| "listParkWatchAutoQaRecords"
		| "getSession"
		| "getAutoQaRecord"
		| "getShipRelevantDiffSnapshot"
		| "isCodexCodeReviewApproved"
		| "observeParkCondition"
		| "getDetectionEscalationsForReconcile"
		| "ackDetectionEscalation"
	>;
	commDbPathForProject: (projectName: string) => string;
	notify: (input: DetectionEscalationInput) => Promise<void>;
	now?: () => number;
	n1Ms?: number;
	qaHealthyMs?: number;
	qaRegistrationGraceMs?: number;
}

interface Condition {
	session: Session;
	kind: string;
	fingerprint: string;
	firstDetectedAtMs: number;
	reason: string;
	nextStep: string;
	minAgeMs: number;
	minObservations?: number;
}

function sqliteMs(value?: string): number | null {
	if (!value) return null;
	const hasZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(value);
	const parsed = Date.parse(hasZone ? value : `${value.replace(" ", "T")}Z`);
	return Number.isFinite(parsed) ? parsed : null;
}

function positiveEnv(
	name: string,
	fallback: number,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const value = Number.parseInt(env[name] ?? "", 10);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Founder grace starts after the durable Lead-first park notification. */
export function parkFounderGraceMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return positiveEnv("FLYWHEEL_PARK_N2_MS", 10 * 60_000, env);
}

function qaCondition(
	record: AutoQaRecord,
	parent: Session,
	store: ParkWatchOptions["store"],
	nowMs: number,
	qaHealthyMs: number,
	registrationGraceMs: number,
): Condition | null {
	const started = sqliteMs(record.started_at) ?? nowMs;
	const base = {
		session: parent,
		fingerprint: `${record.target_pr_head_sha}:${record.qa_execution_id ?? record.retry_attempt_id ?? "unbound"}`,
		firstDetectedAtMs: started,
	};
	if (record.status === "stuck") {
		return {
			...base,
			kind: "park:qa_recovery_exhausted",
			reason: "独立 QA 已死亡且自动 clean-retry 预算耗尽",
			nextStep: "Lead 检查 QA worktree/dispatcher 并恢复 implement 流水线",
			minAgeMs: 0,
		};
	}
	if (record.status === "retry_pending" || record.status === "retry_starting") {
		return null;
	}
	if (record.status === "running") {
		const qa = record.qa_execution_id
			? store.getSession(record.qa_execution_id)
			: undefined;
		const registrationPending =
			!record.qa_execution_id && nowMs - started < registrationGraceMs;
		if (registrationPending) return null;
		if (!qa || qa.status !== "running") {
			return {
				...base,
				kind: "park:qa_hold_orphaned",
				reason: "implement 仍被 QA hold,但对应 QA session 不存在或已终止",
				nextStep: "Lead 确认自动 clean-retry 已启动;未启动则处理 QA recovery",
				minAgeMs: 0,
			};
		}
	}
	return {
		...base,
		kind: "park:qa_hold_healthy",
		reason: "implement 长时间处于健康 QA/retest hold",
		nextStep: "Lead 巡检 QA 进度;健康则继续等待",
		minAgeMs: qaHealthyMs,
	};
}

function sessionAnchor(session: Session, nowMs: number): number {
	return (
		sqliteMs(session.awaiting_review_entered_at) ??
		sqliteMs(session.stage_updated_at) ??
		sqliteMs(session.last_activity_at) ??
		sqliteMs(session.started_at) ??
		nowMs
	);
}

function key(row: {
	target_key: string;
	kind: string;
	episode_fingerprint: string;
}): string {
	return `${row.target_key}\u0000${row.kind}\u0000${row.episode_fingerprint}`;
}

export async function runParkWatch(options: ParkWatchOptions): Promise<void> {
	if (process.env.FLYWHEEL_PARK_WATCH === "0") return;
	const nowMs = options.now?.() ?? Date.now();
	const n1Ms = options.n1Ms ?? positiveEnv("FLYWHEEL_PARK_N1_MS", 10 * 60_000);
	const qaHealthyMs =
		options.qaHealthyMs ??
		positiveEnv("FLYWHEEL_PARK_QA_N3_MS", 2 * 60 * 60_000);
	const registrationGraceMs = options.qaRegistrationGraceMs ?? 10 * 60_000;
	const sessions = options.store.listParkWatchSessions();
	const recordsByParent = new Map<string, AutoQaRecord>();
	for (const record of options.store.listParkWatchAutoQaRecords()) {
		recordsByParent.set(record.parent_execution_id, record);
	}

	const active = new Set<string>();
	const dbByProject = new Map<string, CommDB | null>();
	const dbFor = (project: string): CommDB | null => {
		if (dbByProject.has(project)) return dbByProject.get(project) ?? null;
		try {
			const db = CommDB.openReadonly(options.commDbPathForProject(project));
			dbByProject.set(project, db);
			return db;
		} catch {
			dbByProject.set(project, null);
			return null;
		}
	};

	try {
		for (const session of sessions) {
			const conditions: Condition[] = [];
			const qaRecord = recordsByParent.get(session.execution_id);
			const holdReason = reviewHoldReason(options.store, session);
			if (qaRecord) {
				const qa = qaCondition(
					qaRecord,
					session,
					options.store,
					nowMs,
					qaHealthyMs,
					registrationGraceMs,
				);
				if (qa) conditions.push(qa);
			} else if (session.status === "awaiting_review") {
				const anchor = sessionAnchor(session, nowMs);
				const qid = session.review_question_id;
				if (qid && qid !== "unbound") {
					const db = dbFor(session.project_name);
					if (db) {
						const response = db.getResponse(qid);
						const message = db.getMessageById(qid);
						if (
							!response &&
							(!message || message.relay_state === "terminal_disposed")
						) {
							const superseded = Boolean(message?.superseded_at);
							conditions.push({
								session,
								kind: message
									? superseded
										? "park:gate_superseded"
										: "park:gate_unreachable"
									: "park:gate_row_missing",
								fingerprint: `gate:${qid}`,
								firstDetectedAtMs: anchor,
								reason: message
									? superseded
										? `session 的旧审批 lap 已被同 issue 更新的 gate 取代(supersededBy=${message.superseded_by ?? "unknown"})`
										: "session 仍等审批,但 gate 已不可回答"
									: "session 仍等审批,但 CommDB gate row 已丢失",
								nextStep: superseded
									? "Lead 等 issue 终态清理旧 runner;不要重建或重绑这个旧 gate"
									: "Lead 重新建立并绑定审批 gate",
								minAgeMs: 0,
								minObservations: 2,
							});
						}
					}
				}
				// A broken/missing gate is the more specific incident and wins. Otherwise
				// a review hold remains Lead-visible but founder-suppressed; only a fully
				// actionable review wait uses the founder-pageable generic kind.
				if (conditions.length === 0) {
					if (holdReason !== null) {
						const notice = reviewHoldParkNotice(holdReason);
						conditions.push({
							session,
							kind: notice.kind,
							fingerprint: `review-hold:${holdReason}:${session.pr_head_sha ?? "unknown"}:${session.review_question_id ?? "missing"}`,
							firstDetectedAtMs: anchor,
							reason: notice.reason,
							nextStep: notice.nextStep,
							minAgeMs: n1Ms,
						});
					} else {
						conditions.push({
							session,
							kind: "park:awaiting_review",
							fingerprint: `review:${session.review_question_id ?? "missing"}:${session.pr_head_sha ?? "unknown"}`,
							firstDetectedAtMs: anchor,
							reason: `runner 已 park 在 founder 审批门(PR #${session.pr_number ?? "?"})`,
							nextStep: "Lead 确认审批卡已呈给 founder并跟进决定",
							minAgeMs: n1Ms,
						});
					}
				}
			} else if (holdReason !== null) {
				const notice = reviewHoldParkNotice(holdReason);
				conditions.push({
					session,
					kind: notice.kind,
					fingerprint: `review-hold:${holdReason}:${session.pr_head_sha ?? "unknown"}:${session.review_question_id ?? "missing"}`,
					firstDetectedAtMs: sessionAnchor(session, nowMs),
					reason: notice.reason,
					nextStep: notice.nextStep,
					minAgeMs: n1Ms,
				});
			} else if (session.status === "blocked") {
				conditions.push({
					session,
					kind: "park:blocked",
					fingerprint: `blocked:${session.last_error ?? session.decision_reasoning ?? "unknown"}`,
					firstDetectedAtMs: sessionAnchor(session, nowMs),
					reason: "runner goal 已自标 blocked,流水线需要人工处理",
					nextStep: "Lead 查看 blocker,恢复执行或把决策呈给 founder",
					minAgeMs: 0,
				});
			}

			const db = dbFor(session.project_name);
			if (db && holdReason === null) {
				const declared = db.getEffectiveDeclaredState(
					session.execution_id,
					nowMs,
				);
				if (declared?.kind === "parked") {
					conditions.push({
						session,
						kind: "park:declared",
						fingerprint: `declared:${declared.created_at}`,
						firstDetectedAtMs: declared.created_at,
						reason: `runner 自声明 park${declared.reason ? `:${declared.reason}` : ""}`,
						nextStep: "Lead 巡检等待原因并在可继续时 unpark/wake",
						minAgeMs: n1Ms,
					});
				}
			}

			for (const condition of conditions) {
				const row = options.store.observeParkCondition({
					targetKey: session.execution_id,
					kind: condition.kind,
					episodeFingerprint: condition.fingerprint,
					issueId: session.issue_id,
					firstDetectedAtMs: condition.firstDetectedAtMs,
				});
				active.add(key(row));
				if (row.status !== "NEW") continue;
				if (nowMs - row.first_detected_at_ms < condition.minAgeMs) continue;
				if (row.attempts < (condition.minObservations ?? 1)) continue;
				await options.notify({
					targetKey: session.execution_id,
					kind: condition.kind,
					episodeFingerprint: condition.fingerprint,
					executionId: session.execution_id,
					issueId: session.issue_id,
					issueIdentifier: session.issue_identifier,
					projectName: session.project_name,
					firstDetectedAtMs: row.first_detected_at_ms,
					reason: condition.reason,
					nextStep: condition.nextStep,
				});
			}
		}

		for (const row of options.store.getDetectionEscalationsForReconcile()) {
			if (!row.kind.startsWith(PARK_KIND_PREFIX)) continue;
			if (active.has(key(row))) continue;
			const session = options.store.getSession(row.target_key);
			if (!session) continue;
			const requiresCommEvidence =
				row.kind === "park:declared" ||
				row.kind === "park:gate_row_missing" ||
				row.kind === "park:gate_unreachable" ||
				row.kind === "park:gate_superseded";
			if (requiresCommEvidence && !dbFor(session.project_name)) continue;
			options.store.ackDetectionEscalation(
				row.target_key,
				row.kind,
				row.episode_fingerprint,
				{ atMs: nowMs, disposition: "resolve", via: "recovery" },
			);
		}
	} finally {
		for (const db of dbByProject.values()) db?.close();
	}
}
