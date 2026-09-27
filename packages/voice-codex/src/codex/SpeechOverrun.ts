import { canonicalSpeech } from "../speech.js";

/**
 * FLY-2885 T5c: a read-aloud turn is over its line once this many characters
 * of the transcript do not align to it. v3 rewrites 1-6 characters routinely
 * (research R4, FLY-2866); an invented report adds dozens.
 */
export const SPEECH_OVERRUN_UNALIGNED_CHARS = 8;

export interface SpeechAlignment {
	expectedChars: number;
	actualChars: number;
	/** Transcript characters outside the longest common subsequence. */
	unaligned: number;
	overrun: boolean;
}

/**
 * Bounded character alignment of what was spoken against what was meant.
 * Counting unaligned characters (not "the line was covered first") means a
 * rewrite plus an appended passage cannot slip through.
 */
export function speechAlignment(
	expected: string,
	actual: string,
): SpeechAlignment {
	const want = Array.from(canonicalSpeech(expected));
	const got = Array.from(canonicalSpeech(actual));
	if (got.length > 2 * want.length + 64) {
		return {
			expectedChars: want.length,
			actualChars: got.length,
			unaligned: got.length,
			overrun: true,
		};
	}
	let previous = new Uint16Array(want.length + 1);
	let current = new Uint16Array(want.length + 1);
	for (const char of got) {
		for (let index = 1; index <= want.length; index += 1) {
			current[index] =
				want[index - 1] === char
					? previous[index - 1]! + 1
					: Math.max(previous[index]!, current[index - 1]!);
		}
		[previous, current] = [current, previous];
		current.fill(0);
	}
	const aligned = previous[want.length]!;
	const unaligned = got.length - aligned;
	return {
		expectedChars: want.length,
		actualChars: got.length,
		unaligned,
		overrun: unaligned >= SPEECH_OVERRUN_UNALIGNED_CHARS,
	};
}

/** Sentence ends a read-aloud chunk may contain after speech projection. */
const SENTENCE = /[^。！？!?；;\n]*(?:[。！？!?；;\n]+|$)/gu;

/** The chunk's sentences, terminators included; joined they are the chunk. */
export function readbackSentences(text: string): string[] {
	return (text.match(SENTENCE) ?? []).filter((sentence) => sentence !== "");
}

export interface SpokenPrefix {
	/** The leading sentences the transcript shows were read. */
	spoken: string;
	/** Everything after the last sentence that was read. */
	remainder: string;
	spokenSentences: number;
	totalSentences: number;
}

/**
 * FLY-2885 founder rework A: after an overrun, which sentences of the chunk
 * were actually read. Sentences are matched in order, each against the
 * transcript right after the previous one: a sentence counts as read when a
 * contiguous stretch of transcript there misses at most `tolerance` of its
 * characters and adds at most as many (the 1–6 character rewrite the overrun
 * guard allows, research R4). The first sentence that does not match ends the
 * prefix, so shared wording further on can never mark an unread sentence as
 * read. Reading resumes after the prefix.
 */
export function spokenPrefix(expected: string, observed: string): SpokenPrefix {
	const sentences = readbackSentences(expected);
	const got = Array.from(canonicalSpeech(observed));
	let at = 0;
	let last = -1;
	for (const [index, sentence] of sentences.entries()) {
		const want = Array.from(canonicalSpeech(sentence));
		// Punctuation-only pieces carry nothing to hear.
		if (want.length === 0) continue;
		const end = sentenceEnd(want, got, at);
		if (end === undefined) break;
		at = end;
		last = index;
	}
	const rest = sentences.slice(last + 1).join("");
	return {
		spoken: sentences.slice(0, last + 1).join(""),
		remainder: canonicalSpeech(rest) === "" ? "" : rest.trim(),
		spokenSentences: last + 1,
		totalSentences: sentences.length,
	};
}

/**
 * Review R3: whether `text` opens with `prefix` (in order, within the same
 * tolerance). An overrun chunk's own final opens with everything its deltas
 * showed up to the cut, invented part included, which a later turn's answer
 * cannot; an empty prefix opens nothing.
 */
export function opensWith(prefix: string, text: string): boolean {
	const want = Array.from(canonicalSpeech(prefix));
	if (want.length === 0) return false;
	return sentenceEnd(want, Array.from(canonicalSpeech(text)), 0) !== undefined;
}

export interface StrippedReadbackContinuation {
	text: string;
	matched: boolean;
}

/**
 * QA@3 C2: the answer after a readback barge-in may open by completing the
 * cut word ("进入" -> "了终面。十二。"). Find the longest leading stretch of
 * `actual` that is still a suffix of the requested readback around the
 * observed cut point, and remove it through its sentence terminator. A short
 * accidental overlap without a terminator is not enough to rewrite an answer.
 */
export function stripReadbackContinuation(
	expected: string,
	spoken: string,
	actual: string,
): StrippedReadbackContinuation {
	const want = canonicalSpeech(expected);
	const heard = canonicalSpeech(spoken);
	const gotChars = Array.from(actual);
	const minStart = Math.max(0, heard.length - 6);
	const maxStart = Math.min(want.length, heard.length + 6);
	let bestRawEnd = 0;
	let bestCanonical = 0;
	for (let start = minStart; start <= maxStart; start += 1) {
		const tail = want.slice(start);
		for (let rawEnd = 1; rawEnd <= gotChars.length; rawEnd += 1) {
			const raw = gotChars.slice(0, rawEnd).join("");
			const prefix = canonicalSpeech(raw);
			if (!tail.startsWith(prefix)) break;
			if (
				prefix.length > bestCanonical ||
				(prefix.length === bestCanonical && rawEnd > bestRawEnd)
			) {
				bestCanonical = prefix.length;
				bestRawEnd = rawEnd;
			}
		}
	}
	if (
		bestCanonical < 2 ||
		!/[。！？!?；;\n]/u.test(gotChars.slice(0, bestRawEnd).join(""))
	)
		return { text: actual, matched: false };
	return {
		text: gotChars.slice(bestRawEnd).join("").trimStart(),
		matched: true,
	};
}

/**
 * Where in `got` (from `start`) the sentence `want` ends, if a stretch there
 * reads it within tolerance; the closest such stretch wins.
 */
function sentenceEnd(
	want: string[],
	got: string[],
	start: number,
): number | undefined {
	const tolerance = Math.min(6, Math.floor(want.length / 4));
	// More than `tolerance` extra characters can never qualify.
	const limit = Math.min(got.length, start + want.length + tolerance);
	let previous = new Uint16Array(want.length + 1);
	let current = new Uint16Array(want.length + 1);
	let best: { cost: number; end: number } | undefined;
	for (let end = start + 1; end <= limit; end += 1) {
		const char = got[end - 1];
		for (let index = 1; index <= want.length; index += 1) {
			current[index] =
				want[index - 1] === char
					? previous[index - 1]! + 1
					: Math.max(previous[index]!, current[index - 1]!);
		}
		[previous, current] = [current, previous];
		current.fill(0);
		const aligned = previous[want.length]!;
		const missing = want.length - aligned;
		const extra = end - start - aligned;
		if (missing > tolerance || extra > tolerance) continue;
		if (!best || missing + extra < best.cost)
			best = { cost: missing + extra, end };
	}
	return best?.end;
}

/**
 * The transcript characters outside the longest common subsequence — the
 * invented part. Only its length and digest ever leave the process.
 */
export function unalignedText(expected: string, actual: string): string {
	const want = Array.from(canonicalSpeech(expected));
	const got = Array.from(canonicalSpeech(actual)).slice(
		0,
		2 * want.length + 64,
	);
	const width = want.length + 1;
	const table = new Uint16Array((got.length + 1) * width);
	for (let row = 1; row <= got.length; row += 1) {
		for (let column = 1; column <= want.length; column += 1) {
			table[row * width + column] =
				got[row - 1] === want[column - 1]
					? table[(row - 1) * width + column - 1]! + 1
					: Math.max(
							table[(row - 1) * width + column]!,
							table[row * width + column - 1]!,
						);
		}
	}
	const extra: string[] = [];
	let row = got.length;
	let column = want.length;
	while (row > 0) {
		if (column > 0 && got[row - 1] === want[column - 1]) {
			row -= 1;
			column -= 1;
		} else if (
			column > 0 &&
			table[row * width + column - 1]! >= table[(row - 1) * width + column]!
		) {
			column -= 1;
		} else {
			extra.push(got[row - 1]!);
			row -= 1;
		}
	}
	return extra.reverse().join("");
}
