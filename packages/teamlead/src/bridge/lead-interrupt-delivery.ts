/**
 * FLY-2883 — delivery-loop hooks for controlled interrupt letters.
 *
 * Only a letter whose every field matches the authoritative record written by
 * the controlled route (including a byte-for-byte re-render of its content)
 * gains steer or pane-typing capability; anything else is dead-lettered with
 * zero side effects (R2#1). Every side effect is preceded by an audit row and
 * skipped when that audit cannot be written.
 *
 * Carrier behaviour:
 *   - Codex: steer into the current turn (or start one when idle) via the
 *     sidecar; unsupported → ordinary mail.
 *   - Claude: when the pane is provably busy and safe, type ONLY the fixed
 *     phrase and hold the letter out of the native inbox until the Lead
 *     answers or goes idle. Otherwise ordinary mail.
 *   - Never cancel or interrupt the current turn.
 */

import type { MailboxRow } from "flywheel-comm/mailbox-queue";
import type {
	CodexInterruptResult,
	DurableAcceptReceipt,
	LeadDeliveryBatch,
} from "./lead-delivery-adapter.js";
import {
	LEAD_INTERRUPT_FROM_PREFIX,
	LEAD_INTERRUPT_MESSAGE_TYPE,
	LEAD_INTERRUPT_SOURCE_KIND,
	type LeadInterruptBackend,
	renderLeadInterruptLetter,
} from "./lead-interrupt-contract.js";
import type {
	LeadInterruptAuditEvent,
	LeadInterruptDisposition,
	LeadInterruptRow,
	LeadInterruptStore,
} from "./lead-interrupt-store.js";

export const LEAD_INTERRUPT_HOLD_MS = 10_000;
export const LEAD_INTERRUPT_STATE_RETRY_MS = 30_000;
export const LEAD_INTERRUPT_BINDING_MISMATCH =
	"lead_interrupt_binding_mismatch";

/** What the delivery loop does with a claimed interrupt letter. */
export type LeadInterruptDecision =
	| { kind: "ack"; reason: string }
	| { kind: "dead"; reason: string }
	| { kind: "hold"; retryAfterMs: number; reason: string }
	/** Deliver through the Lead's ordinary adapter, then call onDelivered. */
	| { kind: "mail"; onDelivered: () => void | Promise<void> }
	/** Deliver through the interrupt path inside the loop's failure boundary. */
	| {
			kind: "custom";
			deliver: () => Promise<
				| { receipt: DurableAcceptReceipt }
				| { hold: { retryAfterMs: number; reason: string } }
			>;
	  };

export interface LeadInterruptFence {
	/** Throws when this loop no longer owns the Lead or the letter's claim. */
	assertCurrentOwner(): void;
}

export interface LeadInterruptLoopHooks {
	decide(
		row: MailboxRow,
		batch: LeadDeliveryBatch,
		fence: LeadInterruptFence,
	): Promise<LeadInterruptDecision>;
	/** Audit trail for an invalid multi-member batch the loop dead-letters. */
	rejectBatch?(rows: readonly MailboxRow[]): void;
}

export type { CodexInterruptResult } from "./lead-delivery-adapter.js";

export type ClaudePaneAssessment =
	| { state: "busy_safe" }
	| {
			state: "busy_unsafe" | "idle" | "unknown";
			reason: string;
	  };

/** Pane side of the Claude path (implemented on top of the FLY-2882 reader). */
export interface ClaudeInterruptPane {
	/** Capture and judge the Lead's pane once. */
	assess(): Promise<ClaudePaneAssessment>;
	/**
	 * Re-capture, re-verify identity + judgment, call `assertCurrentOwner`
	 * immediately before sending, then type the fixed phrase. Must never type
	 * anything else; a throwing guard means nothing is sent.
	 */
	typePhrase(
		assertCurrentOwner: () => void,
	): Promise<
		{ outcome: "nudged" } | { outcome: "skipped" | "failed"; reason: string }
	>;
}

export interface LeadInterruptHooksDeps {
	interrupts: () => LeadInterruptStore;
	projectName: string;
	leadId: string;
	backend: LeadInterruptBackend;
	now: () => string;
	codexDeliverInterrupt?: (
		batch: LeadDeliveryBatch,
	) => Promise<CodexInterruptResult>;
	claudePane?: ClaudeInterruptPane;
	logger?: { warn: (message: string, context?: unknown) => void };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** R2#1: every field of the mailbox row must match the authoritative record. */
export function interruptRowMatchesRecord(
	row: MailboxRow,
	record: LeadInterruptRow | undefined,
	scope: { projectName: string; leadId: string; backend: LeadInterruptBackend },
): boolean {
	if (!record) return false;
	return (
		row.type === LEAD_INTERRUPT_MESSAGE_TYPE &&
		row.msg_class === "model" &&
		row.carrier === "inbox" &&
		// The loop delivers delivery_content ?? content; only content is bound.
		row.delivery_content === null &&
		row.content_ref === null &&
		row.delivery_id === record.deliveryId &&
		row.id === record.deliveryId &&
		row.from_agent === `${LEAD_INTERRUPT_FROM_PREFIX}${record.interruptId}` &&
		row.source_kind === LEAD_INTERRUPT_SOURCE_KIND &&
		row.source_ref === record.interruptId &&
		row.recipient_kind === "lead" &&
		row.to_agent === record.targetLeadId &&
		record.targetLeadId === scope.leadId &&
		record.targetProject === scope.projectName &&
		record.targetBackend === scope.backend &&
		row.content ===
			renderLeadInterruptLetter({
				interruptId: record.interruptId,
				voiceSessionId: record.initiatorRef,
				founderMessageId: record.founderMessageId,
				body: record.body,
			})
	);
}

export function createLeadInterruptHooks(
	deps: LeadInterruptHooksDeps,
): LeadInterruptLoopHooks {
	const warn = (message: string, context?: unknown) =>
		(deps.logger ?? console).warn(`[lead-interrupt] ${message}`, context);
	const store = () => deps.interrupts();
	const hold = (reason: string, retryAfterMs = LEAD_INTERRUPT_HOLD_MS) =>
		({ kind: "hold", retryAfterMs, reason }) as const;

	/** Best-effort audit; returns false when it could not be written. */
	const audit = (
		interruptId: string,
		event: LeadInterruptAuditEvent,
		detail: string | null,
	): boolean => {
		try {
			store().appendEvent(interruptId, event, detail, deps.now());
			return true;
		} catch (error) {
			warn(`audit ${event} failed for ${interruptId}: ${describe(error)}`);
			return false;
		}
	};

	const recordDisposition = (
		interruptId: string,
		disposition: LeadInterruptDisposition,
		reason: string | null,
	) => {
		const result = store().recordDisposition({
			interruptId,
			disposition,
			reason,
			event: disposition,
			now: deps.now(),
		});
		if (result === "invalid_state") {
			throw new Error(
				`lead interrupt ${interruptId} cannot take a disposition`,
			);
		}
	};

	const mail = (
		interruptId: string,
		reason: string,
	): LeadInterruptDecision => ({
		kind: "mail",
		onDelivered: () => recordDisposition(interruptId, "mailbox_only", reason),
	});

	/** Re-read after every await: an answered letter is never delivered. */
	const answered = (interruptId: string): LeadInterruptDecision | undefined => {
		if (store().get(interruptId)?.state !== "replied") return undefined;
		audit(interruptId, "acked_after_reply", null);
		return { kind: "ack", reason: "lead_interrupt_replied" };
	};

	const claudeDecision = async (
		record: LeadInterruptRow,
		fence: LeadInterruptFence,
	): Promise<LeadInterruptDecision> => {
		const pane = deps.claudePane;
		if (!pane) return mail(record.interruptId, "pane_judge_unavailable");
		let assessment: ClaudePaneAssessment;
		try {
			assessment = await pane.assess();
		} catch (error) {
			assessment = {
				state: "unknown",
				reason: `assess_error:${describe(error)}`,
			};
		}
		const repliedDuringAssess = answered(record.interruptId);
		if (repliedDuringAssess) return repliedDuringAssess;
		if (store().hasAuditEvent(record.interruptId, "nudged")) {
			// Already typed once: never type again. Keep holding while it works.
			return assessment.state === "busy_safe" ||
				assessment.state === "busy_unsafe"
				? hold("held_after_nudge")
				: mail(record.interruptId, "lead_idle_after_nudge");
		}
		if (assessment.state !== "busy_safe") {
			return mail(
				record.interruptId,
				assessment.state === "idle"
					? "lead_idle"
					: assessment.state === "busy_unsafe"
						? `pane_unsafe:${assessment.reason}`
						: `pane_unknown:${assessment.reason}`,
			);
		}
		// Outside any try: a lost owner must never degrade into "deliver as mail".
		fence.assertCurrentOwner();
		if (!audit(record.interruptId, "nudge_attempt", null)) {
			return mail(record.interruptId, "nudge_audit_unavailable");
		}
		let typed: Awaited<ReturnType<ClaudeInterruptPane["typePhrase"]>>;
		try {
			typed = await pane.typePhrase(() => fence.assertCurrentOwner());
		} catch (error) {
			typed = { outcome: "failed", reason: `type_error:${describe(error)}` };
		}
		if (typed.outcome !== "nudged") {
			audit(
				record.interruptId,
				typed.outcome === "skipped" ? "nudge_skipped" : "nudge_failed",
				typed.reason,
			);
			// typePhrase re-judged the pane (awaits): the Lead may have answered.
			return (
				answered(record.interruptId) ??
				mail(record.interruptId, `nudge_${typed.outcome}:${typed.reason}`)
			);
		}
		try {
			recordDisposition(record.interruptId, "nudged", null);
		} catch (error) {
			// The phrase is already on screen; the audit trail below still shows it.
			warn(
				`nudged disposition failed for ${record.interruptId}: ${describe(error)}`,
			);
			audit(record.interruptId, "nudged", "disposition_unrecorded");
		}
		return answered(record.interruptId) ?? hold("nudged");
	};

	const codexDecision = (
		record: LeadInterruptRow,
		batch: LeadDeliveryBatch,
	): LeadInterruptDecision => {
		const steer = deps.codexDeliverInterrupt;
		if (!steer) return mail(record.interruptId, "steer_unsupported");
		return {
			kind: "custom",
			deliver: async () => {
				const result = await steer(batch);
				if (result.outcome === "steer_failed") {
					audit(record.interruptId, "steer_failed", result.detail);
					return {
						hold: {
							retryAfterMs: LEAD_INTERRUPT_HOLD_MS,
							reason: `steer_failed:${result.detail}`,
						},
					};
				}
				if (result.outcome === "mailbox_only") {
					recordDisposition(record.interruptId, "mailbox_only", result.reason);
				} else {
					recordDisposition(record.interruptId, result.outcome, null);
				}
				return { receipt: result.receipt };
			},
		};
	};

	return {
		rejectBatch(rows) {
			for (const row of rows) {
				try {
					if (row.source_ref && store().get(row.source_ref))
						audit(row.source_ref, "refused", "batch_invalid");
				} catch (error) {
					warn(`batch refusal audit failed for ${row.id}: ${describe(error)}`);
				}
			}
		},
		async decide(row, batch, fence) {
			const interruptId = row.source_ref ?? "";
			let record: LeadInterruptRow | undefined;
			try {
				record = interruptId ? store().get(interruptId) : undefined;
			} catch (error) {
				warn(`record read failed for ${row.id}: ${describe(error)}`);
				return hold("record_unavailable", LEAD_INTERRUPT_STATE_RETRY_MS);
			}
			if (!record || !interruptRowMatchesRecord(row, record, deps)) {
				if (record) audit(record.interruptId, "refused", "binding_mismatch");
				warn(`binding mismatch; dead-lettering ${row.id}`);
				return { kind: "dead", reason: LEAD_INTERRUPT_BINDING_MISMATCH };
			}
			if (record.state === "replied") {
				audit(record.interruptId, "acked_after_reply", null);
				return { kind: "ack", reason: "lead_interrupt_replied" };
			}
			if (record.state === "failed") {
				return { kind: "dead", reason: "lead_interrupt_failed" };
			}
			if (record.state === "requested") {
				try {
					store().transition({
						interruptId: record.interruptId,
						from: ["requested"],
						to: "queued",
						event: "enqueued",
						detail: "completed_by_delivery",
						now: deps.now(),
					});
				} catch (error) {
					warn(
						`requested→queued failed for ${record.interruptId}: ${describe(error)}`,
					);
					return hold("state_commit_pending", LEAD_INTERRUPT_STATE_RETRY_MS);
				}
			}
			if (!audit(record.interruptId, "dispatch_attempt", deps.backend)) {
				return hold(
					"dispatch_audit_unavailable",
					LEAD_INTERRUPT_STATE_RETRY_MS,
				);
			}
			return deps.backend === "codex-app-server"
				? codexDecision(record, batch)
				: claudeDecision(record, fence);
		},
	};
}
