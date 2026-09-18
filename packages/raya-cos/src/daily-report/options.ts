export interface DailyReportOptions {
	turnTimeoutMs: number;
	ingestTimeoutMs: number;
	retryDelayMs: number;
	maxAttempts: number;
	maxSummaryBytes: number;
	maxTotalBytes: number;
}

export const DEFAULT_DAILY_REPORT_OPTIONS: Readonly<DailyReportOptions> =
	Object.freeze({
		turnTimeoutMs: 600_000,
		ingestTimeoutMs: 120_000,
		retryDelayMs: 1_800_000,
		maxAttempts: 3,
		maxSummaryBytes: 65_536,
		maxTotalBytes: 524_288,
	});

const BOUNDS = {
	turnTimeoutMs: [60_000, 1_800_000],
	ingestTimeoutMs: [30_000, 600_000],
	retryDelayMs: [60_000, 21_600_000],
	maxAttempts: [1, 5],
	maxSummaryBytes: [4_096, 1_048_576],
	maxTotalBytes: [65_536, 4_194_304],
} as const satisfies Record<
	keyof DailyReportOptions,
	readonly [number, number]
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseDailyReportOptionsJson(
	raw: string | undefined,
): DailyReportOptions {
	if (raw === undefined) {
		return { ...DEFAULT_DAILY_REPORT_OPTIONS };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error("daily report options must be valid JSON", {
			cause: error,
		});
	}

	if (!isPlainObject(parsed)) {
		throw new Error("daily report options must be a JSON object");
	}

	const options: DailyReportOptions = { ...DEFAULT_DAILY_REPORT_OPTIONS };
	for (const [key, value] of Object.entries(parsed)) {
		if (!(key in BOUNDS)) {
			throw new Error(`daily report options contain unknown key: ${key}`);
		}

		const optionKey = key as keyof DailyReportOptions;
		const [minimum, maximum] = BOUNDS[optionKey];
		if (
			typeof value !== "number" ||
			!Number.isInteger(value) ||
			value < minimum ||
			value > maximum
		) {
			throw new Error(
				`daily report option ${key} must be an integer between ${minimum} and ${maximum}`,
			);
		}
		options[optionKey] = value;
	}

	return options;
}
