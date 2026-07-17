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
import {
	type AccountStore,
	readStore,
	writeStore,
} from "../account-heal/account-store.js";
import { runQuotaGuardCli } from "../account-heal/quota-guard-cli.js";
import type { AccountUsageResult } from "../account-heal/quota-usage-api.js";

const NOW = Date.parse("2026-07-14T20:00:00Z");
const FIVE_RESET = "2026-07-14T23:00:00.000Z";
const WEEK_RESET = "2026-07-21T14:00:00.000Z";
const TOKEN = "secret-token-must-never-leak";

function usage(fiveHPct: number, sevenDPct: number): AccountUsageResult {
	return {
		ok: {
			raw: {
				five_hour: { utilization: fiveHPct, resets_at: FIVE_RESET },
				seven_day: { utilization: sevenDPct, resets_at: WEEK_RESET },
			},
			fiveH: { pct: fiveHPct, resetsAt: FIVE_RESET },
			sevenD: { pct: sevenDPct, resetsAt: WEEK_RESET },
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

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1252-guard-"));
	poolDir = join(dir, "pool");
	storePath = join(dir, "claude-accounts.json");
	mkdirSync(join(poolDir, "business"), { recursive: true });
	writeFileSync(
		join(poolDir, "business", ".credentials.json"),
		JSON.stringify({
			claudeAiOauth: {
				accessToken: TOKEN,
				refreshToken: "refresh-secret",
				expiresAt: NOW + 3_600_000,
			},
		}),
		{ mode: 0o600 },
	);
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
		expect(text).toContain("FLYWHEEL_CLAUDE_QUOTA_BYPASS=1");
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
