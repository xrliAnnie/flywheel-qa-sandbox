export interface LeadInboxNudgeArgs {
	bridgeUrl?: string;
	leadId: string;
	project?: string;
	apiToken?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	warn?: (message: string) => void;
}

/**
 * Best-effort doorbell for the durable Lead inbox queue. The queue row is the
 * authority; this request only shortens the next adaptive poll interval.
 */
export async function nudgeLeadInboxBestEffort(
	args: LeadInboxNudgeArgs,
): Promise<void> {
	const bridgeUrl = args.bridgeUrl?.trim();
	if (!bridgeUrl) return;
	const timeoutMs = args.timeoutMs ?? 200;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const warn =
		args.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
	try {
		const response = await (args.fetchImpl ?? fetch)(
			`${bridgeUrl.replace(/\/+$/, "")}/api/lead-inbox/nudge`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(args.apiToken
						? { Authorization: `Bearer ${args.apiToken}` }
						: {}),
				},
				body: JSON.stringify({
					leadId: args.leadId,
					...(args.project ? { project: args.project } : {}),
				}),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			warn(
				`[flywheel-comm] lead inbox nudge returned ${response.status}; durable queue row retained`,
			);
		}
	} catch (error) {
		warn(
			`[flywheel-comm] lead inbox nudge failed: ${(error as Error).message}; durable queue row retained`,
		);
	} finally {
		clearTimeout(timer);
	}
}
