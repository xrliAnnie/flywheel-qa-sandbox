/**
 * Refactored from Raya apps/voice/src/inbox/SpeechBrief.ts@f669d1b.
 * The three-part validation rules are preserved; invalid or absent briefs now
 * fall back to the complete source message because V2 reads every report.
 */

export interface VoiceSpeechBrief {
	what: string;
	why: string;
	next: string;
}

export type SpeechBriefValidation =
	| { ok: true }
	| {
			ok: false;
			reason:
				| "missing"
				| "empty"
				| "too_long"
				| "internal_identifier"
				| "sentence_terminal";
	  };

export interface SpeechBriefSource {
	content: string;
	embeds?: readonly {
		fields?: readonly { name: string; value: string }[];
	}[];
}

const MAX_FIELD_CODE_POINTS = 200;
const LABELS = ["现状", "原因", "下一步"] as const;

function normalizeSegment(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function validateSpeechBrief(
	brief: VoiceSpeechBrief | undefined,
): SpeechBriefValidation {
	if (!brief) return { ok: false, reason: "missing" };
	const fields = [brief.what, brief.why, brief.next];
	if (fields.some((field) => normalizeSegment(field).length === 0))
		return { ok: false, reason: "empty" };
	if (fields.some((field) => Array.from(field).length > MAX_FIELD_CODE_POINTS))
		return { ok: false, reason: "too_long" };
	if (fields.some((field) => /\p{Number}/u.test(field)))
		return { ok: false, reason: "internal_identifier" };
	if (fields.some((field) => !/[。！？.!?…]$/u.test(normalizeSegment(field))))
		return { ok: false, reason: "sentence_terminal" };
	return { ok: true };
}

/** Extract exactly one unambiguous 现状/原因/下一步 group. */
export function extractSpeechBrief(
	source: SpeechBriefSource,
): VoiceSpeechBrief | undefined {
	const groups: VoiceSpeechBrief[] = [];
	const lines = source.content.split(/\r?\n/u);
	const fields = new Map<string, string[]>();
	for (const line of lines) {
		const match = line.match(/^\s*(现状|原因|下一步)\s*[：:]\s*(.+?)\s*$/u);
		if (match) {
			const values = fields.get(match[1]!) ?? [];
			values.push(match[2]!);
			fields.set(match[1]!, values);
		}
	}
	if (LABELS.every((label) => fields.get(label)?.length === 1)) {
		groups.push({
			what: fields.get("现状")![0]!,
			why: fields.get("原因")![0]!,
			next: fields.get("下一步")![0]!,
		});
	}
	for (const embed of source.embeds ?? []) {
		const byName = new Map<string, string[]>();
		for (const field of embed.fields ?? []) {
			const name = field.name.trim();
			if (!LABELS.includes(name as (typeof LABELS)[number])) continue;
			const values = byName.get(name) ?? [];
			values.push(field.value);
			byName.set(name, values);
		}
		if (LABELS.every((label) => byName.get(label)?.length === 1)) {
			groups.push({
				what: byName.get("现状")![0]!,
				why: byName.get("原因")![0]!,
				next: byName.get("下一步")![0]!,
			});
		}
	}
	return groups.length === 1 ? groups[0] : undefined;
}

export function renderSpeechBrief(brief: VoiceSpeechBrief): string {
	const validation = validateSpeechBrief(brief);
	if (!validation.ok)
		throw new Error(`voice inbox speech brief rejected: ${validation.reason}`);
	return [brief.what, brief.why, brief.next].map(normalizeSegment).join("");
}

/** Split without dropping the tail. Sentence boundaries win; long sentences
 * are split at the backend limit by Unicode code point. */
export function splitSpeechText(text: string, maxCodePoints = 500): string[] {
	if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1)
		throw new Error("speech text limit must be a positive integer");
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [];
	const chunks: string[] = [];
	let current = "";
	const sentences = normalized.match(/.*?[。！？.!?…]+|.+$/gu) ?? [normalized];
	for (const sentence of sentences) {
		for (let rest = Array.from(sentence); rest.length > 0; ) {
			const capacity = maxCodePoints - Array.from(current).length;
			if (capacity === 0) {
				chunks.push(current);
				current = "";
				continue;
			}
			const part = rest.splice(0, capacity).join("");
			current += part;
			if (rest.length > 0 || Array.from(current).length === maxCodePoints) {
				chunks.push(current);
				current = "";
			}
		}
	}
	if (current) chunks.push(current);
	return chunks;
}
