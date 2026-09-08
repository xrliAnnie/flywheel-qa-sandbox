export type ProbeResult =
	| { state: "authorized" }
	| { state: "unauthorized"; status: 403; reason?: string }
	| { state: "incompatible"; status?: number; reason: string }
	| { state: "unavailable"; status?: number; reason: string };

export async function runOutboundPreflight(opts: {
	probe(channelId: string): Promise<ProbeResult>;
	channelIds: string[];
	attempts?: number;
	delayMs?: number;
	sleep?: (ms: number) => Promise<void>;
	log: { info(message: string): void; warn(message: string): void };
}): Promise<"authorized" | "skipped"> {
	const channelIds = [...new Set(opts.channelIds)];
	const attempts = opts.attempts ?? 4;
	const sleep =
		opts.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const results = await Promise.all(
			channelIds.map(async (channelId) => ({
				channelId,
				result: await opts.probe(channelId),
			})),
		);
		const unauthorized = results.find(
			({ result }) => result.state === "unauthorized",
		);
		if (unauthorized?.result.state === "unauthorized") {
			throw new Error(
				`codex-lead-runtime: Bridge refused outbound to channel ${unauthorized.channelId} (403 ${unauthorized.result.reason ?? "lead_channel_unauthorized"}). Declare it as roundtableChannel for this Lead in projects.json, or remove it from FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS. Outbound mode stays bridge; no fallback to direct.`,
			);
		}
		const incompatible = results.find(
			({ result }) => result.state === "incompatible",
		);
		if (incompatible?.result.state === "incompatible") {
			throw new Error(
				`codex-lead-runtime: Bridge outbound probe incompatible for channel ${incompatible.channelId} (HTTP ${incompatible.result.status ?? "unknown"} ${incompatible.result.reason}) — Bridge is older than FLY-2442, the API token is wrong, or the route is missing. Outbound mode stays bridge; no fallback to direct.`,
			);
		}
		if (results.every(({ result }) => result.state === "authorized")) {
			opts.log.info(
				`lead-outbound preflight: authorized ${channelIds.join(",")}`,
			);
			return "authorized";
		}
		if (attempt < attempts) await sleep(opts.delayMs ?? 10_000);
	}
	opts.log.warn(
		`lead-outbound preflight: Bridge unavailable after ${attempts} attempts; bridge mode remains enabled`,
	);
	return "skipped";
}
