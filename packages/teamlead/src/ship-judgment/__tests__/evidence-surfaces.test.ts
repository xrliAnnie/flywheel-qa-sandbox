import { expect, it } from "vitest";
import { judgmentSummary } from "../../epic-page/audit-dictionary.js";
import { canonicalDigest } from "../contract.js";
import { readEpicJudgment } from "../epic-facts.js";
import {
	buildEvidenceLedger,
	EVIDENCE_POLICY_VERSION,
} from "../evidence-ledger.js";
import { renderHistoryDocument } from "../history-pages.js";
import { ShipJudgmentHistory } from "../history-query.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";
import { evidenceMaterials } from "./evidence-fixture.js";

it("carries three labels and precise missing evidence into Epic and history, without reference ID details", async () => {
	const { store, db } = await bindingFixture();
	try {
		const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const materials = evidenceMaterials(binding, NOW);
		delete materials.targets[0]!.qaAuthority;
		const model = {
			model: "fixture",
			effort: "high",
			configuration_digest: "c".repeat(64),
		};
		const frozen = store.getShipJudgmentInputs().freeze(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				targets: [
					{
						repo_identity: "__main__",
						pr_number: 2399,
						head_sha: binding.targets[0]!.head_sha,
						diff_base_sha: "b".repeat(40),
					},
				],
				sources: [],
				files: [],
				requirements: [],
				prompt: "fixture",
				model,
			},
			NOW,
		);
		if (frozen.status !== "created") throw new Error(frozen.status);
		const jobs = store.getShipJudgmentJobs();
		const job = jobs.claim(frozen.inputId, "worker", Date.parse(NOW));
		if (job.status !== "claimed") throw new Error(job.status);
		jobs.markSpawned(job, Date.parse(NOW));
		jobs.finish(
			job,
			{
				alignment: "pass",
				coverage: "pass",
				result: {},
				resultCode: "evaluated",
				durationMs: 1,
				usage: null,
				costUsd: null,
			},
			Date.parse(NOW) + 1,
		);
		const evidence = buildEvidenceLedger(materials, binding, {
			status: "evaluated",
			evaluationId: "surface-evaluation",
			modelSnapshotDigest: "f".repeat(64),
			alignment: "pass",
			coverage: "pass",
		});
		store.getShipJudgmentOpinions().offer(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				inputId: frozen.inputId,
				reason: "evidence_only",
				mechanical: materials.mechanical,
				evidence,
			},
			Date.parse(NOW),
		);
		const value = readEpicJudgment(db, "flywheel", [binding.issueId]).value!;
		expect(value.policy_version).toBe(EVIDENCE_POLICY_VERSION);
		expect(value.points).toMatchObject({
			alignment: "通过",
			conflict: "通过",
			coverage: "缺 QA 判决",
			missing: ["③ QA 判决"],
		});
		const summary = judgmentSummary({
			value,
			observed_at: NOW,
			provenance: {
				kind: "statestore",
				table: "ship_judgment_opinion",
				key: { issue_id: binding.issueId },
			},
		});
		expect(summary).toContain("① 通过");
		expect(summary).toContain("③ 缺 QA 判决");
		const history = new ShipJudgmentHistory(db).read(NOW);
		expect(history.rows[0]!.summary).toContain("① 通过；② 通过；③ 缺 QA 判决");
		const html = renderHistoryDocument(history.rows, {
			asOf: NOW,
			total: 1,
		});
		expect(html).toContain("③ 缺 QA 判决");
		for (const reference of ["design-r1", "code-r5", "1148"]) {
			expect(html).not.toContain(reference);
			expect(JSON.stringify(value.points)).not.toContain(reference);
		}
	} finally {
		store.close();
	}
});
