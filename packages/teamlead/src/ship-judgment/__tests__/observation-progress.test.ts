import { expect, it, vi } from "vitest";
import { observationStorageHealth } from "../../bridge/observation-storage-alert.js";
import { ShipJudgmentOutcomes } from "../outcomes.js";
import { ShipJudgmentRuntime } from "../runtime.js";
import { bindingFixture, HEAD, NOW } from "./binding-fixture.js";

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

it("does not report productive slow verdict pages as starvation", async () => {
	const { store, db } = await bindingFixture();
	let elapsed = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	const original = ShipJudgmentOutcomes.prototype.observeVerdicts;
	const observe = vi
		.spyOn(ShipJudgmentOutcomes.prototype, "observeVerdicts")
		.mockImplementation(function (now) {
			const result = original.call(this, now);
			elapsed += 30;
			return result;
		});
	const runtime = new ShipJudgmentRuntime({
		store,
		owner: "productive",
		mode: () => "dry_run",
		now: () => Date.parse(NOW),
		collect: vi.fn(),
		evaluate: vi.fn(),
		material: vi.fn(),
		unavailable: vi.fn(),
	});
	try {
		db.prepare(`INSERT INTO workflow_rework_request(request_id,run_id,source_event_id,authority,source_node_id,source_attempt,base_revision,authority_context_json,authority_context_digest,founder_feedback_verbatim,requested_at)
 VALUES ('rework','r','source','founder','founder_gate',1,?,'{}',?,'feedback',?)`).run(
			HEAD,
			"b".repeat(64),
			NOW,
		);
		const insert =
			db.prepare(`INSERT INTO workflow_founder_gate_verdict(verdict_id,source_event_id,run_id,gate_node_id,attempt,verdict,question_id,repo_identity,repo_slug,pr_number,head_sha,rework_request_id,claim_id,founder_authored,author_evidence_json,row_digest,recorded_at)
 VALUES (?,?,'r','founder_gate',1,'rework','q','__main__','owner/repo',2399,?,'rework',NULL,0,'{}',?,?)`);
		for (let i = 0; i < 60; i++)
			insert.run(
				`v-${String(i).padStart(3, "0")}`,
				`source-${i}`,
				HEAD,
				"c".repeat(64),
				NOW,
			);
		let previous = 0;
		for (let i = 0; i < 3; i++) {
			await runtime.modeTick();
			const count = (
				db.prepare("SELECT count(*) AS n FROM ship_judgment_outcome").get() as {
					n: number;
				}
			).n;
			expect(count).toBeGreaterThan(previous);
			previous = count;
		}
		expect(observationStorageHealth(store)).toMatchObject({
			starved: false,
			zero_progress_ticks: { verdict: 0 },
		});
	} finally {
		await runtime.stop();
		observe.mockRestore();
		clock.mockRestore();
		store.close();
	}
});
