import { expect, it } from "vitest";
import { canonicalDigest } from "../contract.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";

it("atomically marks history dirty on opinions, decisions and explanations without changing its execution deadline", async () => {
	const { store, db } = await bindingFixture();
	try {
		const state = store.getShipJudgmentHistoryState();
		const claim = state.claim("fixture", Date.parse(NOW));
		expect(claim.status).toBe("claimed");
		const control = () =>
			db
				.prepare(
					"SELECT next_due_at,history_generation FROM ship_judgment_project_state WHERE project_name='flywheel'",
				)
				.get();
		const before = control();
		const clear = () =>
			db
				.prepare(
					"UPDATE ship_judgment_project_state SET history_dirty=0 WHERE project_name='flywheel'",
				)
				.run();
		const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const offered = store.getShipJudgmentOpinions().offer(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				inputId: null,
				reason: "missing_qa",
				mechanical: {
					verdict: "undetermined",
					reason: "missing",
					digest: "a".repeat(64),
					checkedAt: NOW,
					scope: "main+files",
					checkedRepos: 0,
					openPrCount: null,
					overlaps: [],
				},
			},
			Date.parse(NOW),
		);
		if (offered.status !== "created") throw new Error(offered.status);
		expect(state.view().dirty).toBe(true);
		clear();
		const insert = db.prepare(
			"INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,evidence_json) VALUES (?,'retro',?,'q','r','123456789012345680','d','unknown','rework',?,?,'{}')",
		);
		insert.run("outcome", "outcome", NOW, NOW);
		expect(state.view().dirty).toBe(true);
		clear();
		db.prepare(
			"INSERT INTO ship_judgment_clarification(clarification_id,opinion_id,outcome_id,resolution) VALUES ('root',?,'outcome','pending')",
		).run(offered.opinionId);
		expect(state.view().dirty).toBe(true);
		clear();
		db.prepare(
			"INSERT INTO ship_judgment_clarification(clarification_id,opinion_id,outcome_id,reply_source_id,reply_text,reply_digest,founder_id,verified_at,resolution,supersedes) VALUES ('reply',?,'outcome','message','explanation','digest','founder',?,'explained','root')",
		).run(offered.opinionId, NOW);
		expect(state.view().dirty).toBe(true);
		clear();
		expect(() =>
			db.transaction(() => {
				insert.run("rollback", "rollback", NOW, NOW);
				throw new Error("rollback");
			})(),
		).toThrow("rollback");
		expect(state.view().dirty).toBe(false);
		expect(control()).toEqual(before);
		db.prepare(
			"UPDATE workflow_run SET project_name='raya' WHERE run_id='r'",
		).run();
		insert.run("other", "other", NOW, NOW);
		expect(state.view().dirty).toBe(false);
	} finally {
		store.close();
	}
});
