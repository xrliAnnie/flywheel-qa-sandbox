export const TURN_BARRIER_RETRY_MS = 60_000;

export class TurnBarrierError extends Error {
	readonly cause: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "TurnBarrierError";
		this.cause = cause;
	}
}

export interface CodexTurnBarrierOptions {
	retryWindowMs?: number;
	initialRetryMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Serializes durable turn-boundary writes without making the synchronous
 * daemon notification callback async. Failures retry inside the chain and
 * latch permanently so every later boundary await fails closed.
 */
export class CodexTurnBarrier {
	private tail: Promise<void> = Promise.resolve();
	private latchedError: TurnBarrierError | undefined;
	private readonly retryWindowMs: number;
	private readonly initialRetryMs: number;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: CodexTurnBarrierOptions = {}) {
		this.retryWindowMs = Math.max(
			0,
			options.retryWindowMs ?? TURN_BARRIER_RETRY_MS,
		);
		this.initialRetryMs = Math.max(
			1,
			options.initialRetryMs ?? TURN_BARRIER_RETRY_MS / 60,
		);
		this.now = options.now ?? Date.now;
		this.sleep =
			options.sleep ??
			((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	}

	enqueue(write: () => void | Promise<void>): void {
		const next = this.tail.then(async () => {
			if (this.latchedError) return;
			await this.runWithRetry(write);
		});
		this.tail = next.catch((error: unknown) => {
			this.latch(error);
		});
	}

	latch(error: unknown): void {
		if (this.latchedError) return;
		this.latchedError =
			error instanceof TurnBarrierError
				? error
				: new TurnBarrierError(
						`turn barrier failed: ${error instanceof Error ? error.message : String(error)}`,
						error,
					);
	}

	async settled(): Promise<void> {
		let awaited: Promise<void> | undefined;
		while (awaited !== this.tail) {
			awaited = this.tail;
			await awaited;
		}
		if (this.latchedError) throw this.latchedError;
	}

	private async runWithRetry(write: () => void | Promise<void>): Promise<void> {
		const startedAt = this.now();
		let retryDelayMs = this.initialRetryMs;
		for (;;) {
			try {
				await write();
				return;
			} catch (error) {
				const elapsedMs = Math.max(0, this.now() - startedAt);
				const remainingMs = this.retryWindowMs - elapsedMs;
				if (remainingMs <= 0) {
					throw new TurnBarrierError(
						`turn boundary write did not settle within ${this.retryWindowMs}ms`,
						error,
					);
				}
				await this.sleep(Math.min(retryDelayMs, remainingMs));
				retryDelayMs = Math.min(retryDelayMs * 2, this.retryWindowMs);
			}
		}
	}
}
