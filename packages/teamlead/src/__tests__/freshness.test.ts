/**
 * FLY-871 R1/C2 — pool token freshness helper (probe-refresh guard).
 *
 * The incident (2026-07-04): a pooled account's refresh-token FAMILY had been
 * rotated out from under the pool, so the pooled credential was stale. The
 * switch executor wrote that stale token into the machine Keychain → every live
 * session was logged out. The cure: before writing a NON-ACTIVE target to the
 * Keychain, probe-refresh its pooled token (OAuth refresh_token grant). Success
 * → write the rotated credential back to the pool and switch; refusal → DON'T
 * switch (stale), page for a candidate.
 *
 * RED LINES asserted here (all with an INJECTED fetch — ZERO real network):
 *   1. NEVER probe-refresh the ACTIVE account (its live session owns the family)
 *      — throws, 0 fetch calls, pool byte-unchanged.
 *   2. No static-ok pass: a future `expiresAt` does NOT bypass the probe — the
 *      incident class is family-rotation, not access-token expiry.
 *   3. On success the rotated credential is written back to the pool BEFORE the
 *      verdict is returned (ordering) — otherwise the guard itself strands.
 *   4. On refusal / network error / timeout → stale, pool byte-UNCHANGED
 *      (fail-closed: never switch to an unverified credential).
 *   5. The refresh_token / access_token never leaves via any process argv (the
 *      helper reads the file itself; only non-secret names cross the boundary) —
 *      covered by the bash-side contract test; here we assert the fetch BODY.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPoolCredential } from "../account-heal/freshness.js";

let dir: string;
let poolDir: string;

/** A compact (whitespace-free — bash single-token rule) pooled credential. */
function cred(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		claudeAiOauth: {
			accessToken: "sk-ant-oat01-OLD",
			refreshToken: "refresh-OLD",
			expiresAt: 1_000,
			subscriptionType: "max",
			...overrides,
		},
	});
}

function seed(name: string, body = cred()): string {
	const d = join(poolDir, name);
	mkdirSync(d, { recursive: true });
	const f = join(d, ".credentials.json");
	writeFileSync(f, body, { mode: 0o600 });
	return f;
}

/** A fetch that returns a 200 refresh response rotating to new tokens. */
function okFetch(newAccess = "sk-ant-oat01-NEW", newRefresh = "refresh-NEW") {
	return vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					access_token: newAccess,
					refresh_token: newRefresh,
					expires_in: 3600,
					token_type: "Bearer",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly871-freshness-"));
	poolDir = join(dir, "pool");
	mkdirSync(poolDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("verifyPoolCredential — red lines", () => {
	it("RED LINE: refuses to probe-refresh the ACTIVE account (throws, 0 fetch, pool byte-unchanged)", async () => {
		const f = seed("personal");
		const before = readFileSync(f, "utf-8");
		const fetchImpl = okFetch();
		await expect(
			verifyPoolCredential({
				name: "personal",
				activeName: "personal", // name === active
				poolDir,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toThrow(/active/i);
		expect(fetchImpl).toHaveBeenCalledTimes(0); // NEVER hit the network
		expect(readFileSync(f, "utf-8")).toBe(before); // pool untouched
	});

	it("refresh success → rotated credential written back to pool BEFORE the verdict, verdict=refreshed", async () => {
		const f = seed("school");
		const fetchImpl = okFetch("sk-ant-oat01-NEW", "refresh-NEW");
		const verdict = await verifyPoolCredential({
			name: "school",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => 5_000,
		});
		expect(verdict.fresh).toBe("refreshed");
		// The pool file already holds the rotated tokens by the time we get here.
		const after = JSON.parse(readFileSync(f, "utf-8"));
		expect(after.claudeAiOauth.accessToken).toBe("sk-ant-oat01-NEW");
		expect(after.claudeAiOauth.refreshToken).toBe("refresh-NEW");
		expect(after.claudeAiOauth.expiresAt).toBe(5_000 + 3600 * 1000);
		// non-rotated fields preserved
		expect(after.claudeAiOauth.subscriptionType).toBe("max");
		// compact (whitespace-free) — bash kc_write single-token rule
		expect(readFileSync(f, "utf-8")).not.toMatch(/\s/);
		// 0600 preserved
		expect(statSync(f).mode & 0o777).toBe(0o600);
	});

	it("NO static-ok: a FUTURE expiresAt does NOT bypass the probe (family may be dead)", async () => {
		seed("school", cred({ expiresAt: 9_999_999_999_999 })); // far future
		const fetchImpl = okFetch();
		await verifyPoolCredential({
			name: "school",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		// the probe STILL ran despite the future expiry
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("future expiresAt + refresh REFUSED → stale (not a pass), pool byte-unchanged", async () => {
		const f = seed("school", cred({ expiresAt: 9_999_999_999_999 }));
		const before = readFileSync(f, "utf-8");
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
		const verdict = await verifyPoolCredential({
			name: "school",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(verdict.fresh).toBe("stale");
		expect(readFileSync(f, "utf-8")).toBe(before);
	});

	it("network error → stale (fail-closed), pool byte-unchanged", async () => {
		const f = seed("school");
		const before = readFileSync(f, "utf-8");
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		const verdict = await verifyPoolCredential({
			name: "school",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(verdict.fresh).toBe("stale");
		expect(readFileSync(f, "utf-8")).toBe(before);
	});

	it("timeout (fetch respects AbortSignal) → stale", async () => {
		seed("school");
		// A fetch that rejects with an AbortError once the signal fires.
		const fetchImpl = vi.fn(
			(_url: string, init?: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
					);
				}),
		);
		const verdict = await verifyPoolCredential({
			name: "school",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			timeoutMs: 20,
		});
		expect(verdict.fresh).toBe("stale");
	});

	it("missing pool file → stale, no crash, no fetch", async () => {
		const fetchImpl = okFetch();
		const verdict = await verifyPoolCredential({
			name: "ghost",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(verdict.fresh).toBe("stale");
		expect(fetchImpl).toHaveBeenCalledTimes(0);
	});

	it("credential without a refreshToken → stale, no fetch", async () => {
		seed("school", JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
		const fetchImpl = okFetch();
		const verdict = await verifyPoolCredential({
			name: "school",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(verdict.fresh).toBe("stale");
		expect(fetchImpl).toHaveBeenCalledTimes(0);
	});

	it("refresh response missing a new refresh_token → stale (invalid response), pool unchanged", async () => {
		const f = seed("school");
		const before = readFileSync(f, "utf-8");
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ access_token: "a", expires_in: 3600 }), {
					status: 200,
				}),
		);
		const verdict = await verifyPoolCredential({
			name: "school",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(verdict.fresh).toBe("stale");
		expect(readFileSync(f, "utf-8")).toBe(before);
	});

	it("sends the OAuth refresh grant with the pooled refresh_token + client_id in the BODY (never argv)", async () => {
		seed("school", cred({ refreshToken: "refresh-SECRET" }));
		let captured: { url: string; body: unknown } | null = null;
		const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
			captured = { url, body: JSON.parse(String(init?.body ?? "{}")) };
			return new Response(
				JSON.stringify({
					access_token: "n",
					refresh_token: "r",
					expires_in: 1,
				}),
				{ status: 200 },
			);
		});
		await verifyPoolCredential({
			name: "school",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			refreshEndpoint: "https://example.test/v1/oauth/token",
			clientId: "client-abc",
		});
		expect(captured).not.toBeNull();
		const c = captured as unknown as {
			url: string;
			body: Record<string, unknown>;
		};
		expect(c.url).toBe("https://example.test/v1/oauth/token");
		expect(c.body.grant_type).toBe("refresh_token");
		expect(c.body.refresh_token).toBe("refresh-SECRET");
		expect(c.body.client_id).toBe("client-abc");
	});

	it("atomic write-back leaves NO temp files behind", async () => {
		seed("school");
		await verifyPoolCredential({
			name: "school",
			activeName: "personal",
			poolDir,
			fetchImpl: okFetch() as unknown as typeof fetch,
		});
		const leftovers = readdirSync(join(poolDir, "school")).filter(
			(n) => n !== ".credentials.json",
		);
		expect(leftovers).toEqual([]);
		expect(existsSync(join(poolDir, "school", ".credentials.json"))).toBe(true);
	});

	it("refuses a symlinked credential file → stale, no fetch", async () => {
		// A symlinked pool credential is a tamper vector — refuse fail-closed.
		const realDir = join(poolDir, "real");
		mkdirSync(realDir, { recursive: true });
		writeFileSync(join(realDir, ".credentials.json"), cred(), { mode: 0o600 });
		const evilDir = join(poolDir, "evil");
		mkdirSync(evilDir, { recursive: true });
		symlinkSync(
			join(realDir, ".credentials.json"),
			join(evilDir, ".credentials.json"),
		);
		const fetchImpl = okFetch();
		const verdict = await verifyPoolCredential({
			name: "evil",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(verdict.fresh).toBe("stale");
		expect(fetchImpl).toHaveBeenCalledTimes(0);
	});

	// Codex R1 MED — a valid refresh MUST carry a finite positive expires_in.
	it("MISSING expires_in in the refresh response → stale, pool byte-unchanged", async () => {
		const f = seed("school");
		const before = readFileSync(f, "utf-8");
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ access_token: "n", refresh_token: "r" }), // no expires_in
					{ status: 200 },
				),
		);
		const verdict = await verifyPoolCredential({
			name: "school",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(verdict.fresh).toBe("stale");
		expect(readFileSync(f, "utf-8")).toBe(before);
	});

	it("NON-POSITIVE expires_in → stale (never write an already-expired credential)", async () => {
		const f = seed("school");
		const before = readFileSync(f, "utf-8");
		for (const bad of [0, -1, -3600]) {
			const fetchImpl = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "n",
							refresh_token: "r",
							expires_in: bad,
						}),
						{ status: 200 },
					),
			);
			const verdict = await verifyPoolCredential({
				name: "school",
				activeName: "personal",
				poolDir,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			});
			expect(verdict.fresh, `expires_in=${bad}`).toBe("stale");
			expect(readFileSync(f, "utf-8"), `expires_in=${bad}`).toBe(before);
		}
	});

	// Codex R1 HIGH — the timeout must bound the BODY read too. A response that
	// resolves headers (200) but stalls the body must abort → stale, not hang
	// (a hang inside bash `use` holds claude-accounts.lock past its 120s stale
	// window, letting another switch interleave).
	it("HIGH: a hung response BODY is bounded by the timeout (abort → stale, pool unchanged)", async () => {
		const f = seed("school");
		const before = readFileSync(f, "utf-8");
		const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
			const signal = init?.signal;
			// headers resolve immediately; json() never settles until the signal aborts
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () =>
					new Promise((_res, rej) => {
						signal?.addEventListener("abort", () =>
							rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
						);
					}),
			} as unknown as Response);
		});
		const verdict = await verifyPoolCredential({
			name: "school",
			activeName: "personal",
			poolDir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			timeoutMs: 20,
		});
		expect(verdict.fresh).toBe("stale");
		expect(readFileSync(f, "utf-8")).toBe(before);
	});
});
