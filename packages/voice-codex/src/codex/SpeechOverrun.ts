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
 * were actually read. A sentence counts as read when the transcript aligns
 * (in order, LCS) to all of it but a 1–6 character rewrite — the same
 * tolerance the overrun guard gives (research R4). Reading resumes after the
 * last read sentence, so nothing already heard is repeated.
 */
export function spokenPrefix(expected: string, observed: string): SpokenPrefix {
	const sentences = readbackSentences(expected);
	const want = sentences.map((sentence) =>
		Array.from(canonicalSpeech(sentence)),
	);
	const flat = want.flat();
	const owner = want.flatMap((chars, index) => chars.map(() => index));
	const got = Array.from(canonicalSpeech(observed)).slice(
		0,
		2 * flat.length + 64,
	);
	const width = flat.length + 1;
	const table = new Uint16Array((got.length + 1) * width);
	for (let row = 1; row <= got.length; row += 1) {
		for (let column = 1; column <= flat.length; column += 1) {
			table[row * width + column] =
				got[row - 1] === flat[column - 1]
					? table[(row - 1) * width + column - 1]! + 1
					: Math.max(
							table[(row - 1) * width + column]!,
							table[row * width + column - 1]!,
						);
		}
	}
	const matched = want.map(() => 0);
	let row = got.length;
	let column = flat.length;
	while (row > 0 && column > 0) {
		if (got[row - 1] === flat[column - 1]) {
			matched[owner[column - 1]!]! += 1;
			row -= 1;
			column -= 1;
		} else if (
			table[row * width + column - 1]! >= table[(row - 1) * width + column]!
		) {
			column -= 1;
		} else {
			row -= 1;
		}
	}
	let last = -1;
	for (const [index, chars] of want.entries()) {
		// Punctuation-only pieces carry nothing to hear.
		if (chars.length === 0) continue;
		const tolerance = Math.min(6, Math.floor(chars.length / 4));
		if (chars.length - matched[index]! <= tolerance) last = index;
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
