/**
 * FLY-1547 §2.3: the ONE closed settlement-disposition policy for mailbox
 * envelopes — the 读/办两章 (read/act two-chapter) contract in executable form.
 *
 * - FYI chapter: reading is settling. The mailbox MCP auto-acks these with an
 *   empty proposal on the recipient's NEXT tool contact (deferred ack — the
 *   crash windows are covered by the §2.1 lost-handoff redelivery).
 * - ACTIONABLE chapter: settlement is explicit. `task_assignment` is settled
 *   by the runner's own work proposal; an answer-requiring `runner_ask` is
 *   settled only after its reply was enqueued. Unsettled rows are the visible
 *   debt on the ledger.
 * - UNKNOWN: fail-loud. Never auto-settled, stays pending, surfaces as an
 *   error to the reader. The roll-call test in
 *   __tests__/settlement-disposition.test.ts scans every mailbox append site
 *   in this package, so introducing a new kind without classifying it here
 *   turns the build red instead of wedging production mail.
 *
 * Dependency-neutral on purpose: v2-dag is imported by v2-host, v2-cli and the
 * mailbox MCP, so every consumer shares these exact bytes.
 */

/** Lifecycle + notice kinds: reading them IS handling them (current lead
 * behavior, kept byte-faithful — `instruction` and `ask_response` are read-
 * settle today and stay that way; flagged as an explicit design assumption in
 * the FLY-1547 plan). */
const FYI_KINDS = new Set([
	"issue_opened",
	"issue_closed",
	"node_completed",
	"task_dispatched",
	"pr_ready",
	"issue_merged",
	"ship_authorized",
	"ship_action_blocked",
	"ship_retry_exhausted",
	"ship_authority_recovered",
	"ship_actor_authority_recovered",
	"action_unsettleable_generation",
	"ship_retry_rearmed",
	"span_anchor_diverged",
	"review_family_exhausted",
	"lost_writer_span_adopted",
	"attempt_lost_open_candidate",
	"task_dispatch_skipped",
	"task_dispatch_skipped_repeat",
	"task_contract_invalid",
	"task_contract_invalid_repeat",
	"task_dispatch_invalid",
	"task_dispatch_invalid_repeat",
	"instruction",
	"ask_response",
]);

/** Kinds whose settlement is the recipient's explicit act. */
const ACTIONABLE_KINDS = new Set(["task_assignment"]);

export type SettlementDisposition =
	| { chapter: "fyi" }
	| { chapter: "actionable" }
	| { chapter: "unknown"; reason: string };

const ASK_KINDS = new Set(["progress", "ask", "blocked"]);

/**
 * Classify one mailbox envelope. `runner_ask` requires a well-formed payload:
 * a malformed one is UNKNOWN (fail-loud), never silently auto-settled.
 */
export function settlementDisposition(envelope: {
	kind: string;
	payload: string;
}): SettlementDisposition {
	if (envelope.kind === "runner_ask") {
		let askKind: unknown;
		try {
			const parsed: unknown = JSON.parse(envelope.payload);
			askKind =
				typeof parsed === "object" && parsed !== null
					? (parsed as Record<string, unknown>).ask_kind
					: undefined;
		} catch {
			return {
				chapter: "unknown",
				reason: "runner_ask payload is not JSON",
			};
		}
		if (typeof askKind !== "string" || !ASK_KINDS.has(askKind)) {
			return {
				chapter: "unknown",
				reason: `runner_ask payload carries an unrecognized ask_kind ${JSON.stringify(askKind)}`,
			};
		}
		return askKind === "progress"
			? { chapter: "fyi" }
			: { chapter: "actionable" };
	}
	if (FYI_KINDS.has(envelope.kind)) return { chapter: "fyi" };
	if (ACTIONABLE_KINDS.has(envelope.kind)) return { chapter: "actionable" };
	return {
		chapter: "unknown",
		reason: `mailbox kind ${JSON.stringify(envelope.kind)} is not classified`,
	};
}

/** FLY-1547 R3-F7: the ONLY kinds a generic mailbox `send` may emit. Free-form
 * content rides the payload of a classified kind — an unclassifiable kind can
 * never be manufactured through the tool face. */
export const MAILBOX_SEND_KINDS: ReadonlySet<string> = new Set(["instruction"]);

/** The full classified vocabulary — exported for the roll-call test and for
 * protocol/manual text generation; not a second policy. */
export const CLASSIFIED_MAILBOX_KINDS: ReadonlySet<string> = new Set([
	...FYI_KINDS,
	...ACTIONABLE_KINDS,
	"runner_ask",
]);
