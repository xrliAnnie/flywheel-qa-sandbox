import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CodexAccountQuotaStore,
	defaultCodexAccountQuotaStorePath,
	readCodexAccountQuotaStore,
	writeCodexAccountQuotaStore,
} from "../codex-account-quota-store.js";

function store(): CodexAccountQuotaStore {
	return {
		version: 1,
		generatedAt: "2026-09-21T00:00:00.000Z",
		activeAccount: "personal",
		accounts: [
			{
				name: "personal",
				registeredProfile: "personal",
				observedAt: "2026-09-21T00:00:00.000Z",
				authHealth: "valid",
				note: null,
				planType: "pro",
				fiveH: {
					usedPercent: 10,
					windowMinutes: 300,
					resetAt: "2026-09-21T03:00:00.000Z",
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
				creditsObservedAt: "2026-09-21T00:00:00.000Z",
				resetCredits: {
					known: true,
					value: "2",
					availableCount: 2,
					credits: [
						{
							id: "card-1",
							status: "available",
							expiresAt: "2026-10-01T00:00:00.000Z",
						},
					],
				},
				resetCreditsObservedAt: "2026-09-21T00:00:00.000Z",
				unclassifiedWindows: 0,
			},
			{
				name: "shopping",
				registeredProfile: null,
				observedAt: null,
				authHealth: "in_use_unshared",
				note: "in_use_unshared",
				planType: null,
				fiveH: null,
				weekly: null,
				credits: {
					known: false,
					hasCredits: null,
					unlimited: null,
					balance: null,
				},
				creditsObservedAt: null,
				resetCredits: {
					known: false,
					value: null,
					availableCount: null,
					credits: null,
				},
				resetCreditsObservedAt: null,
				unclassifiedWindows: 0,
			},
		],
	};
}

describe("FLY-2688 — Codex account quota store", () => {
	it("round-trips readings and writes owner-only", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2688-store-"));
		const path = join(dir, "codex-accounts.json");
		writeCodexAccountQuotaStore(path, store());
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readCodexAccountQuotaStore(path)).toEqual(store());
		expect(readFileSync(path, "utf8")).not.toContain("id_token");
	});

	it("normalizes the production legacy reset-credit shape without dropping the store", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2807-legacy-store-"));
		const path = join(dir, "codex-accounts.json");
		const legacy = store() as unknown as Record<string, unknown>;
		const accounts = legacy.accounts as Array<Record<string, unknown>>;
		accounts[0]!.resetCredits = { known: true, value: "3" };
		accounts[1]!.resetCredits = { known: false, value: null };
		writeFileSync(path, JSON.stringify(legacy));

		const read = readCodexAccountQuotaStore(path);
		expect(read?.accounts).toHaveLength(2);
		expect(read?.accounts[0]?.planType).toBe("pro");
		expect(read?.accounts[0]?.resetCredits).toEqual({
			known: true,
			value: "3",
			availableCount: 3,
			credits: null,
		});
		expect(read?.accounts[1]?.resetCredits).toEqual({
			known: false,
			value: null,
			availableCount: null,
			credits: null,
		});
	});

	it("does not promote fractional legacy values to card counts", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2807-fraction-store-"));
		const path = join(dir, "codex-accounts.json");
		const legacy = store() as unknown as Record<string, unknown>;
		const accounts = legacy.accounts as Array<Record<string, unknown>>;
		accounts[0]!.resetCredits = { known: true, value: "3.50" };
		writeFileSync(path, JSON.stringify(legacy));

		expect(readCodexAccountQuotaStore(path)?.accounts[0]?.resetCredits).toEqual(
			{
				known: false,
				value: null,
				availableCount: null,
				credits: null,
			},
		);
	});

	it("returns null for a missing, unparseable or schema-invalid store", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2688-store-"));
		expect(readCodexAccountQuotaStore(join(dir, "absent.json"))).toBeNull();

		const broken = join(dir, "broken.json");
		writeFileSync(broken, "{not json");
		expect(readCodexAccountQuotaStore(broken)).toBeNull();

		const invalid = join(dir, "invalid.json");
		writeFileSync(
			invalid,
			JSON.stringify({ ...store(), version: 2 } satisfies Record<
				string,
				unknown
			>),
		);
		expect(readCodexAccountQuotaStore(invalid)).toBeNull();

		const badName = join(dir, "bad-name.json");
		const withBadName = store();
		withBadName.accounts[0]!.name = "../escape";
		writeFileSync(badName, JSON.stringify(withBadName));
		expect(readCodexAccountQuotaStore(badName)).toBeNull();

		const duplicate = join(dir, "duplicate.json");
		const withDuplicate = store();
		withDuplicate.accounts[1]!.name = "personal";
		writeFileSync(duplicate, JSON.stringify(withDuplicate));
		expect(readCodexAccountQuotaStore(duplicate)).toBeNull();

		const danglingActive = join(dir, "dangling.json");
		const withDangling = store();
		withDangling.activeAccount = "nobody";
		writeFileSync(danglingActive, JSON.stringify(withDangling));
		expect(readCodexAccountQuotaStore(danglingActive)).toBeNull();
	});

	it("defaults under the Flywheel state dir", () => {
		expect(
			defaultCodexAccountQuotaStorePath(
				{ FLYWHEEL_STATE_DIR: "/state/dir" },
				"/home/user",
			),
		).toBe("/state/dir/codex-quota/codex-accounts.json");
		expect(defaultCodexAccountQuotaStorePath({}, "/home/user")).toBe(
			"/home/user/.flywheel/codex-quota/codex-accounts.json",
		);
	});
});

describe("FLY-2830 — occupancy reason detail", () => {
	it("round-trips a bounded noteDetail", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2830-store-"));
		const path = join(dir, "codex-accounts.json");
		const value = store();
		value.accounts[1] = {
			...value.accounts[1]!,
			note: "inventory_unavailable",
			noteDetail: "collector_failed:process_authority_invalid",
		};
		writeCodexAccountQuotaStore(path, value);
		expect(readCodexAccountQuotaStore(path)?.accounts[1]?.noteDetail).toBe(
			"collector_failed:process_authority_invalid",
		);
	});

	it.each([
		["markup", "<script>"],
		["a path", "/Users/x/.codex"],
		["over 80 characters", "a".repeat(81)],
		["uppercase", "Collector_Failed"],
	])(
		"refuses to write a noteDetail with %s and keeps the old file",
		(_n, detail) => {
			const dir = mkdtempSync(join(tmpdir(), "fly2830-store-"));
			const path = join(dir, "codex-accounts.json");
			writeCodexAccountQuotaStore(path, store());
			const before = readFileSync(path, "utf8");
			const value = store();
			value.accounts[1] = {
				...value.accounts[1]!,
				note: "inventory_unavailable",
				noteDetail: detail,
			};
			expect(() => writeCodexAccountQuotaStore(path, value)).toThrow();
			expect(readFileSync(path, "utf8")).toBe(before);
			// A hand-edited file with the same value is rejected on read too.
			writeFileSync(path, JSON.stringify(value));
			expect(readCodexAccountQuotaStore(path)).toBeNull();
		},
	);
});
