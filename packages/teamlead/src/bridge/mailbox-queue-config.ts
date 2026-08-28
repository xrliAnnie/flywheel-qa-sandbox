export interface MailboxQueueConfig {
	ackLeaseMs: number;
	batchWindowMs: number;
	batchMaxSize: number;
	inflightMaxBatches: number;
	leaseRetryMax: number;
	deadLetterWindowMs: number;
	unavailableRetryMax: number;
}

export const DEFAULT_MAILBOX_QUEUE_CONFIG: Readonly<MailboxQueueConfig> = {
	ackLeaseMs: 1_800_000,
	batchWindowMs: 30_000,
	batchMaxSize: 10,
	inflightMaxBatches: 3,
	leaseRetryMax: 3,
	deadLetterWindowMs: 1_800_000,
	unavailableRetryMax: 55,
};

type Warn = (message: string) => void;

const warnedInvalidKnobs = new Set<string>();

function boundedInteger(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
	min: number,
	max: number,
	warn: Warn,
): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	if (Number.isInteger(parsed) && parsed >= min && parsed <= max) return parsed;
	if (!warnedInvalidKnobs.has(name)) {
		warnedInvalidKnobs.add(name);
		warn(
			`[mailbox-queue] ignoring invalid ${name}=${JSON.stringify(raw)}; expected integer ${min}..${max}, using ${fallback}`,
		);
	}
	return fallback;
}

/** Resolve once at the beginning of each lane tick. */
export function resolveMailboxQueueConfig(
	env: NodeJS.ProcessEnv = process.env,
	warn: Warn = console.warn,
): MailboxQueueConfig {
	return {
		ackLeaseMs: boundedInteger(
			env,
			"FLYWHEEL_MAILBOX_ACK_LEASE_MS",
			DEFAULT_MAILBOX_QUEUE_CONFIG.ackLeaseMs,
			10_000,
			86_400_000,
			warn,
		),
		batchWindowMs: boundedInteger(
			env,
			"FLYWHEEL_MAILBOX_BATCH_WINDOW_MS",
			DEFAULT_MAILBOX_QUEUE_CONFIG.batchWindowMs,
			0,
			3_600_000,
			warn,
		),
		batchMaxSize: boundedInteger(
			env,
			"FLYWHEEL_MAILBOX_BATCH_MAX",
			DEFAULT_MAILBOX_QUEUE_CONFIG.batchMaxSize,
			1,
			50,
			warn,
		),
		inflightMaxBatches: boundedInteger(
			env,
			"FLYWHEEL_MAILBOX_INFLIGHT_BATCHES",
			DEFAULT_MAILBOX_QUEUE_CONFIG.inflightMaxBatches,
			1,
			20,
			warn,
		),
		leaseRetryMax: boundedInteger(
			env,
			"FLYWHEEL_MAILBOX_LEASE_RETRY_MAX",
			DEFAULT_MAILBOX_QUEUE_CONFIG.leaseRetryMax,
			0,
			10,
			warn,
		),
		deadLetterWindowMs: boundedInteger(
			env,
			"FLYWHEEL_MAILBOX_DEADLETTER_WINDOW_MS",
			DEFAULT_MAILBOX_QUEUE_CONFIG.deadLetterWindowMs,
			10_000,
			86_400_000,
			warn,
		),
		unavailableRetryMax: boundedInteger(
			env,
			"FLYWHEEL_MAILBOX_UNAVAILABLE_RETRY_MAX",
			DEFAULT_MAILBOX_QUEUE_CONFIG.unavailableRetryMax,
			1,
			100_000,
			warn,
		),
	};
}

export function resetMailboxQueueConfigWarningsForTests(): void {
	warnedInvalidKnobs.clear();
}
