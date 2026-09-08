// FLY-2383: proving that real runner orchestration was actually in flight.
//
// `mode=live` is only a candidate list. Its lifecycle set includes pending,
// ship_parked, awaiting_review, design_done and approved_to_ship, so a live row
// whose activity timestamp moves is not evidence that a runner is executing.
// Only the per-session /status receipt can say that.

/**
 * The list response and the single-session status response use different field
 * names for the lifecycle: the list carries `status`, while `/status` adds
 * `session_status` next to its own pane-derived `status`. Filtering the list on
 * `session_status` yields zero candidates and would misreport a usable window as
 * "no orchestration overlap".
 */
export function parseLiveCandidates(payload, options = {}) {
	const excluded = new Set(options.excludeExecutionIds ?? []);
	const sessions = payload?.sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("live sessions payload has no sessions array");
	}
	return sessions
		.filter((session) => typeof session?.execution_id === "string")
		.filter((session) => session.status === "running")
		.filter((session) => !excluded.has(session.execution_id))
		.map((session) => ({
			executionId: session.execution_id,
			status: session.status,
			projectName: session.project_name ?? null,
			issueTitle: session.issue_title ?? null,
		}));
}

export function parseStatusReceipt(payload) {
	if (!payload || typeof payload !== "object") {
		throw new Error("status receipt is not an object");
	}
	const executionId = payload.execution_id;
	if (typeof executionId !== "string" || executionId.length === 0) {
		throw new Error("status receipt has no execution_id");
	}
	return {
		executionId,
		paneStatus: payload.status ?? null,
		sessionStatus: payload.session_status ?? null,
		checkedAt: payload.checked_at ?? null,
		executing:
			payload.session_status === "running" && payload.status === "executing",
	};
}

/**
 * Reduce the samples to the intervals where at least one foreign runner was
 * actually executing. Sampling errors are kept as instrumentation faults — they
 * are emphatically not "zero live sessions".
 */
export function summarizeOrchestrationOverlap(samples, options = {}) {
	const windowStartMonoMs = options.windowStartMonoMs ?? 0;
	const windowEndMonoMs = options.windowEndMonoMs ?? Number.POSITIVE_INFINITY;
	const inWindow = samples.filter(
		(sample) =>
			sample.atMonoMs >= windowStartMonoMs &&
			sample.atMonoMs <= windowEndMonoMs,
	);
	const faults = inWindow.filter((sample) => sample.instrumentationError);
	const executing = inWindow.filter(
		(sample) => !sample.instrumentationError && sample.executing,
	);
	const intervals = [];
	for (const sample of executing) {
		const previous = intervals[intervals.length - 1];
		if (
			previous &&
			previous.executionId === sample.executionId &&
			sample.atMonoMs - previous.endMonoMs <= (options.mergeGapMs ?? 90_000)
		) {
			previous.endMonoMs = sample.atMonoMs;
			previous.samples += 1;
			continue;
		}
		intervals.push({
			executionId: sample.executionId,
			startMonoMs: sample.atMonoMs,
			endMonoMs: sample.atMonoMs,
			samples: 1,
		});
	}
	return {
		samples: inWindow.length,
		executingSamples: executing.length,
		instrumentationFaults: faults.length,
		intervals,
		// The third condition is only satisfied when a real, foreign runner was
		// observed executing inside the voice window.
		qualifyingOverlap: intervals.length > 0,
	};
}
