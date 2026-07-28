export function computeSubmissionExpiry(
	nowMs: number,
	windowMinutes: number,
	absoluteDeadlineMs: number,
): number {
	if (!Number.isFinite(nowMs) || !Number.isFinite(absoluteDeadlineMs)) {
		throw new TypeError("submission expiry timestamps must be finite");
	}
	if (!Number.isInteger(windowMinutes) || windowMinutes <= 0) {
		throw new TypeError("submission window must be a positive integer");
	}
	return Math.min(nowMs + windowMinutes * 60_000, absoluteDeadlineMs);
}
