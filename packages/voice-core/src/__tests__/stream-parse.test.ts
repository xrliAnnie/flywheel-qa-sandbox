/**
 * FLY-1160 §3.0 — shared stream-json parser with event-kind annotation.
 *
 * The resident brain needs to KNOW what kind of event each line is (delta /
 * assistant-final / result / control / system) because the CLI emits BOTH
 * partial text_delta events AND the final complete assistant message for the
 * same turn — yielding both makes TTS speak the whole reply twice (real-machine
 * evidence: FLY-1006 shim S2 round C, dedupeFinalEcho). parseStreamLine (the
 * legacy HeadlessClaudeBrain shape) must keep behaving byte-for-byte — the
 * existing headless-brain tests are the regression sentinel.
 */
import { describe, expect, it } from "vitest";
import { parseStreamEvent, parseStreamLine } from "../brain/stream-parse.js";

const deltaLine = (text: string) =>
	JSON.stringify({
		type: "stream_event",
		session_id: "sess-1",
		event: {
			type: "content_block_delta",
			delta: { type: "text_delta", text },
		},
	});

describe("parseStreamEvent (kind annotation)", () => {
	it("classifies text_delta as kind=delta with text", () => {
		const r = parseStreamEvent(deltaLine("你好"));
		expect(r.kind).toBe("delta");
		expect(r.text).toBe("你好");
		expect(r.recognized).toBe(true);
		expect(r.sessionId).toBe("sess-1");
	});

	it("classifies thinking_delta as kind=other (never yielded, never counts as a delta)", () => {
		const line = JSON.stringify({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				delta: { type: "thinking_delta", thinking: "hmm" },
			},
		});
		const r = parseStreamEvent(line);
		expect(r.kind).toBe("other");
		expect(r.recognized).toBe(true);
	});

	it("classifies the final assistant message as kind=assistant-final with joined text", () => {
		const line = JSON.stringify({
			type: "assistant",
			session_id: "sess-1",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "你最喜欢的" },
					{ type: "text", text: "颜色是青色。" },
				],
			},
		});
		const r = parseStreamEvent(line);
		expect(r.kind).toBe("assistant-final");
		expect(r.text).toBe("你最喜欢的颜色是青色。");
	});

	it("classifies a user message echo as kind=other — founder words must never re-enter the mouth", () => {
		const line = JSON.stringify({
			type: "user",
			message: {
				role: "user",
				content: [{ type: "text", text: "我最喜欢的颜色是青色" }],
			},
		});
		const r = parseStreamEvent(line);
		expect(r.kind).toBe("other");
	});

	it("classifies result events with resultSubtype (interrupt whitelist relies on it)", () => {
		const line = JSON.stringify({
			type: "result",
			subtype: "error_during_execution",
			session_id: "sess-1",
		});
		const r = parseStreamEvent(line);
		expect(r.kind).toBe("result");
		expect(r.resultSubtype).toBe("error_during_execution");
	});

	it("classifies control_response / control_request as kind=control", () => {
		const resp = JSON.stringify({
			type: "control_response",
			response: { subtype: "success", request_id: "req-1" },
		});
		const req = JSON.stringify({
			type: "control_request",
			request_id: "r2",
			request: { subtype: "interrupt" },
		});
		expect(parseStreamEvent(resp).kind).toBe("control");
		expect(parseStreamEvent(req).kind).toBe("control");
	});

	it("classifies system init as kind=system and captures session_id", () => {
		const line = JSON.stringify({
			type: "system",
			subtype: "init",
			session_id: "sess-42",
		});
		const r = parseStreamEvent(line);
		expect(r.kind).toBe("system");
		expect(r.sessionId).toBe("sess-42");
	});

	it("returns kind=other, recognized=false for non-JSON", () => {
		const r = parseStreamEvent("plain text");
		expect(r.kind).toBe("other");
		expect(r.recognized).toBe(false);
	});

	it("tool_use blocks inside an assistant message contribute no text", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", id: "t1", name: "Read", input: {} },
					{ type: "text", text: "看完了。" },
				],
			},
		});
		const r = parseStreamEvent(line);
		expect(r.kind).toBe("assistant-final");
		expect(r.text).toBe("看完了。");
	});
});

describe("parseStreamLine (legacy shape preserved)", () => {
	it("is importable from the shared module with the original shape", () => {
		const r = parseStreamLine(deltaLine("Hi"));
		expect(r).toMatchObject({ recognized: true, text: "Hi" });
	});
});
