import { expect, it } from "vitest";
import { readEpicItemFacts } from "../../StateStore.js";
import { canonicalDigest } from "../contract.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";

const freshness = { generatedAt: NOW, stuckThresholdMinutes: 15 };

it("projects a sourced opinion through shared Epic facts without modifying workflow state", async () => {
	const { store, db } = await bindingFixture();
	try {
		const item = { uuid: "fixture-uuid", identifier: "FLY-2399" };
		const initial = readEpicItemFacts(store, "flywheel", item, freshness);
		expect(initial.ship_judgment).toMatchObject({
			ok: true,
			value: { question_id: "q", opinion_id: null, display: "pending" },
		});
		const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const opinion = store.getShipJudgmentOpinions().offer(
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
		if (opinion.status !== "created") throw new Error(opinion.status);
		const before = db.prepare("SELECT total_changes() AS n").get();
		const facts = readEpicItemFacts(store, "flywheel", item, freshness);
		expect(facts.ship_judgment).toMatchObject({
			ok: true,
			source_updated_at: NOW,
			value: {
				opinion_id: opinion.opinionId,
				source: "machine",
				overall: "undetermined",
				display: "pending",
				reason: "missing_qa",
				evidence: { evaluation: null, mechanical: { scope: "main+files" } },
			},
		});
		expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
		expect(
			readEpicItemFacts(store, "raya", item, freshness).ship_judgment,
		).toBeUndefined();
		db.exec("DROP TABLE ship_judgment_opinion");
		expect(
			readEpicItemFacts(store, "flywheel", item, freshness).ship_judgment,
		).toMatchObject({ ok: false, table: "ship_judgment_opinion" });
	} finally {
		store.close();
	}
});
