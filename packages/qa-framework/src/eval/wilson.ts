// FLY-616 — Wilson score interval (95%) for a binomial proportion.
//
// 用途：小样本（3–5 任务）下给 rate 一个**不确定性区间**，scorecard 仅作 advisory 展示。
// **绝不**用它 block/pass/fail（Codex R3/R5：CI 通常太宽，不能当决策规则）。
// 常规 CLT（normal approx）在 n 小 / p 接近 0 或 1 时失真；Wilson 更稳。

export interface Interval {
	low: number;
	high: number;
}

const Z_95 = 1.959963984540054; // z for 95%

/**
 * Wilson score interval for `successes` out of `n`.
 * Returns [0,1]-clamped {low, high}. n<=0 → {0,1} (maximally uncertain).
 */
export function wilsonInterval(
	successes: number,
	n: number,
	z = Z_95,
): Interval {
	if (n <= 0) return { low: 0, high: 1 };
	const p = successes / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const centre = p + z2 / (2 * n);
	const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
	const low = (centre - margin) / denom;
	const high = (centre + margin) / denom;
	return {
		low: Math.max(0, Math.min(1, low)),
		high: Math.max(0, Math.min(1, high)),
	};
}

/** Two intervals overlap iff neither is strictly below the other. */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
	return a.low <= b.high && b.low <= a.high;
}
