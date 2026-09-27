import type { BodyObservation } from "flywheel-claude-runner";
import type { ExecutionBodySampleControl } from "./execution-body-liveness.js";

interface BodySamplingObserver {
	observe(
		executionId: string,
		control?: ExecutionBodySampleControl,
	): Promise<BodyObservation | undefined>;
	isCurrent(observation: BodyObservation): boolean;
}
export interface ExecutionBodySamplerOptions {
	/** Candidate inventory is scheduling only: it cannot grant death authority. */
	listCandidates(): readonly string[];
	observer: BodySamplingObserver;
	now?: () => number;
}
const PASS_LIMIT = 8;
const CONCURRENCY = 2;
const WINDOW_MS = 5_000;

/** Bounded, independent scheduling for the common OS observer. Stored observations
 * carry their original identity and expiry; reads revalidate that authority and
 * never extend evidence lifetime or infer a verdict from a missed probe. */
export function createExecutionBodySampler(
	options: ExecutionBodySamplerOptions,
) {
	const now = options.now ?? Date.now;
	const demand = new Set<string>();
	const observations = new Map<string, BodyObservation>();
	let cursor = "";
	let active: Promise<void> | undefined;
	let controller: AbortController | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopping: Promise<void> | undefined;

	function current(observation: BodyObservation): boolean {
		try {
			const clock = now();
			return (
				observation.verdict !== "unknown" &&
				Date.parse(observation.observedAt) <= clock &&
				clock < Date.parse(observation.expiresAt) &&
				options.observer.isCurrent(observation)
			);
		} catch {
			return false;
		}
	}
	async function samplePass(): Promise<void> {
		const cancellation = new AbortController();
		controller = cancellation;
		const deadline = now() + WINDOW_MS;
		const timeout = setTimeout(() => cancellation.abort(), WINDOW_MS);
		try {
			for (const [id, observation] of observations) {
				if (!current(observation)) observations.delete(id);
			}
			const candidates = [...new Set(options.listCandidates())].sort();
			const priority = [...demand].slice(0, PASS_LIMIT / 2);
			const pivot = candidates.findIndex((id) => id > cursor);
			const regular =
				pivot < 0
					? candidates
					: [...candidates.slice(pivot), ...candidates.slice(0, pivot)];
			const started = new Set<string>();
			let priorityIndex = 0;
			let regularIndex = 0;
			function next(): string | undefined {
				if (
					cancellation.signal.aborted ||
					now() >= deadline ||
					started.size >= PASS_LIMIT
				)
					return undefined;
				function takePriority(): string | undefined {
					while (priorityIndex < priority.length) {
						const id = priority[priorityIndex++];
						if (id !== undefined && !started.has(id)) return id;
					}
					return undefined;
				}
				function takeRegular(): string | undefined {
					while (regularIndex < regular.length) {
						const id = regular[regularIndex++];
						if (id !== undefined && !started.has(id)) {
							cursor = id;
							return id;
						}
					}
					return undefined;
				}
				// Alternate from the first pair: even a full-window slow priority
				// probe must leave one worker advancing the stable cursor.
				const id =
					started.size % 2 === 0
						? (takePriority() ?? takeRegular())
						: (takeRegular() ?? takePriority());
				if (id === undefined) return undefined;
				started.add(id);
				demand.delete(id);
				return id;
			}
			async function worker(): Promise<void> {
				for (let id = next(); id !== undefined; id = next()) {
					try {
						const observation = await options.observer.observe(id, {
							signal: cancellation.signal,
							deadlineMs: Math.max(0, deadline - now()),
						});
						if (
							!cancellation.signal.aborted &&
							now() < deadline &&
							observation?.identity.executionId === id &&
							current(observation)
						) {
							observations.set(id, observation);
						} else observations.delete(id);
					} catch {
						observations.delete(id);
					}
				}
			}
			// Cancellation propagates into owned OS children. Await every worker's
			// drain, including on shutdown; Promise.race would leave probes alive.
			await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
		} finally {
			clearTimeout(timeout);
			if (controller === cancellation) controller = undefined;
		}
	}
	function runPass(): Promise<void> {
		if (active) return active;
		if (stopping) return stopping;
		const pending = samplePass().finally(() => {
			if (active === pending) active = undefined;
		});
		active = pending;
		return pending;
	}
	return {
		runPass,
		request(executionId: string): void {
			demand.add(executionId);
		},
		/** A dispatcher hot tick reads synchronously; a miss queues future work. */
		read(executionId: string): BodyObservation | undefined {
			const observation = observations.get(executionId);
			if (observation && current(observation))
				return structuredClone(observation);
			observations.delete(executionId);
			demand.add(executionId);
			return undefined;
		},
		start(): void {
			if (timer) return;
			if (stopping) throw new Error("body_sampler_stopping");
			const tick = () => {
				void runPass().catch(() => {
					/* Unknown inventory: retry next tick. */
				});
			};
			timer = setInterval(tick, WINDOW_MS);
			timer.unref?.();
			tick();
		},
		stop(): Promise<void> {
			if (stopping) return stopping;
			if (timer) clearInterval(timer);
			timer = undefined;
			controller?.abort();
			const pending = (async () => {
				try {
					await active;
				} finally {
					observations.clear();
					demand.clear();
				}
			})().finally(() => {
				if (stopping === pending) stopping = undefined;
			});
			stopping = pending;
			return pending;
		},
	};
}
