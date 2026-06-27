/**
 * FLY-292: archiveChatThread must be deterministic — timeout + bounded retry on
 * transient Discord failures, post-archive verification, 404 → markDiscordMissing.
 * removeUserFromChatThread must not be able to hang the awaited finalization chain.
 */
import { describe, expect, it, vi } from "vitest";
import {
	addThreadMember,
	archiveChatThread,
	pinThreadMessage,
	removeUserFromChatThread,
} from "../bridge/chat-thread-utils.js";

const noSleep = async () => {};

function jsonResponse(
	status: number,
	body: unknown,
	headers?: Record<string, string>,
): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...(headers ?? {}) },
	});
}

/** A fetch impl that never resolves until its AbortSignal fires. */
function hangingFetch() {
	return vi.fn(
		(_url: string, init: { signal?: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			}),
	) as unknown as typeof fetch;
}

describe("archiveChatThread", () => {
	it("archives on first 2xx (single attempt, PATCH archived:true)", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, { thread_metadata: { archived: true } }),
		);
		const res = await archiveChatThread("t1", "bot", {
			fetchImpl,
			sleepImpl: noSleep,
		});
		expect(res).toMatchObject({ archived: true, attempts: 1, reason: "ok" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const init = fetchImpl.mock.calls[0][1] as RequestInit;
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(init.body as string)).toEqual({ archived: true });
	});

	it("retries on 429 honoring Retry-After, then succeeds", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(429, { message: "rate" }, { "retry-after": "0" }),
			)
			.mockResolvedValueOnce(
				jsonResponse(200, { thread_metadata: { archived: true } }),
			);
		const sleepImpl = vi.fn(noSleep);
		const res = await archiveChatThread("t1", "bot", { fetchImpl, sleepImpl });
		expect(res).toMatchObject({ archived: true, attempts: 2, reason: "ok" });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleepImpl).toHaveBeenCalledTimes(1);
		expect(sleepImpl).toHaveBeenCalledWith(0); // honored Retry-After: 0s
	});

	it("retries on 5xx then gives up after maxAttempts (reason=exhausted)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(503, "nope"));
		const res = await archiveChatThread("t1", "bot", {
			fetchImpl,
			sleepImpl: noSleep,
			maxAttempts: 3,
		});
		expect(res).toMatchObject({
			archived: false,
			attempts: 3,
			status: 503,
			reason: "exhausted",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("marks thread missing on 404 and does not retry (GEO-200)", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(404, { message: "Unknown Channel" }),
		);
		const markDiscordMissing = vi.fn();
		const res = await archiveChatThread("gone", "bot", {
			fetchImpl,
			sleepImpl: noSleep,
			markDiscordMissing,
		});
		expect(res).toMatchObject({
			archived: false,
			status: 404,
			reason: "missing",
			attempts: 1,
		});
		expect(markDiscordMissing).toHaveBeenCalledTimes(1);
		expect(markDiscordMissing).toHaveBeenCalledWith("gone");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("does not retry on 401 unauthorized", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(401, "bad token"));
		const res = await archiveChatThread("t1", "bot", {
			fetchImpl,
			sleepImpl: noSleep,
		});
		expect(res).toMatchObject({
			archived: false,
			status: 401,
			reason: "unauthorized",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("retries when 2xx body reports archived:false (defensive verify)", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(200, { thread_metadata: { archived: false } }),
			)
			.mockResolvedValueOnce(
				jsonResponse(200, { thread_metadata: { archived: true } }),
			);
		const res = await archiveChatThread("t1", "bot", {
			fetchImpl,
			sleepImpl: noSleep,
		});
		expect(res).toMatchObject({ archived: true, attempts: 2, reason: "ok" });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("treats 2xx with no archived field as success (lenient verify, byte-compat)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
		const res = await archiveChatThread("t1", "bot", {
			fetchImpl,
			sleepImpl: noSleep,
		});
		expect(res).toMatchObject({ archived: true, attempts: 1, reason: "ok" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("retries on network error then gives up (reason=error)", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNRESET");
		});
		const res = await archiveChatThread("t1", "bot", {
			fetchImpl,
			sleepImpl: noSleep,
			maxAttempts: 2,
		});
		expect(res).toMatchObject({
			archived: false,
			reason: "error",
			attempts: 2,
		});
		expect(res.error).toContain("ECONNRESET");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("aborts a hung request via timeout (AbortController wired)", async () => {
		const fetchImpl = hangingFetch();
		const res = await archiveChatThread("t1", "bot", {
			fetchImpl,
			sleepImpl: noSleep,
			maxAttempts: 1,
			timeoutMs: 5,
		});
		expect(res.archived).toBe(false);
		expect(res.reason).toBe("error");
	});
});

describe("removeUserFromChatThread", () => {
	it("DELETEs the member (happy path, no throw)", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		await expect(
			removeUserFromChatThread("t1", "u1", "bot", { fetchImpl }),
		).resolves.toBeUndefined();
		const init = fetchImpl.mock.calls[0][1] as RequestInit;
		expect(init.method).toBe("DELETE");
	});

	it("ignores 404 (already gone)", async () => {
		const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
		await expect(
			removeUserFromChatThread("t1", "u1", "bot", { fetchImpl }),
		).resolves.toBeUndefined();
	});

	it("never throws on network error", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("boom");
		});
		await expect(
			removeUserFromChatThread("t1", "u1", "bot", { fetchImpl }),
		).resolves.toBeUndefined();
	});

	it("times out a hung request without throwing (AbortController wired)", async () => {
		const fetchImpl = hangingFetch();
		await expect(
			removeUserFromChatThread("t1", "u1", "bot", {
				fetchImpl,
				timeoutMs: 5,
			}),
		).resolves.toBeUndefined();
	});
});

describe("addThreadMember (FLY-576: classified outcome)", () => {
	it("returns 'added' on 2xx (204 no-content)", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		await expect(
			addThreadMember("t1", "u1", "bot", { fetchImpl }),
		).resolves.toBe("added");
	});

	it("returns 'permanent' on 403 (missing perms — retry won't help)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(403, { message: "no" }));
		await expect(
			addThreadMember("t1", "u1", "bot", { fetchImpl }),
		).resolves.toBe("permanent");
	});

	it("returns 'permanent' on 404 (thread/user gone)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(404, {}));
		await expect(
			addThreadMember("t1", "u1", "bot", { fetchImpl }),
		).resolves.toBe("permanent");
	});

	it("returns 'transient' on 429 (rate limited — retryable)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(429, {}));
		await expect(
			addThreadMember("t1", "u1", "bot", { fetchImpl }),
		).resolves.toBe("transient");
	});

	it("returns 'transient' on 5xx (retryable)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
		await expect(
			addThreadMember("t1", "u1", "bot", { fetchImpl }),
		).resolves.toBe("transient");
	});

	it("returns 'transient' on 408 Request Timeout (retryable)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(408, {}));
		await expect(
			addThreadMember("t1", "u1", "bot", { fetchImpl }),
		).resolves.toBe("transient");
	});

	it("returns 'transient' on a network error (never throws)", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("boom");
		});
		await expect(
			addThreadMember("t1", "u1", "bot", { fetchImpl }),
		).resolves.toBe("transient");
	});

	it("returns 'transient' on a hung request (AbortController timeout)", async () => {
		const fetchImpl = hangingFetch();
		await expect(
			addThreadMember("t1", "u1", "bot", { fetchImpl, timeoutMs: 5 }),
		).resolves.toBe("transient");
	});
});

describe("pinThreadMessage (FLY-560 Feature C)", () => {
	it("targets the new Message-resource pin endpoint and returns pinned on 204", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const res = await pinThreadMessage("thread1", "msg1", "bot", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(res.outcome).toBe("pinned");
		const url = (fetchImpl.mock.calls[0] as unknown[])[0] as string;
		expect(url).toBe(
			"https://discord.com/api/v10/channels/thread1/messages/pins/msg1",
		);
		const init = (fetchImpl.mock.calls[0] as unknown[])[1] as {
			method: string;
		};
		expect(init.method).toBe("PUT");
	});

	it("returns forbidden on 403 (missing PIN_MESSAGES)", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ code: 50013 }), { status: 403 }),
		);
		const res = await pinThreadMessage("t", "m", "bot", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(res).toEqual({ outcome: "forbidden", status: 403 });
	});

	it("returns missing on 404 (message deleted)", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
		const res = await pinThreadMessage("t", "m", "bot", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(res).toEqual({ outcome: "missing", status: 404 });
	});

	it("returns error on 5xx", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
		const res = await pinThreadMessage("t", "m", "bot", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(res.outcome).toBe("error");
	});

	it("returns error (never throws) on network failure", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNRESET");
		});
		const res = await pinThreadMessage("t", "m", "bot", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(res.outcome).toBe("error");
	});
});
