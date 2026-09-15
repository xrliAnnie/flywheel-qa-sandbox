import { yieldToEventLoop } from "../bridge/event-loop-yield.js";
import type { StateStore } from "../StateStore.js";
import type { CollectionResult } from "./collect.js";
import { canonicalDigest, type FrozenPacket } from "./contract.js";
import { ShipJudgmentScanner } from "./scanner.js";
import {
	type JudgmentWorkerDependencies,
	ShipJudgmentWorker,
} from "./worker.js";

export interface JudgmentRuntimeDependencies {
	store: StateStore;
	owner: string;
	mode(): string;
	collect(questionId: string, signal: AbortSignal): Promise<CollectionResult>;
	evaluate: JudgmentWorkerDependencies["evaluate"];
	/** Schedule opinion recombination with current mechanical evidence, including cached evaluations. */
	material(inputId: string): void;
	unavailable(questionId: string, reason: string): void;
	onError?(code: string): void;
	now?: () => number;
	stopSources?(): Promise<void>;
	deliver?(questionId: string, signal: AbortSignal): Promise<void>;
	modeSweep?(signal: AbortSignal): Promise<void>;
	learningSweep?(signal: AbortSignal): Promise<void>;
}

/** The Bridge owns this pair of background loops and awaits both during shutdown. */
export class ShipJudgmentRuntime {
	readonly scanner: ShipJudgmentScanner;
	readonly worker: ShipJudgmentWorker;
	private stopped = false;
	private modeTimer?: ReturnType<typeof setInterval>;
	private modeFlight: Promise<void> | null = null;
	private deliveryFlight: Promise<void> | null = null;
	private deliveryAbort: AbortController | null = null;
	private lastObservedMode: string | undefined;
	private readonly now: () => number;
	constructor(private readonly deps: JudgmentRuntimeDependencies) {
		this.now = deps.now ?? Date.now;
		const inputs = deps.store.getShipJudgmentInputs();
		this.scanner = new ShipJudgmentScanner({
			store: deps.store,
			mode: deps.mode,
			onError: deps.onError,
			process: async (question, signal) => {
				await this.collect(question, signal);
				if (this.enabled() && !signal.aborted)
					await deps.deliver?.(question, signal);
			},
		});
		this.worker = new ShipJudgmentWorker({
			jobs: deps.store.getShipJudgmentJobs(),
			owner: deps.owner,
			enabled: () => this.enabled(),
			now: this.now,
			onError: deps.onError,
			prepare: async (inputId, signal) => {
				if (!this.enabled()) return null;
				const old = inputs.get(inputId);
				if (!old) return null;
				const current = await this.collect(old.questionId, signal);
				return current === inputId ? (inputs.get(inputId) ?? null) : null;
			},
			isCurrent: (packet) => this.isCurrent(packet),
			evaluate: deps.evaluate,
			settled: (inputId) => {
				deps.material(inputId);
				const packet = inputs.get(inputId);
				if (packet && this.enabled()) this.scanner.enqueue(packet.questionId);
			},
		});
	}
	start(): void {
		if (this.stopped) return;
		if (!this.modeTimer) {
			void this.modeTick();
			this.modeTimer = setInterval(() => {
				void this.modeTick();
			}, 3_000);
			this.modeTimer.unref();
		}
		this.scanner.start();
		this.worker.start();
	}
	modeTick(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.modeFlight) return this.modeFlight;
		// Install the latch before the first observer can execute or re-enter.
		const flight = Promise.resolve()
			.then(() => this.runLocalPages())
			.finally(() => {
				if (this.modeFlight === flight) this.modeFlight = null;
			});
		this.modeFlight = flight;
		return flight;
	}
	private observationEnabled(): boolean {
		if (this.stopped) return false;
		try {
			const mode = this.deps.mode();
			if (mode === "off") {
				this.deliveryAbort?.abort();
				for (const source of ["verdict", "closeout", "clarification"] as const)
					this.deps.store.recordShipJudgmentObservationProgress?.(
						source,
						0,
						0,
						25,
					);
				if (this.lastObservedMode !== "off") {
					try {
						this.deps.store
							.getShipJudgmentDelivery()
							.setMode("off", this.now());
					} catch {
						this.deps.onError?.("mode_sweep_failed");
						return false;
					}
				}
			}
			this.lastObservedMode = mode;
			return mode !== "off";
		} catch {
			this.deps.onError?.("mode_read_failed");
			return false;
		}
	}
	private async runLocalPages(): Promise<void> {
		for (const [method, error] of [
			["observeVerdicts", "verdict_observation_failed"],
			["observeCancellations", "cancellation_observation_failed"],
		] as const) {
			if (!this.observationEnabled()) return;
			const started = performance.now();
			let inspected = 0;
			try {
				const observer = this.deps.store.getShipJudgmentOutcomes();
				observer[method](new Date(this.now()).toISOString());
				const stats =
					method === "observeVerdicts"
						? observer.verdictPageStats()
						: observer.pageStats();
				inspected = stats.sourceCandidates + stats.holderCandidates;
			} catch {
				this.deps.onError?.(error);
			} finally {
				this.deps.store.recordShipJudgmentObservationProgress?.(
					method === "observeVerdicts" ? "verdict" : "closeout",
					inspected,
					performance.now() - started,
					25,
				);
			}
			await yieldToEventLoop();
		}
		if (!this.observationEnabled()) return;
		const started = performance.now();
		let inspected = 0;
		try {
			inspected = this.deps.store
				.getShipJudgmentClarifications(this.deps.mode)
				.sweep();
		} catch {
			this.deps.onError?.("clarification_sweep_failed");
		} finally {
			this.deps.store.recordShipJudgmentObservationProgress?.(
				"clarification",
				inspected,
				performance.now() - started,
				25,
			);
		}
		await yieldToEventLoop();
		if (this.observationEnabled()) this.startDelivery();
	}
	private startDelivery(): void {
		if (
			this.deliveryFlight ||
			(!this.deps.learningSweep && !this.deps.modeSweep)
		)
			return;
		const controller = new AbortController();
		this.deliveryAbort = controller;
		const timer = setTimeout(() => controller.abort(), 15_000);
		timer.unref();
		// Keep the flight until the underlying operations settle after abort;
		// observation timeouts must never admit a second overlapping transport.
		const flight = Promise.resolve()
			.then(async () => {
				for (const [method, error] of [
					["learningSweep", "learning_delivery_failed"],
					["modeSweep", "mode_sweep_failed"],
				] as const) {
					if (controller.signal.aborted || !this.observationEnabled()) return;
					try {
						await this.deps[method]?.(controller.signal);
					} catch {
						this.deps.onError?.(error);
					}
				}
			})
			.finally(() => {
				clearTimeout(timer);
				if (this.deliveryFlight === flight) {
					this.deliveryFlight = null;
					this.deliveryAbort = null;
				}
			});
		this.deliveryFlight = flight;
	}
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.modeTimer) clearInterval(this.modeTimer);
		this.deliveryAbort?.abort();
		await Promise.all([
			this.modeFlight,
			this.deliveryFlight,
			this.scanner.stop(),
			this.worker.stop(),
			this.deps.stopSources?.(),
		]);
	}
	private enabled(): boolean {
		return !this.stopped && this.deps.mode() === "dry_run";
	}
	private isCurrent(packet: FrozenPacket): boolean {
		if (!this.enabled()) return false;
		const binding = this.deps.store.readShipJudgmentBinding(
			packet.questionId,
			packet.channelId,
		);
		return (
			!!binding &&
			binding.projectName === "flywheel" &&
			canonicalDigest(binding) === packet.bindingDigest
		);
	}
	private async collect(
		question: string,
		signal: AbortSignal,
	): Promise<string | null> {
		if (!this.enabled() || signal.aborted) return null;
		const result = await this.deps.collect(question, signal);
		if (!this.enabled() || signal.aborted) return null;
		if (result.status !== "ready") {
			this.deps.unavailable(question, result.reason);
			return null;
		}
		if (result.packet.questionId !== question || !this.isCurrent(result.packet))
			return null;
		const frozen = this.deps.store
			.getShipJudgmentInputs()
			.freeze(result.packet, new Date(this.now()).toISOString());
		if (frozen.status === "created" || frozen.status === "existing") {
			this.deps.material(frozen.inputId);
			return frozen.inputId;
		}
		this.deps.unavailable(question, frozen.status);
		return null;
	}
}
