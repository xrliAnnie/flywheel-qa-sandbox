import type { ExecFileOptions } from "node:child_process";

const MAX_TIMER_MS = 2_147_483_647;

export interface KillableChild {
	kill(signal?: NodeJS.Signals | number): boolean;
}

export type ExecFileLike = (
	file: string,
	argv: readonly string[],
	options: ExecFileOptions,
	callback: (error: Error | null, stdout: string, stderr: string) => void,
) => KillableChild;

export interface WaitAwareExecOptions {
	file: string;
	argv: readonly string[];
	options: ExecFileOptions;
	activeTimeoutMs: number;
	waitingTimeoutMs: number;
	waitRetryMs: number;
	outerTimeoutMs?: number;
	isWaiting: () => boolean;
	execFile: ExecFileLike;
	now?: () => number;
	onProbeError?: (error: unknown) => void;
}

export interface WaitAwareExecResult {
	stdout: string;
	stderr: string;
}

export class WaitAwareExecTimeoutError extends Error {
	readonly timedOut = true;

	constructor(readonly reason: "active" | "waiting" | "outer") {
		super(`wait-aware process exceeded its ${reason} timeout`);
		this.name = "WaitAwareExecTimeoutError";
	}
}

/**
 * Run one child process while excluding checkpointed gate waits from its
 * cumulative active-work budget. The child is never respawned or resumed.
 */
export function runWaitAwareExec(
	input: WaitAwareExecOptions,
): Promise<WaitAwareExecResult> {
	const now = input.now ?? Date.now;
	const activeTimeoutMs = positiveMs(input.activeTimeoutMs, "activeTimeoutMs");
	const waitingTimeoutMs = positiveMs(
		input.waitingTimeoutMs,
		"waitingTimeoutMs",
	);
	const waitRetryMs = positiveMs(input.waitRetryMs, "waitRetryMs");
	const defaultOuterTimeoutMs = Math.min(
		MAX_TIMER_MS,
		Math.max(activeTimeoutMs, waitingTimeoutMs * 7),
	);
	const outerTimeoutMs = positiveMs(
		input.outerTimeoutMs ?? defaultOuterTimeoutMs,
		"outerTimeoutMs",
	);
	const startedAt = now();
	let totalWaitingMs = 0;
	let waitingSince: number | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let child: KillableChild | null = null;
	let settled = false;

	function activeElapsed(at: number): number {
		const currentWait = waitingSince === null ? 0 : at - waitingSince;
		return at - startedAt - totalWaitingMs - currentWait;
	}

	function clearTimer(): void {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	return new Promise<WaitAwareExecResult>((resolve, reject) => {
		const settleSuccess = (stdout: string, stderr: string): void => {
			if (settled) return;
			settled = true;
			clearTimer();
			resolve({ stdout, stderr });
		};

		const settleError = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimer();
			reject(error);
		};

		const timeout = (reason: "active" | "waiting" | "outer"): void => {
			if (settled) return;
			settled = true;
			clearTimer();
			const error = new WaitAwareExecTimeoutError(reason);
			try {
				child?.kill("SIGTERM");
			} finally {
				reject(error);
			}
		};

		const probeWaiting = (): boolean => {
			try {
				return input.isWaiting();
			} catch (error) {
				try {
					input.onProbeError?.(error);
				} catch {
					// A diagnostic hook must not alter fail-closed timeout behavior.
				}
				return false;
			}
		};

		const tick = (): void => {
			if (settled) return;
			const at = now();
			const outerElapsed = at - startedAt;
			if (outerElapsed >= outerTimeoutMs) {
				timeout("outer");
				return;
			}

			const isWaiting = probeWaiting();
			if (isWaiting && waitingSince === null) {
				waitingSince = at;
			} else if (!isWaiting && waitingSince !== null) {
				totalWaitingMs += at - waitingSince;
				waitingSince = null;
			}

			const remainingOuter = outerTimeoutMs - outerElapsed;
			if (waitingSince !== null) {
				const waitElapsed = at - waitingSince;
				if (waitElapsed >= waitingTimeoutMs) {
					timeout("waiting");
					return;
				}
				timer = setTimeout(
					tick,
					Math.min(waitRetryMs, waitingTimeoutMs - waitElapsed, remainingOuter),
				);
				return;
			}

			const active = activeElapsed(at);
			if (active >= activeTimeoutMs) {
				timeout("active");
				return;
			}
			timer = setTimeout(
				tick,
				Math.min(waitRetryMs, activeTimeoutMs - active, remainingOuter),
			);
		};

		try {
			child = input.execFile(
				input.file,
				input.argv,
				input.options,
				(error, stdout, stderr) => {
					if (error) settleError(error);
					else settleSuccess(stdout, stderr);
				},
			);
		} catch (error) {
			settleError(error instanceof Error ? error : new Error(String(error)));
		}

		if (!settled) tick();
	});
}

function positiveMs(value: number, name: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive finite number`);
	}
	return value;
}
