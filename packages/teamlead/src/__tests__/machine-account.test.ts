import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountStore } from "../account-heal/account-store.js";
import { resolveMachineAccount } from "../account-heal/machine-account.js";

let root: string;
let poolDir: string;
let claudeJsonPath: string;

const accounts = [
	["business", "business@example.com"],
	["personal", "personal@example.com"],
	["personal1", "personal1@example.com"],
] as const;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fly1182-machine-account-"));
	poolDir = join(root, "pool");
	claudeJsonPath = join(root, "claude.json");
	for (const [name, emailAddress] of accounts) {
		mkdirSync(join(poolDir, name), { recursive: true });
		writeFileSync(
			join(poolDir, name, "oauthAccount.json"),
			JSON.stringify({ emailAddress }),
			{ mode: 0o600 },
		);
	}
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function store(
	activeAccount: string | null,
	identityStale = false,
): AccountStore {
	return {
		generation: 4,
		activeAccount,
		identityStale,
		accounts: accounts.map(([name]) => ({
			name,
			quotaExhaustedUntil: null,
			weeklyResetAt: null,
		})),
	};
}

function writeActive(name: string): void {
	writeFileSync(join(poolDir, ".active"), `${name}\n`, { mode: 0o600 });
}

function writeIdentity(emailAddress: string): void {
	writeFileSync(
		claudeJsonPath,
		JSON.stringify({ oauthAccount: { emailAddress } }),
		{ mode: 0o600 },
	);
}

function resolve(accountStore: AccountStore) {
	return resolveMachineAccount({
		poolDir,
		claudeJsonPath,
		store: accountStore,
	});
}

describe("resolveMachineAccount — shared fail-closed authority", () => {
	it("resolves only when .active, display identity, and ledger agree on a tracked account", () => {
		writeActive("business");
		writeIdentity("business@example.com");

		expect(resolve(store("business"))).toEqual({
			kind: "resolved",
			name: "business",
		});
	});

	it("fails closed on the production three-way split", () => {
		writeActive("personal1");
		writeIdentity("personal@example.com");

		expect(resolve(store("business"))).toMatchObject({
			kind: "conflict",
			activeMarker: "personal1",
			identityAccount: "personal",
			ledgerAccount: "business",
		});
	});

	it("reports an identity outside the managed pool as untracked", () => {
		writeActive("business");
		writeIdentity("outside@example.com");

		expect(resolve(store("business"))).toMatchObject({
			kind: "untracked",
			identityEmail: "outside@example.com",
		});
	});

	it.each([
		["missing display identity", undefined],
		["corrupt display identity", "{not-json"],
	])("fails closed when %s prevents three-source agreement", (_label, raw) => {
		writeActive("business");
		if (raw !== undefined) writeFileSync(claudeJsonPath, raw, { mode: 0o600 });

		expect(resolve(store("business"))).toMatchObject({ kind: "conflict" });
	});

	it("accepts a previously stale identity only after all three sources corroborate it", () => {
		writeActive("personal");
		writeIdentity("personal@example.com");

		expect(resolve(store("personal", true))).toEqual({
			kind: "resolved",
			name: "personal",
		});
	});
});
