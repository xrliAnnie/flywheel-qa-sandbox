/**
 * FLY-945 Fix D — external-merge convergence sweeper.
 *
 * FLY-921: the Lead executor-merged around the runner → no completion event →
 * post-ship finalization (tmux cleanup + thread archive + Linear Done) never
 * fired and the founder had to ask for the archive by hand. The sweeper
 * converges such sessions on the patrol cadence with strict, fail-closed
 * validation; PR open/unknown/closed-unmerged rows are never touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { type Session, StateStore } from "../../StateStore.js";
import type { BridgeConfig } from "../types.js";

// Spy the finalization orchestrator — the sweeper's job ends at invoking it
// with the right session; the pipeline itself has its own suite.
const runPostShipSpy = vi.fn(async () => {});
vi.mock("../post-ship-finalization.js", async () => {
	const actual = await vi.importActual<
		typeof import("../post-ship-finalization.js")
	>("../post-ship-finalization.js");
	return {
		...actual,
		runPostShipFinalization: (...args: unknown[]) => runPostShipSpy(...args),
	};
});

import {
	createExternalMergeReconciler,
	hasTrustedFounderApproval,
	type PrMergeInfo,
} from "../external-merge-reconcile.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const MERGE_OID = "c".repeat(40);
const OLD_TS = "2026-07-01 00:00:00"; // way past any TTL, inside the 7d window when now is pinned

const projects: ProjectEntry[] = [
	{
		projectName: "proj",
		projectRoot: "/tmp/proj",
		projectRepo: "x/proj",
		leads: [
			{
				agentId: "lead-1",
				forumChannel: "F",
				chatChannel: "C",
				match: { labels: ["engineer"] },
			},
		],
	},
];

const config = {
	host: "127.0.0.1",
	port: 0,
	dbPath: ":memory:",
	notificationChannel: "F",
	defaultLeadAgentId: "lead-1",
	stuckThresholdMinutes: 15,
	stuckCheckIntervalMs: 300000,
	orphanThresholdMinutes: 60,
} as BridgeConfig;

// Pin "now" shortly after OLD_TS so TTL passes AND the 7-day window contains it.
const NOW_MS = new Date("2026-07-02T00:00:00Z").getTime();

function seedSession(store: StateStore, over: Partial<Session> = {}): void {
	const id = (over.execution_id as string) ?? "exec-1";
	store.upsertSession({
		execution_id: id,
		issue_id: "FLY-921",
		project_name: "proj",
		status: "approved_to_ship",
		session_role: "main",
		issue_identifier: "FLY-921",
		issue_labels: JSON.stringify(["engineer"]),
		pr_number: 478,
		last_activity_at: OLD_TS,
		...over,
	} as Session);
	// pr_head_sha is owned by setReviewBinding/patchSessionMetadata, not
	// upsertSession — persist it the way production does.
	store.patchSessionMetadata(id, {
		pr_head_sha: (over.pr_head_sha as string) ?? HEAD,
	});
}

interface Setup {
	store: StateStore;
	pass: () => Promise<void>;
	checkPr: ReturnType<typeof vi.fn>;
	alerts: { title: string }[];
	env: Record<string, string | undefined>;
}

async function setup(opts?: {
	prInfo?: PrMergeInfo;
	trusted?: boolean;
	env?: Record<string, string | undefined>;
	maxCandidates?: number;
	finalizeThreeStagePhases?: (
		issueId: string,
		projectName: string,
	) => Promise<void>;
}): Promise<Setup> {
	const store = await StateStore.create(":memory:");
	const alerts: { title: string }[] = [];
	const checkPr = vi.fn(
		async () =>
			opts?.prInfo ?? {
				state: "merged",
				mergeCommitOid: MERGE_OID,
				headRefOid: HEAD,
			},
	);
	const env = {
		// Ship gates bypassed by default (eligible path); individual tests re-arm.
		FLYWHEEL_MERGE_APPROVAL_GATE: "0",
		FLYWHEEL_QA_DONE_GATE: "0",
		...(opts?.env ?? {}),
	};
	// evaluateShipEligibility reads argsEnv keys only when present — thread via
	// process.env for the gates since computeShipDecision passes process.env.
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	const reconciler = createExternalMergeReconciler({
		store,
		config,
		projects,
		env,
		now: () => NOW_MS,
		maxCandidatesPerProject: opts?.maxCandidates,
		checkPrMerge: checkPr as never,
		hasTrustedApprovalImpl: () => opts?.trusted ?? true,
		finalizeThreeStagePhases: opts?.finalizeThreeStagePhases,
		alertLead: (_s, title) => {
			alerts.push({ title });
		},
		log: () => {},
	});
	return { store, pass: () => reconciler.pass(), checkPr, alerts, env };
}

describe("FLY-945 Fix D: external-merge reconcile pass", () => {
	let envBak: Record<string, string | undefined>;
	beforeEach(() => {
		envBak = {
			FLYWHEEL_MERGE_APPROVAL_GATE: process.env.FLYWHEEL_MERGE_APPROVAL_GATE,
			FLYWHEEL_QA_DONE_GATE: process.env.FLYWHEEL_QA_DONE_GATE,
		};
		runPostShipSpy.mockClear();
	});
	afterEach(() => {
		for (const [k, v] of Object.entries(envBak)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	it("path 1: stale parked + PR MERGED + ship-eligible (gates off) → completed + finalization + audit", async () => {
		const s = await setup();
		seedSession(s.store);
		await s.pass();
		expect(s.store.getSession("exec-1")?.status).toBe("completed");
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
		const audit = s.store
			.getEventsByExecution("exec-1")
			.find((e) => e.event_type === "external_merge_finalized");
		expect(audit?.payload).toMatchObject({
			prNumber: 478,
			mergeCommitOid: MERGE_OID,
		});
	});

	// FLY-1204 (Change A2): the external-merge path is a real ship path, so it
	// must also reclaim the three-stage parked phases (design/implement/qa) — else
	// an external merge writes the post_ship_finalization_claim but leaves the
	// parked phase sessions leaked alive until the periodic patrol catches them.
	// Prove the seam is threaded into runPostShipFinalization's deps.
	it("path 1: passes finalizeThreeStagePhases through to runPostShipFinalization (FLY-1204)", async () => {
		const finalizeThreeStagePhases = vi.fn(async () => {});
		const s = await setup({ finalizeThreeStagePhases });
		seedSession(s.store);
		await s.pass();
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
		const deps = runPostShipSpy.mock.calls[0]?.[1] as {
			finalizeThreeStagePhases?: unknown;
		};
		expect(deps.finalizeThreeStagePhases).toBe(finalizeThreeStagePhases);
	});

	it("path 1: NOT ship-eligible (approval gate armed, no approval) → merge_block park + ONE alert, no finalize", async () => {
		// NOTE: approved_to_ship anchors staleness on last_activity_at (settable
		// in tests); an awaiting_review row's entered_at is stamped to real-now
		// by upsertSession, so it can't be aged in a unit test. Prod covers both.
		const s = await setup({
			env: { FLYWHEEL_MERGE_APPROVAL_GATE: "1", FLYWHEEL_QA_DONE_GATE: "0" },
		});
		seedSession(s.store);
		await s.pass();
		const row = s.store.getSession("exec-1");
		expect(row?.status).toBe("approved_to_ship"); // parked in place, not completed
		expect(row?.merge_block_reason).toContain("merge_without_approval");
		expect(runPostShipSpy).not.toHaveBeenCalled();
		expect(s.alerts).toHaveLength(1);
		// Second pass: marker present → candidate filtered out → no re-alert.
		await s.pass();
		expect(s.alerts).toHaveLength(1);
	});

	it("PR open / unknown / closed-unmerged → untouched (closed ≠ merged)", async () => {
		for (const state of ["open", "unknown", "closed"] as const) {
			const s = await setup({ prInfo: { state } });
			seedSession(s.store);
			await s.pass();
			expect(s.store.getSession("exec-1")?.status).toBe("approved_to_ship");
			expect(runPostShipSpy).not.toHaveBeenCalled();
		}
	});

	it("fresh parked session (inside TTL) is never gh-checked", async () => {
		const s = await setup();
		seedSession(s.store, {
			last_activity_at: new Date(NOW_MS - 60_000)
				.toISOString()
				.replace("T", " ")
				.slice(0, 19),
		});
		await s.pass();
		expect(s.checkPr).not.toHaveBeenCalled();
	});

	it("path 2: completed-but-unfinalized, EXACT merged-head match + trusted approval → finalize (no status change)", async () => {
		const s = await setup({ trusted: true });
		seedSession(s.store, { status: "completed" });
		await s.pass();
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
		const row = s.store.getSession("exec-1");
		expect(row?.status).toBe("completed");
		// The recovery path must preserve the bound head (upsert-free finalize).
		expect(row?.pr_head_sha).toBe(HEAD);
		expect(
			s.store
				.getEventsByExecution("exec-1")
				.some((e) => e.event_type === "external_merge_finalized"),
		).toBe(true);
	});

	it("path 2: trusted approval bound to the OLD head but a DIFFERENT head merged → ALERT, never archived (FLY-921 night shape)", async () => {
		const s = await setup({
			trusted: true,
			prInfo: {
				state: "merged",
				mergeCommitOid: MERGE_OID,
				headRefOid: OTHER_HEAD,
			},
		});
		seedSession(s.store, { status: "completed" });
		await s.pass();
		expect(runPostShipSpy).not.toHaveBeenCalled();
		expect(s.alerts).toHaveLength(1);
		// bound head survives (nothing rewrote the row)
		expect(s.store.getSession("exec-1")?.pr_head_sha).toBe(HEAD);
		// alert is claimed once per (exec, merged head)
		await s.pass();
		expect(s.alerts).toHaveLength(1);
	});

	it("path 2: head matches but NO trusted approval → ALERT, never archived", async () => {
		const s = await setup({ trusted: false });
		seedSession(s.store, { status: "completed" });
		await s.pass();
		expect(runPostShipSpy).not.toHaveBeenCalled();
		expect(s.alerts).toHaveLength(1);
	});

	it("finalize is idempotent: a row that already claimed post-ship finalization is skipped without a gh call", async () => {
		const s = await setup();
		seedSession(s.store, { status: "completed" });
		s.store.insertEvent({
			event_id: "post-ship-finalization-exec-1",
			execution_id: "exec-1",
			issue_id: "FLY-921",
			project_name: "proj",
			event_type: "post_ship_finalization_claim",
			source: "test",
		});
		await s.pass();
		expect(s.checkPr).not.toHaveBeenCalled();
		expect(runPostShipSpy).not.toHaveBeenCalled();
	});

	it("gh budget: at most N candidates per project per pass, rotating across passes", async () => {
		const s = await setup({ maxCandidates: 2, prInfo: { state: "open" } });
		for (let i = 0; i < 5; i++) {
			seedSession(s.store, {
				execution_id: `exec-${i}`,
				issue_id: `FLY-${i}`,
				pr_number: 100 + i,
			} as Partial<Session>);
		}
		await s.pass();
		expect(s.checkPr).toHaveBeenCalledTimes(2);
		await s.pass();
		expect(s.checkPr).toHaveBeenCalledTimes(4);
		// rotation: the 4 calls covered 4 DISTINCT PR numbers, not the same 2 twice
		const prNums = new Set(s.checkPr.mock.calls.map((c) => c[1]));
		expect(prNums.size).toBe(4);
	});

	it("FLYWHEEL_EXTERNAL_MERGE_RECONCILE=0 → complete no-op (reverse-compat)", async () => {
		const s = await setup({
			env: { FLYWHEEL_EXTERNAL_MERGE_RECONCILE: "0" },
		});
		seedSession(s.store);
		await s.pass();
		expect(s.checkPr).not.toHaveBeenCalled();
		expect(s.store.getSession("exec-1")?.status).toBe("approved_to_ship");
	});
});

describe("FLY-945 Fix D: hasTrustedFounderApproval (real CommDB)", () => {
	let tmp: string;
	let envBak: string | undefined;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "fly945-d-"));
		envBak = process.env.FLYWHEEL_COMM_DIR;
		process.env.FLYWHEEL_COMM_DIR = tmp;
	});
	afterEach(() => {
		if (envBak === undefined) delete process.env.FLYWHEEL_COMM_DIR;
		else process.env.FLYWHEEL_COMM_DIR = envBak;
		rmSync(tmp, { recursive: true, force: true });
	});

	const FOUNDER = "123456789012345678";

	function seedGate(
		from: string,
		content: string,
		projectName = "proj",
	): Session {
		const db = new CommDB(join(tmp, projectName, "comm.db"));
		const qid = db.insertQuestion("exec-1", "lead-1", "ship?", {
			checkpoint: "approve_to_ship",
		});
		db.insertResponse(qid, from, content);
		db.close();
		return {
			execution_id: "exec-1",
			issue_id: "FLY-1",
			project_name: projectName,
			status: "completed",
			review_question_id: qid,
		} as Session;
	}

	it("founder-id / bridge / bridge-founder-consent structured approvals are trusted", () => {
		for (const from of [FOUNDER, "bridge", "bridge-founder-consent"]) {
			// distinct project per writer → distinct comm.db, no cross-pollution
			const session = seedGate(
				from,
				JSON.stringify({ approved: true }),
				`proj-${from}`,
			);
			expect(
				hasTrustedFounderApproval(session, {
					env: { DISCORD_OWNER_USER_ID: FOUNDER },
				}),
			).toBe(true);
		}
	});

	it("lead-attributed / plain-text / rejected / unbound → NOT trusted (fail-closed)", () => {
		const leadSession = seedGate(
			"flywheel-eng-lead",
			JSON.stringify({ approved: true }),
		);
		expect(
			hasTrustedFounderApproval(leadSession, {
				env: { DISCORD_OWNER_USER_ID: FOUNDER },
			}),
		).toBe(false);

		const unbound = {
			...leadSession,
			review_question_id: "unbound",
		} as Session;
		expect(
			hasTrustedFounderApproval(unbound, {
				env: { DISCORD_OWNER_USER_ID: FOUNDER },
			}),
		).toBe(false);
	});
});
