/**
 * FLY-1041 Chunk 8 — founder receipt reaction (Annie's core pain point).
 *
 * After the deliverer processes a founder message that had matching ship
 * gates, it reacts on HER message: ✅ = "your decision bound (a response was
 * written — approve or reject)"; ❓ = "did NOT bind (unclear / classifier
 * failure / held / multi-gate)". The receipt means ONLY "binding outcome" —
 * it is NOT "shipped" (ship completion has its own thread notification, R7).
 *
 * Best-effort by design: a PUT failure is audited (`founder_ack_failed`) and
 * never retried or allowed to block delivery — the next founder message
 * simply goes through the whole flow again.
 */

const DISCORD_API = "https://discord.com/api/v10";
const PUT_TIMEOUT_MS = 5_000;

export interface ReactToFounderMessageArgs {
	botToken: string;
	/** The thread id (a Discord thread is a channel). */
	channelId: string;
	/** The FOUNDER's message id — the receipt lands on her message. */
	messageId: string;
	/** FLY-1099 §3.2: 🕒 = durably deferred (auto-binds when the hold clears). */
	emoji: "✅" | "🕒" | "❓";
	fetchImpl?: typeof fetch;
}

/**
 * PUT /channels/{cid}/messages/{mid}/reactions/{emoji}/@me — add the bot's
 * reaction. Requires the ADD_REACTIONS permission; a 403 surfaces as
 * `{ok:false, status:403}` for the caller's `founder_ack_failed` audit.
 * Never throws.
 */
export async function reactToFounderMessage(
	args: ReactToFounderMessageArgs,
): Promise<{ ok: boolean; status?: number }> {
	const fetchImpl = args.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PUT_TIMEOUT_MS);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${args.channelId}/messages/${args.messageId}/reactions/${encodeURIComponent(args.emoji)}/@me`,
			{
				method: "PUT",
				headers: { Authorization: `Bot ${args.botToken}` },
				signal: controller.signal,
			},
		);
		return { ok: res.ok, status: res.status };
	} catch {
		return { ok: false };
	} finally {
		clearTimeout(timer);
	}
}
