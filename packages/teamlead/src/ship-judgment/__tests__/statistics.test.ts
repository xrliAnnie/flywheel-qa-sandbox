import { expect, it } from "vitest";
import { matrixSummary, ShipJudgmentStatistics } from "../statistics.js";
import { bindingFixture, NOW } from "./binding-fixture.js";

it("keeps all twelve cells and explicit denominators, with cancellation outside rework rate", () => {
	expect(matrixSummary([]).rates.reworkAfterCan).toEqual({
		numerator: 0,
		denominator: 0,
		value: null,
	});
	const summary = matrixSummary([
		{ overall: "can", decision: "approved" },
		{ overall: "can", decision: "rework" },
		{ overall: "can", decision: "canceled" },
		{ overall: "cannot", decision: "approved" },
		{ overall: "recommend_reject", decision: "rework" },
		{ overall: "undetermined", decision: "canceled" },
	]);
	expect(summary.matrix).toEqual({
		can: { approved: 1, rework: 1, canceled: 1 },
		cannot: { approved: 1, rework: 0, canceled: 0 },
		recommend_reject: { approved: 0, rework: 1, canceled: 0 },
		undetermined: { approved: 0, rework: 0, canceled: 1 },
	});
	expect(summary.rates.canShareOfHumanApprovals).toEqual({
		numerator: 1,
		denominator: 2,
		value: 0.5,
	});
	expect(summary.rates.reworkAfterCan).toEqual({
		numerator: 1,
		denominator: 2,
		value: 0.5,
	});
	expect(summary.rates.cancellationShare).toEqual({
		numerator: 2,
		denominator: 6,
		value: 1 / 3,
	});
});
it("reports real card inventory and excludes retro/manual/unknown records at a fixed UTC cutoff", async () => {
	const { store, db } = await bindingFixture();
	try {
		const end = "2026-09-12T00:00:00.000Z";
		const insert = db.prepare(
			`INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,evidence_json) VALUES (?,?,?,'q','r','123456789012345678',?,'unknown','approved',?,?,'{}')`,
		);
		for (const kind of ["retro", "lead_manual", "b2"])
			insert.run(kind, kind, kind, "a".repeat(64), NOW, NOW);
		insert.run(
			"future",
			"b2",
			"future",
			"a".repeat(64),
			NOW,
			"2026-09-13T00:00:00.000Z",
		);
		insert.run("at-end", "b2", "at-end", "a".repeat(64), end, end);
		insert.run(
			"before-start",
			"b2",
			"before-start",
			"a".repeat(64),
			"2026-09-10T23:59:59.999Z",
			NOW,
		);
		const stats = store.getShipJudgmentStatistics();
		const result = stats.read({ from: NOW, to: end, asOf: end });
		expect(result.outcomeRecords).toBe(3);
		expect(result.sources).toEqual({
			automaticObservation: 1,
			leadManual: 1,
			legacyRetro: 1,
		});
		expect(result.cards).toMatchObject({
			total: 1,
			noOpinion: 1,
			pendingHumanDecision: 1,
		});
		expect(result.exclusions).toMatchObject({
			retro: 1,
			manual: 1,
			unknown_author: 1,
		});
		expect(result.summary.pairs).toBe(0);
		expect(result.summary.rates.canShareOfHumanApprovals.value).toBeNull();
		expect(() => stats.read({ from: end, to: NOW, asOf: end })).toThrow();
		expect(() => stats.read({ from: NOW, to: end, asOf: NOW })).toThrow();
		expect(() =>
			stats.read({ from: "2026-09-11T01:00:00+01:00", to: end, asOf: end }),
		).toThrow();
	} finally {
		store.close();
	}
});

it("fails explicitly rather than reporting truncated outcome totals", async () => {
	const { store, db } = await bindingFixture();
	try {
		const insert = db.prepare(
			`INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,evidence_json) VALUES (?,'retro',?,'q','r','123456789012345678',?,'unknown','approved',?,?,'{}')`,
		);
		db.transaction(() => {
			for (let n = 0; n < 10001; n++)
				insert.run(String(n), String(n), "a".repeat(64), NOW, NOW);
		})();
		expect(() =>
			new ShipJudgmentStatistics(db).read({
				from: NOW,
				to: "2026-09-12T00:00:00.000Z",
				asOf: "2026-09-12T00:00:00.000Z",
			}),
		).toThrow("statistics_outcome_limit_exceeded_narrow_interval");
	} finally {
		store.close();
	}
});
