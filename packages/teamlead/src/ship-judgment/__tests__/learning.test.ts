import { expect, it, vi } from "vitest";
import { handleShipJudgmentReference } from "../../bridge/ship-judgment-reference-route.js";
import {
	createShipJudgmentReplyObserver,
	listShipJudgmentReplyThreads,
} from "../../bridge/ship-judgment-routes.js";
import { ShipJudgmentClarifications } from "../clarifications.js";
import { canonicalDigest } from "../contract.js";
import { decisionRelation, ShipJudgmentLearning } from "../learning.js";
import { LearningDelivery } from "../learning-delivery.js";
import { ShipJudgmentRuntime } from "../runtime.js";
import { ShipJudgmentStatistics } from "../statistics.js";
import { bindingFixture, CHANNEL, HEAD, NOW } from "./binding-fixture.js";

it.each([
	["eligible", "paired"],
	["late_receipt", "paired"],
	["divergent", "paired"],
	["late", "late"],
	["same_ms", "timing_ambiguous"],
	["dirty", "refresh_pending"],
	["unknown_author", "unknown_author"],
	["other_targets", "superseded"],
	["override", "post_decision_override"],
	["unknown_refresh", "refresh_unknown"],
	["inactive", "inactive"],
] as const)(
	"classifies %s as %s from actual persisted opinion/visibility rows",
	async (scenario, expected) => {
		const { store, db } = await bindingFixture();
		try {
			const now = Date.parse(NOW),
				iso = (offset: number) => new Date(now + offset).toISOString();
			const binding = store.readShipJudgmentBinding("q", CHANNEL)!,
				bindingDigest = canonicalDigest(binding);
			const frozen = store.getShipJudgmentInputs().freeze(
				{
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
				},
				NOW,
			);
			if (frozen.status !== "created") throw new Error(frozen.status);
			const jobs = store.getShipJudgmentJobs(),
				job = jobs.claim(frozen.inputId, "worker", now);
			if (job.status !== "claimed") throw new Error(job.status);
			jobs.markSpawned(job, now);
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
				now + 1,
			);
			const opinion = store.getShipJudgmentOpinions().offer(
				{
					questionId: "q",
					channelId: CHANNEL,
					bindingDigest,
					inputId: frozen.inputId,
					reason: "evaluated",
					mechanical: {
						verdict: "pass",
						reason: "clean",
						digest: "d".repeat(64),
						checkedAt: iso(2),
						scope: "main",
						checkedRepos: 1,
						openPrCount: 0,
						overlaps: [],
					},
				},
				now + 2,
			);
			if (opinion.status !== "created") throw new Error(opinion.status);
			const delivery = store.getShipJudgmentDelivery(),
				claim = delivery.claim("q", CHANNEL, "sender", now + 2);
			if (claim.status !== "claimed") throw new Error(claim.status);
			const visible = scenario === "late" ? 5 : scenario === "same_ms" ? 4 : 3;
			delivery.confirm(
				claim,
				"123456789012345681",
				iso(visible),
				scenario === "late_receipt" ? now + 9 : now + visible,
			);
			const target = store
				.getShipJudgmentInputs()
				.get(frozen.inputId)!.targetsDigest;
			const insert =
				db.prepare(`INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,evidence_json)
 VALUES (?,'b2',?,'q','r',?,?,?,?,?,?,?)`);
			insert.run(
				"decision",
				"source",
				binding.cardMessageId,
				scenario === "other_targets" ? "e".repeat(64) : target,
				scenario === "unknown_author" ? "unknown" : "founder_verified",
				scenario === "divergent" ? "rework" : "approved",
				iso(4),
				iso(6),
				JSON.stringify({
					binding_status: "resolved",
					refresh_history:
						scenario === "dirty"
							? "pending"
							: scenario === "unknown_refresh"
								? "unknown"
								: scenario === "inactive"
									? "inactive"
									: "clear",
				}),
			);
			if (scenario === "override")
				insert.run(
					"first",
					"earlier",
					binding.cardMessageId,
					target,
					"founder_verified",
					"approved",
					iso(3),
					iso(3),
					JSON.stringify({
						binding_status: "resolved",
						refresh_history: "clear",
					}),
				);
			const pair = new ShipJudgmentLearning(db).pair("decision");
			expect(pair.status).toBe(expected);
			const stats = new ShipJudgmentStatistics(db);
			const report = stats.read({ from: NOW, to: iso(10), asOf: iso(10) });
			expect(report.summary.pairs).toBe(pair.status === "paired" ? 1 : 0);
			if (pair.status === "paired") {
				expect(report.summary.matrix[pair.overall][pair.decision]).toBe(1);
				expect(report.versions).toHaveLength(1);
				expect(report.versions[0]).toMatchObject({
					policyVersion: pair.policyVersion,
					modelSnapshotDigest: pair.modelSnapshotDigest,
				});
				const filtered = stats.read({
					from: NOW,
					to: iso(10),
					asOf: iso(10),
					modelSnapshotDigest: "f".repeat(64),
				});
				expect(filtered.summary.pairs).toBe(0);
				expect(filtered.exclusions.version_filtered).toBe(1);
				expect(filtered.cards.total).toBe(1);
			}

			if (scenario === "late_receipt") {
				expect(new ShipJudgmentLearning(db).pair("decision", iso(6))).toEqual({
					status: "late",
				});
				expect(
					new ShipJudgmentLearning(db).pair("decision", iso(9)).status,
				).toBe("paired");
			}
			if (pair.status === "paired")
				expect(pair).toMatchObject({
					opinionId: opinion.opinionId,
					relation: scenario === "divergent" ? "divergent" : "aligned",
					readGapMs: 1,
					visibleAt: iso(3),
					decidedAt: iso(4),
				});
			let mode = "dry_run";
			const clarifications = new ShipJudgmentClarifications(db, () => mode);
			for (const inactive of ["off", "auto"]) {
				mode = inactive;
				expect(clarifications.sweep()).toBe(0);
				expect(clarifications.ensure("decision")).toEqual({
					status: "inactive",
				});
			}
			mode = "dry_run";
			if (scenario === "divergent") {
				const root = canonicalDigest([
					"question",
					opinion.opinionId,
					"decision",
				]);
				// Delivery and immutable root must commit together, even on a local write failure.
				db.exec(`CREATE TRIGGER fail_clarification_delivery BEFORE INSERT ON ship_judgment_delivery
 WHEN NEW.purpose='clarification' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
				expect(() => clarifications.sweep()).toThrow("fixture failure");
				expect(
					db
						.prepare("SELECT count(*) AS n FROM ship_judgment_clarification")
						.get(),
				).toEqual({ n: 0 });
				db.exec("DROP TRIGGER fail_clarification_delivery");
				const runtime = new ShipJudgmentRuntime({
					store,
					owner: "fixture",
					mode: () => mode,
					collect: vi.fn(),
					evaluate: vi.fn(),
					material: vi.fn(),
					unavailable: vi.fn(),
				});
				await runtime.modeTick();
				await runtime.stop();
				expect(
					db
						.prepare("SELECT count(*) AS n FROM ship_judgment_clarification")
						.get(),
				).toEqual({ n: 1 });
				expect(new ShipJudgmentClarifications(db, () => mode).sweep()).toBe(0);
				expect(clarifications.ensure("decision")).toEqual({
					status: "existing",
					clarificationId: root,
				});
				expect(
					db
						.prepare("SELECT count(*) AS n FROM ship_judgment_clarification")
						.get(),
				).toEqual({ n: 1 });
				expect(
					db
						.prepare(
							"SELECT question_id,thread_id,card_message_id,desired_id,state FROM ship_judgment_delivery WHERE purpose='clarification'",
						)
						.get(),
				).toEqual({
					question_id: "q",
					thread_id: binding.threadId,
					card_message_id: binding.cardMessageId,
					desired_id: root,
					state: "pending",
				});

				expect(() =>
					db.transaction(() => {
						db.prepare(
							"INSERT INTO ship_judgment_outcome SELECT 'history-override',source_kind,'history-override',question_id,run_id,card_message_id,targets_digest,authorship,'approved',?,?,verdict_id,evidence_json FROM ship_judgment_outcome WHERE outcome_id='decision'",
						).run(iso(6), iso(6));
						expect(
							store.getShipJudgmentHistory().read(iso(20)).rows[0],
						).toMatchObject({ decision: "approved", clarification: "pending" });
						throw new Error("history fixture rollback");
					})(),
				).toThrow("history fixture rollback");
				expect(clarifications.replyThreads()).toEqual([]);
				const transport = new LearningDelivery(db, () => mode);
				const rendered = transport.view("clarification", root, CHANNEL);
				expect(rendered?.replyTo).toBe(binding.cardMessageId);
				expect(rendered?.content).toContain(`/123456789012345681)`);
				expect(rendered?.since).toBe(iso(4));
				db.prepare(
					"UPDATE workflow_gate_holder SET card_message_id='123456789012345699' WHERE question_id='q'",
				).run();
				expect(transport.view("clarification", root, CHANNEL)).toEqual(
					rendered,
				);
				db.prepare(
					"UPDATE workflow_gate_holder SET card_message_id=? WHERE question_id='q'",
				).run(binding.cardMessageId);

				const claim = transport.claim("clarification", root, "sender", now + 6);
				if (claim.status !== "claimed") throw new Error(claim.status);
				expect(claim.action).toBe("post");
				expect(
					transport.claim("clarification", root, "other", now + 7).status,
				).toBe("busy");
				expect(transport.fail(claim, now + 7, "response_lost", true)).toBe(
					true,
				);
				const retry = transport.claim(
					"clarification",
					root,
					"retry",
					now + 60_008,
				);
				if (retry.status !== "claimed") throw new Error(retry.status);
				expect(retry.action).toBe("scan");
				expect(
					transport.confirm(claim, "123456789012345692", iso(7), now + 60_009),
				).toBe(false);
				expect(
					transport.confirm(retry, "123456789012345692", iso(7), now + 60_009),
				).toBe(true);
				expect(
					transport.claim("clarification", root, "retry", now + 60_010).status,
				).toBe("settled");

				expect(clarifications.replyThreads()).toEqual([
					{ threadId: binding.threadId, questionId: "q" },
				]);
				expect(clarifications.replyThreads(binding.threadId)).toEqual([
					{ threadId: binding.threadId, questionId: "q" },
				]);

				const founder = "123456789012345690",
					messageId = "123456789012345691",
					clarificationMessageId = "123456789012345692";
				const original = {
					id: messageId,
					channel_id: binding.threadId,
					author: { id: founder },
					content: "批准，只是在解释以前的决定。",
					timestamp: iso(8),
					edited_timestamp: null as string | null,
					message_reference: {
						message_id: clarificationMessageId,
						channel_id: binding.threadId,
					},
				};
				const fetchMessage = vi.fn(async () => original as unknown);
				const replies = new ShipJudgmentClarifications(db, () => mode, {
					canonicalFounderId: () => founder,
					fetchMessage,
				});
				const reference = { threadId: binding.threadId, messageId };
				const changesBeforeOff = db
					.prepare("SELECT total_changes() AS n")
					.get();
				mode = "off";
				expect(
					await replies.observe(reference, now + 10, AbortSignal.timeout(1000)),
				).toEqual({ status: "ignored" });
				expect(fetchMessage).not.toHaveBeenCalled();
				expect(clarifications.replyThreads()).toEqual([]);
				expect(
					clarifications.replyTarget(binding.threadId, clarificationMessageId),
				).toBeUndefined();
				expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(
					changesBeforeOff,
				);
				mode = "dry_run";
				fetchMessage.mockImplementationOnce(async () => {
					mode = "off";
					return original;
				});
				expect(
					await replies.observe(reference, now + 10, AbortSignal.timeout(1000)),
				).toEqual({ status: "ignored" });
				expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(
					changesBeforeOff,
				);
				mode = "dry_run";

				for (const invalid of [
					{ ...original, author: { id: "123456789012345699" } },
					{ ...original, channel_id: "123456789012345699" },
					{ ...original, id: "123456789012345699" },
					{
						...original,
						message_reference: { message_id: binding.cardMessageId },
					},
					{
						...original,
						message_reference: { message_id: "123456789012345699" },
					},
					{ ...original, message_reference: undefined },
					{ ...original, timestamp: iso(6) },
					{ ...original, edited_timestamp: iso(11) },
				]) {
					fetchMessage.mockResolvedValueOnce(invalid);
					expect(
						await replies.observe(
							reference,
							now + 10,
							AbortSignal.timeout(1000),
						),
					).toEqual({ status: "ignored" });
				}
				expect(
					db
						.prepare(
							"SELECT count(*) AS n FROM ship_judgment_clarification WHERE supersedes IS NOT NULL",
						)
						.get(),
				).toEqual({ n: 0 });
				fetchMessage.mockRejectedValueOnce(
					new Error("fixture network failure"),
				);
				expect(
					await replies.observe(reference, now + 10, AbortSignal.timeout(1000)),
				).toEqual({ status: "unavailable" });
				const controller = new AbortController();
				fetchMessage.mockImplementationOnce(async () => {
					controller.abort();
					return new Promise(() => {});
				});
				expect(
					await replies.observe(reference, now + 10, controller.signal),
				).toEqual({ status: "unavailable" });
				let currentFounder = founder;
				const changingIdentity = new ShipJudgmentClarifications(
					db,
					() => mode,
					{
						canonicalFounderId: () => currentFounder,
						fetchMessage: async () => {
							currentFounder = "123456789012345699";
							return original;
						},
					},
				);
				expect(
					await changingIdentity.observe(
						reference,
						now + 10,
						AbortSignal.timeout(1000),
					),
				).toEqual({ status: "ignored" });
				db.exec(`CREATE TRIGGER fail_ack_delivery BEFORE INSERT ON ship_judgment_delivery
 WHEN NEW.purpose='ack' BEGIN SELECT RAISE(ABORT,'fixture ack failure'); END`);
				await expect(
					replies.observe(reference, now + 10, AbortSignal.timeout(1000)),
				).rejects.toThrow("fixture ack failure");
				expect(
					db
						.prepare(
							"SELECT count(*) AS n FROM ship_judgment_clarification WHERE supersedes IS NOT NULL",
						)
						.get(),
				).toEqual({ n: 0 });
				db.exec("DROP TRIGGER fail_ack_delivery");
				expect(
					await replies.observe(
						{ ...reference, replyToMessageId: "123456789012345699" },
						now + 10,
						AbortSignal.timeout(1000),
					),
				).toEqual({ status: "ignored" });
				expect(
					db
						.prepare(
							"SELECT count(*) AS n FROM ship_judgment_clarification WHERE supersedes IS NOT NULL",
						)
						.get(),
				).toEqual({ n: 0 });
				const accepted = await replies.observe(
					reference,
					now + 10,
					AbortSignal.timeout(1000),
				);
				expect(accepted).toMatchObject({ status: "recorded" });
				if (accepted.status !== "recorded") throw new Error(accepted.status);
				const ack = transport.view("ack", accepted.clarificationId, CHANNEL);
				expect(ack?.replyTo).toBe(messageId);
				expect(ack?.content).toContain("已记录，未改变批准");
				expect(ack?.content).not.toContain(original.content);

				expect(
					await replies.observe(reference, now + 11, AbortSignal.timeout(1000)),
				).toMatchObject({ status: "existing" });
				fetchMessage.mockResolvedValueOnce({
					...original,
					content: "补充解释",
					edited_timestamp: iso(12),
				});
				expect(
					await replies.observe(reference, now + 13, AbortSignal.timeout(1000)),
				).toMatchObject({ status: "recorded" });
				expect(
					db
						.prepare(
							"SELECT reply_text,resolution,supersedes FROM ship_judgment_clarification WHERE supersedes IS NOT NULL ORDER BY verified_at",
						)
						.all(),
				).toEqual([
					{
						reply_text: original.content,
						resolution: "explained",
						supersedes: root,
					},
					{ reply_text: "补充解释", resolution: "explained", supersedes: root },
				]);
				expect(
					db
						.prepare(
							"SELECT count(*) AS n FROM ship_judgment_delivery WHERE purpose='ack' AND state='pending'",
						)
						.get(),
				).toEqual({ n: 2 });
				vi.spyOn(store, "getSessionLabels").mockReturnValue(["Engineering"]);
				const network = vi.fn(
					async () => new Response(JSON.stringify(original)),
				);
				const observerDeps = {
					store,
					mode: () => mode,
					canonicalFounderId: () => founder,
					projects: [
						{
							projectName: "flywheel",
							projectRoot: "/tmp/fixture",
							leads: [
								{
									agentId: "lead",
									summaryRole: "engineering",
									chatChannel: CHANNEL,
									match: { labels: ["Engineering"] },
									botUserId: "123456789012345696",
									botToken: "fixture-token",
								},
							],
						},
					],
					fetchImpl: network,
				};
				const observer = createShipJudgmentReplyObserver(observerDeps);
				db.prepare(
					"UPDATE workflow_run SET status='terminated' WHERE run_id='r'",
				).run();
				expect(listShipJudgmentReplyThreads(observerDeps).threads).toEqual([
					{
						threadId: binding.threadId,
						issueId: "FLY-2399",
						projectName: "flywheel",
						leadId: "lead",
					},
				]);
				const ingress = {
					projectName: "flywheel",
					leadId: "lead",
					threadId: binding.threadId,
					messageId,
					replyToMessageId: clarificationMessageId,
				};
				expect(
					await observer({
						...ingress,
						replyToMessageId: binding.cardMessageId,
					}),
				).toBe("ignored");
				expect(network).not.toHaveBeenCalled();
				expect(await observer(ingress)).toBe("handled");
				expect(network).toHaveBeenCalledOnce();
				network.mockResolvedValueOnce(new Response("{}", { status: 503 }));
				expect(await observer(ingress)).toBe("retry");
				const refRequest = {
					threadId: binding.threadId,
					messageId,
					replyToMessageId: clarificationMessageId,
					leadAuth: {
						leadId: "lead",
						projectName: "flywheel",
						identityDigest: "a".repeat(64),
					},
				};
				let authorized = true;
				const manualDeps = {
					...observerDeps,
					authorizeLeadRequest: () => authorized,
				};
				const repliesCount = () =>
					(
						db
							.prepare(
								"SELECT count(*) AS n FROM ship_judgment_clarification WHERE supersedes IS NOT NULL",
							)
							.get() as { n: number }
					).n;
				const countBefore = repliesCount();
				original.content = "通过，这是重新核验的旧消息编辑。";
				original.edited_timestamp = iso(12);
				expect(
					(await handleShipJudgmentReference(manualDeps, refRequest)).code,
				).toBe(200);
				expect(repliesCount()).toBe(countBefore + 1);
				expect(
					(await handleShipJudgmentReference(manualDeps, refRequest)).code,
				).toBe(200);
				expect(repliesCount()).toBe(countBefore + 1);
				original.content = "打回：这是另一版解释";
				original.edited_timestamp = iso(13);
				network.mockImplementationOnce(async () => {
					authorized = false;
					return new Response(JSON.stringify(original));
				});
				expect(
					(await handleShipJudgmentReference(manualDeps, refRequest)).code,
				).toBe(403);
				expect(repliesCount()).toBe(countBefore + 1);
				authorized = true;

				expect(store.getWorkflowGateHolderByQuestionId("q")?.state).toBe(
					"awaiting_review",
				);
			} else {
				expect(clarifications.ensure("decision").status).toBe("ineligible");
				expect(
					db
						.prepare("SELECT count(*) AS n FROM ship_judgment_clarification")
						.get(),
				).toEqual({ n: 0 });
			}
		} finally {
			store.close();
		}
	},
);

it.each([
	["can", "approved", "aligned"],
	["can", "rework", "divergent"],
	["can", "canceled", "divergent"],
	["recommend_reject", "approved", "divergent"],
	["recommend_reject", "rework", "aligned"],
	["recommend_reject", "canceled", "abstained"],
	["cannot", "approved", "divergent"],
	["cannot", "rework", "abstained"],
	["cannot", "canceled", "abstained"],
	["undetermined", "approved", "abstained"],
	["undetermined", "rework", "abstained"],
	["undetermined", "canceled", "abstained"],
] as const)(
	"maps %s/%s to action relation %s, not judgment quality",
	(machine, decision, relation) => {
		expect(decisionRelation(machine, decision)).toBe(relation);
	},
);

it("bounds learning scans and resumes after excluded outcomes without consuming off-mode work", async () => {
	const { store, db } = await bindingFixture();
	try {
		const insert =
			db.prepare(`INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,evidence_json)
 VALUES (?,'fixture',?,'q','r','123456789012345678',?,'unknown','approved',?,?,'{}')`);
		for (let i = 0; i < 51; i++)
			insert.run(`outcome-${i}`, `source-${i}`, "a".repeat(64), NOW, NOW);
		let mode = "dry_run";
		expect(new ShipJudgmentClarifications(db, () => mode).sweep()).toBe(16);
		db.exec("VACUUM");
		expect(new ShipJudgmentClarifications(db, () => mode).sweep()).toBe(16);
		expect(new ShipJudgmentClarifications(db, () => mode).sweep()).toBe(16);
		expect(new ShipJudgmentClarifications(db, () => mode).sweep()).toBe(3);
		insert.run("new-outcome", "new-source", "a".repeat(64), NOW, NOW);
		mode = "off";
		expect(new ShipJudgmentClarifications(db, () => mode).sweep()).toBe(0);
		mode = "dry_run";
		expect(new ShipJudgmentClarifications(db, () => mode).sweep()).toBe(1);
		expect(
			db.prepare("SELECT count(*) AS n FROM ship_judgment_clarification").get(),
		).toEqual({ n: 0 });
	} finally {
		store.close();
	}
});

it("commits only inspected clarification outcomes when its synchronous budget is spent", async () => {
	const { store, db } = await bindingFixture();
	let clock: ReturnType<typeof vi.spyOn> | undefined;
	try {
		const insert =
			db.prepare(`INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,evidence_json)
 VALUES (?,'fixture',?,'q','r','123456789012345678',?,'unknown','approved',?,?,'{}')`);
		for (let i = 0; i < 3; i++)
			insert.run(`budget-${i}`, `budget-${i}`, "a".repeat(64), NOW, NOW);
		const observer = new ShipJudgmentClarifications(db, () => "dry_run");
		const ensure = observer.ensure.bind(observer);
		let elapsed = 0;
		clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		vi.spyOn(observer, "ensure").mockImplementation((id) => {
			const result = ensure(id);
			elapsed += 25;
			return result;
		});
		expect(observer.sweep()).toBe(1);
		expect(
			db
				.prepare(
					"SELECT learning_cursor FROM ship_judgment_project_state WHERE project_name='flywheel'",
				)
				.get(),
		).toEqual({ learning_cursor: 1 });
		expect(observer.sweep()).toBe(1);
		expect(observer.sweep()).toBe(1);
		expect(observer.sweep()).toBe(0);
	} finally {
		clock?.mockRestore();
		store.close();
	}
});

it("recomputes a frozen cutoff without later-observed backdated decisions", async () => {
	const { store, db } = await bindingFixture();
	try {
		const iso = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
		const insert =
			db.prepare(`INSERT INTO ship_judgment_outcome(outcome_id,source_kind,source_id,question_id,run_id,card_message_id,targets_digest,authorship,decision,decided_at,observed_at,evidence_json)
 VALUES (?,'fixture',?,'q','r','123456789012345678',?,'founder_verified','approved',?,?,'{}')`);
		insert.run("first", "first", "a".repeat(64), iso(4), iso(6));
		const learning = new ShipJudgmentLearning(db);
		expect(learning.pair("first", iso(5))).toEqual({ status: "missing" });
		expect(learning.pair("first", iso(6))).toEqual({
			status: "unresolved_binding",
		});
		insert.run(
			"late-backdated",
			"late-backdated",
			"a".repeat(64),
			iso(3),
			iso(8),
		);
		expect(learning.pair("first", iso(6))).toEqual({
			status: "unresolved_binding",
		});
		expect(learning.pair("first", iso(8))).toEqual({
			status: "post_decision_override",
		});
		expect(() => learning.pair("first", "not-a-date")).toThrow();
	} finally {
		store.close();
	}
});
