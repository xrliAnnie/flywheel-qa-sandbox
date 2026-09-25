import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createVercelAccountLatest,
	defaultVercelAccountStorePath,
	discardVercelAccountStore,
	readVercelAccountStore,
	type VercelAccountStore,
	vercelAccountFailure,
	writeVercelAccountStore,
} from "../vercel-account-store.js";

const dirs: string[] = [];
function tempPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "vercel-store-"));
	dirs.push(dir);
	return join(dir, "vercel-quota", "vercel-account.json");
}
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const good: VercelAccountStore = {
	version: 1,
	observedAt: "2026-09-25T08:00:00.000Z",
	account: {
		emailSha256: "a".repeat(64),
		username: "xrliannie",
		teamSlug: "xrliannies-projects",
		plan: "pro",
		billingStatus: "active",
		periodEnd: "2026-10-24T07:00:00.000Z",
		canceled: false,
	},
	accountNote: null,
	blob: {
		status: "available",
		sizeBytes: 1_051_925,
		count: 23,
		usageQuotaExceeded: false,
	},
	blobNote: null,
};

function written(value: unknown): string {
	const path = tempPath();
	writeVercelAccountStore(path, good);
	writeFileSync(path, JSON.stringify(value));
	return path;
}

describe("FLY-2875 Vercel account store", () => {
	it("round-trips a full reading with owner-only permissions", () => {
		const path = tempPath();
		writeVercelAccountStore(path, good);
		expect(readVercelAccountStore(path)).toEqual(good);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).not.toContain("@");
	});

	it("round-trips failure readings and the fixed failure record", () => {
		const path = tempPath();
		const failure = vercelAccountFailure(
			"unauthorized",
			new Date("2026-09-25T08:00:00.000Z"),
		);
		expect(failure).toEqual({
			version: 1,
			observedAt: "2026-09-25T08:00:00.000Z",
			account: null,
			accountNote: "unauthorized",
			blob: null,
			blobNote: "unauthorized",
		});
		writeVercelAccountStore(path, failure);
		expect(readVercelAccountStore(path)).toEqual(failure);
		const mixed: VercelAccountStore = {
			...good,
			blob: null,
			blobNote: "owner_mismatch",
		};
		writeVercelAccountStore(path, mixed);
		expect(readVercelAccountStore(path)).toEqual(mixed);
	});

	it("follows FLYWHEEL_STATE_DIR for the default path", () => {
		expect(
			defaultVercelAccountStorePath({ FLYWHEEL_STATE_DIR: "/state" }, "/home"),
		).toBe("/state/vercel-quota/vercel-account.json");
		expect(defaultVercelAccountStorePath({}, "/home")).toBe(
			"/home/.flywheel/vercel-quota/vercel-account.json",
		);
	});

	it("returns null for a missing, oversized or malformed file", () => {
		expect(readVercelAccountStore(tempPath())).toBeNull();
		const path = tempPath();
		writeVercelAccountStore(path, good);
		writeFileSync(path, "{not json");
		expect(readVercelAccountStore(path)).toBeNull();
		writeFileSync(path, " ".repeat(65 * 1024));
		expect(readVercelAccountStore(path)).toBeNull();
	});

	it.each<[string, unknown]>([
		["wrong version", { ...good, version: 2 }],
		["non-canonical observedAt", { ...good, observedAt: "2026-09-25" }],
		["both account and accountNote", { ...good, accountNote: "network" }],
		[
			"neither account nor accountNote",
			{ ...good, account: null, accountNote: null },
		],
		["both blob and blobNote", { ...good, blobNote: "network" }],
		["neither blob nor blobNote", { ...good, blob: null, blobNote: null }],
		[
			"unknown note",
			{ ...good, account: null, accountNote: "token leaked here" },
		],
		[
			"bad email digest",
			{ ...good, account: { ...good.account, emailSha256: "abc" } },
		],
		[
			"plaintext email in username",
			{ ...good, account: { ...good.account, username: "a@b.com" } },
		],
		[
			"bad team slug",
			{ ...good, account: { ...good.account, teamSlug: "Team <x>" } },
		],
		["bad plan", { ...good, account: { ...good.account, plan: "Pro Plan" } }],
		[
			"bad billing status",
			{ ...good, account: { ...good.account, billingStatus: 3 } },
		],
		[
			"non-canonical periodEnd",
			{
				...good,
				account: { ...good.account, periodEnd: "2026-10-24T07:00:00Z" },
			},
		],
		[
			"non-boolean canceled",
			{ ...good, account: { ...good.account, canceled: "no" } },
		],
		[
			"extra account key",
			{ ...good, account: { ...good.account, email: "x" } },
		],
		["negative size", { ...good, blob: { ...good.blob, sizeBytes: -1 } }],
		["fractional count", { ...good, blob: { ...good.blob, count: 1.5 } }],
		["bad blob status", { ...good, blob: { ...good.blob, status: "OK!" } }],
		[
			"non-boolean quota flag",
			{ ...good, blob: { ...good.blob, usageQuotaExceeded: 0 } },
		],
		["extra top-level key", { ...good, token: "x" }],
	])("rejects %s", (_label, value) => {
		expect(readVercelAccountStore(written(value))).toBeNull();
	});

	it("discards a stale file and tolerates an absent one", () => {
		const path = tempPath();
		writeVercelAccountStore(path, good);
		discardVercelAccountStore(path);
		expect(readVercelAccountStore(path)).toBeNull();
		expect(() => discardVercelAccountStore(path)).not.toThrow();
	});

	it("keeps the latest attempt in memory", () => {
		const latest = createVercelAccountLatest();
		expect(latest.get()).toBeNull();
		latest.set(good);
		expect(latest.get()).toEqual(good);
		const failure = vercelAccountFailure(
			"refresh_failed",
			new Date("2026-09-25T09:00:00.000Z"),
		);
		latest.set(failure);
		expect(latest.get()).toEqual(failure);
	});
});
