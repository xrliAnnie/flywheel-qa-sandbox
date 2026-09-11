import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendAudit,
	ledgerPath,
	parseLedgerFile,
	persistSnapshot,
	quarantineCorrupt,
} from "../roundtable-subscription-ledger.js";

const dirs: string[] = [];
function dir() {
	const d = mkdtempSync(join(tmpdir(), "rt-ledger-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("subscription ledger", () => {
	it("atomically persists and reads, rejecting malformed entries without rewriting", () => {
		const d = dir(),
			path = ledgerPath(d);
		expect(parseLedgerFile(path)).toEqual({ ok: false, reason: "missing" });
		persistSnapshot(path, { version: 1, entries: [] });
		expect(parseLedgerFile(path)).toEqual({
			ok: true,
			snapshot: { version: 1, entries: [] },
			dropped: [],
		});
		const raw = JSON.stringify({ version: 1, entries: [{ threadId: "bad" }] });
		writeFileSync(path, raw);
		const result = parseLedgerFile(path);
		expect(result.ok && result.dropped).toHaveLength(1);
		expect(readFileSync(path, "utf8")).toBe(raw);
		expect(readdirSync(d)).toEqual(["roundtable-subscriptions.json"]);
	});
	it("quarantines corrupt files uniquely and audit failure never throws", () => {
		const path = ledgerPath(dir());
		writeFileSync(path, "bad");
		expect(parseLedgerFile(path)).toEqual({ ok: false, reason: "corrupt" });
		quarantineCorrupt(path);
		writeFileSync(path, "bad");
		quarantineCorrupt(path);
		expect(readdirSync(path.substring(0, path.lastIndexOf("/")))).toHaveLength(
			2,
		);
		expect(() =>
			appendAudit("/dev/null/no-file", { op: "test" }),
		).not.toThrow();
	});
});
