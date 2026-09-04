export type EventLoopYieldScheduler = (resume: () => void) => void;

const defaultScheduler: EventLoopYieldScheduler = (resume) => {
	setImmediate(resume);
};

/** Yield after a completed synchronous chunk without changing chunk ordering. */
export function yieldToEventLoop(
	schedule: EventLoopYieldScheduler = defaultScheduler,
): Promise<void> {
	return new Promise<void>((resolve) => schedule(resolve));
}

/**
 * Run chunks strictly sequentially and yield only after each complete chunk.
 * The callback may be async, but its internal ordering remains its own contract.
 */
export async function runSequentialChunks<T>(
	chunks: readonly T[],
	run: (chunk: T) => void | Promise<void>,
	schedule: EventLoopYieldScheduler = defaultScheduler,
): Promise<void> {
	for (const chunk of chunks) {
		await run(chunk);
		await yieldToEventLoop(schedule);
	}
}
