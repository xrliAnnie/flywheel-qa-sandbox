export interface ModelCapState {
	until: string;
	backoffMs: number;
}

export type ModelCapVerdict =
	| { state: "capped"; model: string }
	| { state: "clear" }
	| { state: "unknown"; reason: string };

export const BASE_MODEL_CAP_TTL_MS = 30 * 60_000;
export const MAX_MODEL_CAP_TTL_MS = 4 * 3_600_000;
export const MODEL_CAP_THRASH_WINDOW_MS = 15 * 60_000;

const MODEL_CAP_RE =
	/reached your\s+(.+?)\s+limit\b[\s\S]{0,160}?switch models with \/model/i;
const MAX_CAP_SPAN_CHARS = 280;
const PROGRESS_AFTER_CAP =
	/^\s*(⏺|✅)|(\btests?\s+passed\b)|(\bswitched to\b)/i;
const ACTIVE_INFLIGHT =
	/esc to interrupt|esc\b[^\n]*\bto cancel\b|compacting conversation|^\s*[✻✶✳✢✽]\s|\b(Cooking|Working|Thinking|Forming|Pondering|Simmering|Brewing|Percolating|Crunching|Churning|Computing|Processing|Generating|Distilling|Synthesizing|Marinating|Conjuring|Noodling)\b[^\n]{0,40}\b\d+s\b/i;
const GAUGE_ROW = /^\s*5h\s+[█░]/;
const CAP_CONTINUATION = /usage-credits|switch models with \/model/i;

/**
 * Classify the most recent model-cap episode. Character-budget joining keeps
 * narrow terminal wraps reliable without accepting unbounded scrollback.
 */
export function parseModelCap(pane: string): ModelCapVerdict {
	const lines = pane.split("\n");
	let capEnd = -1;
	let model: string | undefined;

	for (let start = 0; start < lines.length; start++) {
		let buffer = "";
		for (
			let end = start;
			end < lines.length && buffer.length <= MAX_CAP_SPAN_CHARS;
			end++
		) {
			buffer += `${buffer ? " " : ""}${(lines[end] ?? "").trim()}`;
			const match = buffer.match(MODEL_CAP_RE);
			if (!match?.[1]) continue;
			capEnd = end;
			model = match[1].replace(/\s+/g, " ").trim();
			break;
		}
	}
	if (capEnd === -1 || !model) return { state: "clear" };

	let completed = false;
	let active = false;
	for (let index = capEnd + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (!line.trim() || CAP_CONTINUATION.test(line) || GAUGE_ROW.test(line)) {
			continue;
		}
		if (PROGRESS_AFTER_CAP.test(line)) completed = true;
		if (ACTIVE_INFLIGHT.test(line)) active = true;
	}

	if (completed) return { state: "clear" };
	if (active) {
		return {
			state: "unknown",
			reason: `model cap (${model}) has an in-flight operation after it`,
		};
	}
	return { state: "capped", model };
}

export function computeModelCapTtlMs(
	previous: ModelCapState | undefined,
	now: Date,
): number {
	if (!previous) return BASE_MODEL_CAP_TTL_MS;
	const previousUntil = Date.parse(previous.until);
	if (Number.isNaN(previousUntil)) return BASE_MODEL_CAP_TTL_MS;
	if (now.getTime() - previousUntil >= MODEL_CAP_THRASH_WINDOW_MS) {
		return BASE_MODEL_CAP_TTL_MS;
	}
	return Math.min(
		(previous.backoffMs || BASE_MODEL_CAP_TTL_MS) * 2,
		MAX_MODEL_CAP_TTL_MS,
	);
}
