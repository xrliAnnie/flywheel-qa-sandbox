import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compareAccountIdentity,
	fetchProfileIdentity,
	identityDigest,
	identityKey,
} from "../account-heal/account-identity.js";

const TOKEN = "sk-ant-oat01-profile-super-secret";
const PROFILE = {
	account: {
		uuid: "F2CAEDF8-4D28-4E63-A79A-111111111111",
		email: "Annie@Example.COM ",
	},
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("fetchProfileIdentity", () => {
	it("uses the proven OAuth profile contract and returns a normalized identity", async () => {
		const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
			expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
			expect(headers.get("accept")).toBe("application/json");
			return new Response(JSON.stringify(PROFILE), { status: 200 });
		});

		await expect(
			fetchProfileIdentity(TOKEN, {
				endpoint: "https://identity.example.test/api/oauth/profile",
				fetchFn: fetchFn as typeof fetch,
			}),
		).resolves.toEqual({
			email: "annie@example.com",
			uuid: "f2caedf8-4d28-4e63-a79a-111111111111",
		});
		expect(fetchFn).toHaveBeenCalledWith(
			"https://identity.example.test/api/oauth/profile",
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("classifies 401 separately and never exposes token or response text", async () => {
		const fetchFn = vi.fn(
			async () => new Response(`expired ${TOKEN}`, { status: 401 }),
		);
		const result = await fetchProfileIdentity(TOKEN, {
			fetchFn: fetchFn as typeof fetch,
		});
		expect(result).toEqual({ error: "profile_unauthorized" });
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it.each([
		["missing account", {}],
		["missing uuid", { account: { email: "annie@example.com" } }],
		["missing email", { account: { uuid: "u-1" } }],
		["non-string uuid", { account: { uuid: 123, email: "a@b.test" } }],
		["blank email", { account: { uuid: "u-1", email: "   " } }],
	])("classifies malformed profile payloads: %s", async (_label, payload) => {
		const fetchFn = vi.fn(
			async () => new Response(JSON.stringify(payload), { status: 200 }),
		);
		expect(
			await fetchProfileIdentity(TOKEN, { fetchFn: fetchFn as typeof fetch }),
		).toEqual({ error: "profile_malformed" });
	});

	it("classifies invalid JSON, non-401 HTTP errors, and thrown fetches as typed failures", async () => {
		const invalidJson = vi.fn(
			async () => new Response("not-json", { status: 200 }),
		);
		const unavailable = vi.fn(
			async () => new Response(`server echoed ${TOKEN}`, { status: 503 }),
		);
		const thrown = vi.fn(async () => {
			throw new Error(`socket failed while sending ${TOKEN}`);
		});

		expect(
			await fetchProfileIdentity(TOKEN, {
				fetchFn: invalidJson as typeof fetch,
			}),
		).toEqual({ error: "profile_malformed" });
		expect(
			await fetchProfileIdentity(TOKEN, {
				fetchFn: unavailable as typeof fetch,
			}),
		).toEqual({ error: "profile_network" });
		expect(
			await fetchProfileIdentity(TOKEN, { fetchFn: thrown as typeof fetch }),
		).toEqual({ error: "profile_network" });
	});

	it("keeps the 10s-class timeout active until the response body is consumed", async () => {
		vi.useFakeTimers();
		const fetchFn = vi.fn(async () => {
			return {
				ok: true,
				status: 200,
				json: () => new Promise<unknown>(() => undefined),
			} as Response;
		});
		const pending = fetchProfileIdentity(TOKEN, {
			fetchFn: fetchFn as typeof fetch,
			timeoutMs: 25,
		});
		await vi.advanceTimersByTimeAsync(25);
		await expect(pending).resolves.toEqual({ error: "profile_network" });
	});
});

describe("account identity comparison", () => {
	it("prefers uuid when the trusted expected mapping has one", () => {
		expect(
			compareAccountIdentity(
				{ email: "wrong@example.com", uuid: " ABC-123 " },
				{ email: "actual@example.com", uuid: "abc-123" },
			),
		).toBe("match");
		expect(
			compareAccountIdentity(
				{ email: "same@example.com", uuid: "expected" },
				{ email: "same@example.com", uuid: "different" },
			),
		).toBe("mismatch");
	});

	it("falls back to normalized email only when expected uuid is absent", () => {
		expect(
			compareAccountIdentity(
				{ email: " Annie@Example.com " },
				{ email: "annie@example.COM", uuid: "observed-uuid" },
			),
		).toBe("match");
	});

	it("treats a missing trusted expectation as unknown rather than learning from the probe", () => {
		expect(
			compareAccountIdentity(undefined, {
				email: "observed@example.com",
				uuid: "observed-uuid",
			}),
		).toBe("unknown_missing");
	});

	it("uses non-PII keys for comparisons and a stable digest for alert facts", () => {
		expect(identityKey({ email: " Annie@Example.com " })).toBe(
			"email:annie@example.com",
		);
		expect(
			identityKey({ email: "ignored@example.com", uuid: " UUID-1 " }),
		).toBe("uuid:uuid-1");
		const digest = identityDigest({
			email: "ignored@example.com",
			uuid: "UUID-1",
		});
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(digest).not.toContain("ignored@example.com");
	});
});
