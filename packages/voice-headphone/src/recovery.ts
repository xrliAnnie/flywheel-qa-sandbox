/**
 * Boot recovery (FLY-546 B2-2 ③) — reconcile a persisted turn snapshot that
 * died mid-"sending" against the side-effect ledger. Contract: NEVER re-send
 * a relayed reply, receipt card, or approval write.
 *
 * The hardest crash window (Codex R2 #3): Discord accepted the outbound
 * message but the returned id was never persisted. Every daemon outbound
 * carries a deterministic idempotency marker (`〔hp:{itemId}〕` trailer);
 * before any retry we scan the channel's recent messages for the marker and
 * ADOPT the found message instead of re-sending.
 */
import type { HeadphoneQueue, PersistedTurnState } from "flywheel-voice-core";

export function sendMarker(itemId: string): string {
	return `〔hp:${itemId}〕`;
}

export async function adoptOrSend(opts: {
	marker: string;
	scanRecent: () => Promise<Array<{ id: string; content: string }>>;
	send: () => Promise<string>;
}): Promise<{ adopted: boolean; messageId: string }> {
	const recent = await opts.scanRecent();
	const found = recent.find((m) => m.content.includes(opts.marker));
	if (found) return { adopted: true, messageId: found.id };
	return { adopted: false, messageId: await opts.send() };
}

export interface RecoveryDeps {
	/** marker-scan the item's channel; returns the adopted message id if found. */
	adoptSend: (itemId: string, channelId: string) => Promise<string | undefined>;
}

/**
 * Normalize a restored turn snapshot before handing it to the machine.
 * Only the "sending" state needs work — its async side-effect run died with
 * the process. Everything else restores as-is.
 */
export async function normalizeRestoredTurn(
	turn: PersistedTurnState,
	queue: HeadphoneQueue,
	deps: RecoveryDeps,
): Promise<PersistedTurnState> {
	if (turn.state !== "sending" || !turn.currentItem) return turn;
	const item = turn.currentItem;
	const idle: PersistedTurnState = {
		...turn,
		state: "idle",
		currentItem: undefined,
	};

	if (item.kind === "ship_gate") {
		if (item.sideEffects?.approvalAttemptId) {
			// crash point 3: the attempt id is recorded AFTER submitApproval
			// returned (Codex R1 MEDIUM-3), so its presence means the Bridge
			// answered this attempt — re-submitting founder authority on boot
			// is forbidden and unnecessary. The item is NOT re-queued into a
			// voice-approvable turn.
			return idle;
		}
		// crash point 2 (or mid-call): at most a receipt went out / the call
		// died without an observed answer. The item returns to the queue head
		// as a brand-new ship_gate turn — a fresh confirm posts a fresh receipt
		// and the gate write is idempotent, so nothing double-writes and her
		// confirmed approval is never silently lost.
		queue.deferToFront(item);
		return idle;
	}

	// normal reply relay
	if (item.sideEffects?.sentMessageId) {
		// crash point 1: the send完成 and the ledger has the id — done.
		return idle;
	}
	const adopted = await deps.adoptSend(item.id, item.channelId);
	if (adopted) {
		// hardest window: Discord accepted, id未持久化 — adopt, never re-send.
		return idle;
	}
	// nothing went out — the turn restarts fresh from the queue head.
	queue.deferToFront(item);
	return idle;
}
