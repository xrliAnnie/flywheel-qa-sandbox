/**
 * FLY-799 Part A — Tier-2 exact-allowlist approval matcher.
 *
 * The zero-AI fast path for UNAMBIGUOUS short founder approvals. Codex R7 #1 /
 * R8 #3 hard requirement: this is an EXACT whole-message allowlist, NOT a
 * substring keyword detector. Everything that is not a bare, unambiguous, and
 * (if it references an issue/PR) correctly-targeted approval DOWNGRADES to
 * Tier-3 (the subscription classifier). Tier-2 therefore never approves a
 * hedged / negated / multi-clause message, and never approves a message that
 * references a different issue/PR than the current gate ("ship 756" must not
 * approve the FLY-799 gate).
 *
 * Fail-closed: "downgrade" is the safe default — an over-eager downgrade only
 * costs one Tier-3 classifier call; an over-eager "approve" would ship without
 * a real founder approval. Allow phrases + deny tokens live in exported data so
 * table-driven tests pin the boundary and future edits cannot silently
 * reintroduce substring semantics.
 */

/** Normalized (lowercased, single-spaced) whole-message approval phrases. */
export const TIER2_APPROVAL_PHRASES: ReadonlySet<string> = new Set([
	"ship",
	"ship it",
	"approve",
	"approved",
	"lgtm",
	"go",
	"批准",
	"可以 ship",
	"可以",
	"上线",
	"上线吧",
	"同意上线",
	"同意",
]);

/**
 * Hedge / condition / negation tokens. ANY occurrence downgrades to Tier-3 —
 * even inside an otherwise-allowlisted phrase — so "先别 ship" / "ship it after
 * review" / "LGTM after QA" never fast-path to approve. Latin tokens match on
 * word boundaries; CJK tokens match as substrings (no word boundary in CJK).
 */
export const TIER2_DENY_LATIN: readonly string[] = [
	"no",
	"not",
	"dont",
	"but",
	"except",
	"after",
	"if",
	"when",
	"unless",
	"wait",
	"hold",
	"later",
	"yet",
	"maybe",
	"almost",
	"once",
];
export const TIER2_DENY_CJK: readonly string[] = [
	"别",
	"不",
	"先",
	"等",
	"看",
	"再",
	"待会",
	"如果",
	"除非",
	"但是",
	"改完",
	"晚点",
	"回头",
	"稍",
];

const MAX_CHARS = 32;
const MAX_TOKENS = 5;

/**
 * Characters/sequences whose presence means the message is not a bare short
 * approval — quotes, code, URLs, punctuation that implies clauses/conditions,
 * or multi-line. Their presence alone downgrades to Tier-3.
 */
function hasStructuralComplexity(raw: string): boolean {
	if (/[\n\r]/.test(raw)) return true; // multi-line
	if (raw.includes("`") || raw.includes(">")) return true; // code / quote
	if (/https?:\/\//i.test(raw)) return true; // URL
	// clause/condition punctuation (latin + CJK fullwidth)
	if (/[?:;,.!，。；：、！？·…]/.test(raw)) return true;
	return false;
}

export interface Tier2Gate {
	/** Current gate's Linear issue identifier, e.g. "FLY-799". */
	issueIdentifier?: string;
	/** Current gate's PR number. */
	prNumber?: number;
}

/** Extract the numeric part of a "FLY-799"-style identifier. */
function identifierNumber(identifier: string | undefined): number | undefined {
	const m = identifier?.match(/(\d+)\s*$/);
	return m ? Number.parseInt(m[1] as string, 10) : undefined;
}

/**
 * Every issue/PR reference in the (normalized) message must target the current
 * gate; a single mismatch downgrades. Recognized references:
 *   - `fly-<n>`  → must equal the gate identifier (case-insensitive)
 *   - `#<n>`     → must equal the PR number or the issue number
 *   - bare `<n>` → must equal the PR number or the issue number
 * Returns the phrase with all (matching) references stripped, or null when any
 * reference mismatches / is unresolvable.
 */
function stripAndVerifyReferences(
	norm: string,
	gate: Tier2Gate,
): string | null {
	const idNum = identifierNumber(gate.issueIdentifier);
	const identLower = gate.issueIdentifier?.toLowerCase();
	const prNum = gate.prNumber;

	// FLY-<n> references.
	let out = norm;
	const flyRefs = out.match(/fly-\d+/g) ?? [];
	for (const ref of flyRefs) {
		if (!identLower || ref !== identLower) return null;
	}
	out = out.replace(/fly-\d+/g, " ");

	// #<n> and bare <n> references.
	const numRefs = out.match(/#?\d+/g) ?? [];
	for (const ref of numRefs) {
		const n = Number.parseInt(ref.replace("#", ""), 10);
		const matches =
			(prNum !== undefined && n === prNum) ||
			(idNum !== undefined && n === idNum);
		if (!matches) return null;
	}
	out = out.replace(/#?\d+/g, " ");

	return out.replace(/\s+/g, " ").trim();
}

/**
 * FLY-799 (Codex code-review R1 HIGH-3): fail-closed on a DELIBERATE wrong-target
 * reference. True iff the message carries an EXPLICIT issue (`FLY-<n>`) or PR
 * (`#<n>`) reference that does NOT target the current gate — a strong "not this
 * one" signal that must never reach the Tier-3 LLM (which could still approve
 * `ship FLY-756` in the FLY-799 thread). Bare numbers are intentionally NOT
 * treated as references here — they are frequently incidental (`fixes 500
 * errors`), so they still downgrade to Tier-3 for contextual judgement rather
 * than hard-rejecting a genuine approval.
 */
export function hasExplicitMismatchedReference(
	rawMessage: string,
	gate: Tier2Gate,
): boolean {
	if (typeof rawMessage !== "string") return false;
	const norm = rawMessage.toLowerCase();
	const idNum = identifierNumber(gate.issueIdentifier);
	const identLower = gate.issueIdentifier?.toLowerCase();
	const prNum = gate.prNumber;

	// Explicit FLY-<n> issue references.
	for (const m of norm.matchAll(/fly-\d+/g)) {
		if (!identLower || m[0] !== identLower) return true;
	}
	// Explicit #<n> PR references.
	for (const m of norm.matchAll(/#(\d+)/g)) {
		const n = Number.parseInt(m[1] as string, 10);
		const matches =
			(prNum !== undefined && n === prNum) ||
			(idNum !== undefined && n === idNum);
		if (!matches) return true;
	}
	return false;
}

/**
 * Classify a founder text message as a Tier-2 exact approval or a downgrade to
 * Tier-3. Returns "approve" ONLY for a bare, unambiguous, correctly-targeted
 * approval; everything else → "downgrade".
 */
export function matchTier2Approval(
	rawMessage: string,
	gate: Tier2Gate,
): "approve" | "downgrade" {
	if (typeof rawMessage !== "string") return "downgrade";
	if (hasStructuralComplexity(rawMessage)) return "downgrade";

	const norm = rawMessage.trim().replace(/\s+/g, " ").toLowerCase();
	if (norm === "") return "downgrade";
	if (norm.length > MAX_CHARS) return "downgrade";
	if (norm.split(" ").length > MAX_TOKENS) return "downgrade";

	// Hedge / negation guard (latin word-boundary; CJK substring).
	for (const tok of TIER2_DENY_LATIN) {
		if (new RegExp(`\\b${tok}\\b`).test(norm)) return "downgrade";
	}
	for (const tok of TIER2_DENY_CJK) {
		if (norm.includes(tok)) return "downgrade";
	}

	// Any issue/PR reference must target the current gate.
	const stripped = stripAndVerifyReferences(norm, gate);
	if (stripped === null) return "downgrade";

	return TIER2_APPROVAL_PHRASES.has(stripped) ? "approve" : "downgrade";
}
