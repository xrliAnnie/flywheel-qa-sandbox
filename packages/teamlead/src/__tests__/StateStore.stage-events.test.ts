import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { type SessionEvent, StateStore } from "../StateStore.js";

const event: SessionEvent = {
	event_id: "stage-1",
	execution_id: "exec-1",
	issue_id: "FLY-1956",
	project_name: "flywheel",
	event_type: "stage_changed",
	source: "flywheel-comm",
	payload: { stage: "test" },
};

async function fixture() {
	const store = await StateStore.create(":memory:");
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: "FLY-1956",
		project_name: "flywheel",
		status: "running",
		session_stage: "implement",
	});
	return store;
}

function archive(store: StateStore, eventId: string) {
	const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
	const row = db
		.prepare("SELECT * FROM session_events WHERE event_id = ?")
		.get(eventId) as Record<string, unknown>;
	const json = JSON.stringify(row);
	db.prepare(
		"INSERT INTO workflow_terminal_archive (source_table, source_identity, source_created_at, archived_at, row_json, row_sha256) VALUES ('session_events', ?, ?, ?, ?, ?)",
	).run(
		JSON.stringify([eventId]),
		row.ts,
		row.ts,
		json,
		createHash("sha256").update(json).digest("hex"),
	);
	db.prepare("DELETE FROM session_events WHERE event_id = ?").run(eventId);
}

describe("atomic stage event persistence", () => {
	it.each([
		{ ...event, event_type: "heartbeat" },
		{ ...event, payload: { stage: "invalid" } },
		{ ...event, payload: { stage: "implement" } },
	])(
		"rejects an inconsistent stage envelope before writing: %j",
		async (invalid) => {
			const store = await fixture();
			try {
				expect(() => store.insertStageChangedEvent(invalid, "test")).toThrow(
					"invalid_stage_event",
				);
				expect(store.getEventsByExecution("exec-1")).toEqual([]);
				expect(store.getSession("exec-1")?.session_stage).toBe("implement");
			} finally {
				store.close();
			}
		},
	);

	it("selects the greatest valid stage row id across hot and archived storage", async () => {
		const store = await fixture();
		try {
			expect(store.latestStageEvent("exec-1")).toBeUndefined();
			store.insertStageChangedEvent(event, "test");
			const newest = store.insertStageChangedEvent(
				{ ...event, event_id: "stage-2", payload: { stage: "code_review" } },
				"code_review",
			);
			archive(store, "stage-2");
			store.insertEvent({
				...event,
				event_id: "invalid-stage",
				payload: { stage: "not-a-stage" },
			});
			store.insertEvent({
				...event,
				event_id: "another-type",
				event_type: "heartbeat",
			});
			expect(store.latestStageEvent("exec-1")).toEqual(newest.row);
			expect(store.latestStageEvent("another-exec")).toBeUndefined();
			const hot = store.insertStageChangedEvent(
				{ ...event, event_id: "stage-3", payload: { stage: "pr_created" } },
				"pr_created",
			);
			expect(store.latestStageEvent("exec-1")).toEqual(hot.row);
		} finally {
			store.close();
		}
	});

	it.each(["hot", "archived"] as const)(
		"returns the original %s row for exact replay and refuses changed payload or ownership",
		async (source) => {
			const store = await fixture();
			try {
				const original = store.insertStageChangedEvent(event, "test");
				if (source === "archived") {
					archive(store, event.event_id);
				}
				store.patchSessionMetadata("exec-1", { session_stage: "code_review" });
				expect(store.insertStageChangedEvent(event, "test")).toEqual({
					kind: "duplicate",
					row: original.row,
					source,
				});
				for (const changed of [
					{ ...event, payload: { stage: "implement" } },
					{ ...event, execution_id: "another-exec" },
					{ ...event, source: "another-producer" },
				]) {
					expect(
						store.insertStageChangedEvent(
							changed,
							String((changed.payload as { stage: string }).stage),
						),
					).toEqual({ kind: "payload_conflict", row: original.row });
				}
				expect(store.getSession("exec-1")?.session_stage).toBe("code_review");
			} finally {
				store.close();
			}
		},
	);

	it("commits the canonical event and matching session projection together", async () => {
		const store = await fixture();
		try {
			const result = store.insertStageChangedEvent(event, "test");
			expect(result.kind).toBe("inserted");
			expect(result.row).toMatchObject({
				...event,
				id: expect.any(Number),
				ts: expect.any(String),
			});
			expect(store.getSession("exec-1")).toMatchObject({
				session_stage: "test",
				stage_updated_at: result.row.ts,
				last_activity_at: result.row.ts,
			});
		} finally {
			store.close();
		}
	});

	it("rolls back the event when projecting the session fails", async () => {
		const store = await fixture();
		try {
			vi.spyOn(store, "patchSessionMetadata").mockImplementationOnce(() => {
				throw new Error("projection failed");
			});
			expect(() => store.insertStageChangedEvent(event, "test")).toThrow(
				"projection failed",
			);
			expect(store.getEventsByExecution("exec-1")).toEqual([]);
			expect(store.getSession("exec-1")?.session_stage).toBe("implement");
		} finally {
			store.close();
		}
	});
});
