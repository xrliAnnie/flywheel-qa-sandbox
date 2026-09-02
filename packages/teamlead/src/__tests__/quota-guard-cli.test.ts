import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileIdentityResult } from "../account-heal/account-identity.js";
import {
	type AccountStore,
	readStore,
	writeStore,
} from "../account-heal/account-store.js";
import type { AccountsLock } from "../account-heal/accounts-lock.js";
import type { LeaseProof } from "../account-heal/mkdir-lock.js";
import { runQuotaGuardCli } from "../account-heal/quota-guard-cli.js";
import type { AccountUsageResult } from "../account-heal/quota-usage-api.js";

const NOW = Date.parse("2026-07-14T20:00:00Z");
const FIVE_RESET = "2026-07-14T23:00:00.000Z";
const WEEK_RESET = "2026-07-21T14:00:00.000Z";
const TOKEN = "secret-token-must-never-leak";

function writePoolCredential(name: string, token: string): void {
	mkdirSync(join(poolDir, name), { recursive: true });
	writeFileSync(
		join(poolDir, name, ".credentials.json"),
		JSON.stringify({
			claudeAiOauth: {
				accessToken: token,
				refreshToken: `refresh-${name}`,
				expiresAt: NOW + 3_600_000,
			},
		}),
		{ mode: 0o600 },
	);
}

function usage(
	fiveHPct: number,
	sevenDPct: number,
	// `null` means the window has not opened yet (FLY-1366), so default only on
	// `undefined` — `??` would swap an explicit null back to a timestamp.
	resets: { five?: string | null; seven?: string | null } = {},
): AccountUsageResult {
	const five = resets.five === undefined ? FIVE_RESET : resets.five;
	const seven = resets.seven === undefined ? WEEK_RESET : resets.seven;
	return {
		ok: {
			raw: {
				five_hour: { utilization: fiveHPct, resets_at: five },
				seven_day: { utilization: sevenDPct, resets_at: seven },
			},
			fiveH: { pct: fiveHPct, resetsAt: five },
			sevenD: { pct: sevenDPct, resetsAt: seven },
		},
	};
}

function initialStore(): AccountStore {
	return {
		generation: 7,
		activeAccount: "shopping",
		accounts: [
			{ name: "business", quotaExhaustedUntil: null, weeklyResetAt: null },
			{
				name: "shopping",
				quotaExhaustedUntil: null,
				weeklyResetAt: WEEK_RESET,
				lastObservedAt: "2026-07-14T19:54:00Z",
				observedFiveHPct: 12,
				observedSevenDPct: 41,
			},
			{
				name: "school",
				quotaExhaustedUntil: "2026-07-14T22:00:00Z",
				weeklyResetAt: WEEK_RESET,
				lastObservedAt: "2026-07-14T19:58:00Z",
				observedFiveHPct: 10,
				observedSevenDPct: 20,
			},
			{
				name: "personal",
				quotaExhaustedUntil: null,
				weeklyResetAt: WEEK_RESET,
				lastObservedAt: "2026-07-14T19:59:00Z",
				observedFiveHPct: 1,
				observedSevenDPct: 2,
				authExpired: true,
			},
		],
	};
}

let dir: string;
let poolDir: string;
let storePath: string;
let output: string[];

const lease: LeaseProof = {
	lockPath: "/tmp/fly1252-identity.lock",
	markerPath: "/tmp/fly1252-identity.lock/holder.1.token",
	ownershipToken: "owner-token",
};

const immediateAccountsLock: AccountsLock = async (_path, fn) => ({
	kind: "ok",
	value: await fn(lease),
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1252-guard-"));
	poolDir = join(dir, "pool");
	storePath = join(dir, "claude-accounts.json");
	writePoolCredential("business", TOKEN);
	writeStore(initialStore(), storePath);
	output = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(
	result: AccountUsageResult,
	overrides: Parameters<typeof runQuotaGuardCli>[1] = {},
): Promise<number> {
	return runQuotaGuardCli(
		["check", "--name", "business", "--pool", poolDir, "--store", storePath],
		{
			now: () => NOW,
			fetchUsage: async () => result,
			log: (message) => output.push(message),
			...overrides,
		},
	);
}

describe("runQuotaGuardCli", () => {
	describe("P7 identity commands", () => {
		function fetchIdentity(
			result: ProfileIdentityResult,
		): (token: string) => Promise<ProfileIdentityResult> {
			return vi.fn(async (token: string) => {
				expect(token).toBe(TOKEN);
				return result;
			});
		}

		function trustIdentity(
			name: string,
			identity: {
				email: string;
				uuid?: string;
			},
		): void {
			const current = readStore(storePath);
			const account = current.accounts.find((entry) => entry.name === name);
			if (!account) throw new Error(`fixture missing ${name}`);
			account.identity = {
				...identity,
				setAt: "2026-07-14T19:00:00.000Z",
			};
			writeStore(current, storePath);
		}

		function trustBusinessIdentity(identity: {
			email: string;
			uuid?: string;
		}): void {
			trustIdentity("business", identity);
		}

		it("identity-verify consumes the token from stdin and returns 0 on a uuid match", async () => {
			trustBusinessIdentity({
				email: "wrong@example.com",
				uuid: "expected-uuid",
			});
			const probe = fetchIdentity({
				email: "actual@example.com",
				uuid: "EXPECTED-UUID",
			});
			const code = await runQuotaGuardCli(
				["identity-verify", "--name", "business", "--store", storePath],
				{
					readStdin: () => `${TOKEN}\n`,
					fetchIdentity: probe,
					log: (message) => output.push(message),
				},
			);
			expect(code).toBe(0);
			expect(probe).toHaveBeenCalledOnce();
			expect(output.join("\n")).not.toContain(TOKEN);
		});

		it.each([
			{
				label: "positive mismatch",
				result: {
					email: "other@example.com",
					uuid: "other-uuid",
				} as ProfileIdentityResult,
				exit: 34,
			},
			{
				label: "network unknown",
				result: { error: "profile_network" } as ProfileIdentityResult,
				exit: 35,
			},
			{
				label: "malformed unknown",
				result: { error: "profile_malformed" } as ProfileIdentityResult,
				exit: 35,
			},
			{
				label: "unauthorized",
				result: { error: "profile_unauthorized" } as ProfileIdentityResult,
				exit: 38,
			},
		])(
			"identity-verify returns the policy exit for $label",
			async (testCase) => {
				trustBusinessIdentity({
					email: "expected@example.com",
					uuid: "expected-uuid",
				});
				const code = await runQuotaGuardCli(
					["identity-verify", "--name", "business", "--store", storePath],
					{
						readStdin: () => TOKEN,
						fetchIdentity: fetchIdentity(testCase.result),
						log: (message) => output.push(message),
					},
				);
				expect(code).toBe(testCase.exit);
				expect(output.join("\n")).not.toContain(TOKEN);
				expect(output.join("\n")).not.toContain("other@example.com");
			},
		);

		it("identity-verify returns unknown without probing when trusted identity is absent", async () => {
			const probe = fetchIdentity({
				email: "observed@example.com",
				uuid: "observed-uuid",
			});
			const code = await runQuotaGuardCli(
				["identity-verify", "--name", "business", "--store", storePath],
				{
					readStdin: () => TOKEN,
					fetchIdentity: probe,
					log: (message) => output.push(message),
				},
			);
			expect(code).toBe(35);
			expect(probe).not.toHaveBeenCalled();
		});

		it("identity-set writes only explicit normalized identity and preserves generation and unrelated fields", async () => {
			const current = initialStore() as AccountStore & { futureTop?: string };
			current.futureTop = "preserve-me";
			const business = current.accounts.find(
				(entry) => entry.name === "business",
			) as (typeof current.accounts)[number] & { futureEntry?: string };
			business.futureEntry = "also-preserve";
			business.profileVerifyFailed = true;
			writeStore(current, storePath);

			const code = await runQuotaGuardCli(
				[
					"identity-set",
					"--name",
					"business",
					"--email",
					" Annie.Business@Example.COM ",
					"--uuid",
					" UUID-BUSINESS ",
					"--store",
					storePath,
				],
				{
					now: () => NOW,
					withAccountsLock: immediateAccountsLock,
					lockPath: lease.lockPath,
					log: (message) => output.push(message),
				},
			);
			const after = readStore(storePath) as AccountStore & {
				futureTop?: string;
			};
			expect(code).toBe(0);
			expect(after.generation).toBe(7);
			expect(after.futureTop).toBe("preserve-me");
			expect(
				after.accounts.find((entry) => entry.name === "business"),
			).toMatchObject({
				futureEntry: "also-preserve",
				profileVerifyFailed: true,
				identity: {
					email: "annie.business@example.com",
					uuid: "uuid-business",
					setAt: new Date(NOW).toISOString(),
				},
			});
		});

		it("identity-set fails closed without mutating bytes for invalid input, missing account, or blocked lock", async () => {
			const before = readFileSync(storePath, "utf8");
			const cases: Array<{
				argv: string[];
				withLock?: AccountsLock;
			}> = [
				{
					argv: [
						"identity-set",
						"--name",
						"business",
						"--email",
						"not-an-email",
						"--store",
						storePath,
					],
				},
				{
					argv: [
						"identity-set",
						"--name",
						"ghost",
						"--email",
						"ghost@example.com",
						"--store",
						storePath,
					],
				},
				{
					argv: [
						"identity-set",
						"--name",
						"business",
						"--email",
						"business@example.com",
						"--store",
						storePath,
					],
					withLock: async () => ({
						kind: "blocked",
						reason: { kind: "writer_alive" },
					}),
				},
			];
			for (const testCase of cases) {
				expect(
					await runQuotaGuardCli(testCase.argv, {
						withAccountsLock: testCase.withLock ?? immediateAccountsLock,
						lockPath: lease.lockPath,
						log: (message) => output.push(message),
					}),
				).not.toBe(0);
				expect(readFileSync(storePath, "utf8")).toBe(before);
			}
		});

		it("identity-audit --mark probes outside both lock windows and reconciles only identityMismatch", async () => {
			const shoppingToken = "shopping-token-must-never-leak";
			writePoolCredential("shopping", shoppingToken);
			trustIdentity("business", {
				email: "business@example.com",
				uuid: "business-uuid",
			});
			trustIdentity("shopping", {
				email: "shopping@example.com",
				uuid: "shopping-uuid",
			});
			const seeded = readStore(storePath);
			const shopping = seeded.accounts.find(
				(entry) => entry.name === "shopping",
			);
			if (!shopping) throw new Error("fixture missing shopping");
			shopping.identityMismatch = {
				actualDigest: "old-digest",
				markedBy: "executor",
				markedAt: "2026-07-14T18:00:00.000Z",
			};
			shopping.profileVerifyFailed = true;
			writeStore(seeded, storePath);

			let inLock = false;
			let lockCalls = 0;
			const lock: AccountsLock = async (_path, fn) => {
				lockCalls++;
				inLock = true;
				try {
					return { kind: "ok", value: await fn(lease) };
				} finally {
					inLock = false;
				}
			};
			const probe = vi.fn(async (token: string) => {
				expect(inLock).toBe(false);
				return token === TOKEN
					? { email: "intruder@example.com", uuid: "intruder-uuid" }
					: { email: "shopping@example.com", uuid: "shopping-uuid" };
			});

			const code = await runQuotaGuardCli(
				["identity-audit", "--mark", "--pool", poolDir, "--store", storePath],
				{
					now: () => NOW,
					fetchIdentity: probe,
					withAccountsLock: lock,
					lockPath: lease.lockPath,
					log: (message) => output.push(message),
				},
			);

			const after = readStore(storePath);
			const business = after.accounts.find(
				(entry) => entry.name === "business",
			);
			const healedShopping = after.accounts.find(
				(entry) => entry.name === "shopping",
			);
			expect(code).toBe(34);
			expect(lockCalls).toBe(2);
			expect(probe).toHaveBeenCalledTimes(2);
			expect(after.generation).toBe(7);
			expect(business?.identityMismatch).toMatchObject({
				markedBy: "audit",
				markedAt: new Date(NOW).toISOString(),
			});
			expect(business?.identityMismatch?.actualDigest).toMatch(
				/^[a-f0-9]{64}$/,
			);
			expect(healedShopping?.identityMismatch).toBeUndefined();
			expect(healedShopping?.profileVerifyFailed).toBe(true);
			expect(output.join("\n")).not.toContain(TOKEN);
			expect(output.join("\n")).not.toContain(shoppingToken);
			expect(output.join("\n")).not.toContain("intruder@example.com");
		});

		it.each(["credential", "expected identity"])(
			"identity-audit discards a probed mismatch when the %s fingerprint changes",
			async (changedFingerprint) => {
				trustBusinessIdentity({
					email: "business@example.com",
					uuid: "business-uuid",
				});
				let lockCalls = 0;
				const lock: AccountsLock = async (_path, fn) => {
					lockCalls++;
					if (lockCalls === 2) {
						if (changedFingerprint === "credential") {
							writePoolCredential("business", "rotated-token");
						} else {
							trustBusinessIdentity({
								email: "new@example.com",
								uuid: "new-uuid",
							});
						}
					}
					return { kind: "ok", value: await fn(lease) };
				};

				const code = await runQuotaGuardCli(
					["identity-audit", "--mark", "--pool", poolDir, "--store", storePath],
					{
						fetchIdentity: fetchIdentity({
							email: "intruder@example.com",
							uuid: "intruder-uuid",
						}),
						withAccountsLock: lock,
						lockPath: lease.lockPath,
						log: (message) => output.push(message),
					},
				);

				expect(code).toBe(35);
				expect(lockCalls).toBe(2);
				expect(
					readStore(storePath).accounts.find(
						(entry) => entry.name === "business",
					)?.identityMismatch,
				).toBeUndefined();
			},
		);

		it("identity-audit without --mark reports mismatch without changing store bytes", async () => {
			trustBusinessIdentity({
				email: "business@example.com",
				uuid: "business-uuid",
			});
			const before = readFileSync(storePath, "utf8");
			const code = await runQuotaGuardCli(
				["identity-audit", "--pool", poolDir, "--store", storePath],
				{
					fetchIdentity: fetchIdentity({
						email: "intruder@example.com",
						uuid: "intruder-uuid",
					}),
					withAccountsLock: immediateAccountsLock,
					lockPath: lease.lockPath,
					log: (message) => output.push(message),
				},
			);
			expect(code).toBe(34);
			expect(readFileSync(storePath, "utf8")).toBe(before);
		});

		it("identity-alert-flush routes only strict non-secret mismatch facts and never changes command status", async () => {
			const alert = vi.fn(async () => ({ primary: "sent" as const }));
			const code = await runQuotaGuardCli(["identity-alert-flush"], {
				now: () => NOW,
				readStdin: () =>
					JSON.stringify({
						identityChecks: [
							{
								label: "business",
								checkpoint: "pre_write",
								verdict: "mismatch",
								expectedKey: "b".repeat(64),
								actualDigest: "a".repeat(64),
							},
							{
								label: "shopping",
								checkpoint: "capture",
								verdict: "match",
							},
							{
								label: TOKEN,
								checkpoint: "capture_back",
								verdict: "mismatch",
								expectedKey: "bad",
								actualDigest: TOKEN,
							},
						],
					}),
				alert,
				log: (message) => output.push(message),
			});

			expect(code).toBe(0);
			expect(alert).toHaveBeenCalledOnce();
			expect(alert).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "account_identity_mismatch",
					body: expect.stringContaining("label=business"),
				}),
			);
			expect(JSON.stringify(alert.mock.calls)).not.toContain(TOKEN);
		});

		it("identity-alert-flush treats malformed input and delivery failure as best effort", async () => {
			for (const readStdin of [
				() => "not-json",
				() =>
					JSON.stringify({
						identityChecks: [
							{
								label: "business",
								checkpoint: "capture",
								verdict: "mismatch",
								expectedKey: "b".repeat(64),
								actualDigest: "a".repeat(64),
							},
						],
					}),
			]) {
				await expect(
					runQuotaGuardCli(["identity-alert-flush"], {
						readStdin,
						alert: async () => Promise.reject(new Error("delivery down")),
						log: (message) => output.push(message),
					}),
				).resolves.toBe(0);
			}
		});
	});

	it("active-sync updates only the active account and generation, then always exits zero", async () => {
		const before = initialStore();
		const code = await runQuotaGuardCli(
			["active-sync", "--name", "business", "--store", storePath],
			{ log: (message) => output.push(message) },
		);

		expect(code).toBe(0);
		expect(readStore(storePath)).toEqual({
			...before,
			activeAccount: "business",
			generation: 8,
			pendingSwitchNotifications: [],
		});
		expect(output).toEqual([
			"quota guard active-sync: result=synced; name=business",
		]);
	});

	it("active-sync reports invalid inputs without mutating bytes or blocking the committed switch", async () => {
		const before = readFileSync(storePath, "utf8");
		const code = await runQuotaGuardCli(
			["active-sync", "--name", "unknown", "--store", storePath],
			{ log: (message) => output.push(message) },
		);

		expect(code).toBe(0);
		expect(readFileSync(storePath, "utf8")).toBe(before);
		expect(output).toEqual([
			"quota guard active-sync: result=missing_account; name=unknown",
		]);
	});

	it("active-sync-strict clears verified freshening flags", async () => {
		const current = readStore(storePath);
		const personal = current.accounts.find(
			(entry) => entry.name === "personal",
		);
		if (!personal) throw new Error("fixture missing personal");
		personal.refreshTokenInvalid = true;
		personal.profileVerifyFailed = true;
		personal.identity = {
			email: "xrliannie@gmail.com",
			uuid: "uuid-personal",
			setAt: "2026-08-01T00:00:00.000Z",
		};
		personal.identityMismatch = {
			actualDigest: "a".repeat(64),
			markedBy: "executor",
			markedAt: "2026-08-01T00:00:00.000Z",
		};
		writeStore(current, storePath);

		const code = await runQuotaGuardCli(
			[
				"active-sync-strict",
				"--name",
				"personal",
				"--store",
				storePath,
				"--freshened",
			],
			{
				readStdin: () =>
					JSON.stringify({
						email: "xrliannie@gmail.com",
						uuid: "uuid-personal",
					}),
				log: (message) => output.push(message),
			},
		);

		expect(code).toBe(0);
		const after = readStore(storePath);
		expect(after.generation).toBe(current.generation + 1);
		expect(after.activeAccount).toBe("personal");
		expect(
			after.accounts.find((entry) => entry.name === "personal"),
		).not.toMatchObject({
			authExpired: true,
			refreshTokenInvalid: true,
			profileVerifyFailed: true,
			identityMismatch: expect.anything(),
		});
	});

	it.each([
		["unknown flag", ["active-sync-strict", "--wat"]],
		[
			"duplicate flag",
			[
				"active-sync-strict",
				"--name",
				"personal",
				"--name",
				"business",
				"--store",
				storePath,
				"--freshened",
			],
		],
	] as const)(
		"active-sync-strict rejects %s without mutation",
		async (_label, argv) => {
			const before = readFileSync(storePath, "utf8");
			const code = await runQuotaGuardCli([...argv], {
				readStdin: () => JSON.stringify({ email: "xrliannie@gmail.com" }),
				log: (message) => output.push(message),
			});
			expect(code).toBe(47);
			expect(readFileSync(storePath, "utf8")).toBe(before);
		},
	);

	it("returns 0 for two healthy windows and records the real observation", async () => {
		const code = await run(usage(84, 17));

		expect(code).toBe(0);
		expect(
			readStore(storePath).accounts.find((entry) => entry.name === "business"),
		).toMatchObject({
			quotaExhaustedUntil: null,
			weeklyResetAt: WEEK_RESET,
			lastObservedAt: new Date(NOW).toISOString(),
			observedFiveHPct: 84,
			observedSevenDPct: 17,
		});
		expect(output.join("\n")).not.toContain(TOKEN);
	});

	// FLY-1366: an idle account reports `resets_at: null`. That is healthy, not a
	// refusal — the guard must let the run through and never invent exhaustion.
	it("returns 0 for an idle account whose 5h window has not opened", async () => {
		const code = await run(usage(0, 12, { five: null }));

		expect(code).toBe(0);
		expect(
			readStore(storePath).accounts.find((entry) => entry.name === "business"),
		).toMatchObject({
			quotaExhaustedUntil: null,
			weeklyResetAt: WEEK_RESET,
			observedFiveHPct: 0,
		});
		expect(output.join("\n")).not.toContain("REFUSED");
	});

	// Exhausted AND null is a contract violation, not an idle account: stay
	// fail-closed on 32 but say plainly that the reset instant is missing.
	it("stays fail-closed with a truthful message when an exhausted window has no reset", async () => {
		const code = await run(usage(100, 12, { five: null }));
		const text = output.join("\n");

		expect(code).toBe(32);
		expect(text).toContain("REFUSED: target 'business' has no quota");
		expect(text).toContain("reset unavailable");
		expect(text).not.toContain("5h resets null");
	});

	it("returns 32 for weekly exhaustion, records reset, and prints an actionable safe suggestion", async () => {
		const code = await run(usage(34, 100));
		const text = output.join("\n");

		expect(code).toBe(32);
		expect(
			readStore(storePath).accounts.find((entry) => entry.name === "business"),
		).toMatchObject({
			quotaExhaustedUntil: WEEK_RESET,
			observedFiveHPct: 34,
			observedSevenDPct: 100,
		});
		expect(text).toContain("REFUSED: target 'business' has no quota");
		expect(text).toContain("5h 34% / 7d 100%");
		expect(text).toContain("shopping");
		expect(text).toContain("observed 6m ago");
		expect(text).toContain("Suggestion: flywheel-claude-profile use shopping");
		expect(text).toContain("the command will re-verify");
		expect(text).not.toMatch(/bypass|override/i);
		expect(text).not.toMatch(/Suggestion:.*(?:school|personal)/);
		expect(text).not.toContain(TOKEN);
	});

	it("timestamps a delayed usage response when the observation completes", async () => {
		const daemonObservedAt = NOW + 5_000;
		const guardObservedAt = NOW + 10_000;
		const times = [NOW, guardObservedAt];

		const code = await run(usage(34, 100), {
			now: () => times.shift() ?? guardObservedAt,
			fetchUsage: async () => {
				const store = readStore(storePath);
				const business = store.accounts.find(
					(entry) => entry.name === "business",
				);
				if (!business) throw new Error("business fixture missing");
				Object.assign(business, {
					lastObservedAt: new Date(daemonObservedAt).toISOString(),
					observedFiveHPct: 20,
					observedSevenDPct: 20,
				});
				writeStore(store, storePath);
				return usage(34, 100);
			},
		});

		expect(code).toBe(32);
		expect(
			readStore(storePath).accounts.find((entry) => entry.name === "business"),
		).toMatchObject({
			lastObservedAt: new Date(guardObservedAt).toISOString(),
			observedSevenDPct: 100,
			quotaExhaustedUntil: WEEK_RESET,
		});
	});

	it.each([
		{ label: "missing credential", credential: null },
		{
			label: "expired credential",
			credential: { accessToken: TOKEN, expiresAt: NOW },
		},
	])(
		"returns 33 for $label without calling the usage API",
		async ({ credential }) => {
			const fetchUsage = vi.fn(async () => usage(10, 10));
			const code = await run(usage(10, 10), {
				readCredential: () => credential,
				fetchUsage,
			});

			expect(code).toBe(33);
			expect(fetchUsage).not.toHaveBeenCalled();
			expect(output.join("\n")).not.toContain(TOKEN);
		},
	);

	it.each([
		{ error: "unauthorized" as const },
		{ error: "rate_limited" as const, retryAfterMs: 60_000 },
		{ error: "network" as const },
		{ error: "malformed" as const },
	])("returns 33 when usage API result is $error", async (result) => {
		const code = await run(result);
		expect(code).toBe(33);
		expect(output.join("\n")).toContain(`usage lookup failed: ${result.error}`);
		expect(output.join("\n")).not.toContain(TOKEN);
	});

	it("returns 33 when the store is corrupt and preserves its bytes", async () => {
		const corrupt = "{ broken store\n";
		writeFileSync(storePath, corrupt);

		expect(await run(usage(10, 10))).toBe(33);
		expect(readFileSync(storePath, "utf8")).toBe(corrupt);
	});

	it("returns 33 when the target is absent from the store", async () => {
		const noTarget = initialStore();
		noTarget.accounts = noTarget.accounts.filter(
			(entry) => entry.name !== "business",
		);
		writeStore(noTarget, storePath);

		expect(await run(usage(10, 10))).toBe(33);
		expect(output.join("\n")).toContain("store projection failed");
	});

	it("does not recommend stale observations and reports the earliest reset", async () => {
		const stale = initialStore();
		stale.accounts = stale.accounts.map((entry) =>
			entry.name === "shopping"
				? { ...entry, lastObservedAt: "2026-07-12T19:00:00Z" }
				: entry,
		);
		writeStore(stale, storePath);

		expect(await run(usage(100, 100))).toBe(32);
		const text = output.join("\n");
		expect(text).toContain("(stale)");
		expect(text).not.toContain("Suggestion: flywheel-claude-profile use");
		expect(text).toContain("earliest reset");
	});

	it("returns 33 for invalid usage and never echoes credentials in usage errors", async () => {
		const code = await run(usage(10, 10), {
			fetchUsage: async () => {
				throw new Error(`transport failed for ${TOKEN}`);
			},
		});

		expect(code).toBe(33);
		expect(output.join("\n")).not.toContain(TOKEN);
	});

	it("returns 33 for bad CLI usage", async () => {
		expect(
			await runQuotaGuardCli(["bogus"], {
				log: (message) => output.push(message),
			}),
		).toBe(33);
	});
});

describe("quota guard launcher contract", () => {
	it("is registered as a packaged executable", () => {
		const packageRoot = join(import.meta.dirname, "../..");
		const packageJson = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		) as { bin?: Record<string, string> };
		const launcher = join(packageRoot, "bin/flywheel-claude-quota-guard");

		expect(packageJson.bin?.["flywheel-claude-quota-guard"]).toBe(
			"bin/flywheel-claude-quota-guard",
		);
		expect(statSync(launcher).mode & 0o111).not.toBe(0);
	});

	it("fails closed with exit 33 when the compiled CLI is absent", () => {
		const packageRoot = join(import.meta.dirname, "../..");
		const launcher = join(packageRoot, "bin/flywheel-claude-quota-guard");
		const isolatedBin = join(dir, "isolated-package", "bin");
		mkdirSync(isolatedBin, { recursive: true });
		const isolatedLauncher = join(isolatedBin, "flywheel-claude-quota-guard");
		copyFileSync(launcher, isolatedLauncher);
		chmodSync(isolatedLauncher, 0o755);
		const result = spawnSync(isolatedLauncher, ["check"], {
			env: { ...process.env, PATH: process.env.PATH },
			encoding: "utf8",
		});

		expect(result.status).toBe(33);
		expect(result.stderr).toContain("compiled CLI not found");
		expect(result.stderr).not.toContain(TOKEN);
	});
});
