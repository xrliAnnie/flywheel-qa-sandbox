/**
 * FLY-766: `StateStore.getDbPath()` returns the actual opened db path — the
 * ownership truth threaded into the per-runner Chrome owner marker + used by the
 * reaper. Must reflect what the constructor opened, for both `:memory:` and a
 * real file path (so the plugin `:memory:` reaper guard + owner-match work).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const tempDirs: string[] = [];

describe("StateStore.getDbPath (FLY-766)", () => {
	afterEach(() => {
		for (const d of tempDirs.splice(0))
			rmSync(d, { recursive: true, force: true });
	});

	it("returns ':memory:' for an in-memory store", async () => {
		const store = await StateStore.create(":memory:");
		expect(store.getDbPath()).toBe(":memory:");
	});

	it("returns the exact file path for a file-backed store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly766-dbpath-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "teamlead.db");
		const store = await StateStore.create(dbPath);
		expect(store.getDbPath()).toBe(dbPath);
	});
});
