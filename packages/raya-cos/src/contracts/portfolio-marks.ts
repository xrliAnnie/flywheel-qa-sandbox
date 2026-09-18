import { containsSecretLikeText } from "../formatting/discord-text.js";

export type GoalMarkerInvalidReason =
	| "empty_text"
	| "too_long"
	| "bad_goal_id"
	| "malformed";

export interface ParsedGoalRecord {
	text: string;
	ordinal: number;
	line: string;
}

export interface ParsedGoalWithdrawal {
	goalId: string;
	ordinal: number;
	line: string;
}

export interface InvalidGoalMarker {
	line: string;
	reason: GoalMarkerInvalidReason;
}

export interface ParsedGoalLines {
	records: ParsedGoalRecord[];
	withdrawals: ParsedGoalWithdrawal[];
	invalid: InvalidGoalMarker[];
	rest: string;
}

const RECORD_PREFIX = "【记目标】";
const WITHDRAW_PREFIX = "【撤目标】";

function isCandidate(normalized: string): boolean {
	return ["【记目标", "【撤目标", "[记目标", "[撤目标"].some((prefix) =>
		normalized.startsWith(prefix),
	);
}

function invalidReason(normalized: string): GoalMarkerInvalidReason {
	if (normalized.startsWith(RECORD_PREFIX)) {
		return normalized.slice(RECORD_PREFIX.length).trim().length === 0
			? "empty_text"
			: "malformed";
	}
	if (normalized.startsWith(WITHDRAW_PREFIX)) return "bad_goal_id";
	return "malformed";
}

export function parseGoalLines(text: string): ParsedGoalLines {
	const records: ParsedGoalRecord[] = [];
	const withdrawals: ParsedGoalWithdrawal[] = [];
	const invalid: InvalidGoalMarker[] = [];
	const rest: string[] = [];
	for (const line of text.split("\n")) {
		const normalized = line.trim().normalize("NFKC");
		const recordMatch = /^【记目标】\s*(.+)$/.exec(normalized);
		if (recordMatch) {
			const close = line.indexOf("】");
			const goalText = close >= 0 ? line.slice(close + 1) : "";
			if (Array.from(goalText).length > 500) {
				invalid.push({ line, reason: "too_long" });
			} else {
				records.push({ text: goalText, ordinal: records.length, line });
			}
			continue;
		}
		const withdrawMatch = /^【撤目标】\s*(g-\d{8}-\d{2})$/.exec(normalized);
		if (withdrawMatch) {
			withdrawals.push({
				goalId: withdrawMatch[1] ?? "",
				ordinal: withdrawals.length,
				line,
			});
			continue;
		}
		if (isCandidate(normalized)) {
			invalid.push({ line, reason: invalidReason(normalized) });
			continue;
		}
		rest.push(line);
	}
	return { records, withdrawals, invalid, rest: rest.join("\n") };
}

export function parseRefreshLines(text: string): {
	requested: boolean;
	rest: string;
} {
	let requested = false;
	const rest: string[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().normalize("NFKC") === "【刷新读数】") {
			requested = true;
			continue;
		}
		rest.push(line);
	}
	return { requested, rest: rest.join("\n") };
}

export function looksSecretLike(text: string): boolean {
	return containsSecretLikeText(text);
}
