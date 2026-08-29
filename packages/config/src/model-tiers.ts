/**
 * FLY-728: per-issue model routing — the model-tier vocabulary.
 *
 * Single source of truth for three related concerns:
 *   1. The `/api/runs/start` `model` dispatch-param whitelist (Part C). The
 *      Lead's difficulty-sorter judges a tier and passes the model id; the
 *      Bridge accepts only a known tier id / alias (typos fail loud at the
 *      boundary).
 *   2. The tier → default model id mapping. This is the 728 BUILT-IN default;
 *      making the mapping per-project configurable is FLY-709's job.
 *   3. The F/O/S/H thread-title short code (Part D) shown on the `[FLY-XX]`
 *      Discord thread so the founder sees which model an issue is running.
 *
 * Canonical model ids for the 728 default mapping (the founder confirmed the
 * tiers; tier→model is FLY-709-configurable): Fable 5 `claude-fable-5`, Opus 4.8
 * `claude-opus-4-8`, Sonnet 5 `claude-sonnet-5`, Haiku 4.5
 * `claude-haiku-4-5-20251001`. The `[1m]` suffix is the Claude Code CLI
 * 1M-context-window selector at standard pricing.
 *
 * FLY-751: the medium tier dropped its `[1m]` suffix — a 1M-context Claude
 * process costs ~0.35GB more RAM per runner (FLY-753 measured) and most tasks
 * don't need the window. 1M is now an EXPLICIT opt-in: the `opus-1m` /
 * `fable-1m` dispatch aliases (and the same issue labels, see runner-label.ts)
 * resolve to the `[1m]` ids. The ship gate for this change called the flip out
 * to the founder (it reverses the FLY-728-era medium mapping she confirmed).
 *
 * The simple-tier id `claude-sonnet-5` is verified against the token pricing
 * catalog (`token-usage/pricing.ts`), the token report label map
 * (`render-html.ts` → "Sonnet 5"), and the harness model-id context — NOT a
 * guess. The founder confirmed the fleet standard is Sonnet 5 (not 4.6).
 */

export type ModelTier = "heavy" | "medium" | "light" | "trivial";

export interface ModelTierSpec {
	/** Canonical model id passed to the runner CLI `--model`. */
	id: string;
	/** Bare aliases accepted on the dispatch param (in addition to `id`). */
	aliases: readonly string[];
	/** Single-letter thread-title short code (Part D). */
	code: "F" | "O" | "S" | "H";
}

/** Difficulty tier → default model. 728 built-in; FLY-709 makes it configurable. */
export const MODEL_TIERS: Readonly<Record<ModelTier, ModelTierSpec>> = {
	heavy: { id: "claude-fable-5", aliases: ["fable"], code: "F" },
	medium: { id: "claude-opus-4-8", aliases: ["opus"], code: "O" },
	light: { id: "claude-sonnet-5", aliases: ["sonnet"], code: "S" },
	trivial: { id: "claude-haiku-4-5-20251001", aliases: ["haiku"], code: "H" },
};

/**
 * FLY-751: explicit 1M-context opt-in spellings. NOT a tier — a Lead (or a
 * label) reaches for these only when a task genuinely needs the 1M window.
 */
const ONE_M_DISPATCH_MODELS: ReadonlyMap<string, string> = new Map([
	["opus-1m", "claude-opus-4-8[1m]"],
	["claude-opus-4-8[1m]", "claude-opus-4-8[1m]"],
	["fable-1m", "claude-fable-5[1m]"],
	["claude-fable-5[1m]", "claude-fable-5[1m]"],
]);

/** Lowercased id/alias → canonical id (built once from MODEL_TIERS + 1M opt-ins). */
const DISPATCH_MODEL_LOOKUP: ReadonlyMap<string, string> = (() => {
	const m = new Map<string, string>();
	for (const spec of Object.values(MODEL_TIERS)) {
		m.set(spec.id.toLowerCase(), spec.id);
		for (const alias of spec.aliases) m.set(alias.toLowerCase(), spec.id);
	}
	for (const [alias, id] of ONE_M_DISPATCH_MODELS) m.set(alias, id);
	return m;
})();

/**
 * FLY-751: every spelling `normalizeDispatchModel` accepts — for boundary
 * error payloads (`runs-route.ts` INVALID_MODEL `allowed`), so the 1M opt-ins
 * are discoverable and not just tribal knowledge.
 */
export const ACCEPTED_DISPATCH_MODELS: readonly string[] = [
	...DISPATCH_MODEL_LOOKUP.keys(),
];

/**
 * Normalize a dispatch `model` param to a canonical tier id, or `null` when it
 * is not a recognized 728 tier (empty / unknown / a non-tier model). Callers at
 * the `/api/runs/start` boundary reject `null` with `INVALID_MODEL` — a typo
 * must fail loud, never silently spawn the wrong (or account-default) model.
 * Case-insensitive + trimmed. FLY-709 widens the accepted set via config.
 */
export function normalizeDispatchModel(raw: string): string | null {
	const key = raw.trim().toLowerCase();
	if (!key) return null;
	return DISPATCH_MODEL_LOOKUP.get(key) ?? null;
}

/**
 * Map a RESOLVED runner model (from a label, the dispatch param, or a project
 * default) to its F/O/S/H thread-title short code, or `undefined` when there is
 * no code to show — account default (no override) or a non-Claude model. Matches
 * by family so it covers both canonical ids (`claude-fable-5`,
 * `claude-opus-4-8[1m]`) and the bare aliases the label path stores verbatim
 * (`opus`/`sonnet`/`haiku`).
 */
export function modelShortCode(
	model: string | null | undefined,
): "F" | "O" | "S" | "H" | undefined {
	if (!model) return undefined;
	const m = model.toLowerCase();
	if (m === "fable" || m.startsWith("claude-fable")) return "F";
	if (m === "opus" || m.startsWith("claude-opus")) return "O";
	if (m === "sonnet" || m.startsWith("claude-sonnet")) return "S";
	if (m === "haiku" || m.startsWith("claude-haiku")) return "H";
	return undefined;
}

/** Short code → the family display name shown in FLY-892 phase tags/headers. */
const SHORT_CODE_DISPLAY_NAME: Readonly<Record<"F" | "O" | "S" | "H", string>> =
	{ F: "Fable", O: "Opus", S: "Sonnet", H: "Haiku" };

/**
 * FLY-892 (Codex R1 #3): the canonical model DISPLAY name (Fable / Opus / Sonnet
 * / Haiku / GPT) for a phase message tag / pipeline header. Reuses
 * `modelShortCode`, so it covers canonical ids, bare aliases, and `[1m]`
 * variants identically. FLY-1224: the GPT family is recognized BEFORE the
 * F/O/S/H short codes AND before the tier fallback — a codex phase session's
 * `gpt-5.6-sol` must display "GPT-5.6", never fall back to a Claude name (the
 * display lie C2 fixed). When `model` maps to no known family (account default
 * / unknown), fall back to the `fallbackTier`'s name if given, else
 * `undefined`. This is the single display-name contract so no injection point
 * re-derives it.
 */
export function modelDisplayName(
	model: string | null | undefined,
	fallbackTier?: ModelTier,
): string | undefined {
	const m = model?.toLowerCase();
	if (m?.startsWith("gpt-5.6")) return "GPT-5.6";
	if (m?.startsWith("gpt-")) return "GPT";
	const code = modelShortCode(model);
	if (code) return SHORT_CODE_DISPLAY_NAME[code];
	if (fallbackTier)
		return SHORT_CODE_DISPLAY_NAME[MODEL_TIERS[fallbackTier].code];
	return undefined;
}
