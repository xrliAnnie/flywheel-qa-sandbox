import {
	AUTO_NARROW_OPINION_WINDOW,
	AUTO_NARROW_PRECISION_MINIMUM,
	AUTO_NARROW_PRECISION_TARGET,
} from "flywheel-comm/auto-narrow-contract";

export interface AutoNarrowMetricSample {
	decidedAt: string;
	predicted: boolean;
	actual: boolean;
}

export interface AutoNarrowMetrics {
	sampleN: number;
	agreeN: number;
	precisionA: number;
	precisionB: number;
	confidenceLower: number | null;
	sampleStartAt: string | null;
	sampleEndAt: string | null;
	lastEligibleHumanAt: string | null;
}

export type AutoNarrowOpinionReason =
	| "eligible"
	| "gate1_failed"
	| "gate2_failed"
	| "gate3_failed"
	| "multiple_failed"
	| "negative_guard"
	| "facts_unavailable";

function wilsonLower(successes: number, total: number): number | null {
	if (total < AUTO_NARROW_PRECISION_MINIMUM) return null;
	const z = 1.959963984540054;
	const ratio = successes / total;
	const lower =
		(ratio +
			z ** 2 / (2 * total) -
			z *
				Math.sqrt((ratio * (1 - ratio)) / total + z ** 2 / (4 * total ** 2))) /
		(1 + z ** 2 / total);
	return Math.min(1, Math.max(0, lower));
}

export function computeAutoNarrowMetrics(
	samples: readonly AutoNarrowMetricSample[],
): AutoNarrowMetrics {
	const bounded = [...samples]
		.sort((left, right) => right.decidedAt.localeCompare(left.decidedAt))
		.slice(0, AUTO_NARROW_OPINION_WINDOW);
	const eligible = bounded.filter((sample) => sample.predicted);
	const dates = bounded.map((sample) => sample.decidedAt).sort();
	return {
		sampleN: bounded.length,
		agreeN: bounded.filter((sample) => sample.predicted === sample.actual)
			.length,
		precisionA: eligible.filter((sample) => sample.actual).length,
		precisionB: eligible.length,
		confidenceLower: wilsonLower(
			eligible.filter((sample) => sample.actual).length,
			eligible.length,
		),
		sampleStartAt: dates[0] ?? null,
		sampleEndAt: dates.at(-1) ?? null,
		lastEligibleHumanAt:
			eligible
				.map((sample) => sample.decidedAt)
				.sort()
				.at(-1) ?? null,
	};
}

const REASONS: Record<AutoNarrowOpinionReason, string> = {
	eligible: "三道闸均通过",
	gate1_failed: "机器未确认整单为纯文档",
	gate2_failed: "该卡缺少最新 Lead 代理声明 pure_docs",
	gate3_failed: "该 head 的强度二证据未满足",
	multiple_failed: "有多道闸未通过",
	negative_guard: "founder 已打回或仍有待处理输入",
	facts_unavailable: "卡或证据事实暂不可用",
};

function yesNo(value: boolean): "✓" | "✗" {
	return value ? "✓" : "✗";
}

function dateOnly(value: string | null): string {
	return value?.slice(0, 10) ?? "无";
}

export function renderAutoNarrowOpinion(input: {
	mode: "dry_run" | "auto";
	eligible: boolean;
	gate1: boolean;
	gate2: boolean;
	gate3: boolean;
	reasonCode: AutoNarrowOpinionReason;
	metrics: AutoNarrowMetrics;
	now: string;
	correlationMarker: string;
}): string {
	const predicted = input.eligible;
	const metric =
		input.metrics.precisionB === 0
			? "自动批命中不可判"
			: input.metrics.confidenceLower === null
				? `自动批命中 ${input.metrics.precisionA}/${input.metrics.precisionB}（置信：样本不足）`
				: `自动批命中 ${input.metrics.precisionA}/${input.metrics.precisionB}（95%下界 ${input.metrics.confidenceLower.toFixed(2)}）`;
	const agreement =
		input.metrics.sampleN === 0
			? "整体动作一致不可判"
			: `整体动作一致 ${input.metrics.agreeN}/${input.metrics.sampleN}`;
	const lastEligibleMs = Date.parse(
		input.metrics.lastEligibleHumanAt ?? "invalid",
	);
	const nowMs = Date.parse(input.now);
	const stale =
		Number.isFinite(lastEligibleMs) &&
		Number.isFinite(nowMs) &&
		nowMs - lastEligibleMs > 7 * 24 * 60 * 60 * 1_000;
	return [
		`🤖 机器意见：${predicted ? "可自动批" : "不可自动批"}`,
		`闸① 机器判纯文档 ${yesNo(input.gate1)} · 闸② Lead代理声明 pure_docs ${yesNo(input.gate2)} · 闸③ 强度二证据 ${yesNo(input.gate3)}`,
		`理由：${REASONS[input.reasonCode]}`,
		`${stale ? "历史样本，非近期验证 · " : ""}${metric} · ${agreement}`,
		`人工样本 ${input.metrics.sampleN}/${AUTO_NARROW_OPINION_WINDOW}，${dateOnly(input.metrics.sampleStartAt)} 至 ${dateOnly(input.metrics.sampleEndAt)}；最近 eligible 人工对照 ${dateOnly(input.metrics.lastEligibleHumanAt)}`,
		`模式 ${input.mode}；意见不是批准；目标 ${(AUTO_NARROW_PRECISION_TARGET * 100).toFixed(0)}%，不据此自动开启；下界不是这张卡的正确概率。`,
		input.correlationMarker,
	].join("\n");
}
