import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { ShipJudgmentOutcomes } from "../outcomes.js";
import { ShipJudgmentRuntime } from "../runtime.js";
import { bindingFixture, HEAD, NOW } from "./binding-fixture.js";

it("bounds real observation and modeTick with 1.7M events and 500 holders", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2563-observation-performance-"));
	const path = join(root, "fixture.db");
	const { store, db } = await bindingFixture(path);
	const gc: Array<{ start: number; duration: number }> = [];
	const windows: Array<{
		kind: string;
		start: number;
		end: number;
		cpuMs: number;
	}> = [];
	const monitor = new PerformanceObserver((list) => {
		for (const entry of list.getEntries())
			gc.push({ start: entry.startTime, duration: entry.duration });
	});
	monitor.observe({ entryTypes: ["gc"] });
	const samples: Record<string, number[]> = {
		backlog: [],
		steady: [],
		tail: [],
		auto_merge_narrow_gate: [],
		dry_run: [],
	};
	const preparation = performance.now();
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
		db.pragma("wal_checkpoint(TRUNCATE)");
		const preparedMs = performance.now() - preparation;
		expect(
			db.prepare("SELECT count(*) AS n FROM session_events").get(),
		).toEqual({ n: 1700000 });
		expect(
			db.prepare("SELECT count(*) AS n FROM workflow_gate_holder").get(),
		).toEqual({ n: 500 });
		const observer = new ShipJudgmentOutcomes(db);
		const measure = (kind: string) => {
			const started = performance.now();
			const cpu = process.cpuUsage();
			const changed = observer.observeCancellations(NOW);
			const end = performance.now();
			const usage = process.cpuUsage(cpu);
			windows.push({
				kind,
				start: started,
				end,
				cpuMs: (usage.user + usage.system) / 1000,
			});
			samples[kind]!.push(end - started);
			return changed;
		};
		let changed = 0;
		for (let i = 0; i < 5; i++) changed += measure("backlog");
		expect(changed).toBeGreaterThan(0);
		let drained = false;
		for (let i = 0; i < 10000; i++) {
			observer.observeCancellations(NOW);
			if (
				observer.pageStats().sourceCandidates === 0 &&
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
		).toEqual({ n: 25000 });
		for (let i = 0; i < 5; i++) {
			measure("steady");
			expect(observer.pageStats()).toMatchObject({
				sourceCandidates: 0,
				holderCandidates: 0,
				outcomes: 0,
			});
		}
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
			measure("tail");
			expect(observer.pageStats().outcomes).toBeGreaterThan(0);
		}
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
				for (let i = 0; i < 5; i++) {
					const start = performance.now();
					await runtime.modeTick();
					samples[mode]!.push(performance.now() - start);
				}
				expect(onError).not.toHaveBeenCalled();
			} finally {
				await runtime.stop();
			}
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		const summary = Object.fromEntries(
			Object.entries(samples).map(([kind, values]) => [
				kind,
				{
					values,
					max: Math.max(...values),
					p95: [...values].sort((a, b) => a - b)[
						Math.ceil(values.length * 0.95) - 1
					],
				},
			]),
		);
		console.log(
			JSON.stringify({
				fixture: "FLY-2563",
				events: 1700000,
				holders: 500,
				closeouts: 2729,
				matchingSources: 50,
				preparationMs: preparedMs,
				databaseBytes: statSync(path).size,
				sqlite: db.prepare("SELECT sqlite_version() AS version").get(),
				node: process.version,
				samples: summary,
				windows: windows.map((window) => ({
					...window,
					gc: gc.filter(
						(entry) =>
							entry.start < window.end &&
							entry.start + entry.duration > window.start,
					),
				})),
			}),
		);
		for (const kind of ["backlog", "steady", "tail"])
			expect(Math.max(...samples[kind]!)).toBeLessThan(50);
		for (const mode of ["auto_merge_narrow_gate", "dry_run"])
			expect(Math.max(...samples[mode]!)).toBeLessThan(100);
	} finally {
		monitor.disconnect();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 120000);
