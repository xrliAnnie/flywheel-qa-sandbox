/**
 * SessionSlot — the single-session mutex of the resident VC (FLY-545).
 *
 * The resident #huddle VC hosts ONE voice session at a time; /meet (huddle,
 * FLY-545) and /gemini (assistant, FLY-967) contend for the SAME slot — the
 * concurrency=1 rule is a property of the room, not of either mode. Generic
 * semantics per the 545/967 boundary ruling: acquire/release keyed by
 * (mode, holder), busy rejections carry the current holder plus a
 * founder-facing message, and only the current holder can release.
 *
 * In-process state only (plan §10: no cross-restart session recovery — a
 * dropped meeting is re-/meet'ed, honestly).
 */

export interface SessionSlotHolder {
	/** which surface holds the room ("meet" | "live" | ...). */
	mode: string;
	/** what exactly holds it (issue identifier, session id, ...). */
	holder: string;
	/** ISO acquisition time. */
	since: string;
}

export type AcquireResult =
	| { ok: true }
	| { ok: false; busy: SessionSlotHolder; message: string };

export interface SessionSlotOptions {
	now?: () => Date;
}

export class SessionSlot {
	private holder: SessionSlotHolder | null = null;
	private readonly now: () => Date;

	constructor(opts: SessionSlotOptions = {}) {
		this.now = opts.now ?? (() => new Date());
	}

	acquire(mode: string, holder: string): AcquireResult {
		if (this.holder) {
			return {
				ok: false,
				busy: this.holder,
				message: `有一场 /${this.holder.mode} 正在进行(${this.holder.holder}),先结束它再开新的。`,
			};
		}
		this.holder = { mode, holder, since: this.now().toISOString() };
		return { ok: true };
	}

	/** only the exact current holder may release; anything else is refused. */
	release(mode: string, holder: string): boolean {
		if (
			this.holder &&
			this.holder.mode === mode &&
			this.holder.holder === holder
		) {
			this.holder = null;
			return true;
		}
		return false;
	}

	current(): SessionSlotHolder | null {
		return this.holder;
	}
}
