import type { Cell, EpicItem, MissingReason } from "./model.js";

export const FOUNDER_REVIEW_LABEL = "founder-review";
export const RULE_IDS = {
	ready: "ready.v1",
	dependents: "dependents.v1",
	founder: "founder.v1",
	done: "done.v1",
	gaps: "gaps.v1",
} as const;

function priorityRank(priority: number): number {
	return priority === 0 ? Number.MAX_SAFE_INTEGER : priority;
}

function known<T>(cell: Cell<T>): cell is Cell<T> & { value: T } {
	return cell.value !== null && cell.missing === undefined;
}

export function computeReady(items: EpicItem[]): string[] {
	return items
		.filter((item) => {
			if (!known(item.state) || !known(item.blocked_by)) return false;
			if (
				item.state.value.type === "backlog" ||
				item.state.value.type === "completed" ||
				item.state.value.type === "canceled"
			) {
				return false;
			}
			return item.blocked_by.value.every(
				(blocker) => blocker.blocker_state_type === "completed",
			);
		})
		.sort(
			(left, right) =>
				priorityRank(left.priority.value ?? 0) -
					priorityRank(right.priority.value ?? 0) ||
				left.identifier.localeCompare(right.identifier),
		)
		.map((item) => item.identifier);
}

export function doneDefinition(
	generatedAt: string,
): Cell<{ terminal_state: "completed" }> {
	return {
		value: { terminal_state: "completed" },
		provenance: { kind: "derived", rule: "done.v1", from: [] },
		observed_at: generatedAt,
	};
}

export function isFounderNamed(labels: string[]): boolean {
	return labels.includes(FOUNDER_REVIEW_LABEL);
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let result = "";
	let bytes = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		result += character;
		bytes += size;
	}
	return result;
}

type MarkdownFence = { character: string; length: number };

const MARKDOWN_FENCE = /^ {0,3}(`{3,}|~{3,})/;

function isMarkdownFenceCloser(line: string, current: MarkdownFence): boolean {
	const match = line.match(MARKDOWN_FENCE);
	return (
		match?.[1]?.[0] === current.character &&
		match[1].length >= current.length &&
		line.slice(match[0].length).trim().length === 0
	);
}

function findMarkdownFenceClose(
	lines: string[],
	start: number,
	current: MarkdownFence,
): number | null {
	for (let index = start + 1; index < lines.length; index += 1) {
		if (isMarkdownFenceCloser(lines[index]!, current)) return index;
	}
	return null;
}

function scanMarkdownFence(
	line: string,
	current: MarkdownFence | null,
): { current: MarkdownFence | null; fenced: boolean } {
	const match = line.match(MARKDOWN_FENCE);
	if (current) {
		return {
			current: isMarkdownFenceCloser(line, current) ? null : current,
			fenced: true,
		};
	}
	if (!match?.[1]) return { current: null, fenced: false };
	return {
		current: { character: match[1][0]!, length: match[1].length },
		fenced: true,
	};
}

export function extractAcceptance(
	description: string | null | undefined,
): { text: string; truncated: boolean } | null {
	if (!description) return null;
	const lines = description.split(/\r?\n/);
	const heading = /^(#{1,6})[ \t]*(.*)$/;
	const acceptanceTitle =
		/^(?:\u9a8c\u6536|acceptance\b|definition of done\b|dod\b)/i;
	const headings = lines.map((line) => line.match(heading));
	let start = -1;
	let startFence: MarkdownFence | null = null;
	for (let index = 0; index < lines.length; index += 1) {
		const fence = scanMarkdownFence(lines[index]!, startFence);
		startFence = fence.current;
		if (fence.fenced) continue;
		const match = headings[index];
		if (match && acceptanceTitle.test(match[2]!)) {
			start = index;
			break;
		}
	}
	if (start < 0) return null;
	const level = headings[start]![1]!.length;
	let end = lines.length;
	let currentFence: MarkdownFence | null = null;
	let closingFence: number | null = null;
	for (let index = start + 1; index < lines.length; index += 1) {
		const previousFence = currentFence;
		const fence = scanMarkdownFence(lines[index]!, currentFence);
		if (!previousFence && fence.current) {
			closingFence = findMarkdownFenceClose(lines, index, fence.current);
		}
		if (previousFence && closingFence === null) {
			const recovery = headings[index];
			if (recovery && recovery[1]!.length <= level) {
				end = index;
				break;
			}
		}
		currentFence = fence.current;
		if (!currentFence) closingFence = null;
		if (fence.fenced) continue;
		const match = headings[index];
		if (match && match[1]!.length <= level) {
			end = index;
			break;
		}
	}
	const text = lines
		.slice(start + 1, end)
		.join("\n")
		.trim();
	if (text.length === 0) return null;
	const truncated = Buffer.byteLength(text, "utf8") > 4096;
	return { text: truncateUtf8(text, 4096), truncated };
}

export function computeGaps(items: EpicItem[]): Array<{
	item: string;
	face:
		| "what"
		| "done"
		| "founder"
		| "session"
		| "run"
		| "attempt"
		| "gates"
		| "carriers"
		| "land";
	reason: MissingReason;
}> {
	const result: Array<{
		item: string;
		face:
			| "what"
			| "done"
			| "founder"
			| "session"
			| "run"
			| "attempt"
			| "gates"
			| "carriers"
			| "land";
		reason: MissingReason;
	}> = [];
	const faces = [
		["title", "what"],
		["acceptance", "done"],
		["founder_named", "founder"],
		["session", "session"],
		["run", "run"],
		["attempt", "attempt"],
		["gates", "gates"],
		["carriers", "carriers"],
		["land", "land"],
	] as const;
	for (const item of items) {
		for (const [key, face] of faces) {
			const cell = item[key];
			if (cell.value === null && cell.missing) {
				result.push({
					item: item.identifier,
					face,
					reason: cell.missing.reason,
				});
			}
		}
	}
	return result;
}
