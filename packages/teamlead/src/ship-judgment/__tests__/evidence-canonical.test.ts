import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ShipJudgmentLearning } from "../learning.js";

const AT = "2026-09-14T20:00:00.000Z",
	AFTER = "2026-09-14T21:00:00.000Z";
it("shares founder canonicalization with offline replay without requiring an opinion table or migration", () => {
	const db = new Database(":memory:");
	try {
		db.exec(
			"CREATE TABLE ship_judgment_outcome(outcome_id TEXT, question_id TEXT, run_id TEXT, card_message_id TEXT, targets_digest TEXT, source_kind TEXT, authorship TEXT, decision TEXT, decided_at TEXT, observed_at TEXT, evidence_json TEXT)",
		);
		const put = (id: string, decided = AT, author = "founder_verified") =>
			db
				.prepare(
					"INSERT INTO ship_judgment_outcome VALUES (?, 'q','r','card','digest','founder_verdict',?,'approved',?,?,'{}')",
				)
				.run(id, author, decided, decided);
		put("first");
		const learning = new ShipJudgmentLearning(db);
		expect(learning.canonical("first", AT)).toMatchObject({
			status: "canonical",
			outcome: { outcome_id: "first" },
		});
		expect(learning.canonical("first", "2026-09-14T19:59:59.000Z")).toEqual({
			status: "missing",
		});
		put("override", AFTER);
		expect(learning.canonical("override", AFTER)).toEqual({
			status: "post_decision_override",
		});
		expect(learning.canonical("first", AFTER).status).toBe("canonical");
		put("same-time");
		expect(learning.canonical("first", AFTER)).toEqual({
			status: "timing_ambiguous",
		});
		put("proxy", AT, "lead_proxy");
		expect(learning.canonical("proxy", AFTER)).toEqual({
			status: "unknown_author",
		});
	} finally {
		db.close();
	}
});
