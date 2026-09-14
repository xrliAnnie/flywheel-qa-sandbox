import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { ShipJudgmentJobs } from "../jobs.js";

const NOW = Date.parse("2026-09-11T00:00:00.000Z");
function fixture(store: StateStore, count = 2) {
	const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
	for (let n = 0; n < count; n++) {
		store.createWorkflowRun({
			runId: `r${n}`,
			issueId: `FLY-${2399 + n}`,
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		db.prepare(`INSERT INTO workflow_gate_holder(run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,state,created_at,updated_at)
			VALUES (?,'founder_gate',1,?,'execution',?,'awaiting_review',?,?)`).run(
			`r${n}`,
			"a".repeat(40),
			`q${n}`,
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
		);
		db.prepare(`INSERT INTO ship_judgment_input(input_id,project_name,run_id,question_id,card_message_id,thread_id,semantic_ordinal,
			targets_digest,targets_json,sources_json,requirements_json,semantic_digest,policy_version,model_snapshot_digest,model_snapshot_json,requested_at)
			VALUES (?,'flywheel',?,?,'123456789012345678','123456789012345679',1,?,'[]','[]','[]',?,'ship-judgment-v1',?,'{}',?)`).run(
			`i${n}`,
			`r${n}`,
			`q${n}`,
			"a".repeat(64),
			"b".repeat(64),
			"c".repeat(64),
			new Date(NOW).toISOString(),
		);
	}
	return db;
}
const result = {
	alignment: "pass",
	coverage: "pass",
	result: {},
	resultCode: "ok",
	durationMs: 10,
	usage: null,
	costUsd: null,
} as const;

describe("persistent ship judgment jobs", () => {
	it("releases a proven non-spawn without evaluation or retry and records evaluated work as done", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const db = fixture(store);
			const jobs = new ShipJudgmentJobs(db);
			jobs.enqueue("i0");
			jobs.enqueue("i1");
			expect(jobs.queued()).toEqual(["i0", "i1"]);
			const claim = jobs.claim("i0", "worker", NOW);
			if (claim.status !== "claimed") throw new Error(claim.status);
			jobs.markSpawned(claim, NOW);
			expect(
				jobs.confirmNotSpawned(
					{ ...claim, generation: 99 },
					"spawn_failed",
					NOW + 1,
				),
			).toBe(false);
			expect(jobs.confirmNotSpawned(claim, "spawn_failed", NOW + 1)).toBe(true);
			expect(jobs.claim("i0", "worker", NOW + 2).status).toBe("settled");
			expect(
				db
					.prepare(
						"SELECT spawned_at,reserved_at FROM ship_judgment_job WHERE input_id='i0'",
					)
					.get(),
			).toEqual({ spawned_at: null, reserved_at: null });
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_evaluation").get(),
			).toEqual({ n: 0 });
			const next = jobs.claim("i1", "worker", NOW + 3);
			if (next.status !== "claimed") throw new Error(next.status);
			jobs.markSpawned(next, NOW + 3);
			jobs.finish(next, { ...result, resultCode: "evaluated" }, NOW + 4);
			expect(
				db
					.prepare(
						"SELECT state,last_error FROM ship_judgment_job WHERE input_id='i1'",
					)
					.get(),
			).toEqual({ state: "done", last_error: null });
		} finally {
			store.close();
		}
	});
	it("admits one global worker, fences stale completion and caches one evaluation", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const db = fixture(store);
			const jobs = new ShipJudgmentJobs(db);
			jobs.enqueue("i0");
			jobs.enqueue("i0");
			jobs.enqueue("i1");
			const claim = jobs.claim("i0", "worker", NOW);
			expect(claim.status).toBe("claimed");
			if (claim.status !== "claimed") throw new Error("expected claim");
			expect(jobs.claim("i1", "other", NOW)).toEqual({ status: "busy" });
			expect(jobs.markSpawned(claim, NOW)).toBe(true);
			expect(
				jobs.finish(
					{ ...claim, generation: claim.generation + 1 },
					result,
					NOW + 10,
				),
			).toBe(false);
			expect(jobs.finish(claim, result, NOW + 10)).toBe(true);
			expect(jobs.finish(claim, result, NOW + 11)).toBe(false);
			expect(jobs.claim("i0", "worker", NOW + 12)).toEqual({
				status: "settled",
			});
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_evaluation").get(),
			).toEqual({ n: 1 });
			expect(jobs.claim("i1", "worker", NOW + 12).status).toBe("claimed");
		} finally {
			store.close();
		}
	});
	it("persists the daily 30-spawn budget across reopen and leaves queued input available next day", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ship-jobs-"));
		const path = join(dir, "test.db");
		let store = await StateStore.create(path);
		try {
			let db = fixture(store, 31);
			let jobs = new ShipJudgmentJobs(db);
			for (let n = 0; n < 30; n++) {
				jobs.enqueue(`i${n}`);
				const claim = jobs.claim(`i${n}`, "worker", NOW + n * 20);
				if (claim.status !== "claimed") throw new Error(claim.status);
				jobs.markSpawned(claim, NOW + n * 20);
				jobs.finish(claim, result, NOW + n * 20 + 10);
			}
			jobs.enqueue("i30");
			expect(jobs.claim("i30", "worker", NOW + 1000)).toEqual({
				status: "daily_budget",
			});
			store.close();
			store = await StateStore.create(path);
			db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
			jobs = new ShipJudgmentJobs(db);
			expect(jobs.claim("i30", "worker", NOW + 2000)).toEqual({
				status: "daily_budget",
			});
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_evaluation").get(),
			).toEqual({ n: 30 });
			expect(jobs.claim("i30", "worker", NOW + 86_400_000).status).toBe(
				"claimed",
			);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("recovers lost spawned work as unknown without a second model attempt", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const db = fixture(store);
			const jobs = new ShipJudgmentJobs(db);
			jobs.enqueue("i0");
			jobs.enqueue("i1");
			const claim = jobs.claim("i0", "old", NOW);
			if (claim.status !== "claimed") throw new Error(claim.status);
			jobs.markSpawned(claim, NOW);
			expect(jobs.recoverExpired(NOW + 1)).toBe(0);
			expect(jobs.recoverExpired(NOW + 180_000)).toBe(1);
			expect(jobs.claim("i0", "new", NOW + 180_001)).toEqual({
				status: "settled",
			});
			expect(jobs.finish(claim, result, NOW + 180_002)).toBe(false);
			expect(
				db
					.prepare(
						"SELECT alignment,coverage,result_code FROM ship_judgment_evaluation",
					)
					.get(),
			).toEqual({
				alignment: "undetermined",
				coverage: "undetermined",
				result_code: "worker_lost",
			});
			const next = jobs.claim("i1", "new", NOW + 180_003);
			if (next.status !== "claimed") throw new Error(next.status);
			expect(jobs.recoverExpired(NOW + 360_000)).toBe(1);
			expect(jobs.claim("i1", "newer", NOW + 360_001).status).toBe("settled");
		} finally {
			store.close();
		}
	});
});
