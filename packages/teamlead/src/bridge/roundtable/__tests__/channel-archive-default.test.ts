import { afterEach, describe, expect, it, vi } from "vitest";
import {
	makeChannelArchiveDefaultProvider,
	resolveAutoArchiveMinutes,
} from "../channel-archive-default.js";

function response(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("resolveAutoArchiveMinutes", () => {
	it.each([60, 1440, 4320, 10080])(
		"preserves Discord's valid %i-minute value",
		(value) => {
			expect(resolveAutoArchiveMinutes(value)).toBe(value);
		},
	);

	it("returns null instead of a silent 4320 fallback when no safe fallback is explicit", () => {
		expect(resolveAutoArchiveMinutes(null)).toBeNull();
		expect(resolveAutoArchiveMinutes(undefined)).toBeNull();
		expect(resolveAutoArchiveMinutes(30)).toBeNull();
	});

	it("supports a call-site fallback for null and invalid channel values", () => {
		expect(resolveAutoArchiveMinutes(null, 1440)).toBe(1440);
		expect(resolveAutoArchiveMinutes(30, 1440)).toBe(1440);
		expect(resolveAutoArchiveMinutes(Number.NaN, 1440)).toBe(1440);
	});

	it("rejects an invalid call-site fallback instead of silently substituting 4320", () => {
		expect(resolveAutoArchiveMinutes(null, 30)).toBeNull();
	});
});

describe("makeChannelArchiveDefaultProvider", () => {
	it("caches a successful channel read for the TTL, then refreshes", async () => {
		let now = 1_000;
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				response(200, { default_auto_archive_duration: 60 }),
			)
			.mockResolvedValueOnce(
				response(200, { default_auto_archive_duration: 1440 }),
			);
		const provider = makeChannelArchiveDefaultProvider({
			channelId: "parent",
			botToken: "token",
			fetchImpl,
			ttlMs: 100,
			now: () => now,
		});

		expect(await provider()).toBe(60);
		now = 1_099;
		expect(await provider()).toBe(60);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		now = 1_100;
		expect(await provider()).toBe(1440);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("caches Discord's real missing-field shape as an unconfigured default", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response(200, {}));
		const provider = makeChannelArchiveDefaultProvider({
			channelId: "parent",
			botToken: "token",
			fetchImpl,
		});

		expect(await provider()).toBeNull();
		expect(await provider()).toBeNull();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("returns stale data when refresh fails", async () => {
		let now = 1_000;
		const warnings: string[] = [];
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				response(200, { default_auto_archive_duration: 60 }),
			)
			.mockResolvedValueOnce(response(503, {}));
		const provider = makeChannelArchiveDefaultProvider({
			channelId: "parent",
			botToken: "token",
			fetchImpl,
			ttlMs: 100,
			now: () => now,
			logger: { warn: (message) => warnings.push(message) },
		});

		expect(await provider()).toBe(60);
		now = 1_100;
		expect(await provider()).toBe(60);
		expect(warnings).toHaveLength(1);
	});

	it("rejects and warns when no fresh or stale value is available", async () => {
		const warnings: string[] = [];
		const provider = makeChannelArchiveDefaultProvider({
			channelId: "parent",
			botToken: "token",
			fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(503, {})),
			logger: { warn: (message) => warnings.push(message) },
		});

		await expect(provider()).rejects.toThrow("archive default unavailable");
		expect(warnings).toHaveLength(1);
	});

	it("falls through permission failures to the next call-time token", async () => {
		let tokens = ["first", "second"];
		const seenAuth: string[] = [];
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
			const auth = new Headers(init?.headers).get("Authorization") ?? "";
			seenAuth.push(auth);
			return auth === "Bot first"
				? response(403, {})
				: response(200, { default_auto_archive_duration: 60 });
		});
		const provider = makeChannelArchiveDefaultProvider({
			channelId: "parent",
			botToken: () => tokens,
			fetchImpl,
			ttlMs: 0,
		});

		expect(await provider()).toBe(60);
		tokens = ["replacement"];
		await provider();
		expect(seenAuth).toEqual(["Bot first", "Bot second", "Bot replacement"]);
	});

	it("aborts a hung channel read after five seconds and rejects without a stale value", async () => {
		vi.useFakeTimers();
		const warnings: string[] = [];
		const fetchImpl = vi.fn<typeof fetch>(
			async (_url, init) =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		const provider = makeChannelArchiveDefaultProvider({
			channelId: "parent",
			botToken: "token",
			fetchImpl,
			logger: { warn: (message) => warnings.push(message) },
		});

		const pending = expect(provider()).rejects.toThrow(
			"archive default unavailable",
		);
		await vi.advanceTimersByTimeAsync(5_000);
		await pending;
		expect(warnings).toHaveLength(1);
	});
});
