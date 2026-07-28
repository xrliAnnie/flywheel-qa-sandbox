export interface RestartCapacityConfig {
	maxCapacity: number;
	decreaseWindowMs: number;
	healthyIncreaseWindowMs: number;
}

function requirePositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer`);
	}
}

export class RestartCapacity {
	private capacity = 1;
	private lastDecreaseAt: number | null = null;
	private quietWindowStartedAt: number | null = null;

	constructor(private readonly config: RestartCapacityConfig) {
		requirePositiveInteger(config.maxCapacity, "maxCapacity");
		requirePositiveInteger(config.decreaseWindowMs, "decreaseWindowMs");
		requirePositiveInteger(
			config.healthyIncreaseWindowMs,
			"healthyIncreaseWindowMs",
		);
	}

	get current(): number {
		return this.capacity;
	}

	observePressure(nowMs: number): number {
		if (
			this.lastDecreaseAt === null ||
			nowMs - this.lastDecreaseAt >= this.config.decreaseWindowMs
		) {
			this.capacity = Math.max(1, this.capacity - 1);
			this.lastDecreaseAt = nowMs;
		}
		this.quietWindowStartedAt = null;
		return this.capacity;
	}

	observeHealthy(nowMs: number, provenHealthy: boolean): number {
		if (!provenHealthy) {
			this.capacity = 1;
			this.quietWindowStartedAt = null;
			return this.capacity;
		}
		if (this.quietWindowStartedAt === null) {
			this.quietWindowStartedAt = nowMs;
			return this.capacity;
		}
		if (
			nowMs - this.quietWindowStartedAt >=
			this.config.healthyIncreaseWindowMs
		) {
			this.capacity = Math.min(this.config.maxCapacity, this.capacity + 1);
			this.quietWindowStartedAt = nowMs;
		}
		return this.capacity;
	}
}
