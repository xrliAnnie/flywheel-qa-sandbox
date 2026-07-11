/**
 * Shared claude CLI stream-json line parser (FLY-1160 §3.0).
 *
 * Two entry points:
 *   - parseStreamEvent(): kind-annotated parse for the RESIDENT brain. The CLI
 *     emits BOTH partial text_delta events AND the final complete assistant
 *     message for the same turn (real-machine evidence: FLY-1006 shim S2
 *     round C, dedupeFinalEcho) — a consumer that yields both makes TTS speak
 *     the whole reply twice. Carrying the event kind lets the resident brain
 *     yield deltas only, falling back to the assistant-final text ONLY when a
 *     turn produced no delta at all.
 *   - parseStreamLine(): the legacy HeadlessClaudeBrain shape, preserved
 *     byte-for-byte (the existing headless-brain tests are the regression
 *     sentinel). HeadlessClaudeBrain re-exports it from here so the public
 *     import path never breaks.
 */

export type StreamEventKind =
	| "delta"
	| "assistant-final"
	| "result"
	| "control"
	| "system"
	| "other";

export interface ParsedStreamEvent {
	kind: StreamEventKind;
	/** false only when the line is not stream-json we understand. */
	recognized: boolean;
	/** delta text (kind=delta) or joined assistant text (kind=assistant-final). */
	text?: string;
	/** top-level session_id, captured whenever present. */
	sessionId?: string;
	/** result event subtype (interrupted turns end error_during_execution). */
	resultSubtype?: string;
}

type AnyObj = Record<string, any>;

function joinTextBlocks(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: AnyObj) => c?.type === "text" && typeof c.text === "string")
		.map((c: AnyObj) => c.text)
		.join("");
}

/** Kind-annotated parse — the resident brain's event classifier. */
export function parseStreamEvent(line: string): ParsedStreamEvent {
	let obj: AnyObj;
	try {
		obj = JSON.parse(line);
	} catch {
		return { kind: "other", recognized: false };
	}
	if (obj == null || typeof obj !== "object") {
		return { kind: "other", recognized: false };
	}
	const sessionId =
		typeof obj.session_id === "string" ? obj.session_id : undefined;

	const ev = obj.event;
	if (ev && ev.type === "content_block_delta" && ev.delta) {
		if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
			return {
				kind: "delta",
				recognized: true,
				text: ev.delta.text,
				sessionId,
			};
		}
		// thinking_delta / signature_delta / ... — never yielded, never counts
		// as "the turn produced a delta".
		return { kind: "other", recognized: true, sessionId };
	}

	if (typeof obj.type === "string") {
		switch (obj.type) {
			case "assistant":
				return {
					kind: "assistant-final",
					recognized: true,
					text: joinTextBlocks(obj.message?.content ?? obj.content),
					sessionId,
				};
			case "result":
				return {
					kind: "result",
					recognized: true,
					sessionId,
					...(typeof obj.subtype === "string"
						? { resultSubtype: obj.subtype }
						: {}),
				};
			case "control_response":
			case "control_request":
			case "control_cancel_request":
				return { kind: "control", recognized: true, sessionId };
			case "system":
				return { kind: "system", recognized: true, sessionId };
			default:
				// user echoes / tool results / unknown typed events: recognized
				// stream-json, but nothing the mouth may ever speak.
				return { kind: "other", recognized: true, sessionId };
		}
	}
	return { kind: "other", recognized: false, sessionId };
}

/**
 * Parse a stream-json line (S0.1 spike shape) — LEGACY shape, behavior frozen.
 * Returns:
 *   - recognized=true if the line IS stream-json we understand,
 *   - text: assistant text_delta (empty for non-text stream lines),
 *   - sessionId: captured when present (top-level session_id).
 */
export function parseStreamLine(line: string): {
	recognized: boolean;
	text?: string;
	sessionId?: string;
} {
	let obj: AnyObj;
	try {
		obj = JSON.parse(line);
	} catch {
		return { recognized: false };
	}
	if (obj == null || typeof obj !== "object") return { recognized: false };
	const sessionId =
		typeof obj.session_id === "string" ? obj.session_id : undefined;

	// spike shape: { type:"stream_event", event:{ type:"content_block_delta",
	//   delta:{ type:"text_delta", text } } } — take text_delta only, ignore thinking_delta.
	const ev = obj.event;
	if (ev && ev.type === "content_block_delta" && ev.delta) {
		if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
			return { recognized: true, text: ev.delta.text, sessionId };
		}
		return { recognized: true, text: "", sessionId }; // thinking_delta etc.
	}
	// tolerate assistant message shape (non-partial)
	const content = obj.message?.content ?? obj.content;
	if (Array.isArray(content)) {
		const text = content
			.filter((c: AnyObj) => c?.type === "text" && typeof c.text === "string")
			.map((c: AnyObj) => c.text)
			.join("");
		return { recognized: true, text, sessionId };
	}
	if (typeof obj.type === "string")
		return { recognized: true, text: "", sessionId };
	return { recognized: false, sessionId };
}
