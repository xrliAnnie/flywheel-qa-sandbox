import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../contract.js";
import { ShipJudgmentOpinions } from "../opinions.js";
import { bindingFixture, CHANNEL, HEAD, NOW } from "./binding-fixture.js";

describe("bounded judgment opinions", () => {
	it("derives can from the saved evaluation, limits real changes to six per hour, and rejects superseded input", async () => {
		const { store, db } = await bindingFixture();
		try {
			const bindingDigest = canonicalDigest(
				store.readShipJudgmentBinding("q", CHANNEL),
			);
			const packet = {
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest,
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
			};
			const frozen = store.getShipJudgmentInputs().freeze(packet, NOW);
			if (frozen.status !== "created") throw new Error(frozen.status);
			const at = Date.parse(NOW);
			const jobs = store.getShipJudgmentJobs();
			const job = jobs.claim(frozen.inputId, "worker", at);
			if (job.status !== "claimed") throw new Error(job.status);
			jobs.markSpawned(job, at);
			jobs.finish(
				job,
				{
					alignment: "pass",
					coverage: "pass",
					result: {},
					resultCode: "ok",
					durationMs: 1,
					usage: null,
					costUsd: null,
				},
				at + 1,
			);
			const candidate = {
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest,
				inputId: frozen.inputId,
				reason: "evaluated",
				mechanical: {
					verdict: "pass",
					reason: "clean",
					digest: "a".repeat(64),
					checkedAt: NOW,
					scope: "main and open PR files",
					checkedRepos: 1,
					openPrCount: 0,
					overlaps: [],
				},
			};
			for (let n = 0; n < 6; n++) {
				candidate.mechanical.reason = `result_${n}`;
				candidate.mechanical.checkedAt = new Date(
					at + n * 600_000 + 2,
				).toISOString();
				const opinions = new ShipJudgmentOpinions(db, (q, c) =>
					store.readShipJudgmentBinding(q, c),
				);
				expect(opinions.offer(candidate, at + n * 600_000 + 2).status).toBe(
					"created",
				);
			}
			candidate.mechanical.reason = "seventh";
			candidate.mechanical.checkedAt = new Date(at + 3_599_999).toISOString();
			const opinions = new ShipJudgmentOpinions(db, (q, c) =>
				store.readShipJudgmentBinding(q, c),
			);
			expect(opinions.offer(candidate, at + 3_599_999).status).toBe("deferred");
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM ship_judgment_opinion WHERE overall='can'",
					)
					.get(),
			).toEqual({ n: 6 });
			expect(
				store
					.getShipJudgmentInputs()
					.freeze({ ...packet, prompt: "changed requirement" }, NOW).status,
			).toBe("created");
			candidate.mechanical.checkedAt = new Date(at + 3_600_002).toISOString();
			expect(opinions.offer(candidate, at + 3_600_002).status).toBe(
				"binding_changed",
			);
		} finally {
			store.close();
		}
	});
	it("does not mint opinions for unrelated mechanical metadata and coalesces actual changes", async () => {
		const { store, db } = await bindingFixture();
		try {
			const opinions = new ShipJudgmentOpinions(db, (q, c) =>
				store.readShipJudgmentBinding(q, c),
			);
			const at = Date.parse(NOW);
			const candidate = {
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(
					store.readShipJudgmentBinding("q", CHANNEL),
				),
				inputId: null,
				reason: "missing_input",
				mechanical: {
					verdict: "pass",
					reason: "clean",
					digest: "a".repeat(64),
					checkedAt: NOW,
					scope: "main and open PR files",
					checkedRepos: 1,
					openPrCount: 0,
					overlaps: [],
				},
			};
			expect(opinions.offer(candidate, at).status).toBe("created");
			for (let n = 1; n <= 10; n++) {
				candidate.mechanical.digest = canonicalDigest(n);
				candidate.mechanical.checkedAt = new Date(at + n * 1000).toISOString();
				expect(opinions.offer(candidate, at + n * 1000).status).toBe(
					"unchanged",
				);
			}
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_opinion").get(),
			).toEqual({ n: 1 });
			for (let n = 1; n <= 10; n++) {
				candidate.mechanical.reason = `overlap_${n}`;
				candidate.mechanical.checkedAt = new Date(
					at + 20_000 + n * 1000,
				).toISOString();
				expect(opinions.offer(candidate, at + 20_000 + n * 1000).status).toBe(
					"deferred",
				);
			}
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_delivery").get(),
			).toEqual({ n: 1 });
			const pending = db
				.prepare(
					"SELECT latest_candidate_json,dirty_since FROM ship_judgment_delivery",
				)
				.get() as { latest_candidate_json: string; dirty_since: string };
			expect(pending.latest_candidate_json).toContain("overlap_10");
			expect(pending.dirty_since).toBeTruthy();
			candidate.mechanical.checkedAt = new Date(at + 600_000).toISOString();
			expect(opinions.offer(candidate, at + 600_000).status).toBe("created");
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_opinion").get(),
			).toEqual({ n: 2 });
			expect(
				db.prepare("SELECT overall FROM ship_judgment_opinion LIMIT 1").get(),
			).toEqual({ overall: "undetermined" });
		} finally {
			store.close();
		}
	});
	it("rejects stale mechanical evidence and changed card identity before writing", async () => {
		const { store, db } = await bindingFixture();
		try {
			const opinions = new ShipJudgmentOpinions(db, (q, c) =>
				store.readShipJudgmentBinding(q, c),
			);
			const candidate = {
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(
					store.readShipJudgmentBinding("q", CHANNEL),
				),
				inputId: null,
				reason: "missing_input",
				mechanical: {
					verdict: "pass",
					reason: "clean",
					digest: "a".repeat(64),
					checkedAt: NOW,
					scope: "main and open PR files",
					checkedRepos: 1,
					openPrCount: 0,
					overlaps: [],
				},
			};
			expect(opinions.offer(candidate, Date.parse(NOW) + 60_001)).toEqual({
				status: "mechanical_stale",
			});
			expect(opinions.offer(candidate, Date.parse(NOW)).status).toBe("created");
			db.prepare(
				"UPDATE workflow_gate_holder SET card_message_id='123456789012345680'",
			).run();
			candidate.bindingDigest = canonicalDigest(
				store.readShipJudgmentBinding("q", CHANNEL),
			);
			expect(opinions.offer(candidate, Date.parse(NOW))).toEqual({
				status: "binding_changed",
			});
			db.prepare("UPDATE workflow_gate_holder SET state='approved'").run();
			expect(opinions.offer(candidate, Date.parse(NOW))).toEqual({
				status: "binding_changed",
			});
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_delivery").get(),
			).toEqual({ n: 1 });
		} finally {
			store.close();
		}
	});
});
