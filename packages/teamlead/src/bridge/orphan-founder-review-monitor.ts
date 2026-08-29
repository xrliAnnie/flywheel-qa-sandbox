import type { CommDB } from "flywheel-comm/db";
import { parseFounderReviewQuestionContent } from "flywheel-comm/founder-review";
import type {
	WorkflowEngineAlertIdentity,
	WorkflowEngineAlertPayload,
} from "../StateStore.js";
import { parseSqliteUtcMs } from "./founder-notify-utils.js";

const DEFAULT_STALE_HOURS = 24;
const MIN_DELIVERY_GRACE_MINUTES = 10;
const LIVE_RUN_STATUSES = new Set(["active", "held"]);

interface FounderReviewMonitorStore {
	getWorkflowRun(runId: string):
		| {
				run_id: string;
				issue_id: string;
				project_name: string;
				status: string;
		  }
		| undefined;
	getFounderReviewCardBindingByQuestion(questionId: string): unknown;
	enqueueWorkflowEngineAlert(input: {
		escalationUid: string;
		runId: string;
		payload: WorkflowEngineAlertPayload;
	}): void;
}

export interface OrphanFounderReviewMonitorStats {
	scanned: number;
	live: number;
	deliveryMissing: number;
	aged: number;
	alerted: number;
	invalid: number;
}

function staleHours(env: Record<string, string | undefined>): number {
	const parsed = Number.parseInt(
		env.FLYWHEEL_FOUNDER_REVIEW_ORPHAN_STALE_HOURS ?? "",
		10,
	);
	return Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_STALE_HOURS;
}

function deliveryGraceMinutes(env: Record<string, string | undefined>): number {
	const parsed = Number.parseInt(
		env.FLYWHEEL_FOUNDER_REVIEW_ORPHAN_DELIVERY_GRACE_MINUTES ?? "",
		10,
	);
	return Number.isSafeInteger(parsed) && parsed >= MIN_DELIVERY_GRACE_MINUTES
		? parsed
		: MIN_DELIVERY_GRACE_MINUTES;
}

function ageBucketHours(ageMs: number, floorHours: number): number {
	const elapsedHours = ageMs / 3_600_000;
	if (elapsedHours >= floorHours * 4) return floorHours * 4;
	if (elapsedHours >= floorHours * 2) return floorHours * 2;
	return floorHours;
}

export function sweepOrphanFounderReviewGates(input: {
	projectName: string;
	db: CommDB;
	store: FounderReviewMonitorStore;
	resolveAlertIdentity(run: {
		run_id: string;
		issue_id: string;
		project_name: string;
		status: string;
	}): WorkflowEngineAlertIdentity;
	env: Record<string, string | undefined>;
	now?: () => number;
	log?: (message: string) => void;
}): OrphanFounderReviewMonitorStats {
	const stats: OrphanFounderReviewMonitorStats = {
		scanned: 0,
		live: 0,
		deliveryMissing: 0,
		aged: 0,
		alerted: 0,
		invalid: 0,
	};
	const nowMs = (input.now ?? Date.now)();
	const thresholdHours = staleHours(input.env);
	const thresholdMs = thresholdHours * 3_600_000;
	const deliveryGraceMs = deliveryGraceMinutes(input.env) * 60_000;
	const questions = input.db.getOpenGatesByCheckpoint("founder_review");
	stats.scanned = questions.length;

	for (const question of questions) {
		const family = input.db.getFounderReviewFamily(question.id);
		const parsed = family
			? parseFounderReviewQuestionContent(family.question.content)
			: undefined;
		if (!parsed) {
			stats.invalid += 1;
			input.log?.(
				`[founder-review-orphan] invalid immutable gate identity: ${question.id}`,
			);
			continue;
		}
		const run = input.store.getWorkflowRun(parsed.runId);
		if (
			!run ||
			run.project_name !== input.projectName ||
			!LIVE_RUN_STATUSES.has(run.status)
		) {
			continue;
		}
		stats.live += 1;
		const createdAtMs = parseSqliteUtcMs(question.created_at);
		if (createdAtMs === null) {
			stats.invalid += 1;
			continue;
		}
		const ageMs = nowMs - createdAtMs;
		const identity = input.resolveAlertIdentity(run);
		const workflowMetadata = {
			runId: run.run_id,
			issueId: run.issue_id,
			nodeId: "founder_review",
			executionId: question.from_agent,
			questionId: question.id,
			leadResolution: identity.leadResolution,
		};
		if (!input.store.getFounderReviewCardBindingByQuestion(question.id)) {
			if (ageMs < deliveryGraceMs) continue;
			stats.deliveryMissing += 1;
			const escalationUid = `founder-review-delivery-missing:${question.id}`;
			input.store.enqueueWorkflowEngineAlert({
				escalationUid,
				runId: run.run_id,
				payload: {
					leadId: identity.leadId,
					projectName: identity.projectName,
					eventId: escalationUid,
					eventType: "workflow_engine_issue_alert",
					severity: "warning",
					sessionKey: `wf:${run.run_id}`,
					title: `Founder review never reached founder — ${run.issue_id}`,
					body: `founder_review gate ${question.id} is open for live run ${run.run_id}, but no founder_review_card_binding exists. The gate was opened but was never rendered into an answerable founder card.`,
					metadata: {
						workflowEngine: {
							...workflowMetadata,
							disposition: "founder_review_delivery_missing",
						},
					},
				},
			});
			stats.alerted += 1;
			continue;
		}

		if (ageMs < thresholdMs) continue;
		stats.aged += 1;
		const bucket = ageBucketHours(ageMs, thresholdHours);
		const escalationUid = `founder-review-unanswered:${question.id}:${bucket}h`;
		input.store.enqueueWorkflowEngineAlert({
			escalationUid,
			runId: run.run_id,
			payload: {
				leadId: identity.leadId,
				projectName: identity.projectName,
				eventId: escalationUid,
				eventType: "workflow_engine_issue_alert",
				severity: "warning",
				sessionKey: `wf:${run.run_id}`,
				title: `Founder review unanswered for ${bucket}h — ${run.issue_id}`,
				body: `founder_review gate ${question.id} remains open and unanswered on live run ${run.run_id}. It is not superseded and has a durable founder card binding.`,
				metadata: {
					workflowEngine: {
						...workflowMetadata,
						disposition: "founder_review_unanswered",
					},
				},
			},
		});
		stats.alerted += 1;
	}
	return stats;
}
