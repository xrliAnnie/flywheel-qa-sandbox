import { VoiceError } from "../../types.js";

export type RestatementMatch =
	| "exact"
	| "contained"
	| "critical_identifier"
	| "semantic";

export interface UnsolicitedLeadRestatement {
	code: "unsolicited_lead_restatement";
	match: RestatementMatch;
	resultEventId: string;
}

export interface LeadRestatementGuardOptions {
	maxRecentResults?: number;
	maxTextChars?: number;
	semanticDuplicate?: (candidate: string, leadText: string) => Promise<boolean>;
}

interface RememberedLeadResult {
	resultEventId: string;
	text: string;
	normalized: string;
	criticalIdentifiers: Set<string>;
}

const CRITICAL_IDENTIFIER =
	/(?:FLY-\d+|PR\s*#?\s*\d+|#[0-9]+|\b[0-9a-f]{7,40}\b)/giu;

function normalizeText(text: string): string {
	return text
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/[\p{P}\p{S}\s]+/gu, "");
}

function criticalIdentifiers(text: string): Set<string> {
	return new Set(
		[...text.matchAll(CRITICAL_IDENTIFIER)].map((match) =>
			match[0].replace(/\s+/g, "").toUpperCase(),
		),
	);
}

function sharesIdentifier(left: Set<string>, right: Set<string>): boolean {
	for (const identifier of left) {
		if (right.has(identifier)) return true;
	}
	return false;
}

export class LeadRestatementGuard {
	private readonly recent: RememberedLeadResult[] = [];
	private readonly maxRecentResults: number;
	private readonly maxTextChars: number;

	constructor(private readonly opts: LeadRestatementGuardOptions = {}) {
		this.maxRecentResults = opts.maxRecentResults ?? 8;
		this.maxTextChars = opts.maxTextChars ?? 8_000;
		if (
			!Number.isSafeInteger(this.maxRecentResults) ||
			this.maxRecentResults <= 0 ||
			!Number.isSafeInteger(this.maxTextChars) ||
			this.maxTextChars <= 0
		) {
			throw new VoiceError(
				"component-missing",
				"openai-live: Lead restatement guard limits must be positive integers",
			);
		}
	}

	remember(result: { resultEventId: string; text: string }): void {
		if (!result.resultEventId.trim() || !result.text.trim()) {
			throw new VoiceError(
				"backend-protocol",
				"openai-live: Lead restatement evidence must be non-empty",
			);
		}
		this.assertBounded(result.text);
		this.recent.push({
			...result,
			normalized: normalizeText(result.text),
			criticalIdentifiers: criticalIdentifiers(result.text),
		});
		while (this.recent.length > this.maxRecentResults) this.recent.shift();
	}

	async inspect(
		candidate: string,
		opts: { hasNewUserRestatementRequest: boolean },
	): Promise<UnsolicitedLeadRestatement | null> {
		if (opts.hasNewUserRestatementRequest || !candidate.trim()) return null;
		this.assertBounded(candidate);
		const normalized = normalizeText(candidate);
		const candidateIdentifiers = criticalIdentifiers(candidate);
		for (const result of [...this.recent].reverse()) {
			if (normalized === result.normalized) {
				return this.match(result, "exact");
			}
			if (
				Math.min(normalized.length, result.normalized.length) >= 12 &&
				(normalized.includes(result.normalized) ||
					result.normalized.includes(normalized))
			) {
				return this.match(result, "contained");
			}
			if (sharesIdentifier(candidateIdentifiers, result.criticalIdentifiers)) {
				return this.match(result, "critical_identifier");
			}
			if (await this.opts.semanticDuplicate?.(candidate, result.text)) {
				return this.match(result, "semantic");
			}
		}
		return null;
	}

	private match(
		result: RememberedLeadResult,
		match: RestatementMatch,
	): UnsolicitedLeadRestatement {
		return {
			code: "unsolicited_lead_restatement",
			match,
			resultEventId: result.resultEventId,
		};
	}

	private assertBounded(text: string): void {
		if (text.length > this.maxTextChars) {
			throw new VoiceError(
				"resource-exhausted",
				`openai-live: restatement text exceeds ${this.maxTextChars} characters`,
			);
		}
	}
}
