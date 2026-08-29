// FLY-616 — eval: 测量产出质量（通用能力）。
//
// 一个 condition-agnostic 的「测量 + scorecard」层：给两个 condition（如 ponytail
// off/on、换模型、换 backend）跑同一组任务，客观回答「产出质量有没有掉」。
//
// 设计合同（Annie brainstorm LOCKED + Codex design review 7 轮）：
//  - 质量信号（进 verdict）：completionRoute / prOutcome(hardSuccess) / qaVerdict / ciHealth。
//  - 返工轮数 reworkRounds：advisory，不进总软判定。
//  - cost（tokenUsage 读 FLY-614 不重算 / diff / duration）：context 报告项，不进 verdict。
//  - 滞后信号 laggingReopen（过 QA≠真修好）：软信号，不进 verdict，scorecard 摊「回炉率」。
//  - 判定：count-first advisory（摊数字 + 软建议、Annie 定线、不设硬数字门、不做加权总分）。
//  - 缺质量信号绝不当 pass（partial）；lagging/cost 缺失不影响 partial。

import { z } from "zod";

/** FLY-614 token 读契约 —— 616 只消费这个稳定结构，绝不焊死 614 内部 schema（Codex R6）。 */
export const Fly614TokenUsageSchema = z.object({
	source: z.literal("fly-614"),
	totalTokens: z.number().nonnegative(),
	inputTokens: z.number().nonnegative().nullable().optional(),
	outputTokens: z.number().nonnegative().nullable().optional(),
	cacheReadTokens: z.number().nonnegative().nullable().optional(),
	cacheWriteTokens: z.number().nonnegative().nullable().optional(),
	/** 主键 execution-id-first；workspace 仅 614 侧辅助。 */
	lookup: z.object({
		projectName: z.string(),
		issueId: z.string(),
		execId: z.string(),
		worktreePath: z.string().optional(),
		claudeSessionId: z.string().optional(),
		workspaceName: z.string().optional(),
	}),
	confidence: z.enum(["exact_execution", "workspace_time_window"]),
	observedAt: z.string().optional(),
});
export type Fly614TokenUsage = z.infer<typeof Fly614TokenUsageSchema>;

/** 滞后软信号「过 QA≠真修好」（Annie ⑤）。不进 verdict；缺失不影响 partial。 */
export const LaggingReopenSchema = z.object({
	laggingStatus: z.enum([
		"observed",
		"pending",
		"not_applicable",
		"unavailable",
	]),
	/** Linear：仅当状态转换历史显示 ready/pass 后 completed→非 completed（Codex R4 #1）。史料缺→null。 */
	reopened: z.boolean().nullable(),
	/** 快照弱 context（当前非 completed），不叫 reopened。 */
	currentStateNonCompletedAfterReady: z.boolean().nullable(),
	/** 同 issue 晚于 ready/pass 的新 main session（排除 QA）。无可靠 pass 时间→null（Codex R4 #2）。 */
	secondRunner: z.boolean().nullable(),
	refixDetected: z.boolean().nullable(),
	evidence: z
		.object({
			currentState: z.string().optional(),
			transitions: z
				.array(z.object({ at: z.string(), from: z.string(), to: z.string() }))
				.optional(),
			secondRunnerExecIds: z.array(z.string()).optional(),
		})
		.nullable()
		.optional(),
	observedAsOf: z.string().nullable(),
});
export type LaggingReopen = z.infer<typeof LaggingReopenSchema>;

export const CompletionRouteSchema = z.enum([
	"completed",
	"awaiting_review",
	"blocked",
	"failed",
	"unknown",
]);
export const PrOutcomeSchema = z.enum([
	"ready_to_merge",
	"merged",
	"failed",
	"none",
	"unknown",
]);
export const QaVerdictSchema = z.enum(["pass", "fail", "none", "unknown"]);
export const CiHealthSchema = z.enum(["green", "red", "unknown"]);

/** 一个任务在一个 condition 下的客观指标。 */
export const QualityMetricsSchema = z.object({
	issueId: z.string(),
	conditionLabel: z.string(),
	execId: z.string().nullable(),
	// 质量信号（进 verdict）
	completionRoute: CompletionRouteSchema,
	prOutcome: PrOutcomeSchema,
	/** sessions.pr_number；hardSuccess 判据需要它（Codex code review HIGH-1）。 */
	prNumber: z.number().int().nullable(),
	qaVerdict: QaVerdictSchema,
	ciHealth: CiHealthSchema,
	// advisory（不进总软判定）
	reworkRounds: z.number().int().nonnegative().nullable(),
	// context（cost，不进 verdict）
	costContext: z
		.object({
			tokenUsage: Fly614TokenUsageSchema.nullable(),
			diff: z
				.object({
					linesAdded: z.number().int().nonnegative(),
					linesRemoved: z.number().int().nonnegative(),
					filesChanged: z.number().int().nonnegative(),
				})
				.nullable()
				.optional(),
			durationMs: z.number().nonnegative().nullable().optional(),
		})
		.nullable(),
	// 滞后软信号（不进 verdict）
	laggingReopen: LaggingReopenSchema.nullable(),
	// 主观（下一阶段，留空槽）
	subjective: z
		.object({
			score: z.number(),
			rubric: z.string(),
			notes: z.string().optional(),
		})
		.nullable()
		.optional(),
	// coverage / 完整性 —— 只系即时质量信号（lagging/cost 缺失不进 partial）
	signalPresent: z.object({
		hardSuccess: z.boolean(),
		qa: z.boolean(),
		ci: z.boolean(),
		rework: z.boolean(),
	}),
	partial: z.boolean(),
});
export type QualityMetrics = z.infer<typeof QualityMetricsSchema>;

/** 执行那层每跑一条写一行（eval 只按 manifest 提取，不靠 issueId 启发式）。 */
export const TaskRunHandleSchema = z.object({
	issueId: z.string(),
	conditionLabel: z.string(),
	execId: z.string(),
	projectName: z.string(),
	dbPath: z.string(),
	worktreePath: z.string().optional(),
	landStatusPath: z.string().optional(),
	slotDir: z.string().optional(),
	hostRepo: z.string().optional(),
	expectedPrNumber: z.number().int().optional(),
	notes: z.string().optional(),
});
export type TaskRunHandle = z.infer<typeof TaskRunHandleSchema>;

export const EvalRunManifestSchema = z.object({
	meta: z.object({
		issue: z.string(),
		date: z.string(),
		taskSet: z.array(z.string()),
	}),
	conditionLabel: z.string(),
	handles: z.array(TaskRunHandleSchema),
});
export type EvalRunManifest = z.infer<typeof EvalRunManifestSchema>;

/** 一个 condition 的聚合（分母 = 期望任务数；缺信号算非-pass）。 */
export interface ConditionAggregate {
	conditionLabel: string;
	n: number;
	hardSuccessRate: number;
	qaPassRate: number;
	ciGreenRate: number;
	avgReworkRounds: number | null;
	coverage: { hardSuccess: number; qa: number; ci: number; rework: number };
	partialCount: number;
	// context（报告）
	costSummary: {
		medianTotalTokens: number | null;
		medianLinesChanged: number | null;
	} | null;
	// 滞后（报告）
	recycle: { observed: number; recycled: number; rate: number | null };
}

/** 一个 condition 一卡的 scorecard 输入。 */
export interface ConditionResult {
	label: string;
	tasks: QualityMetrics[];
	aggregate: ConditionAggregate;
}

export interface EvalScorecardInput {
	meta: { issue: string; date: string; note?: string; taskSet: string[] };
	conditions: ConditionResult[];
	comparison?: EvalComparison | null;
}

/** 主指标软标签。 */
export type SoftLabel = "looks_hold" | "looks_dropped" | "unclear";
/** 总软建议。 */
export type OverallSuggestion = "looks_hold" | "looks_dropped" | "unclear";

export interface MetricComparison {
	metric: "hardSuccess" | "qa" | "ci";
	baselineRate: number;
	candidateRate: number;
	baselineCount: number;
	candidateCount: number;
	countDelta: number;
	rateDelta: number;
	/** Wilson 95% CI（advisory 展示，绝不当判据）。 */
	baselineCi: { low: number; high: number };
	candidateCi: { low: number; high: number };
	ciOverlap: boolean;
	softLabel: SoftLabel;
}

/** compare(baseline, candidate) 的输出 —— count-first advisory，不阻断，Annie 定最终线。 */
export interface EvalComparison {
	baselineLabel: string;
	candidateLabel: string;
	n: { baseline: number; candidate: number };
	metrics: MetricComparison[];
	overall: OverallSuggestion;
	/** inconclusive 时为 true（样本小 / coverage 不全 / task set 不配对）。 */
	inconclusive: boolean;
	reasons: string[];
	// advisory-only（不进 overall）
	reworkAdvisory: {
		baselineAvg: number | null;
		candidateAvg: number | null;
		baselineSum: number | null;
		candidateSum: number | null;
		note: string | null;
	};
	recycleAdvisory: {
		baselineRate: number | null;
		candidateRate: number | null;
		note: string | null;
	};
}
