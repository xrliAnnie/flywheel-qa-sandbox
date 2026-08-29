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

import {
	isDue,
	readState,
	setTriggerIssueId,
	withCollectionLock,
	writeState,
	type XiaohongshuState,
} from "flywheel-comm/xiaohongshu-state";
import type {
	FlywheelConfig,
	XiaohongshuCollectionConfig,
	XiaohongshuReviewChannel,
} from "flywheel-config";
import {
	XIAOHONGSHU_DEFAULT_FIRST_RUN_CAP,
	XIAOHONGSHU_DEFAULT_MAX_FETCH,
	XIAOHONGSHU_DEFAULT_REVIEW_CHANNEL,
	XIAOHONGSHU_MAX_FETCH_CEILING,
} from "flywheel-config";
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
	// FLY-286 post-hoc params the skill reads (review surface + bounded auto-create).
	reviewChannel: XiaohongshuReviewChannel;
	firstRunCap: number;
	firstRunAnalyzeLimit: number;
	autoCreate: boolean;
	/**
	 * FLY-709: per-collection runner model (config `collections[].model`,
	 * FLY-728-whitelist-validated at load). Forwarded as the /api/runs/start
	 * `model` dispatch param. Absent = today's behavior.
	 */
	model?: string;
}

export type CollectionDecision =
	| { action: "spawn"; plan: CollectionRunPlan }
	| {
			action: "skip";
			project: string;
			collectionId: string;
			reason: "tuple_invalid" | "not_due" | "state_error" | "flag_error";
			detail: string;
	  };

export interface PlannerDeps {
	/** Live project roster (from loadProjects). */
	projects: ProjectEntry[];
	/** Per-project resolved config (ConfigLoader); null when the project has none. */
	loadProjectConfig: (projectName: string) => FlywheelConfig | null;
	/** Call-time project-store gate. */
	learningEnabled: (projectName: string) => boolean;
	/** Current persisted state for a collection (state helper). */
	readState: (project: string, collectionId: string) => XiaohongshuState;
	/** Injectable clock. */
	now: () => Date;
	warn?: (message: string) => void;
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
		let enabled = false;
		try {
			enabled = deps.learningEnabled(project.projectName);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			deps.warn?.(
				`xiaohongshu_learning flag read failed for ${project.projectName}: ${detail} — skipping project`,
			);
			for (const col of learning?.collections ?? []) {
				out.push({
					action: "skip",
					project: project.projectName,
					collectionId: col.collection_id,
					reason: "flag_error",
					detail,
				});
			}
			continue;
		}
		if (!enabled) continue;
		if (!learning?.collections?.length) {
			deps.warn?.(
				`xiaohongshu_learning is enabled for ${project.projectName} but no collections are configured — skipping project`,
			);
			continue;
		}
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

			let state: XiaohongshuState;
			try {
				state = deps.readState(project.projectName, col.collection_id);
			} catch (err) {
				// A corrupt/unsafe state read for ONE collection must not abort the
				// whole tick (per-collection failure isolation).
				out.push({
					action: "skip",
					project: project.projectName,
					collectionId: col.collection_id,
					reason: "state_error",
					detail: (err as Error).message,
				});
				continue;
			}
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
					// FLY-286/2103 post-hoc params. Auto-create is now a fixed contract.
					reviewChannel:
						col.review_channel ?? XIAOHONGSHU_DEFAULT_REVIEW_CHANNEL,
					firstRunCap: col.first_run_cap ?? XIAOHONGSHU_DEFAULT_FIRST_RUN_CAP,
					firstRunAnalyzeLimit:
						col.first_run_analyze_limit ?? XIAOHONGSHU_MAX_FETCH_CEILING,
					autoCreate: true,
					// FLY-709: spread-only so an unconfigured collection keeps today's
					// plan shape (no `model` key at all).
					...(col.model !== undefined ? { model: col.model } : {}),
				},
			});
		}
	}
	return out;
}

/**
 * Build the trigger-issue body (the YAML the skill reads for run params).
 * Exported + pure so a typo in a param NAME — the highest-risk cross-artifact
 * surface — is caught by a unit test (codex PR-5 R1#3). Rebuilt fresh each tick
 * so a config change propagates. `base_url` is deliberately ABSENT: the skill
 * reads `$FLYWHEEL_BRIDGE_URL` from its injected Runner env (single source of
 * truth = the Runner's actual Bridge, never a possibly-stale URL in an issue).
 */
export function buildTriggerBody(
	plan: CollectionRunPlan,
	teamKey: string,
): string {
	return [
		"FLY-222 scheduled-learning trigger issue (auto-created; resynced every tick).",
		"",
		"```yaml",
		`xiaohongshu_learning_run:`,
		`  project: ${plan.project}`,
		`  collection_id: ${plan.collectionId}`,
		`  collection_label: ${plan.collectionLabel}`,
		`  lead_id: ${plan.leadId}`,
		`  linear_team: ${teamKey}`,
		`  target_linear_project: ${plan.targetLinearProject}`,
		`  cadence: ${plan.cadence}`,
		`  max_fetch: ${plan.maxFetch}`,
		`  video_opt_in: ${plan.videoOptIn}`,
		// FLY-286 post-hoc params the skill reads (review surface + bounded
		// auto-create + first-run analyze window).
		`  review_channel: ${plan.reviewChannel}`,
		`  first_run_cap: ${plan.firstRunCap}`,
		`  first_run_analyze_limit: ${plan.firstRunAnalyzeLimit}`,
		`  auto_create: ${plan.autoCreate}`,
		"```",
	].join("\n");
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
		/** FLY-709: dispatch model (FLY-728 Part C param). Key absent when unconfigured. */
		model?: string;
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
			} else if (d.reason === "state_error") {
				deps.alert?.(
					`[xhs-scheduler] ${d.project}/${d.collectionId} state read failed: ${d.detail}`,
				);
			}
			continue;
		}
		const { plan } = d;
		try {
			// createTriggerIssue is the NETWORK step (find-or-create the fixed trigger
			// issue by a stable title + sync its body to the CURRENT params). It runs
			// OUTSIDE the collection mutex — the mutex must NEVER wrap a network call,
			// so its critical sections stay bounded sub-second and a stale-reap can
			// never fire mid-section (codex r3 HIGH-2). Safe to run lock-free here:
			// it is idempotent (the stable-title query dedups) and FLY-176 guarantees
			// a single scheduler tick, so there is no concurrent create.
			const triggerIssueId = await deps.createTriggerIssue(plan);
			// Persist the id with a fast, network-free critical section.
			await withCollectionLock(
				deps.stateDir,
				plan.project,
				plan.collectionId,
				() => {
					const s = readState(deps.stateDir, plan.project, plan.collectionId);
					if (s.triggerIssueId !== triggerIssueId) {
						writeState(deps.stateDir, setTriggerIssueId(s, triggerIssueId));
					}
				},
			);

			const r = await deps.startRun({
				issueId: triggerIssueId,
				projectName: plan.project,
				leadId: plan.leadId,
				...(plan.model !== undefined ? { model: plan.model } : {}),
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
