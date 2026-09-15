import { expect, it, vi } from "vitest";
import { observationStorageHealth } from "../../bridge/observation-storage-alert.js";
import { ShipJudgmentRuntime } from "../runtime.js";
import { bindingFixture, NOW } from "./binding-fixture.js";

it("counts exhausted archive calls without forcing a candidate and clears after an unstalled pass", async () => {
	const { store, db } = await bindingFixture();
	let elapsed = 0;
	let delayNextRead = false;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	const prepare = db.prepare.bind(db);
	const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
		if (delayNextRead && sql.trimStart().startsWith("SELECT")) {
			elapsed += 60;
			delayNextRead = false;
		}
		return prepare(sql);
	});
	try {
		for (let i = 0; i < 3; i++) {
			delayNextRead = true;
			expect(store.archiveTerminalRows({ now: NOW }).scanned).toBe(0);
		}
		expect(observationStorageHealth(store)).toMatchObject({
			starved: true,
			zero_progress_ticks: { archive: 3 },
		});
		delayNextRead = false;
		store.archiveTerminalRows({ now: NOW });
		expect(observationStorageHealth(store)).toMatchObject({
			starved: false,
			zero_progress_ticks: { archive: 0 },
		});
	} finally {
		spy.mockRestore();
		clock.mockRestore();
		store.close();
	}
});

it("reports consecutive budget-exhausted zero-progress ticks and resets on useful or idle work", async () => {
	const { store } = await bindingFixture();
	try {
		for (const kind of [
			"verdict",
			"closeout",
			"clarification",
			"archive",
		] as const) {
			for (let i = 0; i < 3; i++)
				store.recordShipJudgmentObservationProgress(kind, 0, 30, 25);
			expect(observationStorageHealth(store)).toMatchObject({
				starved: true,
				zero_progress_ticks: { [kind]: 3 },
			});
			store.recordShipJudgmentObservationProgress(kind, 1, 30, 25);
			expect(observationStorageHealth(store)).toMatchObject({
				starved: false,
				zero_progress_ticks: { [kind]: 0 },
			});
			store.recordShipJudgmentObservationProgress(kind, 0, 30, 25);
			store.recordShipJudgmentObservationProgress(kind, 0, 1, 25);
			expect(observationStorageHealth(store)).toMatchObject({
				starved: false,
				zero_progress_ticks: { [kind]: 0 },
			});
		}
	} finally {
		store.close();
	}
});

it("keeps exhausted real observer pages empty, exposes starvation, and resumes next unstalled tick", async () => {
	const { store, db } = await bindingFixture();
	db.prepare("UPDATE workflow_run SET created_at=?").run(NOW);
	store.insertEvent({
		event_id: "starvation-closeout",
		execution_id: "fixture",
		issue_id: "FLY-2399",
		project_name: "flywheel",
		event_type: "closeout_report",
		source: "bridge.lifecycle-closeout",
		payload: { disposition: "canceled" },
	});
	db.prepare(
		"UPDATE session_events SET ts=? WHERE event_id='starvation-closeout'",
	).run(NOW);
	let elapsed = 0;
	let stalled = true;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	const prepare = db.prepare.bind(db);
	const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
		if (
			stalled &&
			(sql.startsWith("SELECT * FROM ship_judgment_observation_cursor") ||
				sql.startsWith(
					"SELECT last_event_id FROM ship_judgment_observation_cursor",
				) ||
				sql.startsWith("INSERT OR IGNORE INTO ship_judgment_project_state"))
		)
			elapsed += 30;
		return prepare(sql);
	});
	const runtime = new ShipJudgmentRuntime({
		store,
		owner: "starvation",
		mode: () => "dry_run",
		now: () => Date.parse(NOW),
		collect: vi.fn(),
		evaluate: vi.fn(),
		material: vi.fn(),
		unavailable: vi.fn(),
	});
	try {
		for (let i = 0; i < 3; i++) await runtime.modeTick();
		expect(
			db.prepare("SELECT count(*) AS n FROM ship_judgment_outcome").get(),
		).toEqual({ n: 0 });
		expect(observationStorageHealth(store)).toMatchObject({
			status: "ready",
			starved: true,
			zero_progress_ticks: { closeout: 3, verdict: 3, clarification: 3 },
		});
		stalled = false;
		await runtime.modeTick();
		expect(
			db.prepare("SELECT count(*) AS n FROM ship_judgment_outcome").get(),
		).toEqual({ n: 1 });
		expect(observationStorageHealth(store)).toMatchObject({
			starved: false,
			zero_progress_ticks: { closeout: 0, verdict: 0, clarification: 0 },
		});
	} finally {
		await runtime.stop();
		spy.mockRestore();
		clock.mockRestore();
		store.close();
	}
});
