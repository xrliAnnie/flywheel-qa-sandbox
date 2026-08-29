// FLY-616 — metric extraction.
//
// 纯函数核心 `toQualityMetrics` (无 IO，全测) + 只读 IO 层 `collectMetrics`。
// 安全边界：DB 一律真只读 (better-sqlite3 readonly，绝不实例化 StateStore)；
// 缺质量信号绝不当 pass；lagging/cost 缺失不影响 partial (Codex R4 #3)。
// FLY-614 token / Linear lagging 真采集 = follow-up；v1 注入 mocked reader。

import type {
	Fly614TokenUsage,
	LaggingReopen,
	QualityMetrics,
	TaskRunHandle,
} from "./types.js";

// ---------- pure mappers ----------

/** session.status → completionRoute enum. */
export function mapCompletionRoute(
	status: string | null | undefined,
): QualityMetrics["completionRoute"] {
	switch (status) {
		case "completed":
			return "completed";
		case "awaiting_review":
		case "approved_to_ship":
			return "awaiting_review";
		case "blocked":
			return "blocked";
		case "failed":
			return "failed";
		default:
			return "unknown";
	}
}

/** auto_qa_record.status → qaVerdict (Codex R2 #1 / R4). */
export function mapQaVerdict(
	autoQaStatus: string | null | undefined,
): QualityMetrics["qaVerdict"] {
	switch (autoQaStatus) {
		case "passed":
			return "pass";
		case "failed":
			return "fail";
		case "running":
		case "stuck":
		case "superseded":
			return "unknown";
		default:
			return "none"; // no accepted record
	}
}

export interface LandingParse {
	prOutcome: QualityMetrics["prOutcome"];
	ciHealth: QualityMetrics["ciHealth"];
}

/**
 * land-status.json 三态解析 (语义 copy 自 ExecutionEvidenceCollector，**不 import 私有方法**，Codex R4 #2)。
 * 文件缺 (raw=null) → not attempted; pending → signal_missing; ready_to_merge/merged → green;
 * failed → 保守 unknown CI (v1 不从 landing 断 CI red — gh pr checks 是 follow-up)。
 * v1 ciHealth 只在 ready_to_merge/merged 断 green，其余 unknown (诚实：不夸大)。
 */
export function parseLandingStatus(raw: string | null): LandingParse {
	if (raw == null) return { prOutcome: "none", ciHealth: "unknown" };
	let signal: { status?: string };
	try {
		signal = JSON.parse(raw);
	} catch {
		return { prOutcome: "failed", ciHealth: "unknown" };
	}
	switch (signal.status) {
		case "ready_to_merge":
			return { prOutcome: "ready_to_merge", ciHealth: "green" };
		case "merged":
			return { prOutcome: "merged", ciHealth: "green" };
		case "failed":
			return { prOutcome: "failed", ciHealth: "unknown" };
		case "pending":
			return { prOutcome: "failed", ciHealth: "unknown" }; // signal_missing
		default:
			return { prOutcome: "unknown", ciHealth: "unknown" };
	}
}

// ---------- pure lagging logic (Codex R4) ----------

export interface StateTransition {
	at: string;
	from: string;
	to: string;
}

/**
 * Reopen 仅认状态转换历史 (Codex R4 #1)：ready/pass 时间**之后**出现 completed→非 completed。
 * 能抓 completed→started→completed 多次回炉。史料缺 (null) → null (不从快照瞎猜)。
 */
export function deriveReopenFromTransitions(
	transitions: StateTransition[] | null,
	readyAtIso: string | null,
	isCompletedType: (stateName: string) => boolean,
): boolean | null {
	if (transitions == null) return null;
	const after = readyAtIso
		? transitions.filter((t) => t.at > readyAtIso)
		: transitions;
	return after.some((t) => isCompletedType(t.from) && !isCompletedType(t.to));
}

export interface CandidateSession {
	execId: string;
	sessionRole: string | null;
	startedAt: string | null;
}

/**
 * second-runner (Codex R4 #2)：同 issue 晚于 ready/pass 的新 **main** session (排除 QA)。
 * 无可靠 pass/ready 时间 → null。原 execId 排除。
 */
export function deriveSecondRunner(
	others: CandidateSession[],
	originExecId: string,
	readyOrPassedAtIso: string | null,
): { value: boolean | null; execIds: string[] } {
	if (readyOrPassedAtIso == null) return { value: null, execIds: [] };
	const hits = others.filter(
		(s) =>
			s.execId !== originExecId &&
			(s.sessionRole ?? "main") === "main" &&
			s.startedAt != null &&
			s.startedAt > readyOrPassedAtIso,
	);
	return { value: hits.length > 0, execIds: hits.map((s) => s.execId) };
}

// ---------- pure toQualityMetrics ----------

export interface RawSignals {
	issueId: string;
	conditionLabel: string;
	execId: string | null;
	/** null = session 读不到 (hardSuccess 信号缺)。 */
	session: {
		status: string | null;
		prNumber: number | null;
		prHeadSha: string | null;
		worktreePath: string | null;
	} | null;
	/** accepted auto_qa_record for (parent, targetPrHeadSha)；null = 无记录。 */
	autoQaStatus: string | null;
	/** 是否存在 auto_qa_record family (Codex R4 #1：无 family → rework 信号缺、绝不当 0)。 */
	qaFamilyExists: boolean;
	qaFailLoops: number | null;
	landing: LandingParse;
	costContext: QualityMetrics["costContext"];
	laggingReopen: LaggingReopen | null;
}

export function toQualityMetrics(raw: RawSignals): QualityMetrics {
	const completionRoute = mapCompletionRoute(raw.session?.status);
	const { prOutcome, ciHealth } = raw.landing;
	const qaVerdict = mapQaVerdict(raw.autoQaStatus);

	const hardSuccessPresent = raw.session != null;
	const qaPresent = qaVerdict === "pass" || qaVerdict === "fail";
	const ciPresent = ciHealth === "green" || ciHealth === "red";
	const reworkPresent = raw.qaFamilyExists;
	const reworkRounds = reworkPresent ? (raw.qaFailLoops ?? 0) : null;

	const signalPresent = {
		hardSuccess: hardSuccessPresent,
		qa: qaPresent,
		ci: ciPresent,
		rework: reworkPresent,
	};
	// partial 系即时质量信号 (含 rework，Codex code review #2)；lagging/cost 缺失不进 partial (Codex R4 #3)。
	const partial = !(
		hardSuccessPresent &&
		qaPresent &&
		ciPresent &&
		reworkPresent
	);

	return {
		issueId: raw.issueId,
		conditionLabel: raw.conditionLabel,
		execId: raw.execId,
		completionRoute,
		prOutcome,
		prNumber: raw.session?.prNumber ?? null,
		qaVerdict,
		ciHealth,
		reworkRounds,
		costContext: raw.costContext,
		laggingReopen: raw.laggingReopen,
		signalPresent,
		partial,
	};
}

// ---------- readers (dependency-injected; readonly) ----------

export interface SessionRow {
	status: string | null;
	prNumber: number | null;
	prHeadSha: string | null;
	worktreePath: string | null;
}

export interface EvalReaders {
	readSession(dbPath: string, execId: string): Promise<SessionRow | null>;
	readAcceptedQaStatus(
		dbPath: string,
		parentExecId: string,
		targetPrHeadSha: string | null,
	): Promise<string | null>;
	qaFamilyExists(dbPath: string, parentExecId: string): Promise<boolean>;
	countQaFailLoops(dbPath: string, parentExecId: string): Promise<number>;
	readLandingRaw(
		handle: TaskRunHandle,
		session: SessionRow | null,
	): string | null;
	/** FLY-614 token reader. v1 默认 null (mocked)；真接入待 614 暴露稳定读面。 */
	readFly614Tokens(handle: TaskRunHandle): Promise<Fly614TokenUsage | null>;
	/** Linear lagging reader. v1 默认 not_applicable (mocked)；真采集 follow-up。 */
	readLagging(handle: TaskRunHandle): Promise<LaggingReopen | null>;
	/** diff stats (git). v1 默认 null。 */
	readDiff(handle: TaskRunHandle): Promise<{
		linesAdded: number;
		linesRemoved: number;
		filesChanged: number;
	} | null>;
}

/** v1 默认：614 token / lagging / diff 不接 (null / not_applicable)。质量信号仍真读。 */
export const v1MockedExternalReaders = {
	async readFly614Tokens(): Promise<Fly614TokenUsage | null> {
		return null; // 614 未接入 → tokenUsage=null (成本是 context，不阻塞)
	},
	async readLagging(): Promise<LaggingReopen | null> {
		// 滞后信号 v1 对 sandbox 集 N/A；真采集 follow-up
		return {
			laggingStatus: "not_applicable",
			reopened: null,
			currentStateNonCompletedAfterReady: null,
			secondRunner: null,
			refixDetected: null,
			evidence: null,
			observedAsOf: null,
		};
	},
	async readDiff(): Promise<null> {
		return null;
	},
};

/**
 * 收集一个任务的 QualityMetrics (只读)。把 readers 注入 → 纯 toQualityMetrics。
 */
export async function collectMetrics(
	handle: TaskRunHandle,
	readers: EvalReaders,
): Promise<QualityMetrics> {
	const session = await readers.readSession(handle.dbPath, handle.execId);
	const autoQaStatus = await readers.readAcceptedQaStatus(
		handle.dbPath,
		handle.execId,
		session?.prHeadSha ?? null,
	);
	const qaFamilyExists = await readers.qaFamilyExists(
		handle.dbPath,
		handle.execId,
	);
	const qaFailLoops = qaFamilyExists
		? await readers.countQaFailLoops(handle.dbPath, handle.execId)
		: null;
	const landingRaw = readers.readLandingRaw(handle, session);
	const landing = parseLandingStatus(landingRaw);

	const tokenUsage = await readers.readFly614Tokens(handle);
	const diff = await readers.readDiff(handle);
	const laggingReopen = await readers.readLagging(handle);

	return toQualityMetrics({
		issueId: handle.issueId,
		conditionLabel: handle.conditionLabel,
		execId: handle.execId,
		session,
		autoQaStatus,
		qaFamilyExists,
		qaFailLoops,
		landing,
		costContext: { tokenUsage, diff, durationMs: null },
		laggingReopen,
	});
}
