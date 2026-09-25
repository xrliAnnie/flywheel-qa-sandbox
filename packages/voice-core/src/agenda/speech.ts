import {
	AGENDA_LEAD_URGENT_REASONS,
	type AgendaClass,
	type AgendaItem,
	type AgendaLeadUrgentReason,
} from "./types.js";

/** U1 (plan §4.2): a Lead marks one of its own main-channel messages urgent by
 * starting it with `🚨[urgent:<reason>]`. The Bridge trusts it only from that
 * Lead's own bot, so Discord authorship is the identity. */
export const AGENDA_URGENT_MARKER_PREFIX = "🚨[urgent:";

export function parseAgendaUrgentMarker(
	content: string,
): AgendaLeadUrgentReason | null {
	const match = /^🚨\[urgent:([a-z0-9_]+)\]/u.exec(content.trimStart());
	const reason = match?.[1];
	return reason &&
		AGENDA_LEAD_URGENT_REASONS.includes(reason as AgendaLeadUrgentReason)
		? (reason as AgendaLeadUrgentReason)
		: null;
}

/** Prefixes of voice echoes posted back into Discord (📻 room status, 🗣️
 * transcript mirror). One definition for every consumer (plan §2.1 R1-9). */
export const VOICE_ECHO_PREFIXES = ["📻", "🗣️"] as const;

export const DEFAULT_AGENDA_MAX_SAY_CODE_POINTS = 400;

export type AgendaSayRejection =
	| "empty"
	| "too_long"
	| "url"
	| "markdown"
	| "code"
	| "automation_prefix";

/** Mechanical checks only (plan §3.4) — no semantic judgement of the words. */
export function validateAgendaSay(
	text: string,
	maxCodePoints = DEFAULT_AGENDA_MAX_SAY_CODE_POINTS,
): { ok: true } | { ok: false; reason: AgendaSayRejection } {
	const trimmed = text.trim();
	if (!trimmed) return { ok: false, reason: "empty" };
	if (Array.from(trimmed).length > maxCodePoints)
		return { ok: false, reason: "too_long" };
	if (/https?:\/\/|www\.[a-z0-9-]/iu.test(trimmed))
		return { ok: false, reason: "url" };
	if (/`/u.test(trimmed)) return { ok: false, reason: "code" };
	if (/^\s*(?:[-*+•]\s|\d+[.)、]\s|#{1,6}\s|>\s)/mu.test(trimmed))
		return { ok: false, reason: "markdown" };
	if (/\*\*|__|\[[^\]]*\]\([^)]*\)/u.test(trimmed))
		return { ok: false, reason: "markdown" };
	if (
		trimmed.startsWith("🤖") ||
		VOICE_ECHO_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
	)
		return { ok: false, reason: "automation_prefix" };
	return { ok: true };
}

const DIGITS = "〇一二三四五六七八九";

/** "FLY-2796" → "二七九六": issue numbers are read digit by digit. */
export function spokenIssueNumber(identifier: string): string | null {
	const digits = identifier.match(/(\d+)\s*$/u)?.[1];
	if (!digits) return null;
	return Array.from(digits, (digit) => DIGITS[Number(digit)]).join("");
}

const WAITING_VERB: Record<AgendaClass, string> = {
	awaiting_approval: "批",
	blocked: "授权",
	needs_answer: "回答",
	lead_said: "回",
};

/** Visible degradation (plan §3.4 R1-8): only known facts, never a claim that
 * something was sent or is waiting in a thread we cannot prove. */
export function agendaFallbackLine(item: AgendaItem): string {
	const number = item.issueIdentifier
		? spokenIssueNumber(item.issueIdentifier)
		: null;
	if (number && item.threadUrl)
		return `${number} 在等你${WAITING_VERB[item.class]}，我还没整理好，你也可以直接去 thread 看。`;
	return `${item.leadName}有一条消息在等你回。`;
}

export function agendaTransitionLine(count: number): string {
	return `我在整理，有 ${count} 件要你拍，马上说。`;
}

export function agendaCheckinFallbackLine(sourceHealthy: boolean): string {
	return sourceHealthy ? "我还在，没卡住。" : "我还在，不过消息暂时连不上。";
}
