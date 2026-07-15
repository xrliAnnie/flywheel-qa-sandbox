/**
 * ResidentLineDriver (FLY-1160 §4.1-5) — the /glaw resident-mode turn pump.
 *
 * In resident mode the RESIDENT Claude brain does the thinking (not Gemini):
 * a founder utterance routed to this line becomes one `brain.respond(text)`
 * text stream, and this driver pumps that stream into the line's TextTurnMouth
 * (beginTurn → feed(delta)* → endTurn). It owns the two invariants HuddleSession
 * cannot express from its synchronous handlers:
 *
 *   - SERIAL turns: a new respond() waits for the previous pump to settle
 *     (ResidentClaudeBrain serializes on its own turnChain too, but the mouth's
 *     beginTurn/endTurn bracketing must never interleave between two turns).
 *   - BARGE-IN order (Codex #552-plan R2 #4a): `mouth.flush()` runs
 *     SYNCHRONOUSLY (the founder's interrupt silences the current tick — the
 *     LeadSpeaker <100ms budget is a local call), THEN the in-flight turn is
 *     aborted; the brain's respond signal turns that abort into brain.interrupt()
 *     asynchronously. The next respond awaits the serial barrier, never the stop.
 *
 * A cancelled turn (barge-in / teardown) is a NORMAL live-meeting outcome and
 * is silent. A REAL turn failure (subprocess-failed / timeout / respawn-limit)
 * is fail-loud to onError (→ TIV) and the dead turn's mouth stream is cleared.
 */
import type { Turn } from "flywheel-voice-core";

/** the resident brain surface this driver needs (ResidentClaudeBrain satisfies
 * it). respond's signal, when aborted, ends the turn AND triggers the brain's
 * own interrupt() — the driver relies on that (it does not double-interrupt). */
export interface ResidentTurnBrain {
	respond(
		turn: { text: string; history: Turn[] },
		opts: { signal: AbortSignal },
	): AsyncIterable<string>;
	interrupt(): Promise<void>;
}

/** the full resident-brain handle a /glaw line binds: the driver uses
 * respond/interrupt; the FeedPipeline adapter uses appendContext (§4.1-4).
 * ResidentClaudeBrain satisfies it. */
export interface ResidentBrainHandle extends ResidentTurnBrain {
	appendContext(text: string): { accepted: boolean; seq?: number };
}

/** the text mouth this driver drives (TextTurnMouth satisfies it). */
export interface ResidentMouth {
	beginTurn(): void;
	feed(delta: string): void;
	endTurn(): void;
	/** barge-in fast path: drop the un-synthesized buffer + stop the speaker. */
	flush(): void;
}

export interface ResidentLineDriverOptions {
	brain: ResidentTurnBrain;
	mouth: ResidentMouth;
	/** the first delta of a turn arrived — the line is now audibly answering
	 * (HuddleSession maps this to the speaking presence + the grant belt). The
	 * parallel of the Gemini response-started event. */
	onSpeaking?: () => void;
	/** the turn ended CLEANLY — the full spoken text (HuddleSession captions it
	 * and fans it out to the other lines' feed). The parallel of response-done.
	 * NOT called on a barge-in cancel (the answer was cut) or a real failure. */
	onAnswer?: (text: string) => void;
	/** a REAL turn failure (never a barge-in cancel) — fail-loud to the TIV. */
	onError?: (err: Error) => void;
	log?: (line: string) => void;
}

export class ResidentLineDriver {
	/** serial barrier: each respond chains after the previous pump settles. */
	private turnChain: Promise<void> = Promise.resolve();
	/** EVERY live-or-queued turn's abort handle (Codex R2 HIGH-1). A single
	 * `current` breaks when turn B is queued behind a still-streaming turn A: B
	 * would overwrite the handle and a barge-in would abort B while A kept
	 * playing. barge-in aborts the whole set, so both the streaming and the
	 * queued turn stop. */
	private readonly inFlight = new Set<AbortController>();

	constructor(private readonly opts: ResidentLineDriverOptions) {}

	/** kick off a founder turn — pump the resident's text stream into the mouth.
	 * Fire-and-forget from HuddleSession's synchronous perspective; serial across
	 * calls. */
	respond(text: string): void {
		// Register the controller SYNCHRONOUSLY (Codex R1 HIGH-1 / R2 HIGH-1): a
		// barge-in in the same tick as respond(), or before the turn's async chain
		// runs — even one that lands while a PRIOR turn is still streaming — must
		// cancel this turn. If aborted before the pump starts, the turn is skipped
		// entirely; a dead turn never opens the mouth.
		const ac = new AbortController();
		this.inFlight.add(ac);
		const prev = this.turnChain;
		this.turnChain = (async () => {
			await prev.catch(() => undefined);
			if (ac.signal.aborted) {
				this.inFlight.delete(ac);
				return;
			}
			this.opts.mouth.beginTurn();
			let sawDelta = false;
			let answer = "";
			try {
				for await (const delta of this.opts.brain.respond(
					{ text, history: [] },
					{ signal: ac.signal },
				)) {
					if (!sawDelta) {
						sawDelta = true;
						this.opts.onSpeaking?.();
					}
					answer += delta;
					this.opts.mouth.feed(delta);
				}
				if (ac.signal.aborted) {
					// barge-in landed after a clean stream end — the mouth was
					// already flushed by bargeIn(); do NOT endTurn/answer a dead turn.
					this.opts.log?.("[resident-line] turn cancelled (post-stream)");
				} else {
					this.opts.mouth.endTurn();
					this.opts.onAnswer?.(answer);
				}
			} catch (err) {
				const e = err instanceof Error ? err : new Error(String(err));
				if (ac.signal.aborted) {
					// barge-in / teardown cut the turn — the mouth was already
					// flushed synchronously by bargeIn(); a cancelled turn is silent.
					this.opts.log?.(`[resident-line] turn cancelled: ${e.message}`);
				} else {
					// a real brain failure — clear the dead turn's mouth stream and
					// surface it (never a silent swallow, never a bogus onAnswer).
					this.opts.mouth.flush();
					this.opts.log?.(`[resident-line] turn failed: ${e.message}`);
					this.opts.onError?.(e);
				}
			} finally {
				this.inFlight.delete(ac);
			}
		})();
	}

	/** barge-in: stop the mouth SYNCHRONOUSLY (Codex #552-plan R2 #4a — the
	 * founder's interrupt silences the current tick), THEN end EVERY live-or-
	 * queued turn: abort all their signals (ends the respond loops / skips the
	 * queued ones) and call brain.interrupt() (async, plan-literal — idempotent
	 * with the brain's own signal→interrupt coupling, and robust for a brain that
	 * lacks it). The next respond awaits the serial barrier, never this stop. */
	bargeIn(): void {
		this.opts.mouth.flush();
		for (const ac of this.inFlight) ac.abort();
		void this.opts.brain.interrupt().catch(() => undefined);
	}

	/** teardown: same as barge-in — stop the mouth + end every in-flight turn.
	 * The brain PROCESS is reaped by the manager (manager.close), not here. */
	close(): void {
		this.opts.mouth.flush();
		for (const ac of this.inFlight) ac.abort();
		void this.opts.brain.interrupt().catch(() => undefined);
	}
}
