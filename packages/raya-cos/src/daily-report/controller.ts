import type { DailyReportState } from "../contracts/daily-report.js";

export type DailyReportRecoveryStep =
	| "generate"
	| "write"
	| "ingest"
	| "reconcile_ingest"
	| "announce"
	| "reconcile_announcement"
	| "complete"
	| "send_failure_notice"
	| "stop_failed"
	| "stop_unknown";

export function recoverDailyReportStep(
	state: DailyReportState,
): DailyReportRecoveryStep {
	switch (state.status) {
		case "generating":
			return "generate";
		case "generated":
			return "write";
		case "file_written":
			return "ingest";
		case "ingesting":
			return "reconcile_ingest";
		case "ingested":
			return "announce";
		case "posting":
			return "reconcile_announcement";
		case "posted":
			return "complete";
		case "failed_pending_notice":
			return "send_failure_notice";
		case "failed":
			return "stop_failed";
		case "posted_unknown":
		case "recovered_unknown":
			return "stop_unknown";
	}
}
