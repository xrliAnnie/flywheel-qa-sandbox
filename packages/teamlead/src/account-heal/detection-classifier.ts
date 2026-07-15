/**
 * FLY-871 R2 — layered blocking-condition detector (lead-instruction 47cff318①).
 *
 * Recognises a captured CLI pane's blocking condition (logged-out / quota /
 * rate-limit / permission) ROBUSTLY, so the Codex Infra Bot's watch + the R3
 * runner rescue detection (C8) survive CLI message-format changes:
 *
 *   Layer 1 — fixed pattern (primary, cheap): regex token table. Mirrors +
 *     extends the LeadWatchdog `BLOCKED_KEYWORDS` shapes (that table stays the
 *     authority for LEAD pane classification; this one adds the runner
 *     "kicked-out" auth variants — Invalid API key / please run /login — the lead
 *     path never needs). The exact runner tokens are finalised from a real
 *     kicked-out pane sample in QA (plan S3); the set here is the sensible default.
 *   Layer 2 — cheap AI classifier (fallback, only for UNRECOGNISED-but-anomalous
 *     text): the on-demand headless subscription Haiku classifier (FLY-799's
 *     `runSubscriptionClassifier` — subscription, NOT paid API). Deliberately
 *     reached ONLY when Layer 1 misses AND the text looks error-ish, so a healthy
 *     pane never spends a model call (the "3-layer 省钱" cost-saving).
 *   Layer 3 — fail-suspicious: anything still unclassifiable is reported as
 *     `suspicious` — NEVER silently treated as healthy (47cff318①: "无法归类
 *     一律按可疑上报").
 *
 * The AI layer is an injected seam (`DetectionDeps.aiClassify`) so the whole
 * ladder is unit-testable with a stub; `makeSubscriptionDetectionClassifier`
 * wires the real headless runner. Fail-closed throughout: any AI runner
 * failure / malformed verdict / "unknown" → the ladder falls through to
 * suspicious, never to a false "healthy".
 */

import {
	type RunnerResult,
	runSubscriptionClassifier,
	type SubscriptionClassifierOpts,
} from "../bridge/approval-signal/subscription-claude-classifier-runner.js";

/** A recognised blocking condition, plus the two non-cap terminal verdicts. */
export type DetectionCategory =
	| "login_expired"
	| "usage_limit"
	| "rate_limit"
	| "permission_blocked"
	| "healthy"
	| "suspicious";

/** Which layer produced the verdict (telemetry + tuning). */
export type DetectionLayer = "pattern" | "ai" | "suspicious";

export interface DetectionResult {
	category: DetectionCategory;
	layer: DetectionLayer;
	confidence: "high" | "low";
	/** A short matched snippet / reason, for the Alerts evidence line. */
	evidence?: string;
}

/** The categories a real blocking condition can be (excludes healthy/suspicious). */
type BlockedCategory = Exclude<DetectionCategory, "healthy" | "suspicious">;

/**
 * Layer-1 token table. The `usage_limit` negative lookbehind (`(?<!not your )`)
 * carries the FLY-218 fix (a "not your usage limit" throttle notice is NOT a cap).
 * The `login_expired` set extends the lead tokens with the runner kicked-out
 * shapes (Invalid API key / please run /login / session expired).
 */
const PATTERN_TABLE: Array<{ category: BlockedCategory; tokens: RegExp[] }> = [
	{
		category: "login_expired",
		tokens: [
			/\blogin\b.*\bexpired\b/i,
			/\breauth(?:enticat\w+)?\b/i,
			/invalid api key/i,
			/please run\s+\/login/i,
			/run\s+\/login\b/i,
			/session (?:has )?expired/i,
			/not logged ?in/i,
			/authentication (?:failed|required|error|expired)/i,
			/you are not authenticated/i,
		],
	},
	{ category: "usage_limit", tokens: [/(?<!not your )\busage[-\s]?limit\b/i] },
	{ category: "rate_limit", tokens: [/\brate[-\s]?limit\b/i] },
	{
		category: "permission_blocked",
		tokens: [/\bpermission\b.*\b(?:required|denied)\b/i],
	},
];

/**
 * Error-ish signals used to tell "healthy (unrecognised, no error)" from
 * "anomalous (unrecognised BUT error-ish → escalate to Layer 2 / suspicious)".
 * Keeping the AI layer behind this gate is the cost-saving: normal panes never
 * spend a model call.
 */
const ANOMALY_SIGNALS: RegExp[] = [
	/\berror\b/i,
	/\bfail(?:ed|ure|s|ing)?\b/i,
	/\binvalid\b/i,
	/\bdenied\b/i,
	/\bexpired\b/i,
	/\bunauthorized\b/i,
	/\bforbidden\b/i,
	/\bunable to\b/i,
	/\bcannot\b/i,
	/\btimed out\b/i,
	/\bunexpected\b/i,
];

export interface DetectionDeps {
	/**
	 * Layer-2 AI classifier. Given anomalous-but-unrecognised text, returns a
	 * recognised `DetectionCategory` or null (unknown / unavailable). undefined ⇒
	 * the AI layer is skipped entirely ⇒ anomalous text goes straight to
	 * fail-suspicious. MUST be fail-closed (return null, never throw) — the ladder
	 * also try/catches it belt-and-suspenders.
	 */
	aiClassify?: (text: string) => Promise<DetectionCategory | null>;
}

function firstAnomalySnippet(text: string): string | undefined {
	for (const re of ANOMALY_SIGNALS) {
		const m = text.match(re);
		if (m) {
			const idx = m.index ?? 0;
			return text.slice(Math.max(0, idx - 20), idx + 40).trim();
		}
	}
	return undefined;
}

/**
 * Classify a captured pane's blocking condition through the 3-layer ladder.
 * Never throws; the worst case is a `suspicious` verdict (reported, not silent).
 */
export async function classifyDetection(
	text: string,
	deps: DetectionDeps = {},
): Promise<DetectionResult> {
	// Layer 1 — fixed pattern.
	for (const { category, tokens } of PATTERN_TABLE) {
		const hit = tokens.find((t) => t.test(text));
		if (hit) {
			const m = text.match(hit);
			return {
				category,
				layer: "pattern",
				confidence: "high",
				evidence: m?.[0],
			};
		}
	}

	// No known pattern. Healthy (no error signal) short-circuits — no model call.
	if (!ANOMALY_SIGNALS.some((t) => t.test(text))) {
		return { category: "healthy", layer: "pattern", confidence: "high" };
	}

	// Layer 2 — cheap AI classifier, ONLY for unrecognised-but-anomalous text.
	if (deps.aiClassify) {
		let cat: DetectionCategory | null = null;
		try {
			cat = await deps.aiClassify(text);
		} catch {
			cat = null; // fail-closed
		}
		if (cat === "healthy") {
			return { category: "healthy", layer: "ai", confidence: "low" };
		}
		if (cat && cat !== "suspicious") {
			return {
				category: cat,
				layer: "ai",
				confidence: "low",
				evidence: "ai-classified",
			};
		}
	}

	// Layer 3 — fail-suspicious. NEVER silently healthy.
	return {
		category: "suspicious",
		layer: "suspicious",
		confidence: "low",
		evidence: firstAnomalySnippet(text),
	};
}

const AI_CATEGORIES: ReadonlySet<string> = new Set([
	"login_expired",
	"usage_limit",
	"rate_limit",
	"permission_blocked",
	"healthy",
]);

function buildDetectionPrompt(text: string): string {
	return [
		"You are a STRICT classifier for the terminal pane of an AI coding CLI.",
		"Classify the CURRENT blocking condition into EXACTLY one category.",
		"Categories:",
		"- login_expired: logged out / auth or session expired / invalid API key / it is asking to re-login (/login).",
		"- usage_limit: a subscription usage/quota cap was hit.",
		"- rate_limit: transient rate limiting.",
		"- permission_blocked: a permission is required or was denied.",
		"- healthy: normal operation, no blocking condition.",
		"- unknown: you cannot tell.",
		"Fail-closed: when unsure between healthy and a problem, answer unknown (NOT healthy).",
		'Output ONLY a JSON object, no other text: {"category":"<one of the above>","reason":"<short>"}.',
		"<<<PANE",
		text,
		"PANE",
	].join("\n");
}

/**
 * Production Layer-2 impl: wire the headless subscription Haiku runner into an
 * `aiClassify`. Fail-closed — any runner failure / malformed verdict / "unknown"
 * → null (⇒ the ladder reports suspicious). Maps the model's category string to a
 * `DetectionCategory`, or null when it is "unknown" / not one of the known set.
 */
export function makeSubscriptionDetectionClassifier(
	opts: SubscriptionClassifierOpts & {
		runnerImpl?: (
			prompt: string,
			o?: SubscriptionClassifierOpts,
		) => Promise<RunnerResult>;
	} = {},
): (text: string) => Promise<DetectionCategory | null> {
	const { runnerImpl, ...runnerOpts } = opts;
	const runner = runnerImpl ?? runSubscriptionClassifier;
	return async (text: string): Promise<DetectionCategory | null> => {
		let res: RunnerResult;
		try {
			res = await runner(buildDetectionPrompt(text), runnerOpts);
		} catch {
			return null; // the runner should never throw; belt-and-suspenders
		}
		if (!res.ok) return null;
		const v = res.verdict;
		if (typeof v !== "object" || v === null) return null;
		const cat = (v as { category?: unknown }).category;
		if (typeof cat === "string" && AI_CATEGORIES.has(cat)) {
			return cat as DetectionCategory;
		}
		return null; // "unknown" or anything unexpected → fail-suspicious upstream
	};
}
