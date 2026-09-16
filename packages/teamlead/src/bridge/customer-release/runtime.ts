import {
	type FlagStoreRuntime,
	storeAutoReleaseOnSilenceEnabled,
} from "../flag-store-runtime.js";

/** A live switch, not an authorization: claim still verifies founder evidence and current policy. */
export function customerReleaseAutoEnabled(
	flags: FlagStoreRuntime,
	projectId: string,
): boolean {
	return (
		projectId === "flywheel" &&
		storeAutoReleaseOnSilenceEnabled(flags, projectId)
	);
}

import type {
	CustomerReleaseDecisionPump,
	DecisionPumpOutcome,
} from "./pump.js";
import { customerReleaseClockFailure } from "./scheduler.js";
import type { CustomerReleaseStore } from "./store.js";

interface CustomerReleaseRuntimeOptions {
	store: Pick<
		CustomerReleaseStore,
		"recoverAfterRestart" | "invalidateRuntime"
	>;
	pump: Pick<
		CustomerReleaseDecisionPump,
		"tick" | "pauseClaims" | "resumeClaims"
	>;
	advance: (signal: AbortSignal) => Promise<void>;
	now: () => number;
}

/** Bridge-owned bounded cadence. No process control, deployment or implicit
 * enablement: the pump still enforces current authoritative claim gates. */
export class CustomerReleaseRuntime {
	private running = false;
	private controller = new AbortController();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private flight: Promise<void> | null = null;
	private stopping: Promise<DecisionPumpOutcome> | null = null;
	private previous: number | null = null;
	private failures = 0;
	private clockInvalidPending = false;
	constructor(private readonly options: CustomerReleaseRuntimeOptions) {}
	start(): void {
		if (this.running) return;
		if (this.stopping) throw new Error("customer release runtime is stopping");
		this.options.pump.pauseClaims();
		const now = this.options.now();
		if (customerReleaseClockFailure(null, now))
			throw new Error("customer release runtime clock invalid");
		this.options.store.recoverAfterRestart("flywheel", now);
		this.previous = now;
		this.failures = 0;
		this.clockInvalidPending = false;
		this.controller = new AbortController();
		this.running = true;
		this.options.pump.resumeClaims();
		this.schedule(1000);
	}
	private schedule(delay: number): void {
		if (!this.running) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flight = this.run();
		}, delay);
		this.timer.unref?.();
	}
	private async run(): Promise<void> {
		let unavailable = false;
		try {
			const now = this.options.now();
			const failure = customerReleaseClockFailure(this.previous, now);
			if (failure) {
				this.options.pump.pauseClaims();
				if (failure === "clock_invalid") this.clockInvalidPending = true;
				if (failure !== "clock_invalid") {
					this.options.store.invalidateRuntime(failure, now);
					this.previous = now;
				}
				unavailable = true;
			} else {
				if (this.clockInvalidPending) {
					this.options.store.invalidateRuntime("clock_invalid", now);
					this.clockInvalidPending = false;
				}
				this.previous = now;
				if (this.running) this.options.pump.resumeClaims();
				const outcome = await this.options.pump.tick();
				unavailable = outcome === "unavailable";
				if (this.running && outcome === "idle")
					await this.options.advance(this.controller.signal);
			}
		} catch {
			unavailable = true;
			this.options.pump.pauseClaims();
		} finally {
			this.flight = null;
			this.failures = unavailable ? Math.min(this.failures + 1, 5) : 0;
			this.schedule(Math.min(30000, 1000 * 2 ** this.failures));
		}
	}
	stop(): Promise<DecisionPumpOutcome> {
		if (this.stopping) return this.stopping;
		if (!this.running) return Promise.resolve("idle");
		this.running = false;
		this.controller.abort();
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.options.pump.pauseClaims();
		// Establish the stop condition synchronously before an in-flight probe can return.
		let invalidationFailed = false;
		try {
			this.options.store.invalidateRuntime(
				"runtime_stopping",
				this.options.now(),
			);
		} catch {
			invalidationFailed = true;
		}
		const flight = this.flight;
		this.stopping = (async () => {
			try {
				await flight;
				const outcome = await this.options.pump.tick();
				return invalidationFailed ? "unavailable" : outcome;
			} finally {
				this.stopping = null;
			}
		})();
		return this.stopping;
	}
}
