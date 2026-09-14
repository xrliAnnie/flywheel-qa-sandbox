import { expect, it } from "vitest";
import { canonicalDigest } from "../contract.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";

it("shows immutable audit IDs without a thirty-day or active-card filter and never writes", async () => {
	const { store, db } = await bindingFixture();
	try {
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
					checkedAt: "2020-01-01T00:00:00.000Z",
					scope: "main+files",
					checkedRepos: 0,
					openPrCount: null,
					overlaps: [],
				},
			},
			Date.parse("2020-01-01T00:00:00.000Z"),
		);
		const { opinion_id } = db
			.prepare("SELECT opinion_id FROM ship_judgment_opinion")
			.get() as { opinion_id: string };
		db.prepare(
			"UPDATE workflow_run SET status='terminated' WHERE run_id='r'",
		).run();
		const before = db.prepare("SELECT total_changes() AS n").get();
		const reader = store.getShipJudgmentReader();
		const card = reader.show({ project: "flywheel", question: "q" });
		expect(card).toMatchObject({
			schema_version: 1,
			project: "flywheel",
			questionId: "q",
			records: expect.arrayContaining([
				expect.objectContaining({
					kind: "opinion",
					id: opinion_id,
					source: "machine",
				}),
			]),
		});
		const audit = reader.show({ project: "flywheel", id: opinion_id });
		expect(audit).toMatchObject({
			questionId: "q",
			record: {
				kind: "opinion",
				id: opinion_id,
				data: {
					reason: "missing_qa",
					overall: "undetermined",
					created_at: "2020-01-01T00:00:00.000Z",
				},
			},
		});
		expect(reader.show({ project: "flywheel", id: "missing" })).toBeNull();
		expect(() =>
			reader.show({ project: "raya", question: "q" } as never),
		).toThrow();
		expect(() =>
			reader.show({ project: "flywheel", question: "q", id: opinion_id }),
		).toThrow();
		expect(
			reader.show({ project: "flywheel", question: "q' OR 1=1 --" }),
		).toBeNull();
		expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
		db.prepare(
			"UPDATE workflow_run SET project_name='raya' WHERE run_id='r'",
		).run();
		expect(reader.show({ project: "flywheel", id: opinion_id })).toBeNull();
	} finally {
		store.close();
	}
});

it("retains manual and retro provenance, fails oversized reads explicitly, and permits exact ID lookup on large cards", async () => {
	const { store, db } = await bindingFixture();
	try {
		const insert = db.prepare(
			"INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,evidence_json) VALUES (?,?,?,'q','r','card','digest','unknown','approved',?,?,'{}')",
		);
		for (const [key, kind] of [
			["manual", "lead_manual"],
			["retro", "retro"],
		])
			insert.run(key, kind, key, NOW, NOW);
		const reader = store.getShipJudgmentReader();
		expect(reader.show({ project: "flywheel", id: "manual" })).toMatchObject({
			record: { source: "lead_manual", data: { authorship: "unknown" } },
		});
		expect(reader.show({ project: "flywheel", id: "retro" })).toMatchObject({
			record: { source: "legacy_retro" },
		});
		db.transaction(() => {
			for (let n = 0; n < 1000; n++)
				insert.run("large-" + n, "retro", "large-" + n, NOW, NOW);
		})();
		expect(() => reader.show({ project: "flywheel", question: "q" })).toThrow(
			"audit_card_record_limit_exceeded_use_id",
		);
		expect(reader.show({ project: "flywheel", id: "manual" })).toMatchObject({
			record: { id: "manual" },
		});
		db.prepare(
			"INSERT INTO ship_judgment_outcome SELECT 'oversized',source_kind,'oversized',question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,verdict_id,? FROM ship_judgment_outcome WHERE outcome_id='manual'",
		).run(JSON.stringify({ text: "x".repeat(1024 * 1024) }));
		expect(() => reader.show({ project: "flywheel", id: "oversized" })).toThrow(
			"audit_record_size_exceeded",
		);
	} finally {
		store.close();
	}
});
