import { describe, expect, it, vi } from "vitest";
import { ensureThreadFromMessage } from "../ensure-thread-from-message.js";

function res(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

const PARENT = "roundtable";
const MSG = "42";

describe("ensureThreadFromMessage", () => {
	it("creates the thread (2xx) and returns thread id == message id", async () => {
		const fetchImpl = vi.fn(async () => res(201, { id: MSG }));
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r).toEqual({ ok: true, threadId: MSG });
	});

	it("FLY-802: creates the thread with auto_archive_duration=60 (1h → collapses out of the sidebar)", async () => {
		let createBody: string | undefined;
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			if ((init?.method ?? "GET").toUpperCase() === "POST")
				createBody = typeof init?.body === "string" ? init.body : undefined;
			return res(201, { id: MSG });
		});
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r).toEqual({ ok: true, threadId: MSG });
		expect(JSON.parse(createBody ?? "{}").auto_archive_duration).toBe(60);
	});

	it("already-exists (400/160004) → confirm via GET → ok, no second create", async () => {
		const calls: string[] = [];
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			const method = (init?.method ?? "GET").toUpperCase();
			calls.push(`${method} ${url}`);
			if (method === "POST") return res(400, { code: 160004 });
			// GET /channels/{msgId} confirm
			return res(200, { type: 11, parent_id: PARENT });
		});
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r).toEqual({ ok: true, threadId: MSG });
		expect(calls.filter((c) => c.startsWith("POST")).length).toBe(1);
		expect(
			calls.some((c) => c.startsWith("GET") && c.endsWith(`/${MSG}`)),
		).toBe(true);
	});

	it("already-exists but GET does not confirm parent → client_error", async () => {
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			const method = (init?.method ?? "GET").toUpperCase();
			if (method === "POST") return res(400, { code: 160004 });
			return res(200, { type: 11, parent_id: "some-other-channel" });
		});
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r).toEqual({ ok: false, reason: "client_error", status: 400 });
	});

	it("404 → deleted", async () => {
		const fetchImpl = vi.fn(async () => res(404, {}));
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r).toEqual({ ok: false, reason: "deleted" });
	});

	it("403 → auth", async () => {
		const fetchImpl = vi.fn(async () => res(403, {}));
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r).toEqual({ ok: false, reason: "auth" });
	});

	it("503 → transient", async () => {
		const fetchImpl = vi.fn(async () => res(503, {}));
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r).toEqual({ ok: false, reason: "transient" });
	});

	it("network error → transient", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		});
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r).toEqual({ ok: false, reason: "transient" });
	});
});
