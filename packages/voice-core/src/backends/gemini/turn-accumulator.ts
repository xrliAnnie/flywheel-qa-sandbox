/**
 * TurnAccumulator (FLY-1065 P2) — per-role delta-fragment buffers behind the
 * turn-level `final:true` semantics. Transport transcript fragments are deltas
 * (probe evidence: output fragments never overlap; input arrives whole), so
 * the aggregated turn text is plain concatenation — no joiner, no per-language
 * handling (the 中英混说 contract rides on being character-agnostic).
 *
 * flush() returning null on an empty buffer IS the idempotency gate: any
 * combination of flush signals (finished / first-assistant-output /
 * generation-complete / turn-complete / interrupted / close) emits at most
 * one final per role.
 */

export type TurnRole = "user" | "assistant";

export class TurnAccumulator {
	private readonly bufs: Record<TurnRole, string> = {
		user: "",
		assistant: "",
	};

	append(role: TurnRole, fragment: string): void {
		this.bufs[role] += fragment;
	}

	/** aggregated turn text, clearing the buffer; null when nothing buffered. */
	flush(role: TurnRole): string | null {
		const text = this.bufs[role];
		this.bufs[role] = "";
		return text === "" ? null : text;
	}

	/** drain both roles (session close — rotator rotation must not lose tails). */
	flushAll(): { user: string | null; assistant: string | null } {
		return { user: this.flush("user"), assistant: this.flush("assistant") };
	}
}
