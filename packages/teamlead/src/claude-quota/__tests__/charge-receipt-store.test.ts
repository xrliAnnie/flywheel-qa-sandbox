import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ClaudeChargeFacts,
	type ClaudeChargeReading,
	type ClaudeChargeStore,
	claudeChargeMailboxKey,
	defaultClaudeChargeStorePath,
	readClaudeChargeStore,
	validateClaudeChargeStore,
	writeClaudeChargeStore,
} from "../charge-receipt-store.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function tempPath(): string {
	const root = mkdtempSync(join(tmpdir(), "fly2897-store-"));
	roots.push(root);
	return join(root, "claude-quota", "charge-receipts.json");
}

const FACTS: ClaudeChargeFacts = {
	periodStart: "2026-09-16",
	periodEnd: "2026-10-16",
	paidOn: "2026-09-16",
	amountCents: 20001,
	receiptCount: 2,
	receiptAt: "2026-09-17T00:05:00.000Z",
	canceledAt: null,
	resumedAt: null,
};

function reading(
	overrides: Partial<ClaudeChargeReading> = {},
): ClaudeChargeReading {
	return {
		name: "business",
		mailboxKey: "a".repeat(64),
		readAt: "2026-09-25T23:40:00.000Z",
		status: "ok",
		reason: null,
		facts: FACTS,
		lastGood: {
			readAt: "2026-09-25T23:40:00.000Z",
			status: "ok",
			facts: FACTS,
		},
		...overrides,
	};
}

function store(accounts: ClaudeChargeReading[]): ClaudeChargeStore {
	return {
		version: 1,
		generatedAt: "2026-09-25T23:40:00.000Z",
		accounts,
	};
}

const VALID = store([
	reading(),
	reading({
		name: "personal1",
		mailboxKey: null,
		status: "no_mailbox",
		facts: null,
		lastGood: null,
	}),
	reading({
		name: "partial",
		facts: { ...FACTS, amountCents: null, receiptCount: null },
		lastGood: null,
	}),
	reading({
		name: "school",
		status: "auth_invalid",
		reason: "invalid_grant",
		facts: null,
	}),
	reading({
		name: "shopping",
		status: "canceled",
		facts: { ...FACTS, canceledAt: "2026-09-20T18:00:00.000Z" },
		lastGood: null,
	}),
]);

describe("FLY-2897 charge receipt store", () => {
	it("lives next to the Claude account details", () => {
		expect(
			defaultClaudeChargeStorePath({ FLYWHEEL_STATE_DIR: "/state" }, "/home"),
		).toBe("/state/claude-quota/charge-receipts.json");
		expect(defaultClaudeChargeStorePath({}, "/home")).toBe(
			"/home/.flywheel/claude-quota/charge-receipts.json",
		);
	});

	it("round-trips a valid store as an owner-only file", () => {
		const path = tempPath();
		writeClaudeChargeStore(path, VALID);
		expect(readClaudeChargeStore(path)).toEqual(VALID);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
		expect(readdirSync(join(path, ".."))).toEqual(["charge-receipts.json"]);
	});

	it("reads a missing, oversized or non-JSON file as no store", () => {
		const path = tempPath();
		expect(readClaudeChargeStore(path)).toBeNull();
		writeClaudeChargeStore(path, VALID);
		writeFileSync(path, "{not json");
		expect(readClaudeChargeStore(path)).toBeNull();
		writeFileSync(path, " ".repeat(64 * 1024 + 1));
		expect(readClaudeChargeStore(path)).toBeNull();
	});

	const invalid: Array<[string, (s: ClaudeChargeStore) => unknown]> = [
		["version", (s) => ({ ...s, version: 2 })],
		["generatedAt", (s) => ({ ...s, generatedAt: "2026-09-25" })],
		[
			"too many accounts",
			(s) => ({
				...s,
				accounts: Array.from({ length: 65 }, (_, i) =>
					reading({ name: `a${i}` }),
				),
			}),
		],
		["duplicate names", (s) => ({ ...s, accounts: [reading(), reading()] })],
		["bad name", (s) => ({ ...s, accounts: [reading({ name: "../x" })] })],
		[
			"bad status",
			(s) => ({ ...s, accounts: [reading({ status: "maybe" as never })] }),
		],
		[
			"the retired free status",
			(s) => ({
				...s,
				accounts: [reading({ status: "free" as never, facts: null })],
			}),
		],
		[
			"reason outside the allow-list",
			(s) => ({
				...s,
				accounts: [
					reading({
						status: "read_failed",
						reason: "exit_null" as never,
						facts: null,
					}),
				],
			}),
		],
		[
			"reason carrying an address",
			(s) => ({
				...s,
				accounts: [
					reading({
						status: "read_failed",
						reason: "a@b.c" as never,
						facts: null,
					}),
				],
			}),
		],
		[
			"ok without facts",
			(s) => ({ ...s, accounts: [reading({ facts: null })] }),
		],
		[
			"failure with facts",
			(s) => ({
				...s,
				accounts: [reading({ status: "no_receipt" })],
			}),
		],
		[
			"canceled without canceledAt",
			(s) => ({ ...s, accounts: [reading({ status: "canceled" })] }),
		],
		[
			"non-calendar period",
			(s) => ({
				...s,
				accounts: [reading({ facts: { ...FACTS, periodEnd: "2026-02-30" } })],
			}),
		],
		[
			"period end not after start",
			(s) => ({
				...s,
				accounts: [reading({ facts: { ...FACTS, periodEnd: "2026-09-16" } })],
			}),
		],
		[
			"fractional amount",
			(s) => ({
				...s,
				accounts: [reading({ facts: { ...FACTS, amountCents: 1.5 } })],
			}),
		],
		[
			"an amount without a receipt count",
			(s) => ({
				...s,
				accounts: [reading({ facts: { ...FACTS, receiptCount: null } })],
			}),
		],
		[
			"receipt count out of range",
			(s) => ({
				...s,
				accounts: [reading({ facts: { ...FACTS, receiptCount: 7 } })],
			}),
		],
		[
			"non-canonical instant",
			(s) => ({
				...s,
				accounts: [reading({ readAt: "2026-09-25T23:40:00Z" })],
			}),
		],
		[
			"mailbox key that is not a digest",
			(s) => ({
				...s,
				accounts: [reading({ mailboxKey: "xrliannie@gmail.com" })],
			}),
		],
		[
			"lastGood with a failure status",
			(s) => ({
				...s,
				accounts: [
					reading({
						lastGood: {
							readAt: "2026-09-25T23:40:00.000Z",
							status: "no_receipt" as never,
							facts: FACTS,
						},
					}),
				],
			}),
		],
		[
			"an extra field that could carry mail content",
			(s) => ({
				...s,
				accounts: [{ ...reading(), subject: "Your receipt from Anthropic" }],
			}),
		],
		[
			"an extra facts field",
			(s) => ({
				...s,
				accounts: [reading({ facts: { ...FACTS, body: "x" } as never })],
			}),
		],
	];

	for (const [label, mutate] of invalid) {
		it(`rejects the whole file on ${label}`, () => {
			const path = tempPath();
			writeClaudeChargeStore(path, VALID);
			writeFileSync(path, JSON.stringify(mutate(VALID)));
			expect(readClaudeChargeStore(path)).toBeNull();
			expect(validateClaudeChargeStore(mutate(VALID))).toBe(false);
		});
	}

	it("refuses to write a store the reader would reject, leaving the old file", () => {
		const path = tempPath();
		writeClaudeChargeStore(path, VALID);
		const before = readFileSync(path, "utf8");
		expect(() =>
			writeClaudeChargeStore(
				path,
				store([reading({ reason: "exit_null" as never })]),
			),
		).toThrow("store_invalid");
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readdirSync(join(path, ".."))).toEqual(["charge-receipts.json"]);
	});

	it("binds a mailbox by one shared digest", () => {
		expect(claudeChargeMailboxKey(" XrliAnnie@Gmail.com ")).toBe(
			claudeChargeMailboxKey("xrliannie@gmail.com"),
		);
		expect(claudeChargeMailboxKey("xrliannie@gmail.com")).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(claudeChargeMailboxKey("a@example.com")).not.toBe(
			claudeChargeMailboxKey("b@example.com"),
		);
	});

	it("accepts the bounded-scan failure reasons", () => {
		for (const reason of ["candidate_limit", "search_truncated"] as const) {
			expect(
				validateClaudeChargeStore(
					store([reading({ status: "read_failed", reason, facts: null })]),
				),
			).toBe(true);
		}
	});

	it("writes an empty account list", () => {
		const path = tempPath();
		writeClaudeChargeStore(path, store([]));
		expect(existsSync(path)).toBe(true);
		expect(readClaudeChargeStore(path)?.accounts).toEqual([]);
	});
});
