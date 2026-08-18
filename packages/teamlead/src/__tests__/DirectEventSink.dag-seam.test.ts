/**
 * FLY-1372 §2.5: the durable emitStarted seam for Bridge-trusted behavior
 * fields (doc_tier / issue_url / codex_skip).
 *
 * - Envelope WITH fields (pipeline.dag start) → columns land in the SAME
 *   upsert transaction as row creation (crash-convergent by construction).
 * - Envelope WITHOUT fields (every legacy start) → columns untouched — the
 *   legacy route-patch persistence timing stays byte-identical (#14d).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { EventEnvelope } from "flywheel-edge-worker/dist/ExecutionEventEmitter.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../bridge/plugin.js";
import type { TurnBeltReconciler } from "../bridge/turn-belt-reconcile.js";
import { DirectEventSink } from "../DirectEventSink.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const testProjects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel-seam",
		leads: [],
	},
] as unknown as ProjectEntry[];

const testConfig = {
	host: "127.0.0.1",
	port: 0,
	dbPath: ":memory:",
	ingestToken: "ingest-secret",
	notificationChannel: "test-channel",
	defaultLeadAgentId: "lead",
	stuckThresholdMinutes: 15,
	stuckCheckIntervalMs: 300000,
	orphanThresholdMinutes: 60,
	discordBotToken: "bot-token",
} as unknown as BridgeConfig;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function harness() {
	const dir = mkdtempSync(join(tmpdir(), "fly1372-seam-"));
	const dbPath = join(dir, "state.db");
	const store = await StateStore.create(dbPath);
	cleanups.push(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const sink = new DirectEventSink(store, testConfig, testProjects);
	const raw = (executionId: string) => {
		const reader = new BetterSqlite3(dbPath, { readonly: true });
		try {
			return reader
				.prepare(
					`SELECT doc_tier, issue_url, codex_skip
					   FROM sessions WHERE execution_id = ?`,
				)
				.get(executionId) as {
				doc_tier: string | null;
				issue_url: string | null;
				codex_skip: number;
			};
		} finally {
			reader.close();
		}
	};
	return { store, sink, raw };
}

const baseEnv: EventEnvelope = {
	executionId: "seam-1",
	issueId: "FLY-802",
	projectName: "flywheel",
};

describe("FLY-1372 DirectEventSink behavior-field seam", () => {
	it("FLY-1718 settles launch authority only after the Bridge-local binding", async () => {
		const { sink } = await harness();
		const activate = vi.fn(async () => ({ ok: true }));
		sink.lifecycleActivate = activate;
		await sink.emitStarted({ ...baseEnv, executionId: "doa-owner" });
		expect(activate).not.toHaveBeenCalled();
		await sink.emitWorktreeReady(
			{ ...baseEnv, executionId: "doa-owner" },
			"/tmp/doa-owner",
			{
				branch: "flywheel-FLY-1718",
				generation: "doa-generation-1",
			},
		);
		expect(activate).toHaveBeenCalledOnce();
		expect(activate).toHaveBeenCalledWith("doa-owner");
	});

	it("persists the repository baseline in the immutable worktree binding", async () => {
		const { sink, store } = await harness();
		await sink.emitStarted(baseEnv);
		await sink.emitWorktreeReady(baseEnv, "/tmp/flywheel-seam", {
			branch: "flywheel-FLY-802",
			generation: "generation-1",
			repoBaselineSetJson: '{"repositories":[],"version":1}',
			repoBaselineSetDigest: "digest-1",
		});
		expect(store.getWorktreeBinding("seam-1")).toMatchObject({
			path: "/tmp/flywheel-seam",
			branch: "flywheel-FLY-802",
			generation: "generation-1",
			repoBaselineSetJson: '{"repositories":[],"version":1}',
			repoBaselineSetDigest: "digest-1",
		});
		await sink.emitWorktreeReady(baseEnv, "/tmp/rebound", {
			branch: "rebound",
			generation: "generation-2",
			repoBaselineSetJson: "{}",
			repoBaselineSetDigest: "digest-2",
		});
		expect(store.getWorktreeBinding("seam-1")?.generation).toBe("generation-1");
	});

	it("persists the three behavior fields atomically with session-row creation", async () => {
		const { sink, raw } = await harness();
		await sink.emitStarted({
			...baseEnv,
			docTier: "full",
			issueUrl: "https://linear.app/x/FLY-802",
			codexSkip: false,
		});
		expect(raw("seam-1")).toEqual({
			doc_tier: "full",
			issue_url: "https://linear.app/x/FLY-802",
			codex_skip: 0,
		});
	});

	it("#14d an envelope WITHOUT the fields (legacy start) leaves the columns at their defaults — route-patch timing unchanged", async () => {
		const { sink, raw } = await harness();
		await sink.emitStarted({ ...baseEnv, executionId: "seam-legacy" });
		expect(raw("seam-legacy")).toEqual({
			doc_tier: null,
			issue_url: null,
			codex_skip: 0,
		});
	});

	it("a repeated started upsert without fields does not clobber previously landed values", async () => {
		const { sink, raw } = await harness();
		await sink.emitStarted({
			...baseEnv,
			executionId: "seam-re",
			docTier: "plan_only",
			issueUrl: "https://linear.app/x/FLY-802",
			codexSkip: true,
		});
		await sink.emitStarted({ ...baseEnv, executionId: "seam-re" });
		expect(raw("seam-re")).toEqual({
			doc_tier: "plan_only",
			issue_url: "https://linear.app/x/FLY-802",
			codex_skip: 1,
		});
	});
});

describe("FLY-1385 enrolled teardown seam", () => {
	it("persists a failed takeover signal and alerts before returning from the generalized path", async () => {
		const { store, sink } = await harness();
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		const env = {
			FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
		};
		store.importWorkflowTemplateSeed(seed);
		store.materializeWorkflowRun({
			runId: "run-teardown",
			issueId: "FLY-1335",
			projectName: "flywheel",
			taskCategory: "code",
			templateId: seed.templateId,
			claimsReadEnrolled: true,
			actor: "lead",
			env,
			startReservation: {
				idempotencyKey: "teardown-start",
				selectionDigest: "teardown-selection",
				nodeId: "design",
				attempt: 1,
				executionId: "teardown-exec",
				createdAt: "2026-07-20T00:00:00.000Z",
			},
		});
		store.upsertWorkflowRunNode({
			runId: "run-teardown",
			nodeId: "design",
			attempt: 1,
			state: "running",
			executionId: "teardown-exec",
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-teardown",
				nodeId: "design",
				executionId: "teardown-exec",
				attempt: 1,
				now: "2026-07-20T00:01:00.000Z",
				expiresAt: "2026-07-20T01:00:00.000Z",
				absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
				env,
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: "teardown-exec",
			issue_id: "FLY-1335",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "design",
		});
		const enqueue = vi.fn();
		const displayEnqueue = vi.fn();
		const alertWorktreeTakeoverFailure = vi.fn(async () => {});
		sink.terminalCommDbSync = { enqueue };
		sink.turnBeltReconciler = {
			current: {
				alertWorktreeTakeoverFailure,
			} as unknown as TurnBeltReconciler,
		};
		sink.issueDisplayRefresh = {
			current: {
				enqueue: displayEnqueue,
				refresh: vi.fn(async () => {}),
			},
		};

		await sink.emitFailed(
			{
				executionId: "teardown-exec",
				issueId: "FLY-1335",
				projectName: "flywheel",
				sessionRole: "design",
			},
			"worktree takeover refused",
			undefined,
			{
				failureKind: "worktree_takeover_failed",
				failureReason: "worktree_takeover_failed: dirty",
			},
		);

		expect(store.getSession("teardown-exec")).toMatchObject({
			status: "failed",
			last_error: "worktree takeover refused",
			workflow_node_id: "design",
		});
		expect(
			store
				.getEventsByExecution("teardown-exec")
				.filter((event) => event.event_type === "session_failed"),
		).toHaveLength(1);
		expect(
			store
				.listWorkflowRunEvents("run-teardown")
				.filter((event) => event.kind === "generalized_teardown_recorded"),
		).toHaveLength(1);
		expect(enqueue).toHaveBeenCalledWith("teardown-exec", "failed", "flywheel");
		expect(alertWorktreeTakeoverFailure).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "teardown-exec" }),
			"worktree_takeover_failed: dirty",
		);
		expect(displayEnqueue).not.toHaveBeenCalled();
	});

	it("refuses an evidence-less design completion without invoking legacy completion hooks", async () => {
		const { store, sink } = await harness();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		const env = {
			FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
		};
		store.importWorkflowTemplateSeed(seed);
		store.materializeWorkflowRun({
			runId: "run-completed-teardown",
			issueId: "FLY-1335",
			projectName: "flywheel",
			taskCategory: "code",
			templateId: seed.templateId,
			claimsReadEnrolled: true,
			actor: "lead",
			env,
			startReservation: {
				idempotencyKey: "completed-teardown-start",
				selectionDigest: "completed-teardown-selection",
				nodeId: "design",
				attempt: 1,
				executionId: "completed-teardown-exec",
				createdAt: "2026-07-20T00:00:00.000Z",
			},
		});
		store.upsertWorkflowRunNode({
			runId: "run-completed-teardown",
			nodeId: "design",
			attempt: 1,
			state: "running",
			executionId: "completed-teardown-exec",
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-completed-teardown",
				nodeId: "design",
				executionId: "completed-teardown-exec",
				attempt: 1,
				now: "2026-07-20T00:01:00.000Z",
				expiresAt: "2026-07-20T01:00:00.000Z",
				absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
				env,
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: "completed-teardown-exec",
			issue_id: "FLY-1335",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "design",
		});
		const displayEnqueue = vi.fn();
		sink.issueDisplayRefresh = {
			current: {
				enqueue: displayEnqueue,
				refresh: vi.fn(async () => {}),
			},
		};

		await sink.emitCompleted(
			{
				executionId: "completed-teardown-exec",
				issueId: "FLY-1335",
				projectName: "flywheel",
				sessionRole: "design",
			},
			{
				success: true,
				decision: { route: "phase_design_complete", reasoning: "done" },
			},
		);

		expect(store.getSession("completed-teardown-exec")).toMatchObject({
			status: "running",
			workflow_node_id: "design",
		});
		expect(
			store
				.getEventsByExecution("completed-teardown-exec")
				.filter((event) => event.event_type === "session_completed"),
		).toHaveLength(0);
		expect(
			store
				.listWorkflowRunEvents("run-completed-teardown")
				.filter((event) => event.kind === "generalized_teardown_recorded"),
		).toHaveLength(0);
		expect(displayEnqueue).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/founder design HTML.*refus/i),
		);
		warn.mockRestore();
	});
});
