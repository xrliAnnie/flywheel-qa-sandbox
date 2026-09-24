import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readClaudeManualPrepaid } from "../manual-prepaid.js";

function write(path: string, value: unknown) {
	writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

describe("FLY-2807 — trusted manual Claude prepaid input", () => {
	it("reads provenance-complete cards only from inside the state directory", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "fly2807-manual-"));
		const path = join(stateDir, "manual-prepaid.json");
		write(path, {
			version: 1,
			accounts: [
				{
					account: "business",
					confirmedBy: "founder",
					confirmedAt: "2026-09-23T00:00:00.000Z",
					cards: [
						{ expiresAt: "2026-10-16T00:00:00.000Z" },
						{ expiresAt: "2026-10-01T00:00:00.000Z" },
					],
				},
			],
		});
		expect(readClaudeManualPrepaid(path, stateDir)).toEqual([
			{
				account: "business",
				confirmedBy: "founder",
				confirmedAt: "2026-09-23T00:00:00.000Z",
				cards: [
					{ expiresAt: "2026-10-01T00:00:00.000Z" },
					{ expiresAt: "2026-10-16T00:00:00.000Z" },
				],
			},
		]);
	});

	it("rejects writable, duplicate, malformed or out-of-state inputs", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "fly2807-manual-"));
		const path = join(stateDir, "manual-prepaid.json");
		const valid = {
			version: 1,
			accounts: [
				{
					account: "business",
					confirmedBy: "founder",
					confirmedAt: "2026-09-23T00:00:00.000Z",
					cards: [{ expiresAt: "2026-10-01T00:00:00.000Z" }],
				},
			],
		};
		write(path, valid);
		chmodSync(path, 0o666);
		expect(readClaudeManualPrepaid(path, stateDir)).toBeNull();

		write(path, { ...valid, accounts: [valid.accounts[0], valid.accounts[0]] });
		expect(readClaudeManualPrepaid(path, stateDir)).toBeNull();

		const outside = join(tmpdir(), `outside-${process.pid}.json`);
		write(outside, valid);
		expect(readClaudeManualPrepaid(outside, stateDir)).toBeNull();

		const externalDir = mkdtempSync(join(tmpdir(), "fly2807-manual-external-"));
		const linkedDir = join(stateDir, "linked");
		mkdirSync(externalDir, { recursive: true });
		write(join(externalDir, "manual-prepaid.json"), valid);
		symlinkSync(externalDir, linkedDir);
		expect(
			readClaudeManualPrepaid(join(linkedDir, "manual-prepaid.json"), stateDir),
		).toBeNull();
	});
});
