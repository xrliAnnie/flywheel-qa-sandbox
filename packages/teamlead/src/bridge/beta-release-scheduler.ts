import type { BetaProjectConfig } from "./beta-release-config-source.js";
import type {
	BetaBinding,
	BetaOccurrence,
	BetaStoredObservation,
} from "./beta-release-contract.js";
import { BetaGitHubError } from "./beta-release-github.js";
import type { BetaReceipt } from "./beta-release-receipt.js";
import { validateBetaReceipt } from "./beta-release-receipt.js";
import type { BetaReleaseStore } from "./beta-release-store.js";

export type BetaOwner = "legacy" | "paused" | "bridge";
export interface BetaObservedRun {
	id: number;
	status: "queued" | "in_progress" | "completed";
	conclusion: string | null;
	receipt?: BetaReceipt;
}
/** Adapter verifies all pages, run bindings and covered_by_newer ancestry before returning. */
export interface BetaReleaseTransport {
	assertDrained(binding: BetaBinding, signal: AbortSignal): Promise<void>;
	resolve(
		project: BetaProjectConfig,
		signal: AbortSignal,
	): Promise<BetaBinding>;
	owner(binding: BetaBinding, signal: AbortSignal): Promise<BetaOwner>;
	head(binding: BetaBinding, signal: AbortSignal): Promise<string>;
	dispatch(
		binding: BetaBinding,
		occurrence: BetaOccurrence,
		signal: AbortSignal,
	): Promise<number | null>;
	observe(
		binding: BetaBinding,
		occurrence: BetaOccurrence,
		signal: AbortSignal,
	): Promise<{ runs: BetaObservedRun[] }>;
}
export interface BetaScheduleObservation {
	projectName: string;
	owner: BetaOwner | "unknown";
	intervalHours: number | null;
	status: string;
	observedAtMs: number;
	reason: string | null;
}
export class BetaReleaseScheduler {
	private readonly abort = new AbortController();
	private running: Promise<void> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private observations = new Map<string, BetaScheduleObservation>();
	private unboundObservations = new Map<string, BetaStoredObservation>();
	private reportedErrors = new Map<string, string>();
	constructor(
		private readonly options: {
			store: BetaReleaseStore;
			transport: BetaReleaseTransport;
			projects: () => Promise<BetaProjectConfig[]>;
			now?: () => number;
			onError?: (code: string) => void;
		},
	) {}
	snapshot(): BetaScheduleObservation[] {
		return [...this.observations.values()];
	}
	start(): void {
		if (this.timer || this.abort.signal.aborted) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, 60000);
		this.timer.unref();
		void this.tick();
	}
	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.abort.abort();
		await this.running;
	}
	tick(): Promise<void> {
		if (this.abort.signal.aborted) return Promise.resolve();
		if (this.running) return this.running;
		this.running = this.runTick()
			.then(() => {
				this.reportedErrors.delete("scheduler");
			})
			.catch(() => {
				this.reportError("scheduler", "beta_scheduler_failed");
			})
			.finally(() => {
				this.running = null;
			});
		return this.running;
	}
	private async runTick(): Promise<void> {
		let projects: BetaProjectConfig[];
		try {
			projects = await this.options.projects();
		} catch {
			this.reportError("source", "beta_project_source_failed");
			const now = this.options.now?.() ?? Date.now();
			for (const [name, previous] of this.observations)
				this.observations.set(name, {
					...previous,
					owner: "unknown",
					status: "attention",
					reason: "beta_project_source_failed",
					observedAtMs: now,
				});
			return;
		}
		this.reportedErrors.delete("source");
		for (const lane of this.options.store.lanes()) {
			if (!projects.some((p) => p.projectName === lane.projectName))
				projects.push({
					projectName: lane.projectName,
					projectRoot: "",
					projectRepo: lane.canonicalRepo,
					reason: "unconfigured",
				});
		}
		projects.sort((a, b) => a.projectName.localeCompare(b.projectName));
		let cursor = 0;
		await Promise.all(
			Array.from({ length: Math.min(4, projects.length) }, async () => {
				while (cursor < projects.length && !this.abort.signal.aborted) {
					const project = projects[cursor++]!;
					await this.projectTick(project);
				}
			}),
		);
	}
	private async projectTick(project: BetaProjectConfig): Promise<void> {
		const { store, transport } = this.options;
		const now = this.options.now?.() ?? Date.now();

		const signal = this.abort.signal;
		const prior =
			store.observation(project.projectName) ??
			this.unboundObservations.get(project.projectName);
		if (prior && now < prior.pollAfterMs) {
			this.observations.set(project.projectName, {
				projectName: project.projectName,
				owner: prior.owner,
				intervalHours: project.config?.interval_hours ?? null,
				status: prior.status,
				reason: prior.reason,
				observedAtMs: prior.observedAtMs,
			});
			return;
		}
		let pollAfterMs = 0;
		let owner: BetaOwner | "unknown" = "unknown";
		let status = project.reason ?? "ready";
		let reason: string | null = project.reason;
		const interval = project.config
			? project.config.interval_hours * 3600000
			: (store.lane(project.projectName)?.intervalMs ?? 24 * 3600000);
		try {
			// In-flight work is reconciled even when new configuration is invalid or paused.
			const lane = store.lane(project.projectName);
			const active = store.active(project.projectName);
			if (lane && active) {
				if (active.state === "succeeded" || active.state === "exhausted") {
					store.settle(project.projectName, active.occurrenceId, now, interval);
					status = active.state;
					return;
				}
				if (active.state === "prepared") {
					if (!project.reason) {
						owner = await this.submit(project, lane, active, now);
						status = store.active(project.projectName)?.state ?? "ready";
					}
					return;
				}
				owner = await transport.owner(lane, signal);
				const { runs } = await transport.observe(lane, active, signal);
				const ids = [...new Set([...active.runIds, ...runs.map((r) => r.id)])];
				if (active.runIds.some((id) => !runs.some((r) => r.id === id)))
					throw new Error("beta_run_observation_incomplete");
				const unknown =
					active.state === "dispatch_unknown" || active.state === "dispatching";
				if (unknown && !runs.some((r) => !active.runIds.includes(r.id))) {
					status = "dispatch_unknown";
					if (
						active.attemptCount >= 5 ||
						now - active.createdAtMs >= Math.min(interval, 6 * 3600000)
					) {
						status = "attention";
						reason = "beta_unknown_acceptance";
						pollAfterMs = now + 900000;
					} else if (
						runs.every((r) => r.status === "completed") &&
						!project.reason &&
						now >= (active.retryAtMs ?? active.createdAtMs + 120000)
					) {
						owner = await this.submit(project, lane, active, now);
						status = store.active(project.projectName)?.state ?? "ready";
					}
					return;
				}
				if (runs.length && runs.every((r) => r.status === "completed")) {
					const successes = runs.filter((r) => r.conclusion === "success");
					if (successes.length) {
						const receipts = successes.map((r) =>
							validateBetaReceipt(r.receipt, {
								projectName: lane.projectName,
								repositoryId: lane.repositoryId,
								workflowId: lane.workflowId,
								runId: r.id,
								scheduleKey: active.occurrenceId,
								sourceCommit: active.sourceCommit,
							}),
						);
						if (receipts.every((r) => r.outcome === "not_activated")) {
							store.transition(
								project.projectName,
								active.occurrenceId,
								active.state,
								{
									state: "exhausted",
									runIds: ids,
									result: receipts,
									lastError: "not_activated",
								},
							);
							store.settle(
								project.projectName,
								active.occurrenceId,
								now,
								interval,
							);
							status = "not_activated";
							reason = "not_activated";
						} else {
							store.transition(
								project.projectName,
								active.occurrenceId,
								active.state,
								{ state: "succeeded", runIds: ids, result: receipts },
							);
							store.settle(
								project.projectName,
								active.occurrenceId,
								now,
								interval,
							);
							status = "published";
							reason = null;
						}
					} else {
						if (
							active.attemptCount >= 5 ||
							now - active.createdAtMs >= Math.min(interval, 6 * 3600000)
						) {
							store.transition(
								project.projectName,
								active.occurrenceId,
								active.state,
								{
									state: "exhausted",
									runIds: ids,
									lastError: "beta_retry_exhausted",
								},
							);
							store.settle(
								project.projectName,
								active.occurrenceId,
								now,
								interval,
							);
							status = "exhausted";
						} else if (active.state !== "failed") {
							store.transition(
								project.projectName,
								active.occurrenceId,
								active.state,
								{
									state: "failed",
									runIds: ids,
									lastError: runs.map((r) => r.conclusion).includes("cancelled")
										? "beta_run_cancelled"
										: "beta_run_failed",
									retryAtMs: now + this.backoff(active.attemptCount),
								},
							);
							status = "failed";
						} else if (!project.reason && now >= (active.retryAtMs ?? 0)) {
							owner = await this.submit(project, lane, active, now);
							status = store.active(project.projectName)?.state ?? "ready";
						}
					}
				} else if (runs.length) {
					store.transition(
						project.projectName,
						active.occurrenceId,
						active.state,
						{ state: "running", runIds: ids },
					);
					status = "running";
				} else {
					status = "dispatch_unknown";
					if (
						active.attemptCount >= 5 ||
						now - active.createdAtMs >= Math.min(interval, 6 * 3600000)
					) {
						status = "attention";
						reason = "beta_unknown_acceptance";
						pollAfterMs = now + 900000;
					} else if (
						!project.reason &&
						now >= (active.retryAtMs ?? active.createdAtMs + 120000)
					) {
						owner = await this.submit(project, lane, active, now);
						status = store.active(project.projectName)?.state ?? "ready";
					}
				}
				return;
			}
			if (project.reason) return;
			const binding = await transport.resolve(project, signal);
			owner = await transport.owner(binding, signal);
			status = owner;
			if (owner !== "bridge") return;
			if (!store.lane(project.projectName)) {
				await transport.assertDrained(binding, signal);
				owner = await transport.owner(binding, signal);
				if (owner !== "bridge") return;
			}
			store.bind(binding, now, interval);
			const due = store.due(project.projectName, interval, now);
			if (due === null) {
				status = "ready";
				return;
			}
			const sha = await transport.head(binding, signal);
			const occurrence = store.reserve(project.projectName, due, sha, now);
			if (!occurrence) return;
			owner = await this.submit(project, binding, occurrence, now);
			status = store.active(project.projectName)?.state ?? "ready";
		} catch (error) {
			status = "attention";
			reason =
				error instanceof BetaGitHubError
					? error.code
					: "beta_observation_failed";
			pollAfterMs = Math.max(
				now + 900000,
				error instanceof BetaGitHubError ? (error.retryAtMs ?? 0) : 0,
			);
		} finally {
			const errorScope = `project:${project.projectName}`;
			if (reason) {
				this.reportError(
					errorScope,
					JSON.stringify({
						project: project.projectName,
						reason,
						occurrence: store.active(project.projectName)?.occurrenceId ?? null,
					}),
				);
			} else {
				this.reportedErrors.delete(errorScope);
			}
			this.unboundObservations.set(project.projectName, {
				owner,
				status,
				reason,
				observedAtMs: now,
				pollAfterMs,
			});
			store.recordObservation(project.projectName, {
				owner,
				status,
				reason,
				observedAtMs: now,
				pollAfterMs,
			});
			this.observations.set(project.projectName, {
				projectName: project.projectName,
				owner,
				intervalHours: project.config?.interval_hours ?? null,
				status,
				reason,
				observedAtMs: now,
			});
		}
	}
	private reportError(scope: string, code: string): void {
		if (this.reportedErrors.get(scope) === code) return;
		this.reportedErrors.set(scope, code);
		this.options.onError?.(code);
	}
	private backoff(attempt: number): number {
		return [120000, 300000, 900000][Math.min(2, Math.max(0, attempt - 1))]!;
	}
	private async submit(
		project: BetaProjectConfig,
		binding: BetaBinding,
		occurrence: BetaOccurrence,
		now: number,
	): Promise<BetaOwner> {
		const { store, transport } = this.options;
		const signal = this.abort.signal;
		// Resolve the current config again before retrying; a rebind must not dispatch using old authorization.
		const resolved = await transport.resolve(project, signal);
		store.bind(resolved, now, (project.config?.interval_hours ?? 24) * 3600000);
		const owner = await transport.owner(binding, signal);
		if (owner !== "bridge") return owner;
		const attempts = occurrence.attemptCount + 1;
		if (
			!store.transition(
				project.projectName,
				occurrence.occurrenceId,
				occurrence.state,
				{
					state: "dispatching",
					attemptCount: attempts,
					retryAtMs: now + this.backoff(attempts),
				},
			)
		)
			return owner;
		let runId: number | null = null;
		try {
			runId = await transport.dispatch(binding, occurrence, signal);
		} catch (error) {
			// Preserve uncertain acceptance before publishing a durable observation cooldown.
			if (error instanceof BetaGitHubError) {
				store.transition(
					project.projectName,
					occurrence.occurrenceId,
					"dispatching",
					{
						state: "dispatch_unknown",
						lastError: error.code,
						retryAtMs: Math.max(
							now + this.backoff(attempts),
							error.retryAtMs ?? 0,
						),
					},
				);
				throw error;
			}
		}
		store.transition(
			project.projectName,
			occurrence.occurrenceId,
			"dispatching",
			{
				state: runId === null ? "dispatch_unknown" : "accepted",
				runIds:
					runId === null
						? occurrence.runIds
						: [...new Set([...occurrence.runIds, runId])],
			},
		);
		return owner;
	}
}
