import { randomUUID } from "node:crypto";
import type { BlueprintResult } from "./Blueprint.js";

export interface EventEnvelope {
	executionId: string;
	issueId: string;
	projectName: string;
	issueIdentifier?: string;
	issueTitle?: string;
	retryPredecessor?: string;
	runAttempt?: number;
}

export interface ExecutionEventEmitter {
	emitStarted(env: EventEnvelope): Promise<void>;
	emitCompleted(
		env: EventEnvelope,
		result: BlueprintResult,
		summary?: string,
	): Promise<void>;
	emitFailed(
		env: EventEnvelope,
		error: string,
		lastActivity?: string,
	): Promise<void>;
	/** GEO-157: Heartbeat — dedicated route, no session_events, no OpenClaw notification */
	emitHeartbeat(env: EventEnvelope): Promise<void>;
	flush(): Promise<void>;
}

export class TeamLeadClient implements ExecutionEventEmitter {
	private pending: Promise<void>[] = [];
	private settled = new Set<Promise<void>>();

	constructor(
		private baseUrl: string,
		private authToken?: string,
	) {}

	async emitStarted(env: EventEnvelope): Promise<void> {
		const p = this.postEvent({
			event_id: randomUUID(),
			execution_id: env.executionId,
			issue_id: env.issueId,
			project_name: env.projectName,
			event_type: "session_started",
			payload: {
				issueIdentifier: env.issueIdentifier,
				issueTitle: env.issueTitle,
			},
		});
		this.track(p);
	}

	async emitCompleted(
		env: EventEnvelope,
		result: BlueprintResult,
		summary?: string,
	): Promise<void> {
		const p = this.postEvent({
			event_id: randomUUID(),
			execution_id: env.executionId,
			issue_id: env.issueId,
			project_name: env.projectName,
			event_type: "session_completed",
			payload: {
				issueIdentifier: env.issueIdentifier,
				issueTitle: env.issueTitle,
				evidence: result.evidence,
				decision: result.decision,
				summary,
			},
		});
		this.track(p);
	}

	async emitFailed(
		env: EventEnvelope,
		error: string,
		lastActivity?: string,
	): Promise<void> {
		const p = this.postEvent({
			event_id: randomUUID(),
			execution_id: env.executionId,
			issue_id: env.issueId,
			project_name: env.projectName,
			event_type: "session_failed",
			payload: {
				issueIdentifier: env.issueIdentifier,
				issueTitle: env.issueTitle,
				error,
				lastActivity,
			},
		});
		this.track(p);
	}

	async emitHeartbeat(env: EventEnvelope): Promise<void> {
		// Dedicated heartbeat route — lightweight, no session_events, no OpenClaw notification
		const p = this.postHeartbeat(env.executionId);
		this.track(p);
	}

	async flush(): Promise<void> {
		await Promise.allSettled(this.pending);
		this.pending = [];
		this.settled.clear();
	}

	/** Track a fire-and-forget promise, draining settled ones to prevent unbounded growth. */
	private track(p: Promise<void>): void {
		const tracked = p.finally(() => this.settled.add(tracked));
		this.pending.push(tracked);
		// Periodically drain settled entries
		if (this.settled.size > 0) {
			this.pending = this.pending.filter((item) => !this.settled.has(item));
			this.settled.clear();
		}
	}

	private async postHeartbeat(executionId: string): Promise<void> {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (this.authToken) {
				headers.Authorization = `Bearer ${this.authToken}`;
			}
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 3_000);
			const res = await fetch(`${this.baseUrl}/events/heartbeat`, {
				method: "POST",
				headers,
				body: JSON.stringify({ execution_id: executionId }),
				signal: controller.signal,
			});
			clearTimeout(timeout);
			if (!res.ok) {
				// Heartbeat failures are non-critical — just warn
				console.warn(`[TeamLeadClient] Heartbeat rejected: ${res.status}`);
			}
		} catch {
			// Silently ignore heartbeat failures — they're best-effort
		}
	}

	private async postEvent(body: Record<string, unknown>): Promise<void> {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (this.authToken) {
				headers.Authorization = `Bearer ${this.authToken}`;
			}
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5_000);
			const res = await fetch(`${this.baseUrl}/events`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			clearTimeout(timeout);
			if (!res.ok) {
				console.warn(
					`[TeamLeadClient] Event rejected: ${res.status} ${res.statusText}`,
				);
			}
		} catch (err) {
			console.warn(
				`[TeamLeadClient] Failed to post event: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

export class NoOpEventEmitter implements ExecutionEventEmitter {
	async emitStarted(_env: EventEnvelope): Promise<void> {}
	async emitCompleted(
		_env: EventEnvelope,
		_result: BlueprintResult,
	): Promise<void> {}
	async emitFailed(_env: EventEnvelope, _error: string): Promise<void> {}
	async emitHeartbeat(_env: EventEnvelope): Promise<void> {}
	async flush(): Promise<void> {}
}
