interface AudioClockOptions {
	intervalMs: number;
	now: () => number;
	schedule: (callback: () => void, delayMs: number) => unknown;
	cancel: (handle: unknown) => void;
	onFire: (at: number) => void;
	onDropped: (reason: "stall", scheduledAt: number) => void;
}

export class AudioClock {
	private nextAt = 0;
	private handle: unknown;
	private running = false;

	constructor(private readonly options: AudioClockOptions) {
		if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
			throw new Error("intervalMs must be positive");
		}
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.nextAt = this.options.now() + this.options.intervalMs;
		this.scheduleNext();
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		if (this.handle !== undefined) this.options.cancel(this.handle);
		this.handle = undefined;
	}

	private readonly tick = () => {
		if (!this.running) return;
		const now = this.options.now();
		if (now - this.nextAt >= this.options.intervalMs) {
			const missed = Math.floor((now - this.nextAt) / this.options.intervalMs);
			for (let index = 0; index < missed; index += 1) {
				this.options.onDropped(
					"stall",
					this.nextAt + index * this.options.intervalMs,
				);
			}
			this.options.onFire(now);
			this.nextAt = now + this.options.intervalMs;
		} else {
			this.options.onFire(now);
			this.nextAt += this.options.intervalMs;
		}
		this.scheduleNext();
	};

	private scheduleNext(): void {
		if (!this.running) return;
		const delay = Math.max(0, this.nextAt - this.options.now());
		this.handle = this.options.schedule(this.tick, delay);
	}
}
