import { expect, it } from "vitest";
import { canonicalDigest } from "../contract.js";
import { applySemanticEvidence } from "../evidence-ledger.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";
import { evidenceFixture } from "./evidence-fixture.js";

it("an evaluated but undetermined model result keeps the opinion fail-closed", async () => {
	const { store } = await bindingFixture();
	try {
		const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const evidence = evidenceFixture(binding, NOW),
			at = Date.parse(NOW);
		const frozen = store.getShipJudgmentInputs().freeze(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				targets: evidence.targets.map((t) => ({
					repo_identity: t.r,
					pr_number: t.p,
					head_sha: t.h,
					diff_base_sha: t.b!,
				})),
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
			job = jobs.claim(frozen.inputId, "worker", at);
		if (job.status !== "claimed") throw new Error(job.status);
		jobs.markSpawned(job, at);
		jobs.finish(
			job,
			{
				alignment: "undetermined",
				coverage: "pass",
				result: {},
				resultCode: "evaluated",
				durationMs: 1,
				usage: null,
				costUsd: null,
			},
			at + 1,
		);
		store.getShipJudgmentOpinions().offer(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				inputId: frozen.inputId,
				reason: "evidence_only",
				mechanical: {
					verdict: "pass",
					reason: "mechanical_checks_clear",
					digest: "e".repeat(64),
					checkedAt: NOW,
					scope: "files",
					checkedRepos: 1,
					openPrCount: 4,
					overlaps: [],
				},
				evidence,
			},
			at + 2,
		);
		expect(store.getShipJudgmentDelivery().view("q")).toMatchObject({
			overall: "undetermined",
			evidence: { semantic: { status: "undetermined", alignmentVeto: false } },
		});
	} finally {
		store.close();
	}
});

it("persists evidence-only passing opinions, exposes the ledger in delivery, and deduplicates observation-only changes", async () => {
	const { store, db } = await bindingFixture();
	try {
		const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const evidence = evidenceFixture(binding, NOW);
		const candidate = {
			questionId: "q",
			channelId: CHANNEL,
			bindingDigest: canonicalDigest(binding),
			inputId: null,
			reason: "evidence_only",
			mechanical: {
				verdict: "pass",
				reason: "mechanical_checks_clear",
				digest: "e".repeat(64),
				checkedAt: NOW,
				scope: "files",
				checkedRepos: 1,
				openPrCount: 4,
				overlaps: [],
			},
			evidence,
		};
		const result = store
			.getShipJudgmentOpinions()
			.offer(candidate, Date.parse(NOW));
		expect(result.status).toBe("created");
		expect(
			db
				.prepare(
					"SELECT input_id,evaluation_id,overall FROM ship_judgment_opinion",
				)
				.get(),
		).toEqual({
			input_id: null,
			evaluation_id: null,
			overall: "undetermined",
		});
		expect(store.getShipJudgmentDelivery().view("q")?.evidence).toMatchObject({
			alignment: { verdict: "undetermined", missing: ["input"] },
			coverage: { verdict: "undetermined", missing: ["input"] },
			semantic: { status: "not_run" },
		});
		const refreshed = structuredClone(candidate);
		refreshed.evidence.computedAt = "2026-09-11T00:00:01.000Z";
		refreshed.evidence.evidence.forEach((ref) => {
			ref.observedAt = refreshed.evidence.computedAt;
		});
		expect(
			store.getShipJudgmentOpinions().offer(refreshed, Date.parse(NOW) + 1000)
				.status,
		).toBe("unchanged");
		const changed = structuredClone(candidate);
		changed.evidence.evidence[0]!.id = "new-design";
		expect(
			store.getShipJudgmentOpinions().offer(changed, Date.parse(NOW) + 2000)
				.status,
		).toBe("deferred");
	} finally {
		store.close();
	}
});

it("rejects evidence for a different target set or mechanical result", async () => {
	const { store } = await bindingFixture();
	try {
		const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const wrongBinding = {
			...binding,
			targets: [{ ...binding.targets[0]!, pr_number: 999 }],
		};
		const candidate = {
			questionId: "q",
			channelId: CHANNEL,
			bindingDigest: canonicalDigest(binding),
			inputId: null,
			reason: "evidence_only",
			mechanical: {
				verdict: "pass",
				reason: "mechanical_checks_clear",
				digest: "e".repeat(64),
				checkedAt: NOW,
				scope: "files",
				checkedRepos: 1,
				openPrCount: 4,
				overlaps: [],
			},
			evidence: evidenceFixture(wrongBinding, NOW),
		};
		expect(
			store.getShipJudgmentOpinions().offer(candidate, Date.parse(NOW)).status,
		).toBe("binding_changed");
		candidate.evidence = evidenceFixture(binding, NOW);
		candidate.evidence.conflict.verdict = "fail";
		expect(
			store.getShipJudgmentOpinions().offer(candidate, Date.parse(NOW)).status,
		).toBe("binding_changed");
	} finally {
		store.close();
	}
});

it("uses only the persisted model evaluation for veto, never caller-provided semantic flags", async () => {
	const { store } = await bindingFixture();
	try {
		const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const evidence = applySemanticEvidence(evidenceFixture(binding, NOW), {
			status: "evaluated",
			evaluationId: "invented",
			modelSnapshotDigest: "f".repeat(64),
			alignment: "fail",
			coverage: "fail",
		});
		store.getShipJudgmentOpinions().offer(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				inputId: null,
				reason: "evidence_only",
				mechanical: {
					verdict: "pass",
					reason: "mechanical_checks_clear",
					digest: "e".repeat(64),
					checkedAt: NOW,
					scope: "files",
					checkedRepos: 1,
					openPrCount: 4,
					overlaps: [],
				},
				evidence,
			},
			Date.parse(NOW),
		);
		expect(store.getShipJudgmentDelivery().view("q")).toMatchObject({
			overall: "undetermined",
			evidence: { semantic: { status: "not_run" } },
		});
	} finally {
		store.close();
	}
});
