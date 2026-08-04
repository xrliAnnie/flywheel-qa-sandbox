import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteLease, writeLease } from "../channel-lease.js";

const roots: string[] = [];
function leasePath(): string {
	const root = mkdtempSync(join(tmpdir(), "flywheel-channel-lease-"));
	roots.push(root);
	return join(root, "sub", ".inbox-ready-test");
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("channel lease", () => {
	// FLY-1547 §2.9 reverse-compat: the v1 CommDB inbox-mcp lease wire shape
	// ({pid, startedAt}) must not change — Bridge's runtime selector reads it.
	it("writes the v1 wire shape byte-compatibly when no health field is given", () => {
		const path = leasePath();
		writeLease(path, { pid: 4242, startedAt: "2026-07-30T00:00:00.000Z" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			pid: 4242,
			startedAt: "2026-07-30T00:00:00.000Z",
		});
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual([
			"pid",
			"startedAt",
		]);
	});

	it("deletes idempotently", () => {
		const path = leasePath();
		writeLease(path, { pid: process.pid });
		expect(existsSync(path)).toBe(true);
		deleteLease(path);
		expect(existsSync(path)).toBe(false);
		deleteLease(path); // idempotent
	});
});
