import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("StateStore.getLeadEventSessionKeyBySeq (FLY-2882)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("returns only the session key and never selects the payload", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2882-store-"));
		dirs.push(dir);
		const store = await StateStore.create(join(dir, "teamlead.db"));
		try {
			const seq = store.appendLeadEvent(
				"flywheel-eng-lead",
				"evt-1",
				"session_completed",
				JSON.stringify({ note: "SENTINEL-PAYLOAD" }),
				"flywheel:FLY-2830",
			);
			const bare = store.appendLeadEvent(
				"flywheel-eng-lead",
				"evt-2",
				"session_completed",
				JSON.stringify({ note: "SENTINEL-PAYLOAD" }),
			);
			const raw = (
				store as unknown as {
					db: { raw: { prepare(sql: string): unknown } };
				}
			).db.raw;
			const prepare = raw.prepare.bind(raw);
			const seen: string[] = [];
			raw.prepare = (sql: string) => {
				seen.push(sql);
				return prepare(sql);
			};
			expect(store.getLeadEventSessionKeyBySeq(seq)).toBe("flywheel:FLY-2830");
			expect(store.getLeadEventSessionKeyBySeq(bare)).toBeNull();
			expect(store.getLeadEventSessionKeyBySeq(seq + 1000)).toBeNull();
			expect(seen.length).toBeGreaterThan(0);
			for (const sql of seen) {
				expect(sql).toMatch(
					/SELECT session_key FROM lead_events WHERE seq = \?/,
				);
				expect(sql).not.toMatch(/payload|\*/);
			}
		} finally {
			store.close();
		}
	});
});
