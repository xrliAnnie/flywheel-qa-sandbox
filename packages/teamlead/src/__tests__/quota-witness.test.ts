import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readQuotaWitness,
	WITNESS_MAX_AGE_MS,
	WITNESS_MAX_FUTURE_MS,
	writeQuotaWitness,
} from "../account-heal/quota-witness.js";

const NOW = Date.parse("2026-09-09T04:00:00.000Z");
const UID = process.getuid?.() ?? 501;

let dir: string;
let path: string;

function witness(overrides: Record<string, unknown> = {}) {
	return {
		version: 1 as const,
		kind: "account_disabled" as const,
		observedAt: NOW,
		source: "review_job" as const,
		executionId: "exec-1",
		evidenceDigest: "a".repeat(64),
		...overrides,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly2452-witness-"));
	path = join(dir, "quota-monitor-witness.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("quota account-disabled witness", () => {
	it("writes atomically as 0600 and reads a current same-owner witness", () => {
		writeQuotaWitness(path, witness());

		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["quota-monitor-witness.json"]);
		expect(readQuotaWitness(path, { uid: UID, now: NOW })).toEqual({
			status: "accepted",
			witness: witness(),
		});
	});

	it("accepts runner-pane evidence without an execution id", () => {
		const value = witness({ source: "runner_pane", executionId: undefined });
		writeQuotaWitness(path, value);

		expect(readQuotaWitness(path, { uid: UID, now: NOW })).toEqual({
			status: "accepted",
			witness: value,
		});
	});

	it("distinguishes a missing witness", () => {
		expect(readQuotaWitness(path, { uid: UID, now: NOW })).toEqual({
			status: "rejected",
			reason: "missing",
		});
	});

	it("rejects a symlink and an owner mismatch", () => {
		const target = join(dir, "target.json");
		writeFileSync(target, `${JSON.stringify(witness())}\n`, { mode: 0o600 });
		symlinkSync(target, path);

		expect(readQuotaWitness(path, { uid: UID, now: NOW })).toEqual({
			status: "rejected",
			reason: "symlink",
		});

		rmSync(path);
		writeFileSync(path, `${JSON.stringify(witness())}\n`, { mode: 0o600 });
		expect(readQuotaWitness(path, { uid: UID + 1, now: NOW })).toEqual({
			status: "rejected",
			reason: "owner",
		});
	});

	it("rejects a non-owner-only witness", () => {
		writeFileSync(path, `${JSON.stringify(witness())}\n`, { mode: 0o644 });
		chmodSync(path, 0o644);

		expect(readQuotaWitness(path, { uid: UID, now: NOW })).toEqual({
			status: "rejected",
			reason: "mode",
		});
	});

	it.each([
		["stale", { observedAt: NOW - WITNESS_MAX_AGE_MS - 1 }, "stale"],
		["future", { observedAt: NOW + WITNESS_MAX_FUTURE_MS + 1 }, "future"],
	])("rejects a %s witness", (_label, overrides, reason) => {
		writeFileSync(path, `${JSON.stringify(witness(overrides))}\n`, {
			mode: 0o600,
		});

		expect(readQuotaWitness(path, { uid: UID, now: NOW })).toEqual({
			status: "rejected",
			reason,
		});
	});

	it.each([
		["wrong version", { version: 2 }],
		["wrong kind", { kind: "usage_limit" }],
		["wrong source", { source: "manual" }],
		["unsafe execution id", { executionId: "bad\nvalue" }],
		["bad digest", { evidenceDigest: "abc" }],
		["uppercase digest", { evidenceDigest: "A".repeat(64) }],
		["non-integer time", { observedAt: NOW + 0.5 }],
		["unknown field", { unexpected: true }],
	])("rejects an invalid payload: %s", (_label, overrides) => {
		writeFileSync(path, `${JSON.stringify(witness(overrides))}\n`, {
			mode: 0o600,
		});

		expect(readQuotaWitness(path, { uid: UID, now: NOW })).toEqual({
			status: "rejected",
			reason: "invalid",
		});
	});
});
