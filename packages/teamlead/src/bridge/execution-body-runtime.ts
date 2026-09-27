import type { BodyObservation } from "flywheel-claude-runner";
import {
	createExecutionBodySampler,
	type ExecutionBodySamplerOptions,
} from "./execution-body-sampler.js";

export interface ExecutionBodyRuntimeOptions {
	listCandidates(): readonly string[];
	observer: ExecutionBodySamplerOptions["observer"];
	onDead(executionId: string): Promise<void>;
	onRecoveryActive(executionId: string): Promise<void>;
	replayPending(): Promise<void>;
	now?: () => number;
	report?(error: unknown): void;
}
/** Scheduling only. The sampler owns the sole observation cache; every death
 * consumer must still revalidate that observation at its existing synchronous CAS. */
export function createExecutionBodyRuntime(
	options: ExecutionBodyRuntimeOptions,
) {
	const pending = new Map<string, "dead" | "recovery">();
	const active = new Map<string, Promise<void>>();
	let replay: Promise<void> | undefined;
	let closing = false;
	let stopping: Promise<void> | undefined;
	function report(error: unknown) {
		try {
			options.report?.(error);
		} catch {
			/* Diagnostics cannot strand scheduling. */
		}
	}
	function pump() {
		while (!closing && active.size < 2 && pending.size) {
			const next =
				[...pending].find(([, kind]) => kind === "dead") ??
				pending.entries().next().value;
			if (!next) return;
			const [id, kind] = next;
			pending.delete(id);
			const job = Promise.resolve()
				.then(async () => {
					if (closing) return;
					if (kind === "dead") await options.onDead(id);
					else {
						await options.onRecoveryActive(id);
						if (!closing) sampler.request(id);
					}
				})
				.catch(report)
				.finally(() => {
					active.delete(id);
					pump();
				});
			active.set(id, job);
		}
	}
	function enqueue(observation: BodyObservation) {
		if (closing) return;
		const id = observation.identity.executionId;
		if (active.has(id)) return;
		if (observation.verdict === "dead") pending.set(id, "dead");
		else if (
			observation.verdict === "unknown" &&
			observation.reason === "recovery_active"
		)
			pending.set(id, "recovery");
		else pending.delete(id);
		pump();
	}
	function replayDuties() {
		if (closing || replay) return;
		replay = Promise.resolve()
			.then(() => (closing ? undefined : options.replayPending()))
			.catch(report)
			.finally(() => {
				replay = undefined;
			});
	}
	const sampler = createExecutionBodySampler({
		...options,
		onObservation: enqueue,
		onPassComplete: replayDuties,
	});
	return {
		read: sampler.read,
		request: sampler.request,
		runPass: sampler.runPass,
		async observe(executionId: string): Promise<BodyObservation | undefined> {
			const cached = sampler.read(executionId);
			if (cached) return cached;
			await sampler.runPass();
			const sampled = sampler.read(executionId);
			if (sampled) return sampled;
			// A demand added while another pass was already active may have missed
			// that pass's fixed priority snapshot. Give it one owned bounded pass.
			await sampler.runPass();
			return sampler.read(executionId);
		},
		start() {
			if (stopping) throw new Error("body_runtime_stopping");
			closing = false;
			sampler.start();
		},
		stop(): Promise<void> {
			if (stopping) return stopping;
			closing = true;
			pending.clear();
			const stopped = (async () => {
				await sampler.stop();
				await Promise.all([...active.values(), replay]);
			})().finally(() => {
				if (stopping === stopped) stopping = undefined;
			});
			stopping = stopped;
			return stopped;
		},
	};
}
