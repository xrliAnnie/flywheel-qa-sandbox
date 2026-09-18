export interface ContextUsageProjection {
	ts: string;
	totalTokens: number;
	modelContextWindow: number | null;
}

export interface ContextUsageSummary {
	samples: number;
	latestTokens: number | null;
	peakTokens: number | null;
	effectiveContextWindows: number[];
}

export function summarizeContextUsage(
	rows: readonly ContextUsageProjection[],
): ContextUsageSummary {
	for (const row of rows) {
		if (
			!Number.isFinite(Date.parse(row.ts)) ||
			!Number.isSafeInteger(row.totalTokens) ||
			row.totalTokens < 0 ||
			(row.modelContextWindow !== null &&
				(!Number.isSafeInteger(row.modelContextWindow) ||
					row.modelContextWindow <= 0))
		) {
			throw new Error("context usage projection is invalid");
		}
	}
	return {
		samples: rows.length,
		latestTokens: rows.at(-1)?.totalTokens ?? null,
		peakTokens:
			rows.length > 0 ? Math.max(...rows.map((row) => row.totalTokens)) : null,
		effectiveContextWindows: [
			...new Set(
				rows.flatMap((row) =>
					row.modelContextWindow === null ? [] : [row.modelContextWindow],
				),
			),
		].sort((left, right) => left - right),
	};
}
