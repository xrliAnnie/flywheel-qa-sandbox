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
			archiveDefaultProvider: async () => 60,
		});
		expect(r).toEqual({ ok: true, threadId: MSG });
	});

	it("FLY-802: prefers an already-resolved archiveMinutes over the provider", async () => {
		let createBody: string | undefined;
		const archiveDefaultProvider = vi.fn(async () => 60);
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			if ((init?.method ?? "GET").toUpperCase() === "POST")
				createBody = typeof init?.body === "string" ? init.body : undefined;
			return res(201, { id: MSG });
		});
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			archiveMinutes: 1440,
			archiveDefaultProvider,
		});
		expect(r).toEqual({ ok: true, threadId: MSG });
		expect(JSON.parse(createBody ?? "{}").auto_archive_duration).toBe(1440);
		expect(archiveDefaultProvider).not.toHaveBeenCalled();
	});

	it("FLY-802: resolves the parent channel default when archiveMinutes is absent", async () => {
		let createBody: string | undefined;
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			createBody = typeof init?.body === "string" ? init.body : undefined;
			return res(201, { id: MSG });
		});

		await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			archiveDefaultProvider: async () => 60,
		});

		expect(JSON.parse(createBody ?? "{}").auto_archive_duration).toBe(60);
	});

	it("FLY-1435: missing or invalid archive configuration refuses to create a silent 4320 thread", async () => {
		const warnings: string[] = [];
		const fetchImpl = vi.fn(async () => res(201, { id: MSG }));

		const missing = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger: { warn: (message) => warnings.push(message) },
		});
		const invalid = await ensureThreadFromMessage(PARENT, "43", "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			archiveMinutes: 30,
			logger: { warn: (message) => warnings.push(message) },
		});

		expect(missing).toEqual({
			ok: false,
			reason: "archive_default_unresolved",
		});
		expect(invalid).toEqual({
			ok: false,
			reason: "archive_default_unresolved",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(warnings).toHaveLength(2);
	});

	it("FLY-1435: a rejecting provider holds instead of creating a silent 4320 thread", async () => {
		const fetchImpl = vi.fn(async () => res(201, { id: MSG }));

		const result = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			archiveDefaultProvider: async () => {
				throw new Error("lookup failed");
			},
			logger: { warn: () => {} },
		});

		expect(result).toEqual({
			ok: false,
			reason: "archive_default_unresolved",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
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
			archiveDefaultProvider: async () => 60,
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
			archiveDefaultProvider: async () => 60,
		});
		expect(r).toEqual({ ok: false, reason: "client_error", status: 400 });
	});

	it("404 → deleted", async () => {
		const fetchImpl = vi.fn(async () => res(404, {}));
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			archiveDefaultProvider: async () => 60,
		});
		expect(r).toEqual({ ok: false, reason: "deleted" });
	});

	it("403 → auth", async () => {
		const fetchImpl = vi.fn(async () => res(403, {}));
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			archiveDefaultProvider: async () => 60,
		});
		expect(r).toEqual({ ok: false, reason: "auth" });
	});

	it("503 → transient", async () => {
		const fetchImpl = vi.fn(async () => res(503, {}));
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			archiveDefaultProvider: async () => 60,
		});
		expect(r).toEqual({ ok: false, reason: "transient" });
	});

	it("network error → transient", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		});
		const r = await ensureThreadFromMessage(PARENT, MSG, "tok", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			archiveDefaultProvider: async () => 60,
		});
		expect(r).toEqual({ ok: false, reason: "transient" });
	});
});
