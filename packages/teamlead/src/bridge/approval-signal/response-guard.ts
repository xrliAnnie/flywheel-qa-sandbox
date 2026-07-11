/**
 * FLY-1099 §4.3 (Codex R4 #2 + R5 #1) — the guarded `onResponseWritten`
 * wrapper shared by BOTH founder write paths (live handler + deferred rebind).
 *
 * The shared writer (`writeGateResponseAndRunPostWrite`, byte-frozen) compares
 * a prior response to the new answer only by the `isApproval` BOOLEAN, and it
 * runs the post-write hook BEFORE returning `already_answered` — so a prior
 * founder reject with DIFFERENT feedback would let the production hook
 * `sendRunnerWake` the NEW feedback even though the stored (authoritative)
 * response is the OLD one. The conflict judgement must therefore happen
 * BEFORE the hook executes: this wrapper re-reads the question's single
 * response right before invoking the original hook and refuses (zero hook,
 * zero wake, zero FSM transition) unless:
 *   (i)  the response's actor is the current canonical founder, AND
 *   (ii) approve → the response is a valid structured approval;
 *        reject  → the response equals THIS payload byte-for-byte.
 * An exact-match canonical retry calls the original hook unchanged (the
 * re-run-hook convergence semantics stay intact).
 *
 * The refusal reason is exposed on `state` so the caller (which constructed
 * the wrapper per write attempt) can map it to its terminal:
 *   actor_mismatch / direction_mismatch → gate_gone (someone else answered);
 *   content_mismatch → conflicting_prior_feedback (same-direction reject,
 *   different text — invalidate + double-excerpt audit, never re-wake).
 */

export type ResponseGuardRefusal =
	| "missing_response"
	| "actor_mismatch"
	| "direction_mismatch"
	| "content_mismatch";

export interface ResponseGuardState {
	refusal?: ResponseGuardRefusal;
	/** The stored (winning) response content, for double-excerpt audits. */
	priorContent?: string;
	/** The stored response's actor, for gate_gone audits. */
	priorActor?: string;
}

/** Minimal read face (CommDB satisfies it; the writer's GateResponseDb too). */
export interface ResponseGuardDb {
	getResponse(
		questionId: string,
	): { content: string; from_agent: string } | undefined;
}

export function isApprovalContent(content: string): boolean {
	try {
		return JSON.parse(content)?.approved === true;
	} catch {
		return false;
	}
}

export function makeGuardedOnResponseWritten<
	TInfo extends { questionId: string },
>(args: {
	db: ResponseGuardDb;
	canonicalFounderId: string;
	decision: "approve" | "reject";
	expectedAnswer: string;
	original?: (info: TInfo) => unknown;
}): {
	hook: (info: TInfo) => unknown;
	state: ResponseGuardState;
} {
	const state: ResponseGuardState = {};
	const hook = (info: TInfo): unknown => {
		const prior = args.db.getResponse(info.questionId);
		if (!prior) {
			// The writer only calls the hook after a response reached a durable
			// state — a missing row here is a torn read; refuse fail-closed.
			state.refusal = "missing_response";
			return { ok: false };
		}
		state.priorContent = prior.content;
		state.priorActor = prior.from_agent;
		if (prior.from_agent !== args.canonicalFounderId) {
			state.refusal = "actor_mismatch";
			return { ok: false };
		}
		if (args.decision === "approve") {
			if (!isApprovalContent(prior.content)) {
				state.refusal = "direction_mismatch";
				return { ok: false };
			}
		} else {
			if (isApprovalContent(prior.content)) {
				state.refusal = "direction_mismatch";
				return { ok: false };
			}
			if (prior.content !== args.expectedAnswer) {
				state.refusal = "content_mismatch";
				return { ok: false };
			}
		}
		if (!args.original) return { ok: true };
		return args.original(info);
	};
	return { hook, state };
}
