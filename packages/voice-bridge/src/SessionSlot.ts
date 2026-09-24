/**
 * SessionSlot — the single-session mutex of the resident VC (FLY-545).
 *
 * The resident #huddle VC hosts ONE voice session at a time; /glaw (huddle,
 * FLY-545) and /gemini (assistant, FLY-967) contend for the SAME slot — the
 * concurrency=1 rule is a property of the room, not of either mode. Generic
 * semantics per the 545/967 boundary ruling: acquire/release keyed by
 * (mode, holder), busy rejections carry the current holder plus a
 * founder-facing message, and only the current holder can release.
 *
 * In-process state only (plan §10: no cross-restart session recovery — a
 * dropped meeting is re-/glaw-ed, honestly).
 */

export interface SessionSlotHolder {
	/** which surface holds the room ("meet" | "live" | ...). */
	mode: string;
	/** what exactly holds it (issue identifier, session id, ...). */
	holder: string;
	/** ISO acquisition time. */
	since: string;
	/** Persistent voice-session identity when this is a lease projection. */
	sessionId?: string;
	/** Monotonic generation fenced by the persistent lease owner. */
	sessionGeneration?: number;
}

export interface SessionSlotLease {
	mode: string;
	sessionId: string;
	sessionGeneration: number;
	leaseToken: string;
}

export type AcquireResult =
	| { ok: true }
	| { ok: false; busy: SessionSlotHolder; message: string };

export interface SessionSlotOptions {
	now?: () => Date;
}

export class SessionSlot {
	private holder: SessionSlotHolder | null = null;
	private leaseIdentity: SessionSlotLease | null = null;
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
		this.leaseIdentity = null;
		return { ok: true };
	}

	/**
	 * Project an already-authoritative persistent lease into this process.
	 * The token stays private so busy/status surfaces never disclose it.
	 */
	acquireLease(lease: SessionSlotLease): AcquireResult {
		if (
			!lease.mode ||
			!lease.sessionId ||
			!lease.leaseToken ||
			!Number.isSafeInteger(lease.sessionGeneration) ||
			lease.sessionGeneration < 1
		)
			throw new Error("session_slot_lease_invalid");
		if (this.holder) {
			return {
				ok: false,
				busy: this.holder,
				message: `有一场 /${this.holder.mode} 正在进行(${this.holder.holder}),先结束它再开新的。`,
			};
		}
		this.leaseIdentity = { ...lease };
		this.holder = {
			mode: lease.mode,
			holder: lease.sessionId,
			sessionId: lease.sessionId,
			sessionGeneration: lease.sessionGeneration,
			since: this.now().toISOString(),
		};
		return { ok: true };
	}

	/** only the exact current holder may release; anything else is refused. */
	release(mode: string, holder: string): boolean {
		if (
			!this.leaseIdentity &&
			this.holder &&
			this.holder.mode === mode &&
			this.holder.holder === holder
		) {
			this.holder = null;
			return true;
		}
		return false;
	}

	/** Only the exact persistent owner generation and token may release. */
	releaseLease(lease: SessionSlotLease): boolean {
		if (
			this.leaseIdentity?.mode !== lease.mode ||
			this.leaseIdentity.sessionId !== lease.sessionId ||
			this.leaseIdentity.sessionGeneration !== lease.sessionGeneration ||
			this.leaseIdentity.leaseToken !== lease.leaseToken
		)
			return false;
		this.leaseIdentity = null;
		this.holder = null;
		return true;
	}

	current(): SessionSlotHolder | null {
		return this.holder;
	}
}
