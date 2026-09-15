import { expect, it } from "vitest";
import { ShipJudgmentOutcomes } from "../outcomes.js";
import { bindingFixture, HEAD, NOW } from "./binding-fixture.js";

async function fixture() {
	const value = await bindingFixture();
	value.db
		.prepare(`INSERT INTO workflow_rework_request(request_id,run_id,source_event_id,authority,source_node_id,source_attempt,base_revision,authority_context_json,authority_context_digest,founder_feedback_verbatim,requested_at)
 VALUES ('rework','r','source','founder','founder_gate',1,?,'{}',?,'feedback',?)`)
		.run(HEAD, "b".repeat(64), NOW);
	const statement =
		value.db.prepare(`INSERT INTO workflow_founder_gate_verdict(verdict_id,source_event_id,run_id,gate_node_id,attempt,verdict,question_id,repo_identity,repo_slug,pr_number,head_sha,rework_request_id,claim_id,founder_authored,author_evidence_json,row_digest,recorded_at)
 VALUES (?,?,'r','founder_gate',1,'rework','q','__main__','owner/repo',2399,?,'rework',NULL,0,'{}',?,?)`);
	return {
		...value,
		insert: (id: string, time = NOW) =>
			statement.run(id, `source-${id}`, HEAD, "c".repeat(64), time),
	};
}

it("bounds normal verdict pages and preserves the cursor and authority on replay", async () => {
	const { store, db, insert } = await fixture();
	try {
		for (let i = 0; i < 35; i++) insert(`v-${String(i).padStart(3, "0")}`);
		const authority = db
			.prepare(
				"SELECT * FROM workflow_founder_gate_verdict ORDER BY verdict_id",
			)
			.all();
		let total = 0;
		for (let i = 0; i < 8; i++) {
			const observer = new ShipJudgmentOutcomes(db);
			total += observer.observeVerdicts(NOW);
			expect(observer.verdictPageStats().holderCandidates).toBeLessThanOrEqual(
				16,
			);
		}
		expect(total).toBe(35);
		const observer = new ShipJudgmentOutcomes(db);
		expect(observer.observeVerdicts(NOW)).toBe(0);
		expect(observer.verdictPageStats()).toMatchObject({
			sourceCandidates: 0,
			holderCandidates: 0,
		});
		expect(
			db
				.prepare(
					"SELECT last_recorded_at,last_verdict_id FROM ship_judgment_observation_cursor WHERE source_kind='b2'",
				)
				.get(),
		).toEqual({ last_recorded_at: NOW, last_verdict_id: "v-034" });
		expect(
			db
				.prepare(
					"SELECT * FROM workflow_founder_gate_verdict ORDER BY verdict_id",
				)
				.all(),
		).toEqual(authority);
	} finally {
		store.close();
	}
});

it("reconciles backdated and same-time smaller identities without revisiting consumed holders", async () => {
	const { store, db, insert } = await fixture();
	try {
		insert("z");
		const observer = new ShipJudgmentOutcomes(db);
		expect(observer.observeVerdicts(NOW)).toBe(1);
		insert("a");
		insert("older", "2026-09-10T00:00:00.000Z");
		expect(observer.observeVerdicts(NOW)).toBe(0);
		expect(observer.observeVerdicts("2026-09-11T00:01:00.000Z")).toBe(2);
		expect(observer.verdictPageStats().holderCandidates).toBe(2);
		expect(
			new ShipJudgmentOutcomes(db).observeVerdicts("2026-09-11T00:02:00.000Z"),
		).toBe(0);
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_outcome").get(),
		).toEqual({ n: 3 });
	} finally {
		store.close();
	}
});

it("resumes reconciliation mid-cycle and discovers inserts behind its position on the next cycle", async () => {
	const { store, db, insert } = await fixture();
	try {
		for (let i = 0; i < 35; i++) insert(`v-${String(i).padStart(3, "0")}`);
		for (let i = 0; i < 8; i++)
			new ShipJudgmentOutcomes(db).observeVerdicts(NOW);
		const tick = (minute: number) => {
			const observer = new ShipJudgmentOutcomes(db);
			const count = observer.observeVerdicts(
				new Date(Date.parse(NOW) + minute * 60_000).toISOString(),
			);
			expect(observer.verdictPageStats().reconciled).toBeLessThanOrEqual(16);
			return count;
		};
		expect(tick(1)).toBe(0);
		insert("a-behind");
		expect(tick(2)).toBe(0);
		expect(tick(3)).toBe(0);
		expect(tick(4)).toBe(1);
		expect(
			db
				.prepare(
					"SELECT last_verdict_id FROM ship_judgment_observation_cursor WHERE source_kind='b2'",
				)
				.get(),
		).toEqual({ last_verdict_id: "v-034" });
	} finally {
		store.close();
	}
});

it("quarantines invalid times, defers future evidence, and rolls back the source cursor on write failure", async () => {
	const { store, db, insert } = await fixture();
	try {
		insert("current");
		insert("future", "2026-09-12T00:00:00.000Z");
		insert("invalid", "not-a-time");
		db.exec(
			"CREATE TRIGGER fail_verdict_outcome BEFORE INSERT ON ship_judgment_outcome BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
		);
		expect(() => new ShipJudgmentOutcomes(db).observeVerdicts(NOW)).toThrow(
			"fixture failure",
		);
		expect(
			db
				.prepare(
					"SELECT last_verdict_id FROM ship_judgment_observation_cursor WHERE source_kind='b2'",
				)
				.get(),
		).toEqual({ last_verdict_id: "" });
		db.exec("DROP TRIGGER fail_verdict_outcome");
		const observer = new ShipJudgmentOutcomes(db);
		expect(observer.observeVerdicts(NOW)).toBe(1);
		expect(
			db
				.prepare(
					"SELECT reason FROM ship_judgment_observation_pending ORDER BY reason",
				)
				.all(),
		).toEqual([{ reason: "future" }, { reason: "invalid_source" }]);
		expect(observer.observeVerdicts("2026-09-12T00:00:00.000Z")).toBe(1);
	} finally {
		store.close();
	}
});
