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

/** Drain bounded synchronous pages while allowing timers to run between them. */
export async function drainSynchronousPages<TCursor>(
	run: (cursor?: TCursor) => { nextCursor?: TCursor },
	schedule: EventLoopYieldScheduler = defaultScheduler,
	options: { maxPages?: number } = {},
): Promise<void> {
	let cursor: TCursor | undefined;
	const maxPages = options.maxPages ?? 10_000;
	for (let page = 1; ; page++) {
		const nextCursor = run(cursor).nextCursor;
		if (
			nextCursor !== undefined &&
			cursor !== undefined &&
			JSON.stringify(nextCursor) === JSON.stringify(cursor)
		) {
			throw new Error("maintenance_page_cursor_not_advanced");
		}
		if (nextCursor !== undefined && page >= maxPages) {
			throw new Error(`maintenance_page_limit_exceeded:${maxPages}`);
		}
		cursor = nextCursor;
		await yieldToEventLoop(schedule);
		if (cursor === undefined) return;
	}
}
