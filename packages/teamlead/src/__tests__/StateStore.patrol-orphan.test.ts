import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-2118 StateStore orphan patrol episodes", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists one episode per target and supports replacement and cleanup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2118-orphan-store-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "teamlead.db");
		let store = await StateStore.create(dbPath);

		store.upsertPatrolOrphanWatch({
			target: "runner-flywheel:@7",
			paneFingerprint: "%7:1724860000",
			firstSeenAt: 1_724_860_000_000,
			streak: 1,
			lastSlotStart: 1_724_860_000_000,
			intervalMs: 3_600_000,
			lastAlertAt: null,
		});
		expect(store.getPatrolOrphanWatch("runner-flywheel:@7")).toEqual({
			target: "runner-flywheel:@7",
			paneFingerprint: "%7:1724860000",
			firstSeenAt: 1_724_860_000_000,
			streak: 1,
			lastSlotStart: 1_724_860_000_000,
			intervalMs: 3_600_000,
			lastAlertAt: null,
		});

		store.upsertPatrolOrphanWatch({
			target: "runner-flywheel:@7",
			paneFingerprint: "%8:1724863600",
			firstSeenAt: 1_724_863_600_000,
			streak: 2,
			lastSlotStart: 1_724_863_600_000,
			intervalMs: 3_600_000,
			lastAlertAt: 1_724_863_600_000,
		});
		expect(store.listPatrolOrphanWatches()).toEqual([
			{
				target: "runner-flywheel:@7",
				paneFingerprint: "%8:1724863600",
				firstSeenAt: 1_724_863_600_000,
				streak: 2,
				lastSlotStart: 1_724_863_600_000,
				intervalMs: 3_600_000,
				lastAlertAt: 1_724_863_600_000,
			},
		]);
		store.close();

		store = await StateStore.create(dbPath);
		expect(store.getPatrolOrphanWatch("runner-flywheel:@7")?.streak).toBe(2);
		store.deletePatrolOrphanWatch("runner-flywheel:@7");
		expect(store.listPatrolOrphanWatches()).toEqual([]);
		store.close();
	});
});
