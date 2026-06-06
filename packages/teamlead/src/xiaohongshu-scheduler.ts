/**
 * FLY-222: thin scheduled-learning scheduler — planning core.
 *
 * This module owns the DECISION ("which collections should spawn a learning
 * Runner this tick"), kept pure + dependency-injected so it is unit-testable
 * without a Bridge or launchd. The side-effecting execution (acquire lease →
 * create-if-absent the fixed trigger issue → POST /api/runs/start) and the
 * shell wrapper / plist wire real deps around it.
 *
 * For each project's `xiaohongshu_learning` config (when enabled), each
 * collection is gated by, in order:
 *   1. routing-tuple validity (validateLearningRoutingTuple — skip + alert),
 *   2. due-ness (state.nextDueAt via isDue — skip quietly if not due).
 * Per-collection failures NEVER abort the others (one bad collection can't wedge
 * the tick).
 */

import type {
	FlywheelConfig,
	XiaohongshuCollectionConfig,
} from "flywheel-config";
import { XIAOHONGSHU_DEFAULT_MAX_FETCH } from "flywheel-config";
import {
	isDue,
	readState,
	setTriggerIssueId,
	withCollectionLock,
	writeState,
	type XiaohongshuState,
} from "flywheel-comm/xiaohongshu-state";
import type { ProjectEntry } from "./ProjectConfig.js";
import {
	type RoutingTupleResult,
	validateLearningRoutingTuple,
} from "./xiaohongshu-routing.js";

/** A fully-resolved per-collection run plan (what the executor needs). */
export interface CollectionRunPlan {
	project: string;
	collectionId: string;
	collectionLabel: string;
	leadId: string;
	departmentLabel: string;
	targetLinearProject: string;
	cadence: string;
	maxFetch: number;
	videoOptIn: boolean;
}

export type CollectionDecision =
	| { action: "spawn"; plan: CollectionRunPlan }
	| {
			action: "skip";
			project: string;
			collectionId: string;
			reason: "tuple_invalid" | "not_due";
			detail: string;
	  };

export interface PlannerDeps {
	/** Live project roster (from loadProjects). */
	projects: ProjectEntry[];
	/** Per-project resolved config (ConfigLoader); null when the project has none. */
	loadProjectConfig: (projectName: string) => FlywheelConfig | null;
	/** Current persisted state for a collection (state helper). */
	readState: (project: string, collectionId: string) => XiaohongshuState;
	/** Injectable clock. */
	now: () => Date;
}

const DEFAULT_CADENCE = "weekly";

function resolveMaxFetch(col: XiaohongshuCollectionConfig): number {
	return col.max_fetch ?? XIAOHONGSHU_DEFAULT_MAX_FETCH;
}

/**
 * Plan this tick: enumerate every enabled collection across all projects and
 * decide spawn vs skip. Pure. Order follows projects → collections config order.
 */
export function planLearningRuns(deps: PlannerDeps): CollectionDecision[] {
	const out: CollectionDecision[] = [];
	for (const project of deps.projects) {
		const cfg = deps.loadProjectConfig(project.projectName);
		const learning = cfg?.xiaohongshu_learning;
		if (!learning?.enabled || !learning.collections?.length) continue;
		const videoOptIn = learning.video_opt_in === true;

		for (const col of learning.collections) {
			const tuple: RoutingTupleResult = validateLearningRoutingTuple(
				deps.projects,
				project.projectName,
				{ leadId: col.lead_id, departmentLabel: col.department_label },
			);
			if (!tuple.valid) {
				out.push({
					action: "skip",
					project: project.projectName,
					collectionId: col.collection_id,
					reason: "tuple_invalid",
					detail: tuple.detail,
				});
				continue;
			}

			const state = deps.readState(project.projectName, col.collection_id);
			if (!isDue(state, deps.now())) {
				out.push({
					action: "skip",
					project: project.projectName,
					collectionId: col.collection_id,
					reason: "not_due",
					detail: `next due at ${state.nextDueAt}`,
				});
				continue;
			}

			out.push({
				action: "spawn",
				plan: {
					project: project.projectName,
					collectionId: col.collection_id,
					collectionLabel: col.label,
					leadId: col.lead_id,
					departmentLabel: col.department_label,
					targetLinearProject: col.target_linear_project,
					cadence: col.cadence ?? DEFAULT_CADENCE,
					maxFetch: resolveMaxFetch(col),
					videoOptIn,
				},
			});
		}
	}
	return out;
}

// ─── Executor (side-effecting) ────────────────────────────────────────────────

/** Result of a /api/runs/start call. 409 = an active session already exists. */
export type StartRunResult =
	| { ok: true; executionId: string }
	| { ok: false; status: number; message: string };

export interface ExecutorDeps {
	/** State dir (same the skill/CLI uses). */
	stateDir: string;
	/**
	 * Create the fixed trigger Linear issue for a collection (Bridge
	 * /api/linear/create-issue: team + dept-label name→id + target project +
	 * run-param body). Called ONCE per collection (create-if-absent); returns the
	 * created issue id.
	 */
	createTriggerIssue: (plan: CollectionRunPlan) => Promise<string>;
	/** POST /api/runs/start for the trigger issue. */
	startRun: (args: {
		issueId: string;
		projectName: string;
		leadId: string;
	}) => Promise<StartRunResult>;
	log?: (msg: string) => void;
	alert?: (msg: string) => void;
}

export interface ExecuteReport {
	spawned: string[];
	skipped: { collectionId: string; reason: string }[];
	errors: { collectionId: string; detail: string }[];
}

/**
 * Whether a non-409 start error is really a duplicate-spawn the dispatcher
 * caught atomically (Codex option-A review #1) — treated as a quiet in-flight
 * skip, not an error/alert.
 */
function isDuplicateSpawn(message: string): boolean {
	return /already\s+(in\s+progress|active|has an active)/i.test(message);
}

/**
 * Execute a planned tick (option A lease model): the Runner — not the scheduler
 * — owns the run-level lease (run_key = its exec id; it acquires/renews/releases
 * it). The scheduler's safety is defense-in-depth: the shell wrapper's FLY-176
 * re-entry lockdir (no overlapping ticks) + the runs/start 409 active-session
 * guard + the Runner's own lease + Runner-set-next-due. A Runner that dies
 * before setting next-due leaves the collection due → next tick re-spawns =
 * desired fail-soft retry.
 *
 * Per collection: create-if-absent the fixed trigger issue (id persisted in
 * state under the collection mutex, reused every tick), then start a Runner on
 * it. 409 → skip quietly (already running); other error → record + alert; never
 * abort the rest.
 */
export async function executeLearningPlan(
	decisions: CollectionDecision[],
	deps: ExecutorDeps,
): Promise<ExecuteReport> {
	const report: ExecuteReport = { spawned: [], skipped: [], errors: [] };
	for (const d of decisions) {
		if (d.action === "skip") {
			report.skipped.push({ collectionId: d.collectionId, reason: d.reason });
			if (d.reason === "tuple_invalid") {
				deps.alert?.(
					`[xhs-scheduler] ${d.project}/${d.collectionId} routing invalid: ${d.detail}`,
				);
			}
			continue;
		}
		const { plan } = d;
		try {
			// Create-if-absent the fixed trigger issue, reusing the persisted id.
			// The one-time network create runs under the collection mutex — safe
			// because the FLY-176 lockdir guarantees a single scheduler tick, and
			// the Runner only takes the mutex for short state writes.
			const triggerIssueId = await withCollectionLock(
				deps.stateDir,
				plan.project,
				plan.collectionId,
				async () => {
					const s = readState(deps.stateDir, plan.project, plan.collectionId);
					if (s.triggerIssueId) return s.triggerIssueId;
					const id = await deps.createTriggerIssue(plan);
					writeState(deps.stateDir, setTriggerIssueId(s, id));
					return id;
				},
			);

			const r = await deps.startRun({
				issueId: triggerIssueId,
				projectName: plan.project,
				leadId: plan.leadId,
			});
			if (r.ok) {
				report.spawned.push(plan.collectionId);
				deps.log?.(
					`[xhs-scheduler] spawned ${plan.project}/${plan.collectionId} (${r.executionId}) on ${triggerIssueId}`,
				);
			} else if (r.status === 409 || isDuplicateSpawn(r.message)) {
				// Active session already exists — the in-flight guard. Not an error.
				// Codex option-A review (non-blocking #1): a duplicate that races past
				// the route's StateStore check is caught atomically by RunDispatcher
				// but can surface as a 500 with an "already in progress"-style message
				// rather than a clean 409. Treat that message as the same quiet skip so
				// the in-flight guard never false-alerts.
				report.skipped.push({
					collectionId: plan.collectionId,
					reason: "already_active",
				});
				deps.log?.(
					`[xhs-scheduler] ${plan.project}/${plan.collectionId} already active (${r.status}) — skip`,
				);
			} else {
				report.errors.push({
					collectionId: plan.collectionId,
					detail: `runs/start ${r.status}: ${r.message}`,
				});
				deps.alert?.(
					`[xhs-scheduler] ${plan.project}/${plan.collectionId} start failed (${r.status}): ${r.message}`,
				);
			}
		} catch (err) {
			report.errors.push({
				collectionId: plan.collectionId,
				detail: (err as Error).message,
			});
			deps.alert?.(
				`[xhs-scheduler] ${plan.project}/${plan.collectionId} errored: ${(err as Error).message}`,
			);
		}
	}
	return report;
}
