import { randomUUID } from "node:crypto";
import type {
	DesignBackend,
	SkillFrameworkMode,
	SkillFrameworkVia,
} from "flywheel-config";
import type { TerminalFailureInfo } from "flywheel-core";
import type { BlueprintResult } from "./Blueprint.js";

export interface EventEnvelope {
	executionId: string;
	issueId: string;
	projectName: string;
	issueIdentifier?: string;
	issueTitle?: string;
	/** Bridge-derived founder-visible route line. Direct sink only; never HTTP. */
	routeSummary?: string;
	retryPredecessor?: string;
	runAttempt?: number;
	/** GEO-152: Linear issue labels for multi-lead routing */
	labels?: string[];
	/** FLY-59: Session role for multi-session-per-issue support */
	sessionRole?: string;
	/** FLY-1259: effective design vendor locked at DAG workflow admission. */
	designBackend?: DesignBackend;
	/**
	 * FLY-793 (Step 11): the chat-thread role, computed ONCE at dispatch as
	 * `shareParentBranch ? sessionRole : 'main'`. Carried on session_started so both
	 * started sinks persist `sessions.chat_thread_role` — the durable signal that
	 * routes Session-based thread resolution to the phase side-table (a plain
	 * `sessionRole==='qa'` auto-QA runner on a SEPARATE issue is NOT a phase, so it
	 * stays 'main'). Absent → 'main' (byte-compatible).
	 */
	chatThreadRole?: string;
	/**
	 * FLY-493: the resolved executor backend ("claude-tmux" | "codex-tmux" |
	 * "antigravity-tmux" | "kimi-tmux"). Persisted as `session.adapter_type` so
	 * the dashboard/wake surfaces can see it — in particular so the no-transport
	 * wake-guard recognizes a no-transport (e.g. antigravity / kimi, transport=none)
	 * session and never routes a wake to the env-default claude mailbox.
	 */
	runnerBackend?: string;
	/**
	 * FLY-728: the resolved runner model (e.g. "claude-fable-5", "opus"). Persisted
	 * as `session.runner_model` so the dashboard / issue surfaces show which model a
	 * per-issue routed runner is using. Absent → no `--model` override was resolved
	 * (account default), persisted as NULL (byte-compatible).
	 */
	runnerModel?: string;
	/**
	 * FLY-615: the resolved ponytail condition for this run (e.g. "on:label",
	 * "off:default", "unavailable:readiness:on:project"). Persisted as
	 * `session.ponytail_condition` — the join key for FLY-614 token accounting +
	 * FLY-616 quality eval A/B buckets. Absent → no ponytail condition recorded
	 * (byte-compatible).
	 */
	ponytailCondition?: string;
	/**
	 * FLY-1356: the EFFECTIVE skill-framework arm for this run (post matt
	 * readiness fallback) + how it was decided. Persisted as
	 * `sessions.skill_framework_mode` / `skill_framework_mode_via` — the
	 * attribution join key for the A/B/C split eval. Absent → the flag sat at
	 * its default when this run resolved (byte-compatible; no columns written).
	 */
	skillFrameworkMode?: SkillFrameworkMode;
	skillFrameworkModeVia?: SkillFrameworkVia;
	/**
	 * FLY-1372 §2.5: Bridge-TRUSTED behavior fields, set only for engine-owned
	 * generalized (pipeline.dag) starts so they land in the session row at
	 * creation time (crash-convergent, no post-start patch window).
	 *
	 * AUTHORITY BOUNDARY (Codex design R3-3): these are SERVER-computed gate
	 * inputs. Only the Bridge-local DirectEventSink persists them.
	 * `TeamLeadClient.emitStarted` must NEVER transmit them — the shared HTTP
	 * `/events` ingest token is runner-visible and cannot carry Bridge
	 * authority (same red line as the worktree binding note below) — and the
	 * `/events` session_started handler must ignore any same-named runner
	 * payload fields.
	 */
	docTier?: string;
	issueUrl?: string;
	codexSkip?: boolean;
}

/**
 * FLY-1185 §2.1: the create-time worktree authority binding Blueprint carries
 * alongside `worktree_ready`. ONLY the bridge-local DirectEventSink turns it
 * into StateStore authority (`bindWorktreeOnce`); the HTTP TeamLeadClient
 * deliberately NEVER transmits it — the shared `/events` ingest token is
 * runner-visible, so the HTTP mode structurally has no authority channel and
 * its worktree objects stay unowned/manual-only.
 */
export interface WorktreeBindingInfo {
	branch: string;
	generation: string;
	/** Bridge-local immutable no-artifact baseline; HTTP emitters discard it. */
	repoBaselineSetJson?: string;
	repoBaselineSetDigest?: string;
}

export interface ExecutionEventEmitter {
	emitStarted(env: EventEnvelope): Promise<void>;
	/**
	 * FLY-137: Notify Bridge that the worktree has been created so it can
	 * persist `session.worktree_path` BEFORE the Runner can fire any stage
	 * event (design_review / pr_created). Must be awaited by the caller —
	 * stage handlers downstream rely on the session row carrying the right
	 * worktree path, otherwise `skip.json` and review markers land in a
	 * fallback directory the Runner can't see.
	 *
	 * FLY-1185: `binding` (branch + creation generation) is authority input
	 * for the bridge-local sink only — see WorktreeBindingInfo.
	 */
	emitWorktreeReady(
		env: EventEnvelope,
		worktreePath: string,
		binding?: WorktreeBindingInfo,
	): Promise<void>;
	emitCompleted(
		env: EventEnvelope,
		result: BlueprintResult,
		summary?: string,
	): Promise<void>;
	emitFailed(
		env: EventEnvelope,
		error: string,
		lastActivity?: string,
		failure?: TerminalFailureInfo,
	): Promise<void>;
	/** GEO-157: Heartbeat — dedicated route, no session_events, no lead notification */
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
				sessionRole: env.sessionRole,
				designBackend: env.designBackend,
				// FLY-793 (Codex full-PR R1 #4): carry the chat-thread role on the HTTP
				// started payload too — real runners emit via this client, so without it
				// the /events sink defaults to "main" and (INSERT-once, never updated)
				// permanently misroutes a phase session's thread to the main table.
				chatThreadRole: env.chatThreadRole,
				// FLY-493: executor backend → persisted as session.adapter_type.
				runnerBackend: env.runnerBackend,
				// FLY-728: resolved runner model → persisted as session.runner_model.
				runnerModel: env.runnerModel,
				// FLY-615: ponytail condition → persisted as session.ponytail_condition.
				ponytailCondition: env.ponytailCondition,
				// FLY-1356 (Codex R1 HIGH-3 — the FLY-793 lesson, one field down):
				// the arm attribution must ride the HTTP payload too. The /events
				// sink records only what is actually on the wire (event-route
				// requires BOTH enums valid before persisting), so omitting these
				// here silently drops the A/B/C eval join key for any HTTP emitter.
				skillFrameworkMode: env.skillFrameworkMode,
				skillFrameworkModeVia: env.skillFrameworkModeVia,
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
				reviewQuestionId: result.reviewQuestionId,
				summary,
				labels: result.labels,
				projectId: result.projectId,
				exitReason: result.exitReason,
				consecutiveFailures: result.consecutiveFailures,
				sessionRole: env.sessionRole,
				// FLY-123 R1 #4: adapter resume params (e.g. Codex threadId)
				sessionParams: result.sessionParams,
			},
		});
	}

	/** GEO-261: Terminal event — awaits reliable delivery with retry. */
	async emitFailed(
		env: EventEnvelope,
		error: string,
		lastActivity?: string,
		failure?: TerminalFailureInfo,
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
				sessionRole: env.sessionRole,
				failure,
			},
		});
	}

	async emitHeartbeat(env: EventEnvelope): Promise<void> {
		// Dedicated heartbeat route — lightweight, no session_events, no lead notification
		const p = this.postHeartbeat(env.executionId);
		this.track(p);
	}

	/**
	 * FLY-137: Worktree_ready — awaited by Blueprint after worktree
	 * creation, before adapter execution. Uses the reliable post path so
	 * the caller can rely on Bridge having persisted `worktree_path`
	 * before any downstream stage handler runs.
	 *
	 * FLY-1185 §2.1 (R5#1 option a): the binding parameter is ACCEPTED but
	 * NEVER transmitted — the shared `/events` ingest token is runner-visible,
	 * so HTTP mode must be structurally incapable of writing deletion
	 * authority. `worktree_ready` over HTTP stays display metadata only.
	 */
	async emitWorktreeReady(
		env: EventEnvelope,
		worktreePath: string,
		_binding?: WorktreeBindingInfo,
	): Promise<void> {
		await this.postEventReliable({
			event_id: randomUUID(),
			execution_id: env.executionId,
			issue_id: env.issueId,
			project_name: env.projectName,
			event_type: "worktree_ready",
			payload: {
				worktreePath,
			},
		});
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
		maxRetries = 3, // FLY-86: 4 total attempts for terminal events
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
	async emitWorktreeReady(
		_env: EventEnvelope,
		_worktreePath: string,
		_binding?: WorktreeBindingInfo,
	): Promise<void> {}
	async emitCompleted(
		_env: EventEnvelope,
		_result: BlueprintResult,
	): Promise<void> {}
	async emitFailed(
		_env: EventEnvelope,
		_error: string,
		_lastActivity?: string,
		_failure?: TerminalFailureInfo,
	): Promise<void> {}
	async emitHeartbeat(_env: EventEnvelope): Promise<void> {}
	async flush(): Promise<void> {}
}
