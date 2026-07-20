/**
 * FLY-1356 — sessions.skill_framework_mode/_via persistence + sticky stamp.
 *
 * Covers:
 *  - idempotent ADD COLUMN migration (fresh DB + double-migrate)
 *  - upsert writes both columns; row read maps them back (garbage → undefined)
 *  - COALESCE keeps the recorded arm across later field-less upserts
 *  - getSkillFrameworkStamp: latest non-null arm per issue_id (R1#4 sticky);
 *    garbage column values fail closed to "no stamp"
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SessionUpsert } from "../StateStore.js";
import { StateStore } from "../StateStore.js";

function makeSession(overrides: Partial<SessionUpsert> = {}): SessionUpsert {
	return {
		execution_id: "exec-1",
		issue_id: "FLY-1356",
		project_name: "flywheel",
		status: "running",
		...overrides,
	};
}

describe("FLY-1356 StateStore skill-framework columns", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("migration is idempotent (double migrate keeps working)", () => {
		store.migrate();
		store.upsertSession(
			makeSession({
				skill_framework_mode: "matt",
				skill_framework_mode_via: "forced",
			}),
		);
		expect(store.getSession("exec-1")?.skill_framework_mode).toBe("matt");
	});

	it("upsert persists mode + via and the row reader maps them back", () => {
		store.upsertSession(
			makeSession({
				skill_framework_mode: "bare",
				skill_framework_mode_via: "hash",
			}),
		);
		const row = store.getSession("exec-1")!;
		expect(row.skill_framework_mode).toBe("bare");
		expect(row.skill_framework_mode_via).toBe("hash");
	});

	it("absent fields leave the columns untouched (default flag → NULL columns)", () => {
		store.upsertSession(makeSession());
		const row = store.getSession("exec-1")!;
		expect(row.skill_framework_mode).toBeUndefined();
		expect(row.skill_framework_mode_via ?? undefined).toBeUndefined();
	});

	it("a later field-less upsert keeps the recorded arm (COALESCE)", () => {
		store.upsertSession(
			makeSession({
				skill_framework_mode: "bare",
				skill_framework_mode_via: "override",
			}),
		);
		store.upsertSession(makeSession({ status: "completed" }));
		const row = store.getSession("exec-1")!;
		expect(row.status).toBe("completed");
		expect(row.skill_framework_mode).toBe("bare");
		expect(row.skill_framework_mode_via).toBe("override");
	});

	describe("getSkillFrameworkStamp (R1#4 sticky)", () => {
		it("returns undefined when no session recorded an arm", () => {
			store.upsertSession(makeSession());
			expect(store.getSkillFrameworkStamp("FLY-1356")).toBeUndefined();
			expect(store.getSkillFrameworkStamp("FLY-9999")).toBeUndefined();
		});

		it("returns the most recently active recorded arm for the issue", () => {
			store.upsertSession(
				makeSession({
					execution_id: "exec-old",
					last_activity_at: "2026-07-19T00:00:00Z",
					skill_framework_mode: "matt",
					skill_framework_mode_via: "hash",
				}),
			);
			store.upsertSession(
				makeSession({
					execution_id: "exec-new",
					last_activity_at: "2026-07-20T00:00:00Z",
					skill_framework_mode: "bare",
					skill_framework_mode_via: "override",
				}),
			);
			// A mode-less session (e.g. post-kill A run) must NOT mask the stamp.
			store.upsertSession(
				makeSession({
					execution_id: "exec-noarm",
					last_activity_at: "2026-07-21T00:00:00Z",
				}),
			);
			expect(store.getSkillFrameworkStamp("FLY-1356")).toBe("bare");
		});

		it("garbage column values fail closed to no stamp", () => {
			store.upsertSession(makeSession());
			// Simulate a corrupted/legacy row bypassing the typed layer.
			(store as any).db.run(
				"UPDATE sessions SET skill_framework_mode = 'garbage' WHERE execution_id = 'exec-1'",
			);
			expect(store.getSkillFrameworkStamp("FLY-1356")).toBeUndefined();
		});
	});
});
