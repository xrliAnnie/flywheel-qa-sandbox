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
	/** GEO-152: Linear issue labels for multi-lead routing */
	labels?: string[];
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
				labels: env.labels,
			},
		});
		this.track(p);
	}

	/** GEO-261: Terminal event — awaits reliable delivery with retry. */
	async emitCompleted(
		env: EventEnvelope,
		result: BlueprintResult,
		summary?: string,
	): Promise<void> {
		await this.postEventReliable({
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
				labels: result.labels,
				projectId: result.projectId,
				exitReason: result.exitReason,
				consecutiveFailures: result.consecutiveFailures,
			},
		});
	}

	/** GEO-261: Terminal event — awaits reliable delivery with retry. */
	async emitFailed(
		env: EventEnvelope,
		error: string,
		lastActivity?: string,
	): Promise<void> {
		await this.postEventReliable({
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
				labels: env.labels,
			},
		});
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

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.authToken) {
			headers.Authorization = `Bearer ${this.authToken}`;
		}
		return headers;
	}

	/**
	 * GEO-261: Post a terminal event with retry on transient failures.
	 * Fully self-contained: handles retry, timeout, and logging internally.
	 * Never throws — logs console.error on final failure.
	 */
	private async postEventReliable(
		body: Record<string, unknown>,
		maxRetries = 1,
	): Promise<void> {
		const eventType = body.event_type as string;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5_000);
			try {
				const res = await fetch(`${this.baseUrl}/events`, {
					method: "POST",
					headers: this.buildHeaders(),
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				if (res.ok) return;

				// 4xx (except 429) = permanent failure, don't retry
				if (res.status >= 400 && res.status < 500 && res.status !== 429) {
					console.error(
						`[TeamLeadClient] ${eventType} permanently rejected: ${res.status} ${res.statusText}`,
					);
					return;
				}

				// 5xx or 429 = transient, retry if possible
				const msg = `[TeamLeadClient] ${eventType} rejected: ${res.status} ${res.statusText}`;
				if (attempt < maxRetries) {
					console.warn(`${msg} (retrying in 1s...)`);
					await new Promise((r) => setTimeout(r, 1000));
				} else {
					console.error(`${msg} (no retries left)`);
				}
			} catch (err) {
				// Network error or abort timeout = transient, retry if possible
				const msg = `[TeamLeadClient] ${eventType} failed: ${err instanceof Error ? err.message : String(err)}`;
				if (attempt < maxRetries) {
					console.warn(`${msg} (retrying in 1s...)`);
					await new Promise((r) => setTimeout(r, 1000));
				} else {
					console.error(`${msg} (no retries left)`);
				}
			} finally {
				clearTimeout(timeout);
			}
		}
	}

	private async postHeartbeat(executionId: string): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3_000);
		try {
			const res = await fetch(`${this.baseUrl}/events/heartbeat`, {
				method: "POST",
				headers: this.buildHeaders(),
				body: JSON.stringify({ execution_id: executionId }),
				signal: controller.signal,
			});
			if (!res.ok) {
				console.warn(`[TeamLeadClient] Heartbeat rejected: ${res.status}`);
			}
		} catch {
			// Silently ignore heartbeat failures — they're best-effort
		} finally {
			clearTimeout(timeout);
		}
	}

	/** Best-effort event post for non-terminal events (session_started). */
	private async postEvent(body: Record<string, unknown>): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5_000);
		try {
			const res = await fetch(`${this.baseUrl}/events`, {
				method: "POST",
				headers: this.buildHeaders(),
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) {
				console.warn(
					`[TeamLeadClient] Event rejected: ${res.status} ${res.statusText}`,
				);
			}
		} catch (err) {
			console.warn(
				`[TeamLeadClient] Failed to post event: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			clearTimeout(timeout);
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
