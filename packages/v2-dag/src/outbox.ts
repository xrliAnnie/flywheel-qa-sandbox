import type { WriteTx } from "flywheel-v2-kernel";
import type { CanonicalValue } from "./digests.js";
import { appendMailboxTx } from "./mailbox-append.js";

/**
 * FLY-1544 ③④: the Discord outbox.
 *
 * Engine lifecycle events (issue opened / task dispatched / node completed /
 * PR ready / merged / issue closed) and runner progress mirrors become mailbox
 * rows addressed to ONE well-known lead-kind recipient — the bidirectional
 * Discord messenger (teamlead `flywheel-v2-discord-ingress`). The messenger
 * registers under this id, pulls its mailbox like any lead, performs the
 * Discord effect (create/post/archive the `[FLY-XXXX]` issue thread) and
 * settles each delivery with an event effect recording the outcome.
 *
 * The rows ride the existing mailbox machinery: durable, deduped on
 * (source_kind, source_id), consumed through the normal delivery/settlement
 * path. No new tables, no new daemon — the messenger process already exists.
 */
export const DISCORD_MESSENGER_AGENT_ID = "discord-messenger";

/**
 * The mailbox recipient trigger requires the recipient to exist as a lead
 * agents row BEFORE the insert, and this append runs inside arbitrary engine
 * transactions (admission, dispatch, completion, ship) — so the recipient is
 * provisioned in the SAME transaction, mirroring the engine's idempotent
 * provisioning insert. Without this, the first lifecycle append on a fresh
 * database would abort its whole transaction.
 */
function ensureMessengerRecipientTx(tx: WriteTx): void {
	tx.run(
		`INSERT INTO agents(agent_id,kind,generation,last_poll_at,state)
		 VALUES (@agentId,'lead',0,NULL,'offline')
		 ON CONFLICT(agent_id) DO NOTHING`,
		{ agentId: DISCORD_MESSENGER_AGENT_ID },
	);
}

export function appendDiscordOutboxTx(
	tx: WriteTx,
	input: {
		sourceKind: string;
		sourceId: string;
		/** The messenger's dispatch key: issue_opened / task_dispatched / ... */
		kind: string;
		issueId: string;
		payload: Record<string, CanonicalValue>;
		/** Default "business" (never shed); progress mirrors pass "notice". */
		retentionClass?: "notice" | "business";
		cutoverEpoch: number;
		createdAt: string;
	},
): string {
	ensureMessengerRecipientTx(tx);
	return appendMailboxTx(tx, {
		sourceKind: input.sourceKind,
		sourceId: input.sourceId,
		toAgent: DISCORD_MESSENGER_AGENT_ID,
		kind: input.kind,
		payload: {
			v: 1,
			issue_id: input.issueId,
			...input.payload,
		} as unknown as CanonicalValue,
		retentionClass: input.retentionClass ?? "business",
		cutoverEpoch: input.cutoverEpoch,
		createdAt: input.createdAt,
	});
}

/**
 * FLY-1544 ③④ (founder ruling): lifecycle events are COPIED, never relayed —
 * one engine write lands the same payload in TWO mailboxes: the issue's lead
 * (global awareness, read + ack) and the Discord messenger (thread latency
 * independent of lead liveness). The lead copy carries a `#lead`-suffixed
 * source id so both rows dedup independently on (source_kind, source_id).
 */
export function appendLifecycleTx(
	tx: WriteTx,
	input: {
		sourceKind: string;
		sourceId: string;
		kind: string;
		issueId: string;
		payload: Record<string, CanonicalValue>;
		retentionClass?: "notice" | "business";
		cutoverEpoch: number;
		createdAt: string;
	},
): { messengerUid: string; leadUid: string } {
	const messengerUid = appendDiscordOutboxTx(tx, input);
	const issue = tx.get<{ value: string }>(
		"SELECT value FROM meta WHERE key=@key",
		{ key: `dag_issue:${input.issueId}` },
	);
	if (!issue) {
		throw new Error(
			`lifecycle event ${input.kind} has no issue receipt for ${input.issueId}`,
		);
	}
	const notifyAgentId = (
		JSON.parse(issue.value) as { data?: { notify_agent_id?: unknown } }
	).data?.notify_agent_id;
	if (typeof notifyAgentId !== "string" || notifyAgentId.length === 0) {
		throw new Error(
			`lifecycle event ${input.kind} has no notify agent for ${input.issueId}`,
		);
	}
	const leadUid = appendMailboxTx(tx, {
		sourceKind: input.sourceKind,
		sourceId: `${input.sourceId}#lead`,
		toAgent: notifyAgentId,
		kind: input.kind,
		payload: {
			v: 1,
			issue_id: input.issueId,
			...input.payload,
		} as unknown as CanonicalValue,
		retentionClass: input.retentionClass ?? "business",
		cutoverEpoch: input.cutoverEpoch,
		createdAt: input.createdAt,
	});
	return { messengerUid, leadUid };
}
