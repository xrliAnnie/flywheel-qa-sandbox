import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ShipJudgmentOutcomes } from "../outcomes.js";
import { bindingFixture, NOW } from "./binding-fixture.js";

it("retires automatic dependency retries after ten attempts while retaining the pending diagnosis", async () => {
	const { store, db } = await bindingFixture();
	try {
		db.prepare(
			`INSERT INTO ship_judgment_observation_pending(project_name,source_kind,source_id,reason,next_attempt_at,updated_at) VALUES ('flywheel','closeout','999','restore_replay','',?)`,
		).run(NOW);
		for (let minute = 0; minute < 15; minute++)
			new ShipJudgmentOutcomes(db).observeCancellations(
				new Date(Date.parse(NOW) + minute * 60_000).toISOString(),
			);
		expect(
			db
				.prepare(
					"SELECT reason,attempts,next_attempt_at FROM ship_judgment_observation_pending",
				)
				.get(),
		).toEqual({ reason: "dependency", attempts: 10, next_attempt_at: null });
	} finally {
		store.close();
	}
});

it.each(["FLY-2399", "unmatched"])(
	"enqueues restored source %s without rewinding the global cursor",
	async (issueId) => {
		const { store, db } = await bindingFixture();
		try {
			db.prepare("UPDATE workflow_run SET created_at=?").run(NOW);
			store.insertEvent({
				event_id: "restored",
				execution_id: "closeout",
				issue_id: issueId,
				project_name: "flywheel",
				event_type: "closeout_report",
				source: "bridge.lifecycle-closeout",
				payload: { disposition: "canceled" },
			});
			db.prepare("UPDATE session_events SET ts=?").run(NOW);
			const row = db
				.prepare("SELECT * FROM session_events WHERE event_id='restored'")
				.get() as { id: number };
			const json = JSON.stringify(row);
			db.prepare(
				`INSERT INTO workflow_terminal_archive(source_table,source_identity,source_created_at,archived_at,row_json,row_sha256) VALUES ('session_events',?,?,?,?,?)`,
			).run(
				String(row.id),
				NOW,
				NOW,
				json,
				createHash("sha256").update(json).digest("hex"),
			);
			db.prepare("DELETE FROM session_events WHERE id=?").run(row.id);
			db.exec(
				"UPDATE ship_judgment_observation_cursor SET last_event_id=100 WHERE source_kind='closeout'",
			);
			const result = store.restoreTerminalRow({
				sourceTable: "session_events",
				sourceIdentity: String(row.id),
			});
			expect(result).toMatchObject({
				outcome: "restored",
				observationReplay: { status: "enqueued" },
			});
			expect(new ShipJudgmentOutcomes(db).observeCancellations(NOW)).toBe(
				issueId === "unmatched" ? 0 : 1,
			);
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM ship_judgment_observation_pending",
					)
					.get(),
			).toEqual({ n: 0 });
			expect(
				db
					.prepare(
						"SELECT last_event_id FROM ship_judgment_observation_cursor WHERE source_kind='closeout'",
					)
					.get(),
			).toEqual({ last_event_id: 100 });
			expect(
				store.restoreTerminalRow({
					sourceTable: "session_events",
					sourceIdentity: String(row.id),
				}),
			).toMatchObject({
				outcome: "idempotent",
				observationReplay: { status: "enqueued" },
			});
			expect(new ShipJudgmentOutcomes(db).observeCancellations(NOW)).toBe(0);
		} finally {
			store.close();
		}
	},
);

it("keeps successful restore visible when replay storage fails, and permits an exact retry", async () => {
	const { store, db } = await bindingFixture();
	try {
		store.insertEvent({
			event_id: "restored-failure",
			execution_id: "closeout",
			issue_id: "unmatched",
			project_name: "flywheel",
			event_type: "closeout_report",
			source: "bridge.lifecycle-closeout",
			payload: { disposition: "canceled" },
		});
		const row = db
			.prepare("SELECT * FROM session_events WHERE event_id='restored-failure'")
			.get() as { id: number; ts: string };
		const json = JSON.stringify(row);
		db.prepare(
			`INSERT INTO workflow_terminal_archive(source_table,source_identity,source_created_at,archived_at,row_json,row_sha256) VALUES ('session_events',?,?,?,?,?)`,
		).run(
			String(row.id),
			row.ts,
			NOW,
			json,
			createHash("sha256").update(json).digest("hex"),
		);
		db.prepare("DELETE FROM session_events WHERE id=?").run(row.id);
		db.exec(
			"CREATE TRIGGER reject_replay BEFORE INSERT ON ship_judgment_observation_pending BEGIN SELECT RAISE(ABORT,'replay failure'); END",
		);
		const input = {
			sourceTable: "session_events" as const,
			sourceIdentity: String(row.id),
		};
		expect(store.restoreTerminalRow(input)).toMatchObject({
			outcome: "restored",
			observationReplay: {
				status: "unavailable",
				reason: "replay_enqueue_failed",
			},
		});
		expect(
			db.prepare("SELECT id FROM session_events WHERE id=?").get(row.id),
		).toEqual({ id: row.id });
		db.exec("DROP TRIGGER reject_replay");
		expect(store.restoreTerminalRow(input)).toMatchObject({
			outcome: "idempotent",
			observationReplay: { status: "enqueued" },
		});
	} finally {
		store.close();
	}
});
