/**
 * TextTurnMouth (FLY-1160 §4.1-3) — the /glaw resident brain's mouth.
 *
 * The resident brain streams TEXT deltas (not the 24k PCM GeminiTurnMouth
 * consumes — that mouth's up-sample contract is physically incompatible with
 * EdgeTts's whole-utterance MP3 output, Codex #552-plan R1 #4). So this mouth
 * buffers the delta stream into SENTENCES (punctuation / length) and hands each
 * complete sentence to a serial text speaker (LeadSpeaker's text-queue form):
 * per-sentence EdgeTts synth, play-order preserved, barge-in clears the queue.
 *
 *   beginTurn() → feed(textDelta)* → endTurn()   (endTurn flushes the tail)
 *   flush()  = barge-in: drop the un-synthesized buffer + speaker.stop() (sync)
 *
 * The turn gate mirrors GeminiTurnMouth: feed() outside an open turn is dropped
 * and counted (a late delta of an interrupted turn must never speak). A synth
 * failure is fail-loud to the TIV (onError) — never a silent swallow — but does
 * not crash the turn; the queue moves on.
 */

/** the serial text speaker this mouth drives (LeadSpeaker satisfies it via an
 * adapter: speak → leadSpeaker.speak({kind:"text",text}); stop → stop()). */
export interface TextTurnSpeaker {
	/** synth + play one sentence, in order; resolves cancelled:true on barge-in,
	 * rejects only on a real TTS/player failure. */
	speak(text: string): Promise<{ cancelled: boolean }>;
	/** barge-in fast path: clear the queue + stop the player, SYNCHRONOUSLY. */
	stop(): void;
}

export interface TextTurnMouthOptions {
	speaker: TextTurnSpeaker;
	/** a run-on without sentence punctuation still speaks in chunks this long
	 * (so a long paragraph is not held hostage to a missing 。). Default 80. */
	maxSentenceChars?: number;
	/** fail-loud sink for a real synth/player failure (→ TIV). */
	onError?: (err: Error, sentence: string) => void;
	log?: (line: string) => void;
}

const DEFAULT_MAX_SENTENCE_CHARS = 80;
/** sentence terminators (CJK + ASCII) + hard line breaks. */
const SENTENCE_END = /[。！？!?；;\n]/;
/** a piece worth speaking has at least one char that is neither whitespace
 * nor a bare terminator (a lone "。" would synthesize to silence). */
const HAS_CONTENT = /[^\s。！？!?；;]/;

/**
 * Cut a text buffer into (completeSentences, remainingTail). A sentence ends at
 * a terminator OR when it reaches maxChars (the run-on fallback). Pure so the
 * boundary logic is unit-tested directly.
 */
export function splitSentences(
	buf: string,
	maxChars: number,
): { sentences: string[]; tail: string } {
	const sentences: string[] = [];
	let start = 0;
	for (let i = 0; i < buf.length; i++) {
		const atTerminator = SENTENCE_END.test(buf.charAt(i));
		const atMax = i - start + 1 >= maxChars;
		if (atTerminator || atMax) {
			const piece = buf.slice(start, i + 1).trim();
			if (HAS_CONTENT.test(piece)) sentences.push(piece);
			start = i + 1;
		}
	}
	return { sentences, tail: buf.slice(start) };
}

export class TextTurnMouth {
	private active = false;
	private buffer = "";
	/** observability: deltas dropped by the turn gate (interrupted-turn tail). */
	droppedDeltas = 0;
	private readonly maxChars: number;

	constructor(private readonly opts: TextTurnMouthOptions) {
		this.maxChars = opts.maxSentenceChars ?? DEFAULT_MAX_SENTENCE_CHARS;
	}

	/** a fresh resident turn is about to stream. */
	beginTurn(): void {
		this.active = true;
		this.buffer = "";
	}

	/** one text delta of the current turn — buffered and cut into sentences. */
	feed(textDelta: string): void {
		if (!this.active) {
			if (textDelta.length > 0) this.droppedDeltas++;
			return;
		}
		this.buffer += textDelta;
		const { sentences, tail } = splitSentences(this.buffer, this.maxChars);
		this.buffer = tail;
		for (const s of sentences) this.enqueue(s);
	}

	/** the resident turn finished — flush the trailing partial sentence. */
	endTurn(): void {
		this.active = false;
		const tail = this.buffer.trim();
		this.buffer = "";
		if (HAS_CONTENT.test(tail)) this.enqueue(tail);
	}

	/** barge-in: drop the un-synthesized buffer and stop the speaker NOW. */
	flush(): void {
		this.active = false;
		this.buffer = "";
		this.opts.speaker.stop();
	}

	private enqueue(sentence: string): void {
		void this.opts.speaker.speak(sentence).catch((err) => {
			const e = err instanceof Error ? err : new Error(String(err));
			this.opts.log?.(`[text-mouth] synth failed: ${e.message}`);
			this.opts.onError?.(e, sentence);
		});
	}
}
