import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteLease,
	leaseIsHealthy,
	readLease,
	touchLease,
	writeLease,
} from "../channel-lease.js";

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

	it("round-trips read/touch/delete", () => {
		const path = leasePath();
		writeLease(path, { pid: process.pid });
		touchLease(path, "2026-07-30T01:00:00.000Z");
		expect(readLease(path)?.lastOkAt).toBe("2026-07-30T01:00:00.000Z");
		deleteLease(path);
		expect(readLease(path)).toBeUndefined();
		deleteLease(path); // idempotent
	});

	it("health requires existence, live pid AND fresh lastOkAt", () => {
		const path = leasePath();
		const nowMs = Date.parse("2026-07-30T01:00:10.000Z");
		const live = () => true;
		// missing file
		expect(
			leaseIsHealthy(path, { nowMs, maxAgeMs: 15_000, pidIsLive: live }),
		).toBe(false);
		// legacy lease without lastOkAt is never healthy
		writeLease(path, { pid: 1 });
		expect(
			leaseIsHealthy(path, { nowMs, maxAgeMs: 15_000, pidIsLive: live }),
		).toBe(false);
		// fresh + live
		touchLease(path, "2026-07-30T01:00:00.000Z");
		expect(
			leaseIsHealthy(path, { nowMs, maxAgeMs: 15_000, pidIsLive: live }),
		).toBe(true);
		// stale
		expect(
			leaseIsHealthy(path, { nowMs, maxAgeMs: 5_000, pidIsLive: live }),
		).toBe(false);
		// dead pid
		expect(
			leaseIsHealthy(path, { nowMs, maxAgeMs: 15_000, pidIsLive: () => false }),
		).toBe(false);
	});
});
