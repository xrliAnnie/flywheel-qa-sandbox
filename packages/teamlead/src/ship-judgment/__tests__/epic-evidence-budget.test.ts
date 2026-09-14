import { canonicalJsonString } from "flywheel-config";
import { expect, it } from "vitest";
import { pageForShipJudgmentBudget } from "../../epic-page/__tests__/fixtures/founder-budget.js";
import {
	assertEpicPage,
	EPIC_PAGE_MAX_DOCUMENT_BYTES,
} from "../../epic-page/model.js";
import { canonicalDigest } from "../contract.js";
import { readEpicJudgment } from "../epic-facts.js";
import { ShipJudgmentReader } from "../show.js";
import { bindingFixture, CHANNEL, HEAD, NOW } from "./binding-fixture.js";

it("keeps 60 populated judgments within the document budget while full evidence remains readable by audit ID", async () => {
	const { store, db } = await bindingFixture();
	try {
		const digest = canonicalDigest(store.readShipJudgmentBinding("q", CHANNEL));
		const frozen = store.getShipJudgmentInputs().freeze(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: digest,
				targets: [
					{
						repo_identity: "__main__",
						pr_number: 2399,
						head_sha: HEAD,
						diff_base_sha: "b".repeat(40),
					},
				],
				sources: [],
				files: [],
				requirements: [],
				prompt: "fixture",
				model: {
					model: "fixture",
					effort: "high",
					configuration_digest: "c".repeat(64),
				},
			},
			NOW,
		);
		if (frozen.status !== "created") throw new Error(frozen.status);
		const jobs = store.getShipJudgmentJobs(),
			at = Date.parse(NOW);
		const job = jobs.claim(frozen.inputId, "worker", at);
		if (job.status !== "claimed") throw new Error(job.status);
		const result = {
			requirements: Array.from({ length: 100 }, (_, i) => ({
				requirement_id: `R${i}`,
				quote: "证".repeat(180),
			})),
		};
		jobs.markSpawned(job, at);
		jobs.finish(
			job,
			{
				alignment: "pass",
				coverage: "pass",
				result,
				resultCode: "evaluated",
				durationMs: 1,
				usage: null,
				costUsd: null,
			},
			at + 1,
		);
		const offered = store.getShipJudgmentOpinions().offer(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: digest,
				inputId: frozen.inputId,
				reason: "evaluated",
				mechanical: {
					verdict: "fail",
					reason: "overlap",
					digest: "d".repeat(64),
					checkedAt: NOW,
					scope: "main+files",
					checkedRepos: 1,
					openPrCount: 200,
					overlaps: Array.from({ length: 100 }, (_, i) => ({
						repo_identity: "__main__",
						pr_number: i + 1,
						path: "x".repeat(600),
					})),
				},
			},
			at + 2,
		);
		if (offered.status !== "created") throw new Error(offered.status);
		const before = db.prepare("SELECT total_changes() AS n").get();
		const value = readEpicJudgment(db, "flywheel", ["FLY-2399"]).value!;
		const page = pageForShipJudgmentBudget(60);
		for (const item of page.items)
			item.ship_judgment!.value = structuredClone(value);
		expect(() => assertEpicPage(page)).not.toThrow();
		expect(Buffer.byteLength(canonicalJsonString(page))).toBeLessThanOrEqual(
			EPIC_PAGE_MAX_DOCUMENT_BYTES,
		);
		expect(
			Buffer.byteLength(JSON.stringify(value.evidence)),
		).toBeLessThanOrEqual(2048);
		expect(value.evidence).toMatchObject({
			evaluation: { truncated: true, audit_id: value.evaluation_id },
			mechanical: { truncated: true, audit_id: offered.opinionId },
		});
		const reader = new ShipJudgmentReader(db);
		const evaluation = reader.show({
			project: "flywheel",
			id: value.evaluation_id!,
		});
		expect(JSON.parse(String(evaluation.record!.data.result_json))).toEqual(
			result,
		);
		const opinion = reader.show({ project: "flywheel", id: offered.opinionId });
		expect(
			JSON.parse(String(opinion.record!.data.mechanical_json)).overlaps,
		).toHaveLength(100);
		expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
	} finally {
		store.close();
	}
});
