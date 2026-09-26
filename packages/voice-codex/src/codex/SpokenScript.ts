export type ProtectedTokenKind =
	| "issue"
	| "pull_request"
	| "commit"
	| "number"
	| "name";

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

function normalizedText(value: string): string {
	return value.normalize("NFKC");
}

function comparisonKey(value: string): string {
	return normalizedText(value).toLocaleLowerCase("en-US");
}

function hasTokenBoundaries(
	value: string,
	start: number,
	length: number,
	edge = TOKEN_EDGE,
): boolean {
	const chars = Array.from(value);
	const prefixLength = Array.from(value.slice(0, start)).length;
	const tokenLength = Array.from(value.slice(start, start + length)).length;
	const before = chars[prefixLength - 1];
	const after = chars[prefixLength + tokenLength];
	return (!before || !edge.test(before)) && (!after || !edge.test(after));
}

function matches(
	value: string,
	pattern: RegExp,
	kind: ProtectedTokenKind,
	filter?: (token: string) => boolean,
): ProtectedToken[] {
	pattern.lastIndex = 0;
	const result: ProtectedToken[] = [];
	for (const match of value.matchAll(pattern)) {
		const token = match[0];
		const index = match.index;
		if (
			index === undefined ||
			!hasTokenBoundaries(value, index, token.length) ||
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
			if (hasTokenBoundaries(foldedValue, index, foldedName.length)) {
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
): ProtectedToken[] {
	const value = normalizedText(text);
	return unique([
		...matches(value, ISSUE, "issue"),
		...matches(value, PULL_REQUEST, "pull_request"),
		...matches(
			value,
			COMMIT,
			"commit",
			(token) => /[a-f]/iu.test(token) && /\d/u.test(token),
		),
		...matches(value, NUMBER, "number"),
		...nameTokens(value, rosterNames),
	]);
}

function approvedThreadPointer(spoken: string): boolean {
	return /这条我发到 thread 了[,，]编号以文字为准[。.!！]?$/iu.test(
		normalizedText(spoken).trim(),
	);
}

export function validateSpokenScript(input: {
	spoken: string;
	sources: readonly SpokenScriptSource[];
	rosterNames: readonly string[];
	mode?: "background_result" | "rewrite";
}): SpokenScriptValidation {
	const spokenTokens = extractProtectedTokens(input.spoken, input.rosterNames);
	const sourceTokens = input.sources.flatMap((source) =>
		extractProtectedTokens(source.text, input.rosterNames).map((token) => ({
			...token,
			sourceItemId: source.itemId,
		})),
	);
	const sourceByToken = new Map<string, ProtectedTokenEvidence>();
	for (const token of sourceTokens) {
		sourceByToken.set(
			`${token.kind}:${comparisonKey(token.token)}`,
			sourceByToken.get(`${token.kind}:${comparisonKey(token.token)}`) ?? token,
		);
	}

	const evidence: ProtectedTokenEvidence[] = [];
	const unsupported: ProtectedToken[] = [];
	for (const token of spokenTokens) {
		const source = sourceByToken.get(
			`${token.kind}:${comparisonKey(token.token)}`,
		);
		if (source) evidence.push({ ...token, sourceItemId: source.sourceItemId });
		else unsupported.push(token);
	}

	const usedThreadPointer = approvedThreadPointer(input.spoken);
	const spokenKeys = new Set(
		spokenTokens.map((token) => `${token.kind}:${comparisonKey(token.token)}`),
	);
	const missingRequired =
		input.mode === "rewrite" && !usedThreadPointer
			? unique(
					sourceTokens
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
