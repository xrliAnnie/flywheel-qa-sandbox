import { expect, it } from "vitest";
import { canonicalDigest } from "../contract.js";
import { EVIDENCE_POLICY_VERSION } from "../evidence-ledger.js";
import { ShipJudgmentLearning } from "../learning.js";
import { ShipJudgmentOutcomes } from "../outcomes.js";
import { ShipJudgmentStatistics } from "../statistics.js";
import { bindingFixture, CHANNEL, HEAD, NOW } from "./binding-fixture.js";
import { evidenceFixture, evidenceMaterials } from "./evidence-fixture.js";

it.each([false, true])(
	"pairs a visible evidence opinion with a founder verdict and groups its actual model identity (%s)",
	async (model) => {
		const { store, db } = await bindingFixture();
		try {
			const at = Date.parse(NOW),
				iso = (n: number) => new Date(at + n).toISOString();
			const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
			const evidence = evidenceFixture(binding, NOW);
			let inputId: string | null = null;
			const modelSnapshot = {
				model: "fixture",
				effort: "high",
				configuration_digest: "c".repeat(64),
			};
			if (model) {
				const frozen = store.getShipJudgmentInputs().freeze(
					{
						questionId: "q",
						channelId: CHANNEL,
						bindingDigest: canonicalDigest(binding),
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
						model: modelSnapshot,
					},
					NOW,
				);
				if (frozen.status !== "created") throw new Error(frozen.status);
				inputId = frozen.inputId;
				const jobs = store.getShipJudgmentJobs(),
					job = jobs.claim(inputId, "worker", at);
				if (job.status !== "claimed") throw new Error(job.status);
				jobs.markSpawned(job, at);
				jobs.finish(
					job,
					{
						alignment: "fail",
						coverage: "pass",
						result: {},
						resultCode: "evaluated",
						durationMs: 1,
						usage: null,
						costUsd: null,
					},
					at + 1,
				);
			}
			const opinion = store.getShipJudgmentOpinions().offer(
				{
					questionId: "q",
					channelId: CHANNEL,
					bindingDigest: canonicalDigest(binding),
					inputId,
					reason: "evidence",
					mechanical: evidenceMaterials(binding, NOW).mechanical,
					evidence,
				},
				at + 2,
			);
			if (opinion.status !== "created") throw new Error(opinion.status);
			expect(store.getShipJudgmentDelivery().view("q")?.overall).toBe(
				model ? "recommend_reject" : "can",
			);
			const delivery = store.getShipJudgmentDelivery(),
				receipt = delivery.claim("q", CHANNEL, "sender", at + 2);
			if (receipt.status !== "claimed") throw new Error(receipt.status);
			delivery.confirm(receipt, "123456789012345681", iso(3), at + 3);
			db.prepare(`INSERT INTO workflow_rework_request(request_id,run_id,source_event_id,authority,source_node_id,source_attempt,base_revision,authority_context_json,authority_context_digest,founder_feedback_verbatim,requested_at)
			VALUES ('rework','r','source','founder','founder_gate',1,?,'{}',?,'feedback',?)`).run(
				HEAD,
				"b".repeat(64),
				iso(4),
			);
			db.prepare(`INSERT INTO workflow_founder_gate_verdict(verdict_id,source_event_id,run_id,gate_node_id,attempt,verdict,question_id,repo_identity,repo_slug,pr_number,head_sha,rework_request_id,claim_id,founder_authored,author_evidence_json,row_digest,recorded_at)
			VALUES ('v','source','r','founder_gate',1,'rework','q','__main__','owner/repo',2399,?,'rework',NULL,1,?,?,?)`).run(
				HEAD,
				JSON.stringify({
					kind: "gate_response",
					actor: "founder",
					founder_id_at_capture: "founder",
					source_event_id: "source",
				}),
				"c".repeat(64),
				iso(4),
			);
			expect(new ShipJudgmentOutcomes(db).observeVerdicts(iso(5))).toBe(1);
			const outcome = db
				.prepare(
					"SELECT outcome_id,targets_digest,evidence_json FROM ship_judgment_outcome",
				)
				.get() as {
				outcome_id: string;
				targets_digest: string;
				evidence_json: string;
			};
			expect(JSON.parse(outcome.evidence_json).binding_status).toBe("resolved");
			expect(outcome.targets_digest).toBe(evidence.targetsDigest);
			expect(
				new ShipJudgmentLearning(db).pair(outcome.outcome_id, iso(6)),
			).toMatchObject({
				status: "paired",
				opinionId: opinion.opinionId,
				relation: model ? "aligned" : "divergent",
				policyVersion: EVIDENCE_POLICY_VERSION,
				modelSnapshotDigest: model ? canonicalDigest(modelSnapshot) : null,
			});
			const statistics = new ShipJudgmentStatistics(db).read({
				from: NOW,
				to: iso(10),
				asOf: iso(10),
			});
			expect(statistics.versions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						policyVersion: EVIDENCE_POLICY_VERSION,
						modelSnapshotDigest: model ? canonicalDigest(modelSnapshot) : null,
					}),
				]),
			);
		} finally {
			store.close();
		}
	},
);
