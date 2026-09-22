import { randomUUID } from "node:crypto";
import { scrubTranscript } from "flywheel-voice-core";

const SENTENCE_END = new Set(["。", "！", "？", "；", "\n"]);
const DIGIT_SPEECH = [
	"零",
	"一",
	"二",
	"三",
	"四",
	"五",
	"六",
	"七",
	"八",
	"九",
];
const CHINESE_DIGIT = new Map([
	["零", 0],
	["〇", 0],
	["一", 1],
	["二", 2],
	["两", 2],
	["三", 3],
	["四", 4],
	["五", 5],
	["六", 6],
	["七", 7],
	["八", 8],
	["九", 9],
]);

export interface PreparedSpeech {
	speechId: string;
	spokenText: string;
	expectedTokens: string[];
	generationBudgetMs: number;
}

export function stripForSpeech(value: string): string {
	return value
		.replace(/^```[^\n]*\n?/gmu, "")
		.replace(/^```$/gmu, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
		.replace(/[*_~`]+/gu, "")
		.replace(/^\s{0,3}(?:#{1,6}|[-+>])\s+/gmu, "")
		.trim();
}

function digitsForSpeech(value: string): string {
	return Array.from(value)
		.map((digit) => DIGIT_SPEECH[Number(digit)] ?? digit)
		.join(" ");
}

export function projectForSpeech(value: string): string {
	return stripForSpeech(
		scrubTranscript(value)
			.replace(/\[redacted\]/gu, "敏感内容已隐藏")
			.replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
			.replace(/https?:\/\/\S+/giu, "链接见文字消息")
			.replace(
				/\b([A-Z]{2,10})-(\d+)\b/gu,
				(_match, letters, digits) =>
					`${Array.from(letters as string).join(" ")} ${digitsForSpeech(digits as string)}`,
			)
			.replace(
				/\p{Extended_Pictographic}|\p{Regional_Indicator}|[\uFE0E\uFE0F\u200D]/gu,
				"",
			),
	)
		.normalize("NFKC")
		.replace(/[ \t]+/gu, " ")
		.replace(/ *\n */gu, "\n")
		.trim();
}

function splitSpeech(value: string, configuredMax: number): string[] {
	if (!Number.isSafeInteger(configuredMax) || configuredMax <= 0) {
		throw new Error("speechChunkTokens must be a positive integer");
	}
	const max = Math.min(configuredMax, 80);
	const chars = Array.from(value);
	const chunks: string[] = [];
	let index = 0;
	while (index < chars.length) {
		const remaining = chars.length - index;
		if (remaining <= max) {
			chunks.push(chars.slice(index).join(""));
			break;
		}
		let end = index + max;
		for (let cursor = end - 1; cursor >= index; cursor -= 1) {
			if (SENTENCE_END.has(chars[cursor]!)) {
				end = cursor + 1;
				break;
			}
		}
		chunks.push(chars.slice(index, end).join(""));
		index = end;
	}
	return chunks.filter((chunk) => chunk.trim().length > 0);
}

function parseChineseInteger(value: string): string | null {
	if (!value) return null;
	if (!/[十百千万]/u.test(value)) {
		const digits = Array.from(value).map((char) => CHINESE_DIGIT.get(char));
		return digits.every((digit) => digit !== undefined)
			? digits.join("")
			: null;
	}
	let total = 0;
	let section = 0;
	let number = 0;
	for (const char of value) {
		const digit = CHINESE_DIGIT.get(char);
		if (digit !== undefined) {
			number = digit;
			continue;
		}
		const unit = { 十: 10, 百: 100, 千: 1_000, 万: 10_000 }[char];
		if (!unit) return null;
		if (unit === 10_000) {
			section += number;
			total += (section || 1) * unit;
			section = 0;
			number = 0;
		} else {
			section += (number || 1) * unit;
			number = 0;
		}
	}
	return String(total + section + number);
}

function canonicalChineseNumber(value: string): string {
	const negative = value.startsWith("负");
	const unsigned = negative ? value.slice(1) : value;
	const [integer, fraction, ...extra] = unsigned.split("点");
	if (extra.length > 0) return value;
	const parsedInteger = parseChineseInteger(integer ?? "");
	if (parsedInteger === null) return value;
	if (fraction === undefined) return `${negative ? "-" : ""}${parsedInteger}`;
	const parsedFraction = parseChineseInteger(fraction);
	if (parsedFraction === null || /[十百千万]/u.test(fraction)) return value;
	return `${negative ? "-" : ""}${parsedInteger}.${parsedFraction}`;
}

function canonicalSpeech(value: string): string {
	const projected = projectForSpeech(value).toLowerCase();
	const numeric = projected.replace(
		/[负零〇一二两三四五六七八九十百千万点]+/gu,
		(match) => canonicalChineseNumber(match),
	);
	const chars = Array.from(numeric);
	return chars
		.filter((char, index) => {
			if (/\s/u.test(char) || /[，。！？；、,!?;:：]/u.test(char)) return false;
			if (char !== ".") return true;
			return (
				/\d/u.test(chars[index - 1] ?? "") && /\d/u.test(chars[index + 1] ?? "")
			);
		})
		.join("");
}

export function isFiniteSpeechEquivalent(
	expected: string,
	actual: string,
): boolean {
	return canonicalSpeech(expected) === canonicalSpeech(actual);
}

export function prepareReplySpeech(
	rawText: string,
	configuredMax = 80,
): PreparedSpeech[] {
	const projected = projectForSpeech(rawText);
	if (!projected) return [];
	return splitSpeech(projected, configuredMax).map((spokenText) => {
		const codePoints = Array.from(spokenText).length;
		return {
			speechId: randomUUID(),
			spokenText,
			expectedTokens: [canonicalSpeech(spokenText)],
			generationBudgetMs: Math.min(
				70_000,
				Math.max(20_000, 10_000 + 700 * codePoints),
			),
		};
	});
}

export function chunkForSpeech(value: string, maxTokens = 80): string[] {
	return prepareReplySpeech(value, maxTokens).map((item) => item.spokenText);
}
