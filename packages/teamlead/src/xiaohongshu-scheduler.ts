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
