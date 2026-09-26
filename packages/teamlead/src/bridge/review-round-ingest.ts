import { getModelConfigSnapshot } from "flywheel-config";
import type { StateStore } from "../StateStore.js";
import { resolveRequiredReviewModel } from "../workflow-review-routing.js";
import type {
	ReviewRecordOutcome,
	ReviewRoundFindings,
	ReviewRoundType,
} from "./review-round-store.js";

/**
 * FLY-2891: validate + persist one local Codex review round (or the review
 * gate's acceptance of the final APPROVED round). Shared by the HTTP route and
 * the spool reconciler so both paths apply identical validation and the same
 * idempotency rules. Every identity/authority field is derived server-side;
 * client-supplied issue/run/node/required-model values are ignored.
 */

const CODEX_ID_RE = /^[0-9A-Za-z-]{8,128}$/;
const EXEC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const FUTURE_SKEW_MS = 60_000;

export type ReviewRoundErrorType =
	| "invalid_payload"
	| "unknown_execution"
	| "project_mismatch"
	| "conflict";

export type ReviewRoundIngestResult =
	| {
			httpStatus: 200;
			body: {
				recorded: true;
				kind: "round" | "gate_acceptance";
				duplicate?: true;
				backfilled?: true;
				requiredModel?: string;
				requiredEffort?: string;
				modelMatch: boolean | null;
			};
	  }
	| {
			httpStatus: 400 | 404 | 409 | 500;
			body: {
				recorded: false;
				errorType?: ReviewRoundErrorType;
				reason: string;
			};
	  };

export type ReviewRoundIngestStore = Pick<
	StateStore,
	| "getSession"
	| "reviewRounds"
	| "getWorkflowRunNodeForExecution"
	| "getWorkflowExecutionRuntime"
	| "getWorkflowRun"
	| "listWorkflowRunEvents"
>;

class InvalidPayload extends Error {}

function invalid(reason: string): never {
	throw new InvalidPayload(reason);
}

function optionalString(
	body: Record<string, unknown>,
	key: string,
	max: number,
): string | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > max)
		invalid(`${key} must be a non-empty string of at most ${max} characters`);
	return value.trim();
}

function requiredString(
	body: Record<string, unknown>,
	key: string,
	max: number,
): string {
	return optionalString(body, key, max) ?? invalid(`${key} is required`);
}

function boundedInt(
	body: Record<string, unknown>,
	key: string,
	min: number,
	max: number,
): number {
	const value = body[key];
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < min ||
		(value as number) > max
	)
		invalid(`${key} must be an integer from ${min} to ${max}`);
	return value as number;
}

function codexId(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || !CODEX_ID_RE.test(value))
		invalid(`${key} must match ${CODEX_ID_RE.source}`);
	return value;
}

function optionalSha(
	body: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !FULL_SHA_RE.test(value.toLowerCase()))
		invalid(`${key} must be a 40-hex sha`);
	return value.toLowerCase();
}

function timestamp(
	body: Record<string, unknown>,
	key: string,
	now: Date,
): string {
	const value = requiredString(body, key, 64);
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) invalid(`${key} is not a timestamp`);
	if (parsed - now.getTime() > FUTURE_SKEW_MS)
		invalid(`${key} is in the future`);
	return new Date(parsed).toISOString();
}

function findings(body: Record<string, unknown>): ReviewRoundFindings {
	const raw = body.findings;
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw))
		invalid("findings must be an object");
	const record = raw as Record<string, unknown>;
	const out: ReviewRoundFindings = {};
	for (const key of ["critical", "high", "medium", "low"] as const) {
		if (record[key] === undefined) continue;
		out[key] = boundedInt(record, key, 0, 10_000);
	}
	return out;
}

function canonicalModel(model: string): string {
	try {
		return getModelConfigSnapshot().getDispatchCanonical(model) ?? model;
	} catch {
		return model;
	}
}

export function reviewModelMatches(
	observed: { model?: string; effort?: string },
	required: { reviewerModel: string; reviewerEffort: string } | undefined,
): boolean | null {
	if (!required || !observed.model || !observed.effort) return null;
	return (
		canonicalModel(observed.model) === canonicalModel(required.reviewerModel) &&
		observed.effort === required.reviewerEffort
	);
}

function outcomeResult(
	kind: "round" | "gate_acceptance",
	outcome: ReviewRecordOutcome,
	required: { reviewerModel: string; reviewerEffort: string } | undefined,
	modelMatch: boolean | null,
): ReviewRoundIngestResult {
	if (outcome.outcome === "conflict")
		return {
			httpStatus: 409,
			body: { recorded: false, errorType: "conflict", reason: outcome.reason },
		};
	return {
		httpStatus: 200,
		body: {
			recorded: true,
			kind,
			...(outcome.outcome === "duplicate" ? { duplicate: true as const } : {}),
			...(outcome.outcome === "backfilled"
				? { backfilled: true as const }
				: {}),
			...(required
				? {
						requiredModel: required.reviewerModel,
						requiredEffort: required.reviewerEffort,
					}
				: {}),
			modelMatch,
		},
	};
}

export function ingestReviewRound(
	store: ReviewRoundIngestStore,
	rawBody: unknown,
	opts: {
		delivery: "http" | "spool";
		now?: () => Date;
		logger?: Pick<Console, "warn">;
	},
): ReviewRoundIngestResult {
	const now = opts.now?.() ?? new Date();
	try {
		if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody))
			invalid("body must be an object");
		const body = rawBody as Record<string, unknown>;
		const kind = body.kind ?? "round";
		if (kind !== "round" && kind !== "gate_acceptance")
			invalid("kind must be round or gate_acceptance");
		const executionId = requiredString(body, "executionId", 128);
		if (!EXEC_ID_RE.test(executionId)) invalid("executionId is malformed");
		const reviewType = body.reviewType;
		if (reviewType !== "design" && reviewType !== "code")
			invalid("reviewType must be design or code");
		const codexThreadId = codexId(body, "codexThreadId");
		const codexTurnId = codexId(body, "codexTurnId");
		const requestId = optionalString(body, "requestId", 256);
		const reviewedTarget = optionalString(body, "reviewedTarget", 512);
		const reviewedPlanBlobSha = optionalSha(body, "reviewedPlanBlobSha");
		const reviewedHeadSha = optionalSha(body, "reviewedHeadSha");
		const bodyProject = optionalString(body, "projectName", 256);

		// Validate the whole payload before touching session state.
		let round:
			| {
					round: number;
					verdict: "APPROVED" | "CHANGES_REQUESTED";
					findings: ReviewRoundFindings;
					modelEvidence: "rollout_turn" | "unavailable";
					observedModel?: string;
					observedEffort?: string;
					reviewedAt: string;
			  }
			| undefined;
		let gate:
			| {
					finalRound: number;
					roundsTotal: number;
					observedModel: string;
					observedEffort: string;
					reviewedTarget: string;
					acceptedAt: string;
			  }
			| undefined;
		if (kind === "round") {
			const verdict = body.verdict;
			if (verdict !== "APPROVED" && verdict !== "CHANGES_REQUESTED")
				invalid("verdict must be APPROVED or CHANGES_REQUESTED");
			const modelEvidence = body.modelEvidence;
			if (modelEvidence !== "rollout_turn" && modelEvidence !== "unavailable")
				invalid("modelEvidence must be rollout_turn or unavailable");
			const observedModel = optionalString(body, "observedModel", 128);
			const observedEffort = optionalString(body, "observedEffort", 128);
			if (
				modelEvidence === "rollout_turn" &&
				(!observedModel || !observedEffort)
			)
				invalid(
					"rollout_turn evidence requires observedModel and observedEffort",
				);
			if (modelEvidence === "unavailable" && (observedModel || observedEffort))
				invalid("unavailable evidence must not carry an observed model");
			round = {
				round: boundedInt(body, "round", 1, 200),
				verdict,
				findings: findings(body),
				modelEvidence,
				observedModel,
				observedEffort,
				reviewedAt: timestamp(body, "reviewedAt", now),
			};
		} else {
			const finalRound = boundedInt(body, "finalRound", 1, 200);
			const roundsTotal = boundedInt(body, "roundsTotal", 1, 200);
			if (finalRound > roundsTotal)
				invalid("finalRound must not exceed roundsTotal");
			gate = {
				finalRound,
				roundsTotal,
				observedModel: requiredString(body, "observedModel", 128),
				observedEffort: requiredString(body, "observedEffort", 128),
				reviewedTarget: reviewedTarget ?? invalid("reviewedTarget is required"),
				acceptedAt: timestamp(body, "acceptedAt", now),
			};
			if (reviewType === "design" && (!requestId || !reviewedPlanBlobSha))
				invalid(
					"design gate acceptance requires requestId and reviewedPlanBlobSha",
				);
			if (reviewType === "code" && !reviewedHeadSha)
				invalid("code gate acceptance requires reviewedHeadSha");
		}

		const session = store.getSession(executionId);
		if (!session)
			return {
				httpStatus: 404,
				body: {
					recorded: false,
					errorType: "unknown_execution",
					reason: `no session for execution ${executionId}`,
				},
			};
		if (bodyProject && bodyProject !== session.project_name)
			return {
				httpStatus: 409,
				body: {
					recorded: false,
					errorType: "project_mismatch",
					reason: "projectName does not match the execution's session",
				},
			};

		let required: { reviewerModel: string; reviewerEffort: string } | undefined;
		try {
			required = resolveRequiredReviewModel(
				store,
				executionId,
				reviewType as ReviewRoundType,
				requestId,
			);
		} catch (error) {
			opts.logger?.warn(
				`[review-round] required reviewer model unresolved for ${executionId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const binding = store.getWorkflowRunNodeForExecution(executionId);
		const runtime = store.getWorkflowExecutionRuntime(executionId);
		const receivedAt = now.toISOString();

		if (round) {
			const modelMatch = reviewModelMatches(
				{ model: round.observedModel, effort: round.observedEffort },
				required,
			);
			const outcome = store.reviewRounds.recordRound({
				executionId,
				reviewType: reviewType as ReviewRoundType,
				codexThreadId,
				codexTurnId,
				round: round.round,
				projectName: session.project_name,
				issueId: session.issue_id,
				runId: binding?.run_id,
				nodeId: binding?.node_id,
				authorVendor: runtime?.vendor,
				authorModel: runtime?.model,
				verdict: round.verdict,
				findings: round.findings,
				observedModel: round.observedModel,
				observedEffort: round.observedEffort,
				modelEvidence: round.modelEvidence,
				requiredModel: required?.reviewerModel,
				requiredEffort: required?.reviewerEffort,
				modelMatch: modelMatch === null ? null : modelMatch ? 1 : 0,
				requestId,
				reviewedTarget,
				reviewedPlanBlobSha,
				reviewedHeadSha,
				delivery: opts.delivery,
				reviewedAt: round.reviewedAt,
				receivedAt,
			});
			return outcomeResult("round", outcome, required, modelMatch);
		}
		const acceptance = gate!;
		const modelMatch = reviewModelMatches(
			{ model: acceptance.observedModel, effort: acceptance.observedEffort },
			required,
		);
		const outcome = store.reviewRounds.recordGateAcceptance({
			executionId,
			reviewType: reviewType as ReviewRoundType,
			codexThreadId,
			codexTurnId,
			finalRound: acceptance.finalRound,
			roundsTotal: acceptance.roundsTotal,
			observedModel: acceptance.observedModel,
			observedEffort: acceptance.observedEffort,
			requiredModel: required?.reviewerModel,
			requiredEffort: required?.reviewerEffort,
			requestId,
			reviewedTarget: acceptance.reviewedTarget,
			reviewedPlanBlobSha,
			reviewedHeadSha,
			projectName: session.project_name,
			runId: binding?.run_id,
			nodeId: binding?.node_id,
			acceptedAt: acceptance.acceptedAt,
			receivedAt,
		});
		return outcomeResult("gate_acceptance", outcome, required, modelMatch);
	} catch (error) {
		if (error instanceof InvalidPayload)
			return {
				httpStatus: 400,
				body: {
					recorded: false,
					errorType: "invalid_payload",
					reason: error.message,
				},
			};
		opts.logger?.warn(
			`[review-round] write failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {
			httpStatus: 500,
			body: { recorded: false, reason: "review round write failed" },
		};
	}
}
