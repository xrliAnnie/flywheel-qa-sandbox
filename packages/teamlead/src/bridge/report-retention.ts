export const REPORT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** One exact age boundary shared by every hosted-report retention consumer. */
export function isReportExpired(nowMs: number, createdAtMs: number): boolean {
	return (
		Number.isFinite(createdAtMs) && nowMs - createdAtMs >= REPORT_RETENTION_MS
	);
}
