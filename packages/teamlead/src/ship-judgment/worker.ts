import type { FrozenPacket } from "./contract.js";
import type { JobResult, ShipJudgmentJobs } from "./jobs.js";

export interface JudgmentWorkerDependencies {
	jobs: ShipJudgmentJobs;
	owner: string;
	/** Disabled modes leave never-started inputs queued without consuming an attempt. */
	enabled?(): boolean;
	/** Refresh live material before reservation. Return null for stale/disabled/missing inputs. */
	prepare(inputId: string, signal: AbortSignal): Promise<FrozenPacket | null>;
	/** Synchronous final project/mode/binding/material check immediately before launch. */
	isCurrent(packet: FrozenPacket): boolean;
	evaluate(
		packet: FrozenPacket,
		signal: AbortSignal,
	): Promise<{ spawned: boolean; evaluation: JobResult }>;
	/** Schedule recombination with fresh mechanical evidence; never discard the saved semantic result. */
	settled(inputId: string): void;
	now?: () => number;
	onError?: (code: string) => void;
}

/** A standalone 30s loop. Card handlers enqueue only; shutdown joins the actual process close. */
export class ShipJudgmentWorker {
	private readonly abort = new AbortController();
	private timer: ReturnType<typeof setInterval> | undefined;
	private active: Promise<void> | undefined;
	private readonly now: () => number;
	constructor(private readonly deps: JudgmentWorkerDependencies) {
		this.now = deps.now ?? Date.now;
	}

	start(): void {
		if (this.timer || this.abort.signal.aborted) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, 30_000);
		this.timer.unref();
		void this.tick();
	}

	tick(): Promise<void> {
		if (this.active) return this.active;
		if (this.abort.signal.aborted) return Promise.resolve();
		this.active = Promise.resolve()
			.then(() => this.drain())
			.catch(() => {
				this.deps.onError?.("judgment_worker_failed");
			})
			.finally(() => {
				this.active = undefined;
			});
		return this.active;
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.abort.abort();
		await this.active;
	}

	private async drain(): Promise<void> {
		const { jobs } = this.deps;
		if (this.deps.enabled && !this.deps.enabled()) return;
		jobs.recoverExpired(this.now());
		for (const inputId of jobs.queued()) {
			if (
				this.abort.signal.aborted ||
				(this.deps.enabled && !this.deps.enabled())
			)
				return;
			const packet = await this.deps.prepare(inputId, this.abort.signal);
			if (
				this.abort.signal.aborted ||
				(this.deps.enabled && !this.deps.enabled())
			)
				return;
			const claim = jobs.claim(inputId, this.deps.owner, this.now());
			if (claim.status === "busy" || claim.status === "daily_budget") return;
			if (claim.status !== "claimed") continue;
			if (!packet || !this.deps.isCurrent(packet)) {
				jobs.confirmNotSpawned(claim, "input_superseded", this.now());
				continue;
			}
			if (!jobs.markSpawned(claim, this.now())) {
				jobs.confirmNotSpawned(claim, "launch_admission_expired", this.now());
				continue;
			}
			// Keep a durable launch intent until the process positively proves it never started.
			// An exception/crash leaves the lease for conservative no-retry recovery.
			const result = await this.deps.evaluate(packet, this.abort.signal);
			if (result.spawned) jobs.finish(claim, result.evaluation, this.now());
			else
				jobs.confirmNotSpawned(claim, result.evaluation.resultCode, this.now());
			this.deps.settled(inputId);
		}
	}
}
