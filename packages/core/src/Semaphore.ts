/**
 * Async counting semaphore — limits concurrent access to a shared resource.
 * Waiters are unblocked in FIFO order.
 */
export class Semaphore {
	private count = 0;
	private readonly max: number;
	private readonly queue: Array<() => void> = [];

	constructor(maxConcurrent: number) {
		if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
			throw new RangeError(
				`maxConcurrent must be a positive integer, got ${maxConcurrent}`,
			);
		}
		this.max = maxConcurrent;
	}

	async acquire(): Promise<void> {
		if (this.count < this.max) {
			this.count++;
			return;
		}
		return new Promise<void>((resolve) => {
			this.queue.push(resolve);
		});
	}

	release(): void {
		const next = this.queue.shift();
		if (next) {
			// Hand the slot directly to the next waiter (count stays the same)
			next();
		} else if (this.count > 0) {
			this.count--;
		}
	}

	get used(): number {
		return this.count;
	}

	get queueLength(): number {
		return this.queue.length;
	}
}
