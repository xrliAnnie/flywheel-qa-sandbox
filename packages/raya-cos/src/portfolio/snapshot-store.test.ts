import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SnapshotStore } from "./snapshot-store.js";
import type { PortfolioSnapshot } from "./types.js";

function snapshot(snapshotId: string, seq: number): PortfolioSnapshot {
	return {
		v: 1,
		snapshotId,
		seq,
		sampledAt: "2026-09-06T12:00:00Z",
		trigger: "test",
		projects: [],
		activityAvailable: false,
		all: { git: "unavailable", gh: "unavailable", linear: "unavailable" },
	};
}

describe("SnapshotStore", () => {
	it("does not let an out-of-order completion move latest backward", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "raya-snapshots-order-"));
		const store = new SnapshotStore(stateDir);

		store.write(snapshot("newer", 2));
		store.write(snapshot("older", 1));

		expect(store.readLatest()?.snapshotId).toBe("newer");
		expect(
			JSON.parse(readFileSync(store.latestPath, "utf8")) as PortfolioSnapshot,
		).toMatchObject({ snapshotId: "newer", seq: 2 });
	});

	it("keeps the newest 50 snapshot files and reports each prune", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "raya-snapshots-prune-"));
		const onPruned = vi.fn();
		const store = new SnapshotStore(stateDir, Date.now, onPruned);

		// Existing persisted snapshots are setup; exercise both pruning writes through
		// the real store without spending the test timeout fsyncing fifty fixtures.
		for (let sequence = 1; sequence <= 50; sequence += 1) {
			const existing = snapshot(
				`snapshot-${String(sequence).padStart(3, "0")}`,
				sequence,
			);
			writeFileSync(
				join(store.snapshotsRoot, `${existing.snapshotId}.json`),
				JSON.stringify(existing),
			);
		}
		writeFileSync(
			store.latestPath,
			JSON.stringify(snapshot("snapshot-050", 50)),
		);
		for (const sequence of [51, 52]) {
			store.write(
				snapshot(`snapshot-${String(sequence).padStart(3, "0")}`, sequence),
			);
		}

		const names = readdirSync(store.snapshotsRoot).sort();
		expect(names).toHaveLength(50);
		expect(names[0]).toBe("snapshot-003.json");
		expect(names.at(-1)).toBe("snapshot-052.json");
		expect(onPruned).toHaveBeenNthCalledWith(1, "snapshot-001");
		expect(onPruned).toHaveBeenNthCalledWith(2, "snapshot-002");
	});
	it("preserves corrupt latest data and refuses to overwrite a frozen snapshot", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "raya-snapshot-guards-"));
		const store = new SnapshotStore(stateDir);
		const first = snapshot("fixed", 1);
		store.write(first);
		store.write(first);
		expect(() => store.write({ ...first, trigger: "replacement" })).toThrow(
			/binding/,
		);
		writeFileSync(store.latestPath, "{broken");
		expect(() => store.readLatest()).toThrow();
		expect(readFileSync(store.latestPath, "utf8")).toBe("{broken");
		expect(() => store.write(snapshot("new", 2))).toThrow();
	});
	it("refuses symlinked files and a held writer lock", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "raya-snapshot-lock-"));
		const store = new SnapshotStore(stateDir);
		const target = join(stateDir, "target");
		writeFileSync(target, JSON.stringify(snapshot("outside", 3)));
		symlinkSync(target, store.latestPath);
		expect(() => store.readLatest()).toThrow();
		const other = new SnapshotStore(
			mkdtempSync(join(tmpdir(), "raya-snapshot-lock2-")),
		);
		writeFileSync(join(other.root, ".lock"), "existing owner");
		expect(() => other.write(snapshot("one", 1))).toThrow(/lock/);
		expect(readFileSync(join(other.root, ".lock"), "utf8")).toBe(
			"existing owner",
		);
	});
});
