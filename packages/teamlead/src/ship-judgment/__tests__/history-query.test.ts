import { expect, it } from "vitest";
import { canonicalDigest } from "../contract.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";

it("freezes latest opinions and decisions at asOf, includes terminated cards and expires window membership", async () => {
	const { store, db } = await bindingFixture();
	try {
		const now = Date.parse(NOW),
			iso = (ms: number) => new Date(now + ms).toISOString();
		const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		store.getShipJudgmentOpinions().offer(
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
			now,
		);
		db.prepare(
			"UPDATE workflow_run SET status='terminated' WHERE run_id='r'",
		).run();
		db.prepare(
			"INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,evidence_json) VALUES ('o','retro','o','q','r','123456789012345680','d','unknown','rework',?,?,'{}')",
		).run(iso(1), iso(100));
		const before = db.prepare("SELECT total_changes() AS n").get();
		const reader = store.getShipJudgmentHistory();
		const first = reader.read(iso(50));
		expect(first.rows).toHaveLength(1);
		expect(first.rows[0]).toMatchObject({
			questionId: "q",
			overall: "undetermined",
			decision: null,
			source: "machine",
		});
		const second = reader.read(iso(101));
		expect(second.rows[0]).toMatchObject({
			decision: "rework",
			authorship: "unknown",
			decisionSource: "legacy_retro",
		});
		expect(second.digest).not.toBe(first.digest);
		expect(reader.read(iso(102)).digest).toBe(second.digest);
		expect(reader.read(iso(32 * 86400000)).rows).toEqual([]);
		expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
		const opinion = db
			.prepare("SELECT opinion_id FROM ship_judgment_opinion")
			.get() as { opinion_id: string };
		db.prepare(
			"INSERT INTO ship_judgment_clarification(clarification_id,opinion_id,outcome_id,resolution) VALUES ('root',?,'o','pending')",
		).run(opinion.opinion_id);
		db.prepare(
			"INSERT INTO ship_judgment_clarification(clarification_id,opinion_id,outcome_id,reply_source_id,reply_text,reply_digest,founder_id,verified_at,resolution,supersedes) VALUES ('late-reply',?,'o','source','explanation','digest','founder',?,'explained','root')",
		).run(opinion.opinion_id, iso(32 * 86400000));
		expect(reader.read(iso(31 * 86400000)).rows).toEqual([]);
		expect(reader.read(iso(32 * 86400000)).rows).toEqual([
			expect.objectContaining({
				questionId: "q",
				clarification: "explained",
				clarificationAuditId: "late-reply",
			}),
		]);
		db.prepare(
			"INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,evidence_json) VALUES ('later','lead_manual','later','q','r','123456789012345680','d','unknown','approved',?,?,'{}')",
		).run(iso(32 * 86400000 + 1), iso(32 * 86400000 + 1));
		expect(reader.read(iso(32 * 86400000 + 2)).rows[0]).toMatchObject({
			decision: "approved",
			clarification: "explained",
			clarificationAuditId: "late-reply",
		});
	} finally {
		store.close();
	}
});
