/**
 * Per-key mutex — ensures only one concurrent operation per project.
 * Waiters for the same key are unblocked in FIFO order.
 *
 * Uses the same direct-handoff pattern as Semaphore: when a waiter
 * exists, release() hands the lock directly without releasing the
 * held state, preventing new callers from jumping the queue.
 */
export class ProjectLock {
	private readonly held = new Set<string>();
	private readonly queues = new Map<string, Array<() => void>>();

	async acquire(projectId: string): Promise<void> {
		if (!this.held.has(projectId)) {
			this.held.add(projectId);
			return;
		}
		return new Promise<void>((resolve) => {
			let q = this.queues.get(projectId);
			if (!q) {
				q = [];
				this.queues.set(projectId, q);
			}
			q.push(resolve);
		});
	}

	release(projectId: string): void {
		if (!this.held.has(projectId)) return;

		const q = this.queues.get(projectId);
		if (q && q.length > 0) {
			// Hand lock directly to next waiter — held stays true
			// so new acquire() callers still see it as locked.
			const next = q.shift()!;
			if (q.length === 0) this.queues.delete(projectId);
			next();
		} else {
			this.held.delete(projectId);
		}
	}
}
