import type { RequestHandler } from "express";

export type OutboundPressureRoute =
	| "events"
	| "workflow_decision"
	| "lead_inbox_nudge";

interface RoutePressure {
	requests_total: number;
	finished_total: number;
	response_closed_before_finish_total: number;
	slow_total: number;
	max_finish_ms: number;
	last_closed_before_finish_at: string | null;
	last_closed_before_finish_after_ms: number | null;
}

const emptyPressure = (): RoutePressure => ({
	requests_total: 0,
	finished_total: 0,
	response_closed_before_finish_total: 0,
	slow_total: 0,
	max_finish_ms: 0,
	last_closed_before_finish_at: null,
	last_closed_before_finish_after_ms: null,
});

/** Per-process diagnostics; no timers or lifecycle hooks. */
export class OutboundPressureMeter {
	private readonly routes: Record<OutboundPressureRoute, RoutePressure> = {
		events: emptyPressure(),
		workflow_decision: emptyPressure(),
		lead_inbox_nudge: emptyPressure(),
	};
	constructor(
		private readonly options: {
			now?: () => number;
			recordSpan?: (name: string, startMs: number, endMs: number) => void;
		} = {},
	) {}

	observe(route: OutboundPressureRoute): RequestHandler {
		return (_req, res, next) => {
			const clock = this.options.now ?? Date.now;
			const start = clock();
			const stats = this.routes[route];
			stats.requests_total++;
			res.once("finish", () => {
				const end = clock();
				const elapsed = Math.max(0, end - start);
				stats.finished_total++;
				stats.max_finish_ms = Math.max(stats.max_finish_ms, elapsed);
				if (elapsed > 500) {
					stats.slow_total++;
					this.options.recordSpan?.(`http:${route}`, start, end);
				}
			});
			res.once("close", () => {
				if (res.writableFinished) return;
				const end = clock();
				stats.response_closed_before_finish_total++;
				stats.last_closed_before_finish_at = new Date(end).toISOString();
				stats.last_closed_before_finish_after_ms = Math.max(0, end - start);
			});
			next();
		};
	}

	snapshot(): Record<OutboundPressureRoute, RoutePressure> {
		return {
			events: { ...this.routes.events },
			workflow_decision: { ...this.routes.workflow_decision },
			lead_inbox_nudge: { ...this.routes.lead_inbox_nudge },
		};
	}
}
