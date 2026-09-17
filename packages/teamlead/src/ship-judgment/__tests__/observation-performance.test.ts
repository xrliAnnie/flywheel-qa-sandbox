import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { ShipJudgmentOutcomes } from "../outcomes.js";
import { ShipJudgmentRuntime } from "../runtime.js";
import { bindingFixture, HEAD, NOW } from "./binding-fixture.js";

it("bounds observation work with 1.7M events and 500 holders", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2563-observation-performance-"));
	const path = join(root, "fixture.db");
	const { store, db } = await bindingFixture(path);
	const clock = vi.spyOn(performance, "now").mockReturnValue(0);
	const checkpoint = () => {
		const result = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
			busy?: number;
		}>;
		expect(result[0]?.busy).toBe(0);
		expect(statSync(`${path}-wal`).size).toBe(0);
	};
	try {
		db.prepare("UPDATE workflow_run SET created_at=?").run(NOW);
		db.transaction(() => {
			const insert = db.prepare(
				`INSERT INTO workflow_gate_holder(run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,state,created_at,updated_at) VALUES ('r','founder_gate',? ,?,'execution',?,'superseded',?,?)`,
			);
			for (let i = 2; i <= 500; i++)
				insert.run(i, HEAD, `q-${String(i).padStart(4, "0")}`, NOW, NOW);
			db.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<1700000)
    INSERT INTO session_events(event_id,execution_id,issue_id,project_name,event_type,source,payload,ts)
    SELECT 'performance-'||n,'fixture',CASE WHEN n<=50 THEN 'FLY-2399' ELSE 'unmatched' END,'flywheel',
      CASE WHEN n<=2729 THEN 'closeout_report' ELSE 'performance_noise' END,
      CASE WHEN n<=2729 THEN 'bridge.lifecycle-closeout' ELSE 'fixture' END,
      CASE WHEN n<=2729 THEN '{"disposition":"canceled"}' ELSE '{}' END,? FROM numbers`).run(
				NOW,
			);
		})();
		checkpoint();
		expect(
			db.prepare("SELECT count(*) AS n FROM session_events").get(),
		).toEqual({ n: 1_700_000 });
		expect(
			db.prepare("SELECT count(*) AS n FROM workflow_gate_holder").get(),
		).toEqual({ n: 500 });

		const observer = new ShipJudgmentOutcomes(db);
		const pages: ReturnType<typeof observer.pageStats>[] = [];
		const observe = () => {
			const changed = observer.observeCancellations(NOW);
			const stats = observer.pageStats();
			expect(stats.sourceCandidates).toBeLessThanOrEqual(40);
			expect(stats.holderCandidates).toBeLessThanOrEqual(16);
			expect(stats.cursorAfter).toBeGreaterThanOrEqual(stats.cursorBefore);
			pages.push(stats);
			return { changed, stats };
		};
		const betweenPages = () =>
			new Promise<void>((resolve) => setImmediate(resolve));

		let changed = 0;
		for (let i = 0; i < 5; i++) {
			changed += observe().changed;
			await betweenPages();
		}
		expect(changed).toBeGreaterThan(0);
		expect(pages.some((page) => page.cursorAfter > page.cursorBefore)).toBe(
			true,
		);

		let drained = false;
		for (let i = 0; i < 10_000; i++) {
			const { stats } = observe();
			await betweenPages();
			if (
				stats.sourceCandidates === 0 &&
				(
					db
						.prepare(
							"SELECT count(*) AS n FROM ship_judgment_observation_pending",
						)
						.get() as { n: number }
				).n === 0
			) {
				drained = true;
				break;
			}
		}
		expect(drained).toBe(true);
		expect(
			db
				.prepare(
					"SELECT count(*) AS n FROM ship_judgment_outcome WHERE source_kind='closeout'",
				)
				.get(),
		).toEqual({ n: 25_000 });

		for (let i = 0; i < 5; i++) {
			const { stats } = observe();
			expect(stats).toMatchObject({
				sourceCandidates: 0,
				holderCandidates: 0,
				outcomes: 0,
			});
		}

		checkpoint();
		const append = (id: string) =>
			store.insertEvent({
				event_id: id,
				execution_id: "fixture",
				issue_id: "FLY-2399",
				project_name: "flywheel",
				event_type: "closeout_report",
				source: "bridge.lifecycle-closeout",
				payload: { disposition: "canceled" },
			});
		for (let i = 0; i < 5; i++) {
			append(`tail-${i}`);
			db.prepare("UPDATE session_events SET ts=? WHERE event_id=?").run(
				NOW,
				`tail-${i}`,
			);
			const { stats } = observe();
			expect(stats.outcomes).toBeGreaterThan(0);
			expect(stats.cursorAfter).toBeGreaterThan(stats.cursorBefore);
			await betweenPages();
		}

		checkpoint();
		const progress = vi.spyOn(store, "recordShipJudgmentObservationProgress");
		for (const mode of ["auto_merge_narrow_gate", "dry_run"] as const) {
			const onError = vi.fn();
			const runtime = new ShipJudgmentRuntime({
				store,
				owner: "performance-fixture",
				mode: () => mode,
				now: () => Date.parse(NOW),
				collect: vi.fn(),
				evaluate: vi.fn(),
				material: vi.fn(),
				unavailable: vi.fn(),
				onError,
			});
			try {
				for (let i = 0; i < 5; i++) await runtime.modeTick();
				expect(onError).not.toHaveBeenCalled();
			} finally {
				await runtime.stop();
			}
		}
		const progressCalls = progress.mock.calls;
		expect(
			progressCalls.some(
				([source, inspected]) => source === "closeout" && inspected > 0,
			),
		).toBe(true);
		expect(
			progressCalls
				.filter(([source]) => source === "verdict")
				.every(([, inspected]) => inspected === 0),
		).toBe(true);
	} finally {
		clock.mockRestore();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);
