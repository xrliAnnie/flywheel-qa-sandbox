/**
 * FLY-696 M1/C2 — selectNextAccount: pick the next usable Claude account when
 * the active one hits a cap.
 *
 *  - 5h cap    → temporary: switch to any usable account (the current one comes
 *                back after its 5h reset), don't burn the weekly pool.
 *  - weekly/both cap → switch to the account whose WEEKLY reset is soonest
 *                ("周五先用周一 reset 的"); accounts with unknown weekly reset are
 *                deprioritized; never return an account still exhausted this week.
 *  - all others unusable → null (caller pages Annie with the earliest reset).
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AccountEntry,
	type AccountStore,
	emptyStore,
	readStore,
	selectNextAccount,
	writeStore,
} from "../account-heal/account-store.js";

const NOW = new Date("2026-07-03T20:00:00Z");

function store(accounts: AccountEntry[], active: string): AccountStore {
	return { generation: 1, activeAccount: active, accounts };
}
const acct = (
	name: string,
	over: Partial<AccountEntry> = {},
): AccountEntry => ({
	name,
	quotaExhaustedUntil: null,
	weeklyResetAt: null,
	authExpired: false,
	...over,
});

describe("selectNextAccount", () => {
	it("weekly cap → picks the account with the SOONEST weekly reset", () => {
		const s = store(
			[
				acct("personal", { quotaExhaustedUntil: "2026-07-10T00:00:00Z" }),
				acct("business", { weeklyResetAt: "2026-07-07T14:00:00Z" }), // Tue
				acct("school", { weeklyResetAt: "2026-07-06T14:00:00Z" }), // Mon (sooner)
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
			}),
		).toBe("school");
	});

	it("weekly cap → an account with unknown weekly reset is deprioritized", () => {
		const s = store(
			[
				acct("personal", { quotaExhaustedUntil: "2026-07-10T00:00:00Z" }),
				acct("business", { weeklyResetAt: null }), // unknown → last
				acct("school", { weeklyResetAt: "2026-07-08T14:00:00Z" }),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
			}),
		).toBe("school");
	});

	it("weekly cap → never returns an account still weekly-exhausted this week", () => {
		const s = store(
			[
				acct("personal", { quotaExhaustedUntil: "2026-07-10T00:00:00Z" }),
				acct("school", { quotaExhaustedUntil: "2026-07-09T00:00:00Z" }), // also dead
				acct("business", { weeklyResetAt: "2026-07-08T14:00:00Z" }),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
			}),
		).toBe("business");
	});

	it("5h cap → picks any usable account other than the current one", () => {
		const s = store(
			[acct("personal"), acct("school"), acct("business")],
			"personal",
		);
		const pick = selectNextAccount(s, {
			scope: "5h",
			currentName: "personal",
			now: NOW,
		});
		expect(pick).not.toBe("personal");
		expect(["school", "business"]).toContain(pick);
	});

	it("an account whose quotaExhaustedUntil is in the PAST is usable again", () => {
		const s = store(
			[
				acct("personal", { quotaExhaustedUntil: "2026-07-10T00:00:00Z" }),
				acct("school", { quotaExhaustedUntil: "2026-07-03T18:00:00Z" }), // past → back
			],
			"personal",
		);
		expect(
			selectNextAccount(s, { scope: "5h", currentName: "personal", now: NOW }),
		).toBe("school");
	});

	it("auth-expired accounts are not eligible for a quota switch", () => {
		const s = store(
			[acct("personal"), acct("school", { authExpired: true })],
			"personal",
		);
		expect(
			selectNextAccount(s, { scope: "5h", currentName: "personal", now: NOW }),
		).toBeNull();
	});

	it("returns null when no other account is usable (caller pages Annie)", () => {
		const s = store(
			[
				acct("personal", { quotaExhaustedUntil: "2026-07-10T00:00:00Z" }),
				acct("school", { quotaExhaustedUntil: "2026-07-09T00:00:00Z" }),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
			}),
		).toBeNull();
	});
});

describe("account-store IO", () => {
	let dir: string;
	let path: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly696-store-"));
		path = join(dir, "claude-accounts.json");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("readStore returns an empty store when the file is missing", () => {
		expect(readStore(path)).toEqual(emptyStore());
	});

	it("writeStore → readStore round-trips and writes 0600", () => {
		const s = store([acct("personal"), acct("school")], "personal");
		s.generation = 4;
		writeStore(s, path);
		expect(readStore(path)).toEqual(s);
		// 0600 — the state file references account names; keep it owner-only.
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("readStore returns an empty store on corrupt JSON (fail-soft, not throw)", () => {
		writeStore(store([acct("personal")], "personal"), path);
		// clobber with garbage
		writeFileSync(path, "{ not json");
		expect(readStore(path)).toEqual(emptyStore());
	});
});
