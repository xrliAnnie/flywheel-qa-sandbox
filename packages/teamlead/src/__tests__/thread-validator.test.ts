import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	lookupThreadParent,
	type ThreadValidationDeps,
	validateThreadExists,
} from "../bridge/thread-validator.js";

const mockFetch = vi.fn();
beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

describe("validateThreadExists (GEO-200)", () => {
	let deps: ThreadValidationDeps;

	beforeEach(() => {
		vi.clearAllMocks();
		deps = { markDiscordMissing: vi.fn() };
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns true for valid thread (200)", async () => {
		mockFetch.mockResolvedValue({ status: 200 });

		const result = await validateThreadExists("thread-123", "bot-token", deps);

		expect(result).toBe(true);
		expect(deps.markDiscordMissing).not.toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalledWith(
			"https://discord.com/api/v10/channels/thread-123",
			expect.objectContaining({
				headers: { Authorization: "Bot bot-token" },
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("returns false for deleted thread (404) and calls markDiscordMissing", async () => {
		mockFetch.mockResolvedValue({ status: 404 });

		const result = await validateThreadExists("thread-gone", "bot-token", deps);

		expect(result).toBe(false);
		expect(deps.markDiscordMissing).toHaveBeenCalledWith("thread-gone");
	});

	it("fail-open on 429 (rate limit)", async () => {
		mockFetch.mockResolvedValue({ status: 429 });

		const result = await validateThreadExists("thread-123", "bot-token", deps);

		expect(result).toBe(true);
		expect(deps.markDiscordMissing).not.toHaveBeenCalled();
	});

	it("fail-open on 500 (server error)", async () => {
		mockFetch.mockResolvedValue({ status: 500 });

		const result = await validateThreadExists("thread-123", "bot-token", deps);

		expect(result).toBe(true);
		expect(deps.markDiscordMissing).not.toHaveBeenCalled();
	});

	it("fail-open on network error", async () => {
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		const result = await validateThreadExists("thread-123", "bot-token", deps);

		expect(result).toBe(true);
		expect(deps.markDiscordMissing).not.toHaveBeenCalled();
	});

	it("fail-open on abort/timeout", async () => {
		mockFetch.mockRejectedValue(
			new DOMException("The operation was aborted", "AbortError"),
		);

		const result = await validateThreadExists("thread-123", "bot-token", deps);

		expect(result).toBe(true);
		expect(deps.markDiscordMissing).not.toHaveBeenCalled();
	});
});

describe("lookupThreadParent (FLY-2442)", () => {
	it.each([10, 11, 12])("resolves Discord thread type %s", async (type) => {
		const fetchImpl = vi.fn().mockResolvedValue({
			status: 200,
			ok: true,
			json: async () => ({ type, parent_id: "roundtable" }),
		});

		await expect(
			lookupThreadParent("thread", "bot-token", { fetchImpl }),
		).resolves.toEqual({ state: "resolved", parentId: "roundtable" });
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://discord.com/api/v10/channels/thread",
			expect.objectContaining({
				headers: { Authorization: "Bot bot-token" },
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("rejects a non-thread response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			status: 200,
			ok: true,
			json: async () => ({ type: 0, parent_id: "roundtable" }),
		});
		await expect(
			lookupThreadParent("channel", "bot-token", { fetchImpl }),
		).resolves.toEqual({ state: "not_thread" });
	});

	it.each([
		[404, { state: "absent" }],
		[401, { state: "denied", status: 401 }],
		[403, { state: "denied", status: 403 }],
		[429, { state: "transient", status: 429 }],
		[500, { state: "transient", status: 500 }],
	] as const)("classifies HTTP %s", async (status, expected) => {
		const fetchImpl = vi.fn().mockResolvedValue({ status, ok: false });
		await expect(
			lookupThreadParent("thread", "bot-token", { fetchImpl }),
		).resolves.toEqual(expected);
	});

	it("treats network failures as transient", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
		await expect(
			lookupThreadParent("thread", "bot-token", { fetchImpl }),
		).resolves.toEqual({ state: "transient" });
	});
});
