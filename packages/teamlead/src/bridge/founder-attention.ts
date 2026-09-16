/** Shared title/page vocabulary. Unmarked questions never imply founder attention. */
export const FOUNDER_ATTENTION_KINDS = {
	ship: "ship",
	founder_gate: "ship",
	legacy_founder_gate: "answer",
	founder_ask: "answer",
} as const;

export type FounderAttentionLevel = "ship" | "answer" | null;

export function founderAttentionLevel(
	kinds: Iterable<string>,
): FounderAttentionLevel {
	let result: FounderAttentionLevel = null;
	for (const kind of kinds) {
		if (!Object.hasOwn(FOUNDER_ATTENTION_KINDS, kind)) continue;
		const level =
			FOUNDER_ATTENTION_KINDS[kind as keyof typeof FOUNDER_ATTENTION_KINDS];
		if (level === "ship") return "ship";
		result = level;
	}
	return result;
}
