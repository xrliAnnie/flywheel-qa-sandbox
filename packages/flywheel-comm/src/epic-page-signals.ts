export const EPIC_PAGE_SIGNAL_KINDS = [
	"runner_stopped",
	"question_pending",
	"waiting_founder",
] as const;

export type EpicPageSignalKind = (typeof EPIC_PAGE_SIGNAL_KINDS)[number];

export const EPIC_PAGE_STOP_REASONS = [
	"blocked",
	"quota",
	"context_full",
	"error",
] as const;

export type EpicPageStopReason = (typeof EPIC_PAGE_STOP_REASONS)[number];

/**
 * Narrow projection for Epic-page liveness. Free-form mailbox content and
 * question identity deliberately cannot cross this boundary.
 */
export interface EpicPageSignalRow {
	kind: EpicPageSignalKind;
	execution_id: string;
	since: string;
	reason?: EpicPageStopReason;
	question_id_present: true;
}

export interface EpicPageSignalQueryResult {
	signals: EpicPageSignalRow[];
	truncated: boolean;
}
