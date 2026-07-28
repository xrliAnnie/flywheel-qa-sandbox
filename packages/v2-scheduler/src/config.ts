export interface SchedulerConfig {
	heartbeatStaleMs: number;
	heartbeatConfirmMs: number;
	confirmPollMs: number;
	repairLeaseMs: number;
	hardTimeoutMs: number;
	retryBaseMs: number;
	retryCapMs: number;
	candidateLimit: number;
	restartConcurrencyMax: number;
	pressureDecreaseWindowMs: number;
	healthyIncreaseWindowMs: number;
	memorySampleIntervalMs: number;
	freeTriggerPercent: number;
	freeClearPercent: number;
	freeTriggerFloorBytes: number;
	freeClearFloorBytes: number;
	swapoutRamDivisor: number;
	swapoutFloorPages: number;
}

export const DEFAULT_SCHEDULER_CONFIG: Readonly<SchedulerConfig> =
	Object.freeze({
		heartbeatStaleMs: 30_000,
		heartbeatConfirmMs: 15_000,
		confirmPollMs: 500,
		repairLeaseMs: 60_000,
		hardTimeoutMs: 55_000,
		retryBaseMs: 5000,
		retryCapMs: 60_000,
		candidateLimit: 100,
		restartConcurrencyMax: 1,
		pressureDecreaseWindowMs: 2000,
		healthyIncreaseWindowMs: 180_000,
		memorySampleIntervalMs: 1000,
		freeTriggerPercent: 8,
		freeClearPercent: 15,
		freeTriggerFloorBytes: 2 * 1024 ** 3,
		freeClearFloorBytes: 4 * 1024 ** 3,
		swapoutRamDivisor: 1024,
		swapoutFloorPages: 2048,
	});

function requirePositiveInteger(
	value: number,
	name: keyof SchedulerConfig,
): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer`);
	}
}

export function validateSchedulerConfig(
	config: SchedulerConfig,
): SchedulerConfig {
	for (const [key, value] of Object.entries(config) as Array<
		[keyof SchedulerConfig, number]
	>) {
		requirePositiveInteger(value, key);
	}
	if (config.restartConcurrencyMax > 32) {
		throw new TypeError("restartConcurrencyMax must be <= 32");
	}
	if (config.candidateLimit > 1000) {
		throw new TypeError("candidateLimit must be <= 1000");
	}
	if (config.repairLeaseMs < config.hardTimeoutMs) {
		throw new TypeError("repair lease must cover the scheduler hard timeout");
	}
	if (config.heartbeatConfirmMs >= config.hardTimeoutMs) {
		throw new TypeError("heartbeat confirmation must fit within hard timeout");
	}
	if (config.confirmPollMs > config.heartbeatConfirmMs) {
		throw new TypeError(
			"confirmation poll interval exceeds confirmation window",
		);
	}
	if (config.retryBaseMs > config.retryCapMs) {
		throw new TypeError("retry base must not exceed retry cap");
	}
	if (config.freeTriggerPercent >= config.freeClearPercent) {
		throw new TypeError(
			"free trigger percent must be below free clear percent",
		);
	}
	if (config.freeClearPercent > 100) {
		throw new TypeError("free clear percent must be <= 100");
	}
	if (config.freeTriggerFloorBytes > config.freeClearFloorBytes) {
		throw new TypeError("free trigger floor must not exceed free clear floor");
	}
	return { ...config };
}

function parseConcurrency(raw: string): number {
	if (!/^[1-9][0-9]*$/.test(raw)) {
		throw new TypeError(
			"FLYWHEEL_V2_RESTART_CONCURRENCY_MAX must be a canonical positive integer",
		);
	}
	return Number(raw);
}

export function resolveSchedulerConfig(
	env: NodeJS.ProcessEnv = process.env,
): SchedulerConfig {
	const raw = env.FLYWHEEL_V2_RESTART_CONCURRENCY_MAX;
	return validateSchedulerConfig({
		...DEFAULT_SCHEDULER_CONFIG,
		restartConcurrencyMax:
			raw === undefined
				? DEFAULT_SCHEDULER_CONFIG.restartConcurrencyMax
				: parseConcurrency(raw),
	});
}
