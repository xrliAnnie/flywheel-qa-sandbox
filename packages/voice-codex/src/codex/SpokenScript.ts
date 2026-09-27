export type ProtectedTokenKind =
	| "issue"
	| "pull_request"
	| "commit"
	| "number"
	| "name"
	| "outcome";

export interface ProtectedToken {
	kind: ProtectedTokenKind;
	token: string;
}

export interface SpokenScriptSource {
	itemId: string;
	text: string;
}

export interface ProtectedTokenEvidence extends ProtectedToken {
	sourceItemId: string;
}

export type SpokenScriptValidation =
	| {
			ok: true;
			evidence: ProtectedTokenEvidence[];
			usedThreadPointer: boolean;
	  }
	| {
			ok: false;
			evidence: ProtectedTokenEvidence[];
			unsupported: ProtectedToken[];
			missingRequired: ProtectedToken[];
			usedThreadPointer: boolean;
	  };

const ISSUE = /[A-Z][A-Z0-9]{1,9}-\d+/giu;
const PULL_REQUEST = /(?:PR\s*)?#\d+/giu;
const COMMIT = /\b[0-9a-f]{7,40}\b/giu;
const NUMBER = /\d+(?:\.\d+)?(?:%|:\d{2}(?::\d{2})?)?/gu;
const TOKEN_EDGE = /[A-Z0-9_]/iu;

/** Deterministic proof that boundary checks stay proportional to indexed input. */
export interface SpokenScriptWork {
	sourceScans: number;
	sourceCodeUnits: number;
	boundaryChecks: number;
	boundaryCodeUnitsRead: number;
}

function normalizedText(value: string): string {
	return value.normalize("NFKC");
}

function comparisonKey(value: string): string {
	return normalizedText(value).toLocaleLowerCase("en-US");
}

/**
 * The edge class is ASCII-only, so UTF-16 indexing sees the same neighbours
 * as code points. Linear per match: the old per-match Array.from(value) made a
 * large tool output quadratic and blocked the event loop (QA@5 B2).
 */
function hasTokenBoundaries(
	value: string,
	start: number,
	length: number,
	edge = TOKEN_EDGE,
	work?: SpokenScriptWork,
): boolean {
	const before = value[start - 1];
	const after = value[start + length];
	if (work) {
		work.boundaryChecks += 1;
		work.boundaryCodeUnitsRead += Number(before !== undefined);
		work.boundaryCodeUnitsRead += Number(after !== undefined);
	}
	return (!before || !edge.test(before)) && (!after || !edge.test(after));
}

function matches(
	value: string,
	pattern: RegExp,
	kind: ProtectedTokenKind,
	filter?: (token: string) => boolean,
	work?: SpokenScriptWork,
): ProtectedToken[] {
	pattern.lastIndex = 0;
	const result: ProtectedToken[] = [];
	for (const match of value.matchAll(pattern)) {
		const token = match[0];
		const index = match.index;
		if (
			index === undefined ||
			!hasTokenBoundaries(value, index, token.length, TOKEN_EDGE, work) ||
			(filter && !filter(token))
		)
			continue;
		result.push({ kind, token });
	}
	return result;
}

function nameTokens(
	value: string,
	rosterNames: readonly string[],
	work?: SpokenScriptWork,
): ProtectedToken[] {
	const foldedValue = comparisonKey(value);
	const result: ProtectedToken[] = [];
	for (const rosterName of rosterNames) {
		const normalizedName = normalizedText(rosterName).trim();
		if (!normalizedName) continue;
		const foldedName = comparisonKey(normalizedName);
		let offset = 0;
		while (offset <= foldedValue.length - foldedName.length) {
			const index = foldedValue.indexOf(foldedName, offset);
			if (index < 0) break;
			if (
				hasTokenBoundaries(
					foldedValue,
					index,
					foldedName.length,
					TOKEN_EDGE,
					work,
				)
			) {
				result.push({
					kind: "name",
					token: value.slice(index, index + normalizedName.length),
				});
			}
			offset = index + foldedName.length;
		}
	}
	return result;
}

/**
 * Yes/no outcomes are key facts too (FLY-2886 Lead 1c8019f8): a paraphrase
 * may say 过了 for 全绿, never 通过 for 没通过. Negations are matched and
 * masked first so a bare positive word inside them is not read as a yes.
 * The token is the polarity, so any wording of the same polarity matches.
 */
const NEGATIVE_OUTCOMES = [
	"没通过",
	"未通过",
	"不通过",
	"没有通过",
	"没过",
	"没有过",
	"没成功",
	"不成功",
	"未成功",
	"失败",
	"挂了",
	"红了",
	"红着",
	"飘红",
	"被拒",
	"驳回",
	"否决",
	"没合并",
	"未合并",
	"没有合并",
	"没合进",
	"没批准",
	"未批准",
	"没批",
	"没完成",
	"未完成",
];
const POSITIVE_OUTCOMES = [
	"通过",
	"过了",
	"成功",
	"全绿",
	"绿了",
	"合并了",
	"已合并",
	"合进去",
	"合进了",
	"批准",
	"批了",
	"完成了",
	"已完成",
];
const NEGATIVE_WORDS =
	/\b(?:fail(?:ed|ing|ure)?|rejected|changes[ _]requested|not merged|unmerged)\b/giu;
const POSITIVE_WORDS =
	/\b(?:pass(?:ed|es)?|approved|merged|succeeded|success)\b/giu;

/** Time phrases that reuse 过 (过了十分钟, 没过多久) are not outcomes. */
const TEMPORAL_PHRASES =
	/过了\s*(?:\d+|[一二两三四五六七八九十半几]+)?\s*(?:个)?\s*(?:秒|分钟|小时|钟头|天|周|会儿|一会|阵|很久|好久|不久)|没过(?:多久|几|一会)|过了没多久/gu;

function outcomeTokens(value: string): ProtectedToken[] {
	let rest = value.toLocaleLowerCase("en-US").replace(TEMPORAL_PHRASES, " ");
	let negative = false;
	for (const word of NEGATIVE_OUTCOMES)
		if (rest.includes(word)) {
			negative = true;
			rest = rest.replaceAll(word, " ");
		}
	if (NEGATIVE_WORDS.test(rest)) negative = true;
	NEGATIVE_WORDS.lastIndex = 0;
	rest = rest.replace(NEGATIVE_WORDS, " ");
	const positive =
		POSITIVE_OUTCOMES.some((word) => rest.includes(word)) ||
		POSITIVE_WORDS.test(rest);
	POSITIVE_WORDS.lastIndex = 0;
	return [
		...(positive ? [{ kind: "outcome" as const, token: "positive" }] : []),
		...(negative ? [{ kind: "outcome" as const, token: "negative" }] : []),
	];
}

function unique(tokens: ProtectedToken[]): ProtectedToken[] {
	const seen = new Set<string>();
	return tokens.filter((token) => {
		const key = `${token.kind}:${comparisonKey(token.token)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function extractProtectedTokens(
	text: string,
	rosterNames: readonly string[],
	work?: SpokenScriptWork,
): ProtectedToken[] {
	const value = normalizedText(text);
	return unique([
		...matches(value, ISSUE, "issue", undefined, work),
		...matches(value, PULL_REQUEST, "pull_request", undefined, work),
		...matches(
			value,
			COMMIT,
			"commit",
			(token) => /[a-f]/iu.test(token) && /\d/u.test(token),
			work,
		),
		...matches(value, NUMBER, "number", undefined, work),
		...nameTokens(value, rosterNames, work),
		...outcomeTokens(value),
	]);
}

function approvedThreadPointer(spoken: string): boolean {
	return /这条我发到 thread 了[,，]编号以文字为准[。.!！]?$/iu.test(
		normalizedText(spoken).trim(),
	);
}

type SourceIndex = {
	tokens: ProtectedTokenEvidence[];
	byKey: Map<string, ProtectedTokenEvidence>;
};

function indexSources(
	sources: readonly SpokenScriptSource[],
	rosterNames: readonly string[],
	work?: SpokenScriptWork,
): SourceIndex {
	const tokens = sources.flatMap((source) => {
		if (work) {
			work.sourceScans += 1;
			work.sourceCodeUnits += source.text.length;
		}
		return extractProtectedTokens(source.text, rosterNames, work).map(
			(token) => ({
				...token,
				sourceItemId: source.itemId,
			}),
		);
	});
	const byKey = new Map<string, ProtectedTokenEvidence>();
	for (const token of tokens) {
		const key = `${token.kind}:${comparisonKey(token.token)}`;
		if (!byKey.has(key)) byKey.set(key, token);
	}
	return { tokens, byKey };
}

function validateAgainst(
	index: SourceIndex,
	spoken: string,
	rosterNames: readonly string[],
	mode: "background_result" | "rewrite" | undefined,
	work?: SpokenScriptWork,
): SpokenScriptValidation {
	const spokenTokens = extractProtectedTokens(spoken, rosterNames, work);
	const evidence: ProtectedTokenEvidence[] = [];
	const unsupported: ProtectedToken[] = [];
	for (const token of spokenTokens) {
		const source = index.byKey.get(
			`${token.kind}:${comparisonKey(token.token)}`,
		);
		if (source) evidence.push({ ...token, sourceItemId: source.sourceItemId });
		else unsupported.push(token);
	}

	const usedThreadPointer = approvedThreadPointer(spoken);
	const spokenKeys = new Set(
		spokenTokens.map((token) => `${token.kind}:${comparisonKey(token.token)}`),
	);
	const missingRequired =
		mode === "rewrite" && !usedThreadPointer
			? unique(
					index.tokens
						.filter(
							(token) =>
								token.kind === "issue" || token.kind === "pull_request",
						)
						.filter(
							(token) =>
								!spokenKeys.has(`${token.kind}:${comparisonKey(token.token)}`),
						)
						.map(({ kind, token }) => ({ kind, token })),
				)
			: [];

	if (unsupported.length === 0 && missingRequired.length === 0) {
		return { ok: true, evidence, usedThreadPointer };
	}
	return {
		ok: false,
		evidence,
		unsupported,
		missingRequired,
		usedThreadPointer,
	};
}

export function validateSpokenScript(input: {
	spoken: string;
	sources: readonly SpokenScriptSource[];
	rosterNames: readonly string[];
	mode?: "background_result" | "rewrite";
}): SpokenScriptValidation {
	return validateAgainst(
		indexSources(input.sources, input.rosterNames),
		input.spoken,
		input.rosterNames,
		input.mode,
	);
}

export const THREAD_POINTER_SENTENCE = "这条我发到 thread 了，编号以文字为准。";

export interface SpokenScriptRepair {
	/** Whole kept sentences, plus the thread pointer when anything was dropped. */
	spoken: string;
	droppedSentences: string[];
	/** The source must be posted before `spoken` may be said. */
	needsThread: boolean;
}

/**
 * Sentence-level guard for free paraphrase (FLY-2886 Lead 1c8019f8): a
 * sentence whose key fact does not match the source is dropped whole — never
 * cut mid-sentence — and the script ends by pointing to the thread, where the
 * exact text is posted. Supported sentences are kept as written.
 */
export function repairSpokenScript(input: {
	spoken: string;
	sources: readonly SpokenScriptSource[];
	rosterNames: readonly string[];
	mode?: "background_result" | "rewrite";
	work?: SpokenScriptWork;
}): SpokenScriptRepair {
	const sentences =
		input.spoken.match(/[^。！？!?；;\n]+[。！？!?；;\n]*/gu) ?? [];
	const index = indexSources(input.sources, input.rosterNames, input.work);
	const kept: string[] = [];
	const droppedSentences: string[] = [];
	for (const sentence of sentences) {
		if (!sentence.trim()) continue;
		const check = validateAgainst(
			index,
			sentence,
			input.rosterNames,
			"background_result",
			input.work,
		);
		if (check.ok) kept.push(sentence);
		else droppedSentences.push(sentence.trim());
	}
	const keptText = kept.join("").trim();
	const missingRequired =
		input.mode === "rewrite" &&
		!validateAgainst(index, keptText, input.rosterNames, "rewrite", input.work)
			.ok;
	const needsThread = droppedSentences.length > 0 || missingRequired;
	if (!needsThread)
		return { spoken: input.spoken, droppedSentences, needsThread };
	return {
		spoken: keptText.endsWith(THREAD_POINTER_SENTENCE)
			? keptText
			: `${keptText}${THREAD_POINTER_SENTENCE}`,
		droppedSentences,
		needsThread,
	};
}
