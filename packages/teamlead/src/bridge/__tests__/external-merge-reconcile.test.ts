/**
 * FLY-945 Fix D — external-merge convergence sweeper.
 *
 * FLY-921: the Lead executor-merged around the runner → no completion event →
 * post-ship finalization (tmux cleanup + thread archive + Linear Done) never
 * fired and the founder had to ask for the archive by hand. The sweeper
 * converges such sessions on the patrol cadence with strict, fail-closed
 * validation; PR open/unknown/closed-unmerged rows are never touched.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { legacyWorkflowSeeds } from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import {
	insertHistoricalAutoQaRecord,
	setHistoricalQaRequiredSnapshot,
} from "../../__tests__/helpers/historical-qa.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { type Session, StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../../workflow-run-snapshot.js";
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
import {
	computeAuthoritativeShipDecision,
	mergedPrCiProbe,
} from "../merge-ship-gate.js";

let HEAD = "";
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

function seedSession(
	store: StateStore,
	over: Partial<Session> = {},
	qaRequired: 0 | 1 = 0,
): void {
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
		worktree_path: worktreePath,
		...over,
	} as Session);
	// pr_head_sha is owned by setReviewBinding/patchSessionMetadata, not
	// upsertSession — persist it the way production does.
	store.patchSessionMetadata(id, {
		pr_head_sha: (over.pr_head_sha as string) ?? HEAD,
	});
	setHistoricalQaRequiredSnapshot(store, {
		executionId: id,
		required: qaRequired,
		reason: "external merge fixture",
	});
}

function seedMergeApproval(store: StateStore, executionId = "exec-1"): void {
	const db = new CommDB(join(tmpRoot, "comm", "proj", "comm.db"));
	const questionId = db.insertQuestion(executionId, "lead-1", "ship?", {
		checkpoint: "approve_to_ship",
	});
	db.insertResponse(questionId, "bridge", JSON.stringify({ approved: true }));
	db.close();
	store.setReviewBinding(executionId, {
		questionId,
		prHeadSha: HEAD,
	});
	store.recordCodexReviewApproved({
		executionId,
		targetPrHeadSha: HEAD,
		issueId: "FLY-921",
		projectName: "proj",
	});
}

function bindEngineRun(store: StateStore, executionId = "exec-1"): void {
	const dispatchBak = process.env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH;
	const writeBak = process.env.FLYWHEEL_WORKFLOW_CLAIMS_WRITE;
	const readBak = process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ;
	try {
		process.env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH = "1";
		process.env.FLYWHEEL_WORKFLOW_CLAIMS_WRITE = "1";
		process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ = "1";
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		store.importWorkflowTemplateSeed(seed);
		store.materializeWorkflowRun({
			runId: "engine-run",
			issueId: "FLY-921",
			projectName: "proj",
			taskCategory: "code",
			templateId: seed.templateId,
			claimsReadEnrolled: false,
			actor: "lead",
			startReservation: {
				idempotencyKey: "engine-start",
				selectionDigest: "selection",
				nodeId: "design",
				attempt: 1,
				executionId,
				createdAt: "2026-07-01T00:00:00.000Z",
			},
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "engine-run",
				nodeId: "design",
				executionId,
				attempt: 1,
				now: "2026-07-01T00:01:00.000Z",
				expiresAt: "2027-07-01T00:01:00.000Z",
				absoluteDeadlineAt: "2027-07-02T00:01:00.000Z",
				env: {
					FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
				},
			}).ok,
		).toBe(true);
	} finally {
		for (const [key, value] of Object.entries({
			FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: dispatchBak,
			FLYWHEEL_WORKFLOW_CLAIMS_WRITE: writeBak,
			FLYWHEEL_WORKFLOW_CLAIMS_READ: readBak,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

interface Setup {
	store: StateStore;
	pass: () => Promise<void>;
	checkPr: ReturnType<typeof vi.fn>;
	alerts: { title: string }[];
	env: Record<string, string | undefined>;
}

let tmpRoot: string;
let worktreePath: string;
let stateDbSequence = 0;

async function setup(opts?: {
	prInfo?: PrMergeInfo;
	trusted?: boolean;
	env?: Record<string, string | undefined>;
	maxCandidates?: number;
	finalizeWorkflowPhaseRoles?: (
		issueId: string,
		projectName: string,
	) => Promise<void>;
	retireMergedGates?: Parameters<
		typeof createExternalMergeReconciler
	>[0]["retireMergedGates"];
}): Promise<Setup> {
	const store = await StateStore.create(
		join(tmpRoot, `state-${stateDbSequence++}.db`),
	);
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
		FLYWHEEL_WORKFLOW_CLAIMS_READ: "0",
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
		finalizeWorkflowPhaseRoles: opts?.finalizeWorkflowPhaseRoles,
		retireMergedGates: opts?.retireMergedGates,
		alertLead: (_s, title) => {
			alerts.push({ title });
		},
		log: () => {},
	});
	return { store, pass: () => reconciler.pass(), checkPr, alerts, env };
}

describe("FLY-945 Fix D: external-merge reconcile pass", () => {
	let priorCommDir: string | undefined;
	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "fly945-external-merge-"));
		worktreePath = join(tmpRoot, "worktree");
		mkdirSync(worktreePath);
		execFileSync("git", ["init", "-q", worktreePath]);
		execFileSync("git", [
			"-C",
			worktreePath,
			"config",
			"user.email",
			"test@example.com",
		]);
		execFileSync("git", ["-C", worktreePath, "config", "user.name", "Test"]);
		writeFileSync(join(worktreePath, "fixture.txt"), "fixture\n");
		execFileSync("git", ["-C", worktreePath, "add", "fixture.txt"]);
		execFileSync("git", ["-C", worktreePath, "commit", "-qm", "fixture"]);
		HEAD = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		priorCommDir = process.env.FLYWHEEL_COMM_DIR;
		process.env.FLYWHEEL_COMM_DIR = join(tmpRoot, "comm");
		stateDbSequence = 0;
		runPostShipSpy.mockClear();
	});
	afterEach(() => {
		if (priorCommDir === undefined) delete process.env.FLYWHEEL_COMM_DIR;
		else process.env.FLYWHEEL_COMM_DIR = priorCommDir;
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("path 1: stale parked + PR MERGED + approved → completed + finalization + audit", async () => {
		const s = await setup();
		seedSession(s.store);
		seedMergeApproval(s.store);
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

	it("offers only a fresh MERGED proof to gate retirement", async () => {
		const retireMergedGates = vi.fn(
			async (input: {
				revalidate: () => Promise<"authorized" | "unknown">;
			}) => {
				expect(await input.revalidate()).toBe("authorized");
			},
		);
		const s = await setup({
			retireMergedGates: retireMergedGates as never,
		});
		seedSession(s.store);

		await s.pass();

		expect(retireMergedGates).toHaveBeenCalledWith(
			expect.objectContaining({
				projectName: "proj",
				canonicalIssueId: "FLY-921",
				prNumber: 478,
				authorityCredential: `proj:478:${MERGE_OID}`,
				revalidate: expect.any(Function),
			}),
		);
		expect(s.checkPr).toHaveBeenCalledTimes(2);
	});

	it("path 1: an already-merged PR does not re-run the open-PR CI probe", async () => {
		const s = await setup();
		seedSession(s.store, {}, 1);
		const db = new CommDB(join(tmpRoot, "comm", "proj", "comm.db"));
		const qid = db.insertQuestion("exec-1", "lead-1", "ship?", {
			checkpoint: "approve_to_ship",
		});
		db.insertResponse(qid, "bridge", JSON.stringify({ approved: true }));
		db.close();
		s.store.setReviewBinding("exec-1", {
			questionId: qid,
			prHeadSha: HEAD,
		});
		insertHistoricalAutoQaRecord(s.store, {
			parentExecutionId: "exec-1",
			targetPrHeadSha: HEAD,
			issueId: "FLY-921",
			projectName: "proj",
			status: "passed",
		});
		s.store.recordCodexReviewApproved({
			executionId: "exec-1",
			targetPrHeadSha: HEAD,
			issueId: "FLY-921",
			projectName: "proj",
		});
		const session = s.store.getSession("exec-1");
		if (!session) throw new Error("session missing");
		const decision = await computeAuthoritativeShipDecision(
			s.store,
			session,
			HEAD,
			s.env as NodeJS.ProcessEnv,
			undefined,
			mergedPrCiProbe,
		);
		expect(decision).toMatchObject({
			eligible: true,
			mergeApprovalOk: true,
			qaOk: true,
		});

		await s.pass();

		expect(s.store.getSession("exec-1")?.status).toBe("completed");
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
		expect(s.alerts).toHaveLength(0);
	});

	// FLY-1204 (Change A2): the external-merge path is a real ship path, so it
	// must also reclaim the DAG workflow parked phases (design/implement/qa) — else
	// an external merge writes the post_ship_finalization_claim but leaves the
	// parked phase sessions leaked alive until the periodic patrol catches them.
	// Prove the seam is threaded into runPostShipFinalization's deps.
	it("path 1: passes finalizeWorkflowPhaseRoles through to runPostShipFinalization (FLY-1204)", async () => {
		const finalizeWorkflowPhaseRoles = vi.fn(async () => {});
		const s = await setup({ finalizeWorkflowPhaseRoles });
		seedSession(s.store);
		seedMergeApproval(s.store);
		await s.pass();
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
		const deps = runPostShipSpy.mock.calls[0]?.[1] as {
			finalizeWorkflowPhaseRoles?: unknown;
		};
		expect(deps.finalizeWorkflowPhaseRoles).toBe(finalizeWorkflowPhaseRoles);
	});

	it("path 1: no approval → merge_block park + ONE alert, no finalize", async () => {
		// NOTE: approved_to_ship anchors staleness on last_activity_at (settable
		// in tests); an awaiting_review row's entered_at is stamped to real-now
		// by upsertSession, so it can't be aged in a unit test. Prod covers both.
		const s = await setup();
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

	it("path 2: an engine-owned completed row cannot bypass missing snapshot ship claims", async () => {
		const s = await setup({ trusted: true });
		bindEngineRun(s.store);
		seedSession(s.store, { status: "completed" });
		await s.pass();
		expect(runPostShipSpy).not.toHaveBeenCalled();
		expect(s.alerts).toHaveLength(1);
		expect(
			s.store
				.getEventsByExecution("exec-1")
				.find((event) => event.event_type === "external_merge_suspect")
				?.payload,
		).toMatchObject({
			engineShipEligible: false,
			engineShipReason: "gate_holder_subject_mismatch",
		});
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

	it("finalize is idempotent only after durable finalization completion", async () => {
		const s = await setup();
		seedSession(s.store, { status: "completed" });
		s.store.insertEvent({
			event_id: "post-ship-finalization-completed-exec-1",
			execution_id: "exec-1",
			issue_id: "FLY-921",
			project_name: "proj",
			event_type: "post_ship_finalization_completed",
			source: "test",
		});
		await s.pass();
		expect(s.checkPr).not.toHaveBeenCalled();
		expect(runPostShipSpy).not.toHaveBeenCalled();
	});

	it("a legacy once-claim without completion is repaired instead of skipped", async () => {
		const s = await setup({ trusted: true });
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
		expect(s.checkPr).toHaveBeenCalledTimes(1);
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
	});

	it("reconciles every declared repository head and finalizes only after the complete set merges", async () => {
		const s = await setup({ maxCandidates: 3 });
		s.store.createWorkflowRun({
			runId: "declared-run",
			issueId: "FLY-1434",
			projectName: "proj",
			claimsReadEnrolled: true,
		});
		s.store.openWorkflowPrManifest({
			runId: "declared-run",
			expectedCount: 2,
		});
		for (const [nodeId, executionId] of [
			["implement-main", "declared-main"],
			["implement-nested", "declared-nested"],
		] as const) {
			s.store.upsertWorkflowRunNode({
				runId: "declared-run",
				nodeId,
				attempt: 1,
				state: "done",
				executionId,
			});
			s.store.upsertSession({
				execution_id: executionId,
				issue_id: "FLY-1434",
				project_name: "proj",
				status: "running",
			});
		}
		const db = (
			s.store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		for (const binding of [
			{
				node: "implement-main",
				pr: 687,
				head: HEAD,
				identity: "__main__",
				slug: "geoforge3d/flywheel",
			},
			{
				node: "implement-nested",
				pr: 42,
				head: OTHER_HEAD,
				identity: "geoforge3d/dashboard",
				slug: "geoforge3d/dashboard",
			},
		]) {
			db.run(
				`INSERT INTO workflow_node_pr_binding
				   (run_id, node_id, attempt, pr_number, head_sha,
				    target_repo_identity, probe_repo_slug, target_repo_path,
				    worktree_binding_generation, receipt_id, bound_at)
				 VALUES ('declared-run', ?, 1, ?, ?, ?, ?, '/tmp/repo',
				         'generation-1', ?, '2026-07-23T00:00:00.000Z')`,
				[
					binding.node,
					binding.pr,
					binding.head,
					binding.identity,
					binding.slug,
					`receipt-${binding.pr}`,
				],
			);
		}
		expect(
			s.store.sealWorkflowPrManifestFromBindings({
				runId: "declared-run",
			}).ok,
		).toBe(true);
		s.checkPr.mockImplementation(async (_root: string, prNumber: number) => ({
			state: "merged",
			headRefOid: prNumber === 687 ? HEAD : OTHER_HEAD,
			mergeCommitOid: MERGE_OID,
		}));

		await s.pass();

		expect(
			s.store
				.listCurrentWorkflowDeclaredPrs("declared-run")
				.map((row) => row.state),
		).toEqual(["merged", "merged"]);
		expect(s.checkPr).toHaveBeenCalledWith(
			"/tmp/proj",
			42,
			10_000,
			"geoforge3d/dashboard",
		);
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
		expect(runPostShipSpy.mock.calls[0]?.[0]).toMatchObject({
			runId: "declared-run",
		});
		expect(runPostShipSpy.mock.calls[0]?.[0]).not.toHaveProperty("mergedPr");
	});

	it("holds declared-PR convergence when the capable producer has no founder_review pass", async () => {
		const s = await setup({ maxCandidates: 1 });
		const repoRoot = join(tmpRoot, "founder-review-repo");
		mkdirSync(join(repoRoot, ".flywheel"), { recursive: true });
		writeFileSync(
			join(repoRoot, ".flywheel", "config.yaml"),
			"project: proj\nlinear:\n  team_id: FLY\nrunners:\n  default: claude\n  available:\n    claude:\n      type: claude\nteams:\n  - name: default\n    orchestrators:\n      - type: dag\n        runner: claude\ndecision_layer:\n  autonomy_level: advisor\n  escalation_channel: discord\ncheckpoints:\n  founder_review:\n    enabled: true\n    timeout_ms: 172800000\n    timeout_behavior: fail-close\n",
		);
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy_land_v1",
		)!;
		const producerId = "implement";
		const manifest = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === producerId
					? { ...node, founder_review: true as const }
					: node,
			),
		};
		s.store.createWorkflowRun({
			runId: "declared-review-run",
			issueId: "FLY-1758",
			projectName: "proj",
			snapshotJson: JSON.stringify(
				buildWorkflowRunSnapshotV1({
					template: { id: seed.templateId, revision: 1 },
					manifest,
				}),
			),
			claimsReadEnrolled: true,
		});
		s.store.openWorkflowPrManifest({
			runId: "declared-review-run",
			expectedCount: 1,
		});
		s.store.upsertWorkflowRunNode({
			runId: "declared-review-run",
			nodeId: producerId,
			attempt: 1,
			state: "done",
			executionId: "declared-review-producer",
		});
		s.store.upsertSession({
			execution_id: "declared-review-producer",
			issue_id: "FLY-1758",
			issue_identifier: "FLY-1758",
			project_name: "proj",
			status: "running",
		});
		const db = (
			s.store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id, node_id, attempt, pr_number, head_sha,
			    target_repo_identity, probe_repo_slug, target_repo_path,
			    worktree_binding_generation, receipt_id, bound_at)
			 VALUES ('declared-review-run', ?, 1, 1758, ?,
			         '__main__', 'geoforge3d/flywheel', ?,
			         'generation-1', 'review-receipt',
			         '2026-08-14T00:00:00.000Z')`,
			[producerId, HEAD, repoRoot],
		);
		expect(
			s.store.sealWorkflowPrManifestFromBindings({
				runId: "declared-review-run",
			}).ok,
		).toBe(true);

		await s.pass();

		expect(runPostShipSpy).not.toHaveBeenCalled();
		expect(s.alerts).toHaveLength(1);
		expect(
			s.store
				.getEventsByExecution("declared-review-producer")
				.find(
					(event) => event.event_type === "founder_review_finalization_hold",
				)?.payload,
		).toMatchObject({
			runId: "declared-review-run",
			head: HEAD,
			reason: "founder_review_missing",
		});
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

	it("ignores the retired parent kill switch and still scans", async () => {
		const retiredKey = ["FLYWHEEL", "EXTERNAL", "MERGE", "RECONCILE"].join("_");
		const s = await setup({
			env: { [retiredKey]: "0" },
		});
		seedSession(s.store);
		await s.pass();
		expect(s.checkPr).toHaveBeenCalledOnce();
		expect(s.store.getSession("exec-1")?.status).toBe("approved_to_ship");
	});
});

describe("FLY-1314: external-merge TURN-belt reclaim", () => {
	let tmp: string;
	let priorCommDir: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "fly1314-turn-belt-"));
		priorCommDir = process.env.FLYWHEEL_COMM_DIR;
		process.env.FLYWHEEL_COMM_DIR = tmp;
		runPostShipSpy.mockClear();
	});

	afterEach(() => {
		if (priorCommDir === undefined) delete process.env.FLYWHEEL_COMM_DIR;
		else process.env.FLYWHEEL_COMM_DIR = priorCommDir;
		delete process.env.FLYWHEEL_TURN_BELT_MERGED_RECLAIM;
		rmSync(tmp, { recursive: true, force: true });
	});

	async function beltHarness(args?: {
		state?: PrMergeInfo["state"];
		probe?: "alive" | "dead_pin" | "absent" | "indeterminate";
		prNumber?: number | null;
		tmuxSession?: string;
		grantedAt?: number;
		beltOnly?: boolean;
		checkPr?: (root: string, pr: number) => Promise<PrMergeInfo>;
		now?: () => number;
		env?: Record<string, string | undefined>;
	}) {
		const store = await StateStore.create(":memory:");
		seedSession(store, {
			execution_id: "qa-holder",
			issue_id: "FLY-1307",
			status: "completed",
			session_role: "qa",
			chat_thread_role: "qa",
			pr_number: args?.prNumber === null ? undefined : (args?.prNumber ?? 478),
			tmux_session:
				args?.tmuxSession === undefined ? "tmux:qa" : args.tmuxSession,
		});
		// Make this a genuine belt-only source: finalization is complete, so the
		// ordinary completed candidate filters out before the TURN candidate.
		if (args?.beltOnly !== false) {
			store.insertEvent({
				event_id: "post-ship-finalization-completed-qa-holder",
				execution_id: "qa-holder",
				issue_id: "FLY-1307",
				project_name: "proj",
				event_type: "post_ship_finalization_completed",
				source: "test",
			});
		}
		const dbPath = join(tmp, "proj", "comm.db");
		const db = new CommDB(dbPath);
		db.grantTurn(
			"FLY-1307",
			"qa-holder",
			"qa",
			args?.grantedAt ?? NOW_MS - 31 * 60_000,
		);
		db.close();
		const checkPr = vi.fn(
			args?.checkPr ??
				(async () => ({
					state: args?.state ?? "merged",
					mergeCommitOid: MERGE_OID,
					headRefOid: HEAD,
				})),
		);
		const probe = vi.fn(async () => args?.probe ?? "dead_pin");
		const reconciler = createExternalMergeReconciler({
			store,
			config,
			projects,
			env: args?.env ?? {},
			now: args?.now ?? (() => NOW_MS),
			checkPrMerge: checkPr as never,
			probeTurnHolderLiveness: probe,
			log: () => {},
		});
		return {
			store,
			dbPath,
			checkPr,
			probe,
			pass: () => reconciler.pass(),
		};
	}

	it("reclaims a belt-only merged candidate and writes the exact CAS audit", async () => {
		const h = await beltHarness();
		await h.pass();

		expect(h.checkPr).toHaveBeenCalledTimes(1);
		expect(h.probe).toHaveBeenCalledTimes(1);
		const db = new CommDB(h.dbPath);
		expect(db.getTurn("FLY-1307")).toBeNull();
		db.close();
		expect(
			h.store
				.getEventsByExecution("qa-holder")
				.find(
					(event) => event.event_type === "turn_belt_reclaimed_external_merge",
				)?.payload,
		).toMatchObject({
			issueId: "FLY-1307",
			holderExecId: "qa-holder",
			epoch: 1,
			prNumber: 478,
			mergeCommitOid: MERGE_OID,
		});
	});

	it("refuses CAS deletion when the epoch advances during the gh probe", async () => {
		let dbPath = "";
		const h = await beltHarness({
			checkPr: async () => {
				const db = new CommDB(dbPath);
				db.grantTurn("FLY-1307", "new-holder", "implement", NOW_MS);
				db.close();
				return { state: "merged", mergeCommitOid: MERGE_OID };
			},
		});
		dbPath = h.dbPath;
		await h.pass();

		const db = new CommDB(h.dbPath);
		expect(db.getTurn("FLY-1307")).toMatchObject({
			holder_exec_id: "new-holder",
			epoch: 2,
		});
		db.close();
		expect(
			h.store
				.getEventsByExecution("qa-holder")
				.some(
					(event) => event.event_type === "turn_belt_reclaimed_external_merge",
				),
		).toBe(false);
	});

	it.each(["open", "closed", "unknown"] as const)(
		"leaves the belt untouched when PR state is %s",
		async (state) => {
			const h = await beltHarness({ state });
			await h.pass();
			const db = new CommDB(h.dbPath);
			expect(db.getTurn("FLY-1307")).not.toBeNull();
			db.close();
		},
	);

	it.each(["alive", "indeterminate"] as const)(
		"does not spend gh or reclaim when the persisted target probes %s",
		async (probe) => {
			const h = await beltHarness({ probe });
			await h.pass();
			expect(h.checkPr).not.toHaveBeenCalled();
			const db = new CommDB(h.dbPath);
			expect(db.getTurn("FLY-1307")).not.toBeNull();
			db.close();
		},
	);

	it("child kill-switch disables only belt reclaim", async () => {
		const h = await beltHarness({
			env: { FLYWHEEL_TURN_BELT_MERGED_RECLAIM: "0" },
		});
		await h.pass();
		expect(h.checkPr).not.toHaveBeenCalled();
	});

	it("the retired parent kill switch no longer disables belt probing", async () => {
		const retiredKey = ["FLYWHEEL", "EXTERNAL", "MERGE", "RECONCILE"].join("_");
		const h = await beltHarness({
			env: { [retiredKey]: "0" },
		});
		await h.pass();
		expect(h.probe).toHaveBeenCalledOnce();
		expect(h.checkPr).toHaveBeenCalledOnce();
	});

	it("requires a persisted tmux target before treating a terminal holder as dead", async () => {
		const h = await beltHarness({ tmuxSession: "" });
		await h.pass();
		expect(h.probe).not.toHaveBeenCalled();
		expect(h.checkPr).not.toHaveBeenCalled();
	});

	it("refuses missing and conflicting PR evidence before spending gh", async () => {
		const missing = await beltHarness({ prNumber: null });
		await missing.pass();
		expect(missing.checkPr).not.toHaveBeenCalled();

		const conflict = await beltHarness();
		seedSession(conflict.store, {
			execution_id: "implement-old",
			issue_id: "FLY-1307",
			status: "failed",
			session_role: "implement",
			chat_thread_role: "implement",
			pr_number: 999,
		});
		await conflict.pass();
		expect(conflict.checkPr).not.toHaveBeenCalled();
	});

	it("promotes a belt that becomes old enough on a later patrol", async () => {
		let clock = NOW_MS;
		const h = await beltHarness({
			grantedAt: NOW_MS - 29 * 60_000,
			now: () => clock,
		});
		await h.pass();
		expect(h.checkPr).not.toHaveBeenCalled();

		clock += 2 * 60_000;
		await h.pass();
		expect(h.checkPr).toHaveBeenCalledTimes(1);
	});

	it("negative-caches non-MERGED results for ten minutes", async () => {
		let clock = NOW_MS;
		const h = await beltHarness({ state: "open", now: () => clock });
		await h.pass();
		await h.pass();
		expect(h.checkPr).toHaveBeenCalledTimes(1);

		clock += 10 * 60_000 + 1;
		await h.pass();
		expect(h.checkPr).toHaveBeenCalledTimes(2);
	});

	it("dedupes ordinary and belt candidates by issue+PR into one gh probe", async () => {
		const h = await beltHarness({ beltOnly: false });
		await h.pass();
		expect(h.checkPr).toHaveBeenCalledTimes(1);
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
		if (from === "bridge-founder-consent") {
			// Read compatibility is intentionally broader than write authority. Seed
			// the pre-FLY-1981 historical row at the migration layer so this fixture
			// cannot accidentally exercise a now-forbidden production write API.
			const raw = (
				db as unknown as {
					db: {
						prepare: (sql: string) => {
							run: (...args: unknown[]) => unknown;
						};
					};
				}
			).db;
			const responseId = `historical-response:${qid}`;
			const deliveryId = `historical-delivery:${qid}`;
			raw
				.prepare(
					"INSERT INTO mailbox_identity (id, delivery_id, insert_projection_hash) VALUES (?, ?, ?)",
				)
				.run(responseId, deliveryId, "historical-test-fixture");
			raw
				.prepare(
					`INSERT INTO mailbox
					 (id, delivery_id, from_agent, to_agent, recipient_kind, type, content,
					  ref_id, created_at, expires_at, relay_state)
					 VALUES (?, ?, 'bridge-founder-consent', 'exec-1', 'runner', 'response',
					         ?, ?, '2026-08-22T00:00:00.000Z',
					         '2026-08-25T00:00:00.000Z', 'terminal_disposed')`,
				)
				.run(responseId, deliveryId, content, qid);
			raw
				.prepare(
					"UPDATE mailbox SET relay_state = 'terminal_disposed' WHERE id = ?",
				)
				.run(qid);
		} else {
			db.insertResponse(qid, from, content);
		}
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
