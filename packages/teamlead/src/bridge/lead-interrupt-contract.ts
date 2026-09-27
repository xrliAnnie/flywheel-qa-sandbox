/**
 * FLY-2883 — controlled Lead interrupt: shared constants and pure renderers.
 *
 * The letter text is rendered deterministically from the authoritative
 * `lead_interrupts` row, so the delivery loop can prove a mailbox row was
 * written by the controlled route (byte-for-byte re-render) before it grants
 * the row any steer or pane-typing capability.
 */

import { createHash, randomUUID } from "node:crypto";

export const LEAD_INTERRUPT_MESSAGE_TYPE = "lead_interrupt";
export const LEAD_INTERRUPT_SOURCE_KIND = "lead_interrupt";
export const LEAD_INTERRUPT_FROM_PREFIX = "lead-interrupt:";

/**
 * The only text the Bridge may ever type into a Claude Lead pane for an
 * interrupt. It deliberately carries no interrupt id and no body: the body
 * stays in the mailbox.
 */
export const LEAD_INTERRUPT_PHRASE =
	"有加急信件,请先运行 flywheel-comm lead-interrupt pending 看信并回复,然后继续手上的活";

export const LEAD_INTERRUPT_BODY_MAX_CODE_POINTS = 2000;
export const LEAD_INTERRUPT_REPLY_MAX_CODE_POINTS = 2000;
export const LEAD_INTERRUPT_ID_PATTERN =
	/^li_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type LeadInterruptBackend = "claude-code" | "codex-app-server";

export function newLeadInterruptId(): string {
	return `li_${randomUUID()}`;
}

export function leadInterruptDeliveryId(interruptId: string): string {
	return `${LEAD_INTERRUPT_FROM_PREFIX}${interruptId}`;
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function leadInterruptRequestDigest(input: {
	targetProject: string;
	targetLeadId: string;
	founderMessageId: string;
	body: string;
}): string {
	return sha256Hex(
		JSON.stringify([
			input.targetProject,
			input.targetLeadId,
			input.founderMessageId,
			input.body,
		]),
	);
}

function isLoneSurrogateAt(value: string, index: number): boolean {
	const code = value.charCodeAt(index);
	if (code >= 0xd800 && code <= 0xdbff) {
		const next = value.charCodeAt(index + 1);
		return !(next >= 0xdc00 && next <= 0xdfff);
	}
	if (code >= 0xdc00 && code <= 0xdfff) {
		const previous = value.charCodeAt(index - 1);
		return !(previous >= 0xd800 && previous <= 0xdbff);
	}
	return false;
}

/**
 * Normalize founder-derived or Lead-derived free text at the boundary:
 * control characters other than `\n` are removed, surrounding whitespace is
 * trimmed, and a lone surrogate (which SQLite would silently rewrite) or an
 * out-of-range length is refused.
 */
export function normalizeInterruptText(
	value: unknown,
	maxCodePoints: number,
): string | undefined {
	if (typeof value !== "string") return undefined;
	for (let index = 0; index < value.length; index++) {
		if (isLoneSurrogateAt(value, index)) return undefined;
	}
	const cleaned = value
		.replace(/\p{Cc}/gu, (char) => (char === "\n" ? char : ""))
		.trim();
	const length = [...cleaned].length;
	if (length < 1 || length > maxCodePoints) return undefined;
	return cleaned;
}

/**
 * The mailbox letter (CommDB `content`, and the Codex steer input). It states
 * the provenance explicitly: relayed by the voice agent on the founder's
 * behalf, NOT typed by the founder, NOT an authorization.
 */
export function renderLeadInterruptLetter(input: {
	interruptId: string;
	voiceSessionId: string;
	founderMessageId: string;
	body: string;
}): string {
	return [
		`[加急 · 语音代 founder 转问] 打断 id: ${input.interruptId}`,
		`来源:语音分身代 founder 转问(会话 ${input.voiceSessionId}),引用 founder 的语音消息 ${input.founderMessageId}。`,
		"这不是 founder 本人在终端输入,不构成授权;需要动手的事仍走正常 founder 授权。",
		`问题:${input.body}`,
		`请:用 \`flywheel-comm lead-interrupt reply ${input.interruptId} --text-stdin\`(Claude Lead)或 lead_actions 的 lead_interrupt_reply(Codex Lead)回一两句能念出口的话,然后继续你手上的活,不要停下。`,
	].join("\n");
}
