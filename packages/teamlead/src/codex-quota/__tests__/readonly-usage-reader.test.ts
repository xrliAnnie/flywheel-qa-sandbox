import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifyCodexAuth } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { codexInstallAccountKey } from "flywheel-claude-runner/bin/codex-account-install.mjs";
import { describe, expect, it, vi } from "vitest";
import { readCodexReadonlyUsage } from "../readonly-usage-reader.js";

const NOW = Date.parse("2026-09-23T00:00:00.000Z");
const registry = {
	version: 1 as const,
	primary: "personal" as const,
	profiles: [
		{
			name: "personal" as const,
			email: "personal@example.test",
			role: "primary" as const,
		},
	],
};

function jwt(payload: Record<string, unknown>): string {
	return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
}

function auth(account = "personal") {
	return JSON.stringify({
		tokens: {
			access_token: "secret-access-token",
			id_token: jwt({
				email: `${account}@example.test`,
				"https://api.openai.com/auth": {
					chatgpt_account_id: account,
					chatgpt_plan_type: "prolite",
				},
			}),
		},
	});
}

const accountKey = (raw: string) =>
	codexInstallAccountKey(identifyCodexAuth(raw, registry));

describe("FLY-2807 — in-use Codex readonly usage reader", () => {
	it("maps WHAM usage without writing auth or following redirects", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2807-wham-"));
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, auth(), { mode: 0o600 });
		const before = readFileSync(authPath, "utf8");
		const fetchFn = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				expect(init?.method).toBe("GET");
				expect(init?.redirect).toBe("error");
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer secret-access-token",
				);
				expect(
					(init?.headers as Record<string, string>)["ChatGPT-Account-Id"],
				).toBe("personal");
				return new Response(
					JSON.stringify({
						plan_type: "prolite",
						rate_limit: {
							primary_window: {
								used_percent: 10,
								limit_window_seconds: 18_000,
								reset_at: Math.floor(NOW / 1000) + 3_600,
							},
							secondary_window: {
								used_percent: 100,
								limit_window_seconds: 604_800,
								reset_at: Math.floor(NOW / 1000) + 86_400,
							},
						},
						credits: { has_credits: false, unlimited: false, balance: "0" },
						reset_credit_count: 1,
					}),
					{ status: 200 },
				);
			},
		);

		const result = await readCodexReadonlyUsage({
			authPath,
			registry,
			expectedAccountKey: accountKey(auth()),
			now: () => NOW,
			fetchFn: fetchFn as typeof fetch,
			endpoint: "https://chatgpt.com/backend-api/wham/usage",
		});

		expect(result).toEqual({
			ok: {
				observedAt: "2026-09-23T00:00:00.000Z",
				planType: "prolite",
				fiveH: {
					usedPercent: 10,
					windowMinutes: 300,
					resetAt: "2026-09-23T01:00:00.000Z",
				},
				weekly: {
					usedPercent: 100,
					windowMinutes: 10080,
					resetAt: "2026-09-24T00:00:00.000Z",
				},
				credits: {
					known: true,
					hasCredits: false,
					unlimited: false,
					balance: "0",
				},
				resetCredits: {
					known: true,
					value: "1",
					availableCount: 1,
					credits: null,
				},
				unclassifiedWindows: 0,
			},
		});
		expect(readFileSync(authPath, "utf8")).toBe(before);
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("fails closed on identity mismatch before sending a bearer token", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2807-wham-"));
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, auth());
		const fetchFn = vi.fn();

		expect(
			await readCodexReadonlyUsage({
				authPath,
				registry,
				expectedAccountKey: accountKey(auth("other")),
				fetchFn: fetchFn as typeof fetch,
			}),
		).toEqual({ error: "identity_mismatch" });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("refuses an alternate production origin without an injected transport", async () => {
		await expect(
			readCodexReadonlyUsage({
				authPath: "/not-read-before-origin-check",
				registry,
				expectedAccountKey: "personal@example.test",
				endpoint: "https://attacker.example.test/usage",
			}),
		).rejects.toThrow("codex_readonly_test_origin_requires_fetch_injection");
	});

	it.each([
		[401, "unauthorized"],
		[403, "forbidden"],
	] as const)(
		"maps HTTP %s to %s without response leakage",
		async (status, error) => {
			const dir = mkdtempSync(join(tmpdir(), "fly2807-wham-"));
			const authPath = join(dir, "auth.json");
			writeFileSync(authPath, auth());
			expect(
				await readCodexReadonlyUsage({
					authPath,
					registry,
					expectedAccountKey: accountKey(auth()),
					fetchFn: (async () =>
						new Response("secret", { status })) as typeof fetch,
				}),
			).toEqual({ error });
		},
	);

	it("maps malformed and timed-out responses to safe errors", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2807-wham-"));
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, auth());
		const base = {
			authPath,
			registry,
			expectedAccountKey: accountKey(auth()),
		};
		expect(
			await readCodexReadonlyUsage({
				...base,
				fetchFn: (async () =>
					new Response(JSON.stringify({ rate_limit: {} }), {
						status: 200,
					})) as typeof fetch,
			}),
		).toEqual({ error: "malformed" });

		expect(
			await readCodexReadonlyUsage({
				...base,
				timeoutMs: 1,
				fetchFn: ((_input, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(new Error("aborted")),
							{ once: true },
						);
					})) as typeof fetch,
			}),
		).toEqual({ error: "network" });
	});
});
