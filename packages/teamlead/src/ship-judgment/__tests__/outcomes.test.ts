import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canonicalDigest } from "../contract.js";
import { ShipJudgmentLearning } from "../learning.js";
import { refreshHistoryAt, ShipJudgmentOutcomes } from "../outcomes.js";
import { ShipJudgmentRuntime } from "../runtime.js";
import { bindingFixture, CHANNEL, HEAD, NOW } from "./binding-fixture.js";

beforeEach(() => {
	vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(() => {
	vi.restoreAllMocks();
});

it("defers future and invalid timestamps without blocking later sources", async () => {
	const { store, db } = await bindingFixture();
	try {
		db.prepare("UPDATE workflow_run SET created_at=?").run(NOW);
		for (const [id, ts] of [
			["future", "2026-09-12T00:00:00.000Z"],
			["invalid", "bad-time"],
			["current", NOW],
		]) {
			store.insertEvent({
				event_id: id!,
				execution_id: "closeout",
				issue_id: "FLY-2399",
				project_name: "flywheel",
				event_type: "closeout_report",
				source: "bridge.lifecycle-closeout",
				payload: { disposition: "canceled" },
			});
			db.prepare("UPDATE session_events SET ts=? WHERE event_id=?").run(ts, id);
		}
		const observer = new ShipJudgmentOutcomes(db);
		expect(observer.observeCancellations(NOW)).toBe(1);
		expect(
			db
				.prepare(
					"SELECT reason FROM ship_judgment_observation_pending ORDER BY reason",
				)
				.all(),
		).toEqual([{ reason: "future" }, { reason: "invalid_source" }]);
		expect(observer.observeCancellations(NOW)).toBe(0);
		expect(observer.pageStats().holderCandidates).toBe(0);
		expect(observer.observeCancellations("2026-09-12T00:00:00.000Z")).toBe(1);
		expect(
			db.prepare("SELECT reason FROM ship_judgment_observation_pending").all(),
		).toEqual([{ reason: "invalid_source" }]);
	} finally {
		store.close();
	}
});

it("uses rounded UTC milliseconds for equal SQLite and ISO cancellation evidence", async () => {
	const { store, db } = await bindingFixture();
	try {
		const sqliteTime = "2026-09-11 00:00:00.123";
		const isoTime = "2026-09-11T00:00:00.123Z";
		db.prepare("UPDATE workflow_run SET created_at=?").run(sqliteTime);
		db.prepare("UPDATE workflow_gate_holder SET created_at=?").run(sqliteTime);
		db.prepare(
			`INSERT INTO linear_state_observations(project,issue_uuid,last_state_type,last_linear_updated_at,observed_at,terminal_authorized) VALUES ('flywheel','FLY-2399','canceled',?,?,1)`,
		).run(isoTime, isoTime);
		store.insertEvent({
			event_id: "utc-equality",
			execution_id: "closeout",
			issue_id: "FLY-2399",
			project_name: "flywheel",
			event_type: "closeout_report",
			source: "bridge.lifecycle-closeout",
			payload: { disposition: "canceled", rootKey: "FLY-2399" },
		});
		db.prepare("UPDATE session_events SET ts=?").run(sqliteTime);
		expect(new ShipJudgmentOutcomes(db).observeCancellations(isoTime)).toBe(1);
		expect(
			db
				.prepare("SELECT authorship,decided_at FROM ship_judgment_outcome")
				.get(),
		).toEqual({ authorship: "founder_verified", decided_at: isoTime });
	} finally {
		store.close();
	}
});

it("advances unmatched closeout sources and never revisits holders without new input", async () => {
	const { store, db } = await bindingFixture();
	try {
		for (let i = 0; i < 725; i++)
			store.insertEvent({
				event_id: `unmatched-${i}`,
				execution_id: "closeout",
				issue_id: "unrelated",
				project_name: "flywheel",
				event_type: "closeout_report",
				source: "bridge.lifecycle-closeout",
				payload: { disposition: "canceled" },
			});
		db.prepare("UPDATE session_events SET ts=?").run(NOW);
		const observer = new ShipJudgmentOutcomes(db);
		for (let i = 0; i < 100; i++) {
			expect(observer.observeCancellations(NOW)).toBe(0);
			if (observer.pageStats().sourceCandidates === 0) break;
		}
		expect(
			db
				.prepare(
					"SELECT last_event_id FROM ship_judgment_observation_cursor WHERE source_kind='closeout'",
				)
				.get(),
		).toEqual(
			db.prepare("SELECT MAX(id) AS last_event_id FROM session_events").get(),
		);
		expect(
			db
				.prepare("SELECT COUNT(*) AS n FROM ship_judgment_observation_pending")
				.get(),
		).toEqual({ n: 0 });
		for (let i = 0; i < 3; i++) {
			observer.observeCancellations(NOW);
			expect(observer.pageStats()).toMatchObject({
				sourceCandidates: 0,
				holderCandidates: 0,
				outcomes: 0,
			});
		}
	} finally {
		store.close();
	}
});

it("persists terminal-holder fanout across bounded pages and rolls back progress with outcomes", async () => {
	const { store, db } = await bindingFixture();
	try {
		db.prepare("UPDATE workflow_run SET created_at=?").run(NOW);
		db.exec("UPDATE workflow_gate_holder SET state='superseded'");
		for (let i = 2; i <= 35; i++)
			db.prepare(`INSERT INTO workflow_gate_holder(run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,state,created_at,updated_at)
		 VALUES ('r','founder_gate',?,?,'execution',?,'superseded',?,?)`).run(
				i,
				HEAD,
				`q-${i.toString().padStart(2, "0")}`,
				NOW,
				NOW,
			);
		store.insertEvent({
			event_id: "fanout",
			execution_id: "closeout",
			issue_id: "FLY-2399",
			project_name: "flywheel",
			event_type: "closeout_report",
			source: "bridge.lifecycle-closeout",
			payload: { disposition: "canceled" },
		});
		db.prepare("UPDATE session_events SET ts=?").run(NOW);
		db.exec(
			"CREATE TRIGGER fail_outcome BEFORE INSERT ON ship_judgment_outcome BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
		);
		expect(() =>
			new ShipJudgmentOutcomes(db).observeCancellations(NOW),
		).toThrow("fixture failure");
		expect(
			db
				.prepare(
					"SELECT last_event_id FROM ship_judgment_observation_cursor WHERE source_kind='closeout'",
				)
				.get(),
		).toEqual({ last_event_id: 0 });
		db.exec("DROP TRIGGER fail_outcome");
		let total = 0;
		for (let i = 0; i < 10; i++) {
			// Reconstruct the observer each time: fanout state cannot live in JS.
			const observer = new ShipJudgmentOutcomes(db);
			total += observer.observeCancellations(NOW);
			expect(observer.pageStats().holderCandidates).toBeLessThanOrEqual(16);
		}
		expect(total).toBe(35);
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_outcome").get(),
		).toEqual({ n: 35 });
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM workflow_gate_holder WHERE state='superseded'",
				)
				.get(),
		).toEqual({ n: 35 });
		expect(
			db
				.prepare("SELECT COUNT(*) AS n FROM ship_judgment_observation_pending")
				.get(),
		).toEqual({ n: 0 });
	} finally {
		store.close();
	}
});

for (const drift of [false, true]) {
	it.each([
		[
			1,
			{
				kind: "gate_response",
				actor: "founder",
				founder_id_at_capture: "founder",
				source_event_id: "source",
			},
			"founder_verified",
		],
		[
			1,
			{
				kind: "gate_response",
				actor: "proxy",
				founder_id_at_capture: "founder",
				source_event_id: "source",
			},
			"unknown",
		],
		[
			0,
			{
				kind: "gate_response",
				actor: "founder",
				founder_id_at_capture: "founder",
				source_event_id: "source",
			},
			"unknown",
		],
		[0, { kind: "auto_narrow_gate", source_event_id: "source" }, "auto"],
		[0, { kind: "operator", principal: "lead" }, "lead_proxy"],
		[
			1,
			{
				kind: "founder_message",
				channel_id: CHANNEL,
				message_id: "123456789012345689",
				card_message_id: "123456789012345678",
				author_user_id: "founder",
				founder_id_at_capture: "founder",
				question_id: "q",
				head_sha: HEAD,
				message_ts: NOW,
				card_message_ts: NOW,
				verified_at: NOW,
			},
			"founder_verified",
		],
		[
			1,
			{
				kind: "founder_message",
				channel_id: CHANNEL,
				message_id: "123456789012345689",
				card_message_id: "123456789012345678",
				author_user_id: "founder",
				founder_id_at_capture: "founder",
				question_id: "wrong",
				head_sha: HEAD,
				message_ts: NOW,
				card_message_ts: NOW,
				verified_at: NOW,
			},
			"unknown",
		],
		[
			1,
			{
				kind: "founder_message",
				channel_id: CHANNEL,
				message_id: "123456789012345689",
				card_message_id: "123456789012345678",
				author_user_id: "founder",
				founder_id_at_capture: "founder",
				question_id: "q",
				head_sha: HEAD,
				message_ts: NOW,
				card_message_ts: NOW,
				verified_at: new Date(Date.parse(NOW) + 1).toISOString(),
			},
			"unknown",
		],
	] as const)(
		`observes B2 authorship (%s/%j) as %s without rewriting authority (target drift ${drift})`,
		async (bit, evidence, authorship) => {
			const { store, db } = await bindingFixture();
			try {
				const bindingDigest = canonicalDigest(
					store.readShipJudgmentBinding("q", CHANNEL),
				);
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
				store.getShipJudgmentOpinions().offer(
					{
						questionId: "q",
						channelId: CHANNEL,
						bindingDigest,
						inputId: frozen.inputId,
						reason: "pending",
						mechanical: {
							verdict: "undetermined",
							reason: "pending",
							digest: "c".repeat(64),
							checkedAt: NOW,
							scope: "main",
							checkedRepos: 1,
							openPrCount: 0,
							overlaps: [],
						},
					},
					Date.parse(NOW),
				);

				db.prepare(`INSERT INTO workflow_rework_request(request_id,run_id,source_event_id,authority,source_node_id,source_attempt,base_revision,authority_context_json,authority_context_digest,founder_feedback_verbatim,requested_at)
 VALUES ('rework','r','source','founder','founder_gate',1,?,'{}',?,'feedback',?)`).run(
					HEAD,
					"b".repeat(64),
					NOW,
				);
				db.prepare(`INSERT INTO workflow_founder_gate_verdict(verdict_id,source_event_id,run_id,gate_node_id,attempt,verdict,question_id,repo_identity,repo_slug,pr_number,head_sha,rework_request_id,claim_id,founder_authored,author_evidence_json,row_digest,recorded_at)
 VALUES ('v','source','r','founder_gate',1,'rework','q','__main__','owner/repo',2399,?,'rework',NULL,?,?,?,?)`).run(
					HEAD,
					bit,
					JSON.stringify(evidence),
					"c".repeat(64),
					NOW,
				);
				const before = db
					.prepare("SELECT * FROM workflow_founder_gate_verdict")
					.all();
				if (drift)
					db.prepare(
						"INSERT INTO workflow_declared_pr(run_id,revision,repo_identity,probe_repo_slug,pr_number,frozen_head_sha,declared_at) VALUES ('r',1,'nested','owner/nested',2400,?,?)",
					).run(HEAD, NOW);
				const observer = new ShipJudgmentOutcomes(db);
				expect(observer.observeVerdicts(NOW)).toBe(1);
				expect(observer.observeVerdicts(NOW)).toBe(0);
				const observedTarget = db
					.prepare("SELECT targets_digest FROM ship_judgment_outcome")
					.get();
				const expectedTarget = {
					targets_digest: store.getShipJudgmentInputs().get(frozen.inputId)!
						.targetsDigest,
				};
				if (drift) expect(observedTarget).not.toEqual(expectedTarget);
				else expect(observedTarget).toEqual(expectedTarget);
				expect(
					db
						.prepare(
							"SELECT authorship,decision,decided_at FROM ship_judgment_outcome",
						)
						.get(),
				).toEqual({ authorship, decision: "rework", decided_at: NOW });
				expect(
					db.prepare("SELECT * FROM workflow_founder_gate_verdict").all(),
				).toEqual(before);
				expect(
					db
						.prepare(
							"SELECT state FROM workflow_gate_holder WHERE question_id='q'",
						)
						.get(),
				).toEqual({ state: "awaiting_review" });
				expect(() =>
					db
						.prepare("UPDATE ship_judgment_outcome SET decision='approved'")
						.run(),
				).toThrow(/immutable/);
			} finally {
				store.close();
			}
		},
	);
}

it.each([
	["2026-09-10T23:59:59.000Z", null, "dry_run", "clear"],
	[
		"2026-09-10T23:59:59.000Z",
		"2026-09-10T23:59:58.000Z",
		"dry_run",
		"pending",
	],
	["2026-09-11T00:00:01.000Z", null, "dry_run", "unknown"],
	[null, null, "dry_run", "unknown"],
	[NOW, null, "dry_run", "unknown"],
	["2026-09-10T23:59:59.000Z", null, "auto", "inactive"],
] as const)(
	"preserves refresh history %s/%s/%s as %s",
	(changed, dirty, mode, status) => {
		expect(
			refreshHistoryAt(
				{
					presentation_state_changed_at: changed,
					dirty_since: dirty,
					delivery_mode: mode,
				},
				NOW,
			),
		).toBe(status);
	},
);

it.each([
	["complete", "founder_verified", 1],
	["missing_observation", "unknown", 1],
	["not_authorized", "unknown", 1],
	["reopened", "unknown", 1],
	["later_observation", "unknown", 1],
	["wrong_root", "unknown", 1],
	["ambiguous_run", "unknown", 1],
	["technical", null, 0],
	["other_project", null, 0],
] as const)(
	"observes cancellation %s using Linear + closeout + original run",
	async (scenario, expected, count) => {
		const { store, db } = await bindingFixture();
		try {
			const decided = "2026-09-11T00:01:00.000Z",
				observed = "2026-09-11T00:02:00.000Z",
				closed = "2026-09-11T00:03:00.000Z";
			db.prepare("UPDATE workflow_run SET created_at=? WHERE run_id='r'").run(
				NOW,
			);
			if (scenario === "ambiguous_run") {
				db.prepare(
					"UPDATE workflow_run SET status='terminated' WHERE run_id='r'",
				).run();
				store.createWorkflowRun({
					runId: "other-run",
					issueId: "FLY-2399",
					projectName: "flywheel",
				});
				db.prepare(
					"UPDATE workflow_run SET created_at=? WHERE run_id='other-run'",
				).run(NOW);
			}

			db.prepare(
				"INSERT INTO workflow_run_issue_alias(run_id,issue_alias) VALUES ('r','issue-uuid')",
			).run();
			if (scenario !== "missing_observation")
				db.prepare(`INSERT INTO linear_state_observations(project,issue_uuid,last_state_type,last_linear_updated_at,observed_at,terminal_authorized)
 VALUES ('flywheel','issue-uuid',?,?,?,?)`).run(
					scenario === "reopened" ? "started" : "canceled",
					scenario === "later_observation"
						? "2026-09-11T00:04:00.000Z"
						: decided,
					observed,
					scenario === "not_authorized" ? 0 : 1,
				);
			store.insertEvent({
				event_id: "closeout",
				execution_id: "closeout-FLY-2399",
				issue_id: "FLY-2399",
				project_name: scenario === "other_project" ? "raya" : "flywheel",
				event_type:
					scenario === "technical"
						? "run_terminated_by_operator"
						: "closeout_report",
				source: "bridge.lifecycle-closeout",
				payload: {
					rootKey: scenario === "wrong_root" ? "other-uuid" : "issue-uuid",
					disposition: "canceled",
					outcome: "complete",
				},
			});
			db.prepare(
				"UPDATE session_events SET ts=? WHERE event_id='closeout'",
			).run(closed);
			const observer = new ShipJudgmentOutcomes(db);
			const errors = vi.fn();
			let mode = "off";
			const runtime = new ShipJudgmentRuntime({
				store,
				owner: "fixture",
				mode: () => mode,
				now: () => Date.parse("2026-09-11T00:05:00.000Z"),
				collect: async () => {
					throw new Error("must not collect");
				},
				evaluate: async () => {
					throw new Error("must not evaluate");
				},
				material: () => {},
				unavailable: () => {},
				onError: errors,
			});
			await runtime.modeTick();
			expect(
				db.prepare("SELECT count(*) AS n FROM ship_judgment_outcome").get(),
			).toEqual({ n: 0 });
			mode = "dry_run";
			await runtime.modeTick();
			await runtime.stop();
			expect(errors).not.toHaveBeenCalled();
			expect(
				db.prepare("SELECT count(*) AS n FROM ship_judgment_outcome").get(),
			).toEqual({ n: count });
			expect(observer.observeCancellations("2026-09-11T00:05:01.000Z")).toBe(0);
			const rows = db
				.prepare(
					"SELECT authorship,decision,verdict_id,decided_at FROM ship_judgment_outcome",
				)
				.all();
			expect(rows).toEqual(
				count
					? [
							{
								authorship: expected,
								decision: "canceled",
								verdict_id: null,
								decided_at: expected === "founder_verified" ? decided : closed,
							},
						]
					: [],
			);
			expect(store.getWorkflowGateHolderByQuestionId("q")?.state).toBe(
				"awaiting_review",
			);
		} finally {
			store.close();
		}
	},
);

it("keeps repeated closeouts as audit receipts but excludes duplicate cancellation episodes from learning", async () => {
	const { store, db } = await bindingFixture();
	try {
		db.prepare("UPDATE workflow_run SET created_at=? WHERE run_id='r'").run(
			NOW,
		);
		db.prepare(
			"INSERT INTO workflow_run_issue_alias(run_id,issue_alias) VALUES ('r','issue-uuid')",
		).run();
		db.prepare(
			`INSERT INTO linear_state_observations(project,issue_uuid,last_state_type,last_linear_updated_at,observed_at,terminal_authorized) VALUES ('flywheel','issue-uuid','canceled','2026-09-11T00:01:00.000Z','2026-09-11T00:02:00.000Z',1)`,
		).run();
		const close = (eventId: string, time: string) => {
			store.insertEvent({
				event_id: eventId,
				execution_id: "closeout-FLY-2399",
				issue_id: "FLY-2399",
				project_name: "flywheel",
				event_type: "closeout_report",
				source: "bridge.lifecycle-closeout",
				payload: {
					rootKey: "issue-uuid",
					disposition: "canceled",
					outcome: "complete",
				},
			});
			db.prepare("UPDATE session_events SET ts=? WHERE event_id=?").run(
				time,
				eventId,
			);
		};
		const observer = new ShipJudgmentOutcomes(db),
			learning = new ShipJudgmentLearning(db);
		const rows = () =>
			db
				.prepare("SELECT outcome_id FROM ship_judgment_outcome ORDER BY rowid")
				.all() as { outcome_id: string }[];
		close("first", "2026-09-11T00:03:00.000Z");
		expect(observer.observeCancellations("2026-09-11T00:03:01.000Z")).toBe(1);
		const first = rows()[0]!.outcome_id,
			original = learning.pair(first);
		expect(original.status).toBe("unresolved_binding");
		close("retry", "2026-09-11T00:04:00.000Z");
		expect(observer.observeCancellations("2026-09-11T00:04:01.000Z")).toBe(1);
		expect(rows()).toHaveLength(2);
		expect(learning.pair(first)).toEqual(original);
		expect(learning.pair(rows()[1]!.outcome_id)).toEqual({
			status: "duplicate_cancellation",
		});
		const audit = db
			.prepare("SELECT * FROM ship_judgment_outcome ORDER BY rowid")
			.all();
		db.exec("VACUUM");
		expect(new ShipJudgmentLearning(db).pair(first)).toEqual(original);
		expect(new ShipJudgmentLearning(db).pair(rows()[1]!.outcome_id)).toEqual({
			status: "duplicate_cancellation",
		});
		expect(
			db.prepare("SELECT * FROM ship_judgment_outcome ORDER BY rowid").all(),
		).toEqual(audit);
		expect(observer.observeCancellations("2026-09-11T00:04:02.000Z")).toBe(0);
		db.prepare(
			"UPDATE linear_state_observations SET last_linear_updated_at='2026-09-11T00:05:00.000Z',observed_at='2026-09-11T00:06:00.000Z'",
		).run();
		close("later-change", "2026-09-11T00:07:00.000Z");
		expect(observer.observeCancellations("2026-09-11T00:07:01.000Z")).toBe(1);
		expect(learning.pair(rows()[2]!.outcome_id)).toEqual({
			status: "post_decision_override",
		});
		expect(learning.pair(first)).toEqual(original);
	} finally {
		store.close();
	}
});
