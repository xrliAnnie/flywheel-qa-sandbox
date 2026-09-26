/**
 * FLY-2862 — report a Codex Lead's failed reply to the Bridge.
 *
 * LeadInputRouter calls this (`onReplyFailed`) when an inbound that owed a reply
 * got an empty final answer. The Bridge logs it and, if a live voice session owns
 * the reply thread, has the voice daemon speak a status line so the founder is
 * not left listening to the waiting tone. Best effort: it never throws and never
 * delays the router; an unreportable failure is logged locally instead.
 */
import type { EMPTY_FINAL_ANSWER } from "./LeadInputRouter.js";
import type { JournalEntry } from "./LeadJournal.js";

const REPORT_TIMEOUT_MS = 5_000;

/** Runtime config first; else the Bridge coordinates a Lead pane already carries. */
export function resolveReplyFailureBridge(
	config: { bridgeUrl?: string; apiToken?: string },
	env: NodeJS.ProcessEnv,
): { bridgeUrl: string; apiToken: string } {
	return {
		bridgeUrl:
			config.bridgeUrl?.trim() ||
			env.BRIDGE_URL?.trim() ||
			env.FLYWHEEL_BRIDGE_URL?.trim() ||
			"",
		apiToken:
			config.apiToken?.trim() ||
			env.TEAMLEAD_API_TOKEN?.trim() ||
			env.FLYWHEEL_API_TOKEN?.trim() ||
			"",
	};
}

export function createLeadReplyFailureReporter(opts: {
	bridgeUrl: string;
	apiToken: string;
	projectName: string;
	leadId: string;
	/** Where an entry without a reply route would have been answered. */
	chatChannelId: string;
	fetchImpl?: typeof fetch;
	logger: { warn: (message: string, context?: unknown) => void };
}): (entry: JournalEntry, reason: typeof EMPTY_FINAL_ANSWER) => Promise<void> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const base = opts.bridgeUrl.trim().replace(/\/+$/, "");
	return async (entry, reason) => {
		const channelId = entry.replyChannelId ?? opts.chatChannelId;
		const unreported = (why: string) =>
			opts.logger.warn("lead_reply_failed_unreported", {
				id: entry.id,
				channelId,
				reason,
				why,
			});
		if (!base || !opts.apiToken) {
			unreported("bridge_unconfigured");
			return;
		}
		try {
			const response = await fetchImpl(
				`${base}/api/lead-outbound/reply-failed`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${opts.apiToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						projectName: opts.projectName,
						leadId: opts.leadId,
						channelId,
						idempotencyKey: entry.id,
						reason,
					}),
					signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
				},
			);
			if (!response.ok) unreported(`http_${response.status}`);
		} catch (error) {
			unreported((error as Error).message);
		}
	};
}
