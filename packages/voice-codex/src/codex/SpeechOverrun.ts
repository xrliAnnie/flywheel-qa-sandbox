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
