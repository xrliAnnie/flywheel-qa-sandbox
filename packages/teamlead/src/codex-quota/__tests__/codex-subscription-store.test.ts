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
	type CodexSubscriptionStore,
	defaultCodexSubscriptionStorePath,
	readCodexSubscriptionStore,
	writeCodexSubscriptionStore,
} from "../codex-subscription-store.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const KEY = "a".repeat(64);
const STORE: CodexSubscriptionStore = {
	version: 1,
	generatedAt: "2026-09-24T23:30:00.000Z",
	accounts: [
		{
			name: "business",
			identityKey: KEY,
			observedAt: "2026-09-24T23:30:00.000Z",
			status: "active",
			renewsAt: "2026-10-23T03:59:39.000Z",
			endsAt: null,
			note: null,
		},
		{
			name: "personal1",
			identityKey: "b".repeat(64),
			observedAt: "2026-09-24T23:30:00.000Z",
			status: "canceled",
			renewsAt: null,
			endsAt: "2026-10-19T04:02:27.000Z",
			note: null,
		},
		{
			name: "school",
			identityKey: "c".repeat(64),
			observedAt: "2026-09-20T00:00:00.000Z",
			status: "active",
			renewsAt: "2026-10-03T23:37:58.000Z",
			endsAt: null,
			note: "unauthorized",
		},
		{
			name: "fresh",
			identityKey: "d".repeat(64),
			observedAt: "2026-09-24T23:30:00.000Z",
			status: "none",
			renewsAt: null,
			endsAt: null,
			note: null,
		},
		{
			name: "broken",
			observedAt: null,
			status: "unknown",
			renewsAt: null,
			endsAt: null,
			note: "problem:invalid_credential",
		},
	],
};

function tempPath(): string {
	const root = mkdtempSync(join(tmpdir(), "fly2864-codex-sub-store-"));
	roots.push(root);
	return join(root, "codex-quota", "codex-subscriptions.json");
}

describe("FLY-2864 — Codex subscription store", () => {
	it("derives its path next to the Codex quota store", () => {
		expect(
			defaultCodexSubscriptionStorePath({ FLYWHEEL_STATE_DIR: "/state" }),
		).toBe("/state/codex-quota/codex-subscriptions.json");
		expect(defaultCodexSubscriptionStorePath({}, "/home/me")).toBe(
			"/home/me/.flywheel/codex-quota/codex-subscriptions.json",
		);
	});

	it("round-trips a mixed store with a 0600 file", () => {
		const path = tempPath();
		writeCodexSubscriptionStore(path, STORE);
		expect(readCodexSubscriptionStore(path)).toEqual(STORE);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).not.toMatch(/token|@/);
	});

	it("returns null for a missing, oversized or unparsable file", () => {
		const path = tempPath();
		expect(readCodexSubscriptionStore(path)).toBeNull();
		writeCodexSubscriptionStore(path, STORE);
		writeFileSync(path, "x".repeat(256 * 1024 + 1));
		expect(readCodexSubscriptionStore(path)).toBeNull();
		writeFileSync(path, "{not json");
		expect(readCodexSubscriptionStore(path)).toBeNull();
	});

	it("rejects duplicate names and every invalid field", () => {
		const path = tempPath();
		writeCodexSubscriptionStore(path, STORE);
		const active = STORE.accounts[0]!;
		const orphan = STORE.accounts[4]!;
		const invalid: unknown[] = [
			{ ...STORE, version: 2 },
			{ ...STORE, generatedAt: "2026-09-24T23:30:00Z" },
			{ ...STORE, accounts: [active, active] },
			{ ...STORE, accounts: "x" },
			...[
				{ ...active, name: "../escape" },
				{ ...active, identityKey: "A".repeat(64) },
				{ ...active, identityKey: "a".repeat(63) },
				{ ...active, status: "paused" },
				{ ...active, renewsAt: "2026-10-23T03:59:39+00:00" },
				{ ...active, renewsAt: null },
				{ ...active, endsAt: "2026-10-23T03:59:39.000Z" },
				{ ...active, observedAt: null },
				{ ...active, note: "Bad Note!" },
				{ ...active, status: "none", renewsAt: "2026-10-23T03:59:39.000Z" },
				{
					...active,
					status: "canceled",
					renewsAt: "2026-10-23T03:59:39.000Z",
					endsAt: null,
				},
				// Orphan (no identity) rows carry no facts and must name a problem.
				{ ...orphan, note: "unauthorized" },
				{ ...orphan, status: "active", renewsAt: "2026-10-23T03:59:39.000Z" },
				{ ...orphan, observedAt: "2026-09-24T23:30:00.000Z" },
				{ ...orphan, endsAt: "2026-10-23T03:59:39.000Z" },
			].map((account) => ({ ...STORE, accounts: [account] })),
		];
		for (const store of invalid) {
			writeFileSync(path, JSON.stringify(store));
			expect(readCodexSubscriptionStore(path)).toBeNull();
		}
	});
});
