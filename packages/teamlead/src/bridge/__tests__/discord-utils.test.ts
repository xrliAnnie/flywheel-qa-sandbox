/**
 * FLY-162 P2: Unit tests for postDiscordMessageToChannel helper.
 *
 * Covers: single-chunk happy / multi-chunk split / partial fail envelope
 * (failedChunkIndex + remainingText) / fail-fast (no retry) / allowed_mentions
 * assertion on every POST body / replyTo passthrough / error shapes.
 */

import { describe, expect, it, vi } from "vitest";
import {
	editDiscordMessageInChannel,
	MAX_DISCORD_MESSAGE_LENGTH,
	postDiscordMessageToChannel,
	sendTypingToChannel,
	splitDiscordMessage,
} from "../discord-utils.js";

/** Build a Response-like object the helper consumes. */
function okResponse(body: object): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function errResponse(status: number, body: object | string): Response {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new Response(text, {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("postDiscordMessageToChannel (FLY-162 P2)", () => {
	it("single chunk: returns messageIds + posts allowed_mentions: { parse: [] }", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(okResponse({ id: "msg-1" }));
		const result = await postDiscordMessageToChannel(
			"thread-aaa",
			"hello world",
			"bot-token",
			{ origin: "lead_authored" },
			fetchMock as unknown as typeof fetch,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.messageIds).toEqual(["msg-1"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = fetchMock.mock.calls[0];
		expect(call[0]).toBe(
			"https://discord.com/api/v10/channels/thread-aaa/messages",
		);
		const init = call[1] as RequestInit;
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bot bot-token");
		expect(headers["Content-Type"]).toBe("application/json");
		const body = JSON.parse(init.body as string);
		expect(body.content).toBe("hello world");
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});

	it("multi-chunk split: all chunks sent, in order, each with allowed_mentions", async () => {
		// Build text > MAX_DISCORD_MESSAGE_LENGTH so splitter produces ≥2 chunks
		const longText = `${"x".repeat(MAX_DISCORD_MESSAGE_LENGTH)}\n${"y".repeat(
			500,
		)}`;
		const expectedChunks = splitDiscordMessage(longText);
		expect(expectedChunks.length).toBeGreaterThanOrEqual(2);

		const fetchMock = vi.fn();
		for (let i = 0; i < expectedChunks.length; i++) {
			fetchMock.mockResolvedValueOnce(okResponse({ id: `msg-${i}` }));
		}

		const result = await postDiscordMessageToChannel(
			"thread-bbb",
			longText,
			"bot-token",
			{ origin: "lead_authored" },
			fetchMock as unknown as typeof fetch,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.messageIds).toHaveLength(expectedChunks.length);

		for (let i = 0; i < expectedChunks.length; i++) {
			const body = JSON.parse(
				(fetchMock.mock.calls[i][1] as RequestInit).body as string,
			);
			expect(body.content).toBe(expectedChunks[i]);
			expect(body.allowed_mentions).toEqual({ parse: [] });
		}
	});

	it("replyTo: includes message_reference with the given message_id", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(okResponse({ id: "msg-r1" }));
		await postDiscordMessageToChannel(
			"thread-ccc",
			"reply text",
			"bot-token",
			{ origin: "lead_authored", replyTo: "orig-msg-id" },
			fetchMock as unknown as typeof fetch,
		);
		const body = JSON.parse(
			(fetchMock.mock.calls[0][1] as RequestInit).body as string,
		);
		expect(body.message_reference).toEqual({ message_id: "orig-msg-id" });
		// replyTo only attached to the FIRST chunk per Discord behavior
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});

	it("fail-fast on first chunk: returns partial envelope with chunksSent=0, failedChunkIndex=0, remainingText=full", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(errResponse(500, "internal error"));

		const result = await postDiscordMessageToChannel(
			"thread-ddd",
			"only one chunk",
			"bot-token",
			{ origin: "lead_authored" },
			fetchMock as unknown as typeof fetch,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.chunksSent).toBe(0);
		expect(result.chunksTotal).toBe(1);
		expect(result.failedChunkIndex).toBe(0);
		expect(result.messageIds).toEqual([]);
		expect(result.remainingText).toBe("only one chunk");
		expect(result.error).toMatch(/Discord 500/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("fail-fast mid-stream: stops after failed chunk, returns remainingText = unsent chunks joined", async () => {
		const longText = `${"x".repeat(MAX_DISCORD_MESSAGE_LENGTH)}\n${"y".repeat(
			MAX_DISCORD_MESSAGE_LENGTH,
		)}\n${"z".repeat(500)}`;
		const expectedChunks = splitDiscordMessage(longText);
		expect(expectedChunks.length).toBe(3);

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(okResponse({ id: "msg-0" }))
			.mockResolvedValueOnce(errResponse(429, { message: "rate limited" }));
		// 3rd chunk POST should NOT happen — fail-fast.

		const result = await postDiscordMessageToChannel(
			"thread-eee",
			longText,
			"bot-token",
			{ origin: "lead_authored" },
			fetchMock as unknown as typeof fetch,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.chunksSent).toBe(1);
		expect(result.chunksTotal).toBe(3);
		expect(result.failedChunkIndex).toBe(1);
		expect(result.messageIds).toEqual(["msg-0"]);
		// remainingText = chunks[1] + "\n" + chunks[2] (joined with newline; trim applied by splitter)
		expect(result.remainingText).toBe(
			`${expectedChunks[1]}\n${expectedChunks[2]}`,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("network throw on POST: returns partial envelope with error message", async () => {
		const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
		const result = await postDiscordMessageToChannel(
			"thread-fff",
			"text",
			"bot-token",
			{ origin: "lead_authored" },
			fetchMock as unknown as typeof fetch,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.error).toMatch(/ECONNREFUSED/);
		expect(result.chunksSent).toBe(0);
		expect(result.failedChunkIndex).toBe(0);
		expect(result.remainingText).toBe("text");
	});

	it("Discord returns ok but no id: treated as failure with chunksSent unchanged", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(okResponse({})); // no id
		const result = await postDiscordMessageToChannel(
			"thread-ggg",
			"text",
			"bot-token",
			{ origin: "lead_authored" },
			fetchMock as unknown as typeof fetch,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.error).toMatch(/missing message id/i);
	});

	it("marks every automation chunk while preserving first-chunk reply metadata", async () => {
		const longText = `${"x".repeat(MAX_DISCORD_MESSAGE_LENGTH)}\n${"y".repeat(
			500,
		)}`;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(okResponse({ id: "auto-1" }))
			.mockResolvedValueOnce(okResponse({ id: "auto-2" }));

		await postDiscordMessageToChannel(
			"thread-auto",
			longText,
			"bot-token",
			{ origin: "automation", replyTo: "source-1" },
			fetchMock as unknown as typeof fetch,
		);

		const bodies = fetchMock.mock.calls.map((call) =>
			JSON.parse((call[1] as RequestInit).body as string),
		);
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(body.content).toMatch(/^🤖\[自动\] /);
			expect(body.allowed_mentions).toEqual({ parse: [] });
		}
		expect(bodies[0].message_reference).toEqual({ message_id: "source-1" });
		expect(bodies[1].message_reference).toBeUndefined();
	});

	it("marks automated edits idempotently", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await editDiscordMessageInChannel(
			"thread-auto",
			"message-auto",
			"🤖[自动] phase update",
			"bot-token",
			{ origin: "automation" },
			fetchMock as unknown as typeof fetch,
		);
		const body = JSON.parse(
			(fetchMock.mock.calls[0][1] as RequestInit).body as string,
		);
		expect(body.content).toBe("🤖[自动] phase update");
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});
});

describe("sendTypingToChannel (FLY-404)", () => {
	it("POSTs to /channels/{id}/typing as a bot, body-less, returns ok", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		const res = await sendTypingToChannel(
			"chan-1",
			"bot-token",
			fetchMock as unknown as typeof fetch,
		);
		expect(res.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = fetchMock.mock.calls[0];
		expect(call[0]).toBe("https://discord.com/api/v10/channels/chan-1/typing");
		const init = call[1] as RequestInit;
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bot bot-token");
		// Typing endpoint takes NO body (no content → cannot echo-storm).
		expect(init.body).toBeUndefined();
	});

	it("non-2xx response: returns { ok: false } with the status — never throws", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
		const res = await sendTypingToChannel(
			"chan-2",
			"bot-token",
			fetchMock as unknown as typeof fetch,
		);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/Discord 403/);
	});

	it("network throw: returns { ok: false } with the error — never throws", async () => {
		const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
		const res = await sendTypingToChannel(
			"chan-3",
			"bot-token",
			fetchMock as unknown as typeof fetch,
		);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/ECONNREFUSED/);
	});
});
