/**
 * TalkSessionRotator — keeps a talk conversation alive across Gemini Live
 * session expiry (FLY-959 bug 2). On "session-expiring" (server goAway) it
 * closes the current session, takes the ResumeHandle, and opens a resumed
 * session with it. The mic and player never restart; frames arriving during
 * the sub-second swap are dropped. Scope: goAway-driven renewal ONLY —
 * unexpected disconnects (error events) still surface and are not retried.
 */
import type {
	AudioFormat,
	ConversationSession,
	ResumeHandle,
} from "./types.js";

export interface TalkSessionRotatorOptions {
	/** open a (possibly resumed) conversation — the CLI binds backend+opts here. */
	create: (resumeHandle?: ResumeHandle) => Promise<ConversationSession>;
	/** attach CLI event handlers; called for the first and every rotated session. */
	attach: (session: ConversationSession) => void;
	/** rotation status lines (the CLI writes them to stderr). */
	log?: (line: string) => void;
	/** rotation failed — the conversation is dead; the CLI decides shutdown. */
	onError?: (err: unknown) => void;
	/** an UNEXPECTED disconnect was auto-recovered (FLY-545 QA R2 F1) —
	 * resumed=true when the successor carried the resume handle (context
	 * kept), false when it restarted cold. Callers surface this to the user
	 * ("刚才闪断了一下…") so the abort window is never a silent black hole. */
	onReconnected?: (resumed: boolean) => void;
	/** a connection-DEATH reconnect rotation is STARTING (FLY-545 QA R5) —
	 * fired before the successor exists, so the caller can show a truthful
	 * "line down / recovering" state for the whole abort window. Graceful
	 * goAway rotations are planned and sub-second — they do not fire this. */
	onDown?: () => void;
}

export class TalkSessionRotator {
	private session?: ConversationSession;
	private rotating = false;
	private closed = false;

	constructor(private readonly opts: TalkSessionRotatorOptions) {}

	/** open the first session. */
	async start(): Promise<void> {
		const first = await this.opts.create();
		this.session = first;
		this.hook(first);
	}

	/** forward one mic frame; dropped while a rotation is in flight. */
	sendAudio(frame: Buffer, format: AudioFormat): void {
		this.session?.sendAudio(frame, format);
	}

	/** FLY-967: forward a control prompt to the current session; dropped while a
	 * rotation is in flight (sub-second window — the caller may re-issue). */
	endUserTurn(): void {
		this.session?.endUserTurn();
	}

	sendText(text: string): void {
		this.session?.sendText(text);
	}

	/** FLY-545: forward a silent context feed to the current session. Returns
	 * false while a rotation is in flight (no live session) — the caller's
	 * feed cursor must NOT advance on a drop, or the fact is lost forever
	 * (Codex R1 HIGH: a silent void no-op read as delivered). */
	injectContext(text: string): boolean {
		if (!this.session) return false;
		this.session.injectContext(text);
		return true;
	}

	/** close the live session (if any) and stop all future rotation. */
	async close(): Promise<ResumeHandle | undefined> {
		this.closed = true;
		const s = this.session;
		this.session = undefined;
		return s?.close();
	}

	private hook(session: ConversationSession): void {
		this.opts.attach(session);
		// session-scoped: a late/duplicate go-away from a rotated-out session
		// must never rotate (and close) its successor (Codex R1 #1).
		session.on("session-expiring", () => {
			if (this.session === session) void this.rotate(session);
		});
		// connection DEATH auto-reconnect (FLY-545 QA R2 F1): the meeting-
		// assembly burst reproducibly aborts a live ws; the resume handle is
		// still cached in the session, so a rotate recovers the conversation
		// instead of leaving the line dead for the rest of the meeting. Only
		// this one error code rotates — protocol/tool errors stay put.
		session.on("error", (err) => {
			if (
				err.code === "connection-closed" &&
				this.session === session &&
				!this.closed
			) {
				void this.rotate(session, { reconnect: true });
			}
		});
	}

	/** single-flight renewal (goAway rotation AND disconnect reconnect):
	 * close → take handle → reopen resumed. */
	private async rotate(
		expected: ConversationSession,
		opts: { reconnect?: boolean } = {},
	): Promise<void> {
		if (this.rotating || this.closed || this.session !== expected) return;
		this.rotating = true;
		// after the guard, so a late/duplicate error never double-fires it.
		if (opts.reconnect) this.opts.onDown?.();
		const old = expected;
		this.session = undefined; // frames drop instead of hitting a dying socket
		try {
			const handle = await old.close();
			const next = await this.opts.create(handle);
			if (this.closed) {
				await next.close(); // closed mid-rotation — don't leak the new session
				return;
			}
			this.session = next;
			this.hook(next);
			this.opts.log?.(
				handle
					? "[session resumed]"
					: "[session restarted — no resume handle, context lost]",
			);
			if (opts.reconnect) this.opts.onReconnected?.(!!handle);
		} catch (err) {
			this.opts.onError?.(err);
		} finally {
			this.rotating = false;
		}
	}
}
