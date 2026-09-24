import {
	canonicalSubmissionDigest,
	parsePercentageModelSplit,
	parseWeightedModelSplit,
	resolvePercentageModelSplit,
	resolveWeightedModelSplit,
} from "flywheel-config";
import type { WorkflowRunEventRow } from "./StateStore.js";
import type {
	FrozenWeightedModelAssignmentReceipt,
	WorkflowModelAssignmentReceipt,
} from "./workflow-menu.js";

export interface ScorecardAssignmentReceiptV1 {
	schemaVersion: 1;
	runId: string;
	nodeId: string;
	policyVersion: string;
	arm: string;
	resolvedModel: string;
	assignedAt: string;
}

export type ScorecardAssignmentRead =
	| { state: "unassigned" }
	| { state: "unknown"; reason: string; eventUids: string[] }
	| { state: "invalid_assignment"; reason: string; eventUids: string[] }
	| {
			state: "assigned";
			receipt: ScorecardAssignmentReceiptV1;
			eventUid: string;
			digest: string;
	  };

export interface ScorecardDegradedReceiptV1 {
	schemaVersion: 1;
	runId: string;
	nodeId: string;
	activationId: string;
	assignmentEventUid: string;
	arm: string;
	degraded: true;
	assignedModel: string;
	actualModel: string;
	reason: "codex_pool_exhausted";
	degradedAt: string;
}

export type ScorecardDegradationRead =
	| { state: "not_degraded" }
	| { state: "invalid_degradation"; reason: string; eventUids: string[] }
	| {
			state: "degraded";
			receipt: ScorecardDegradedReceiptV1;
			eventUid: string;
			digest: string;
	  };

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function utcTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
		return `${value.replace(" ", "T")}.000Z`;
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
		return undefined;
	}
	return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function boundedString(value: unknown, max = 256): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function canonicalReceipt(
	event: WorkflowRunEventRow,
): ScorecardAssignmentReceiptV1 | undefined {
	const payload = record(event.payload);
	if (
		!payload ||
		!event.node_id ||
		event.event_uid !== `model_arm_assigned:${event.run_id}:${event.node_id}` ||
		payload.schemaVersion !== 1 ||
		payload.runId !== event.run_id ||
		payload.nodeId !== event.node_id ||
		!boundedString(payload.policyVersion, 128) ||
		!boundedString(payload.arm, 128) ||
		!boundedString(payload.resolvedModel)
	) {
		return undefined;
	}
	const assignedAt = utcTimestamp(payload.assignedAt);
	if (!assignedAt) return undefined;
	return {
		schemaVersion: 1,
		runId: event.run_id,
		nodeId: event.node_id,
		policyVersion: payload.policyVersion,
		arm: payload.arm,
		resolvedModel: payload.resolvedModel,
		assignedAt,
	};
}

function legacyReceipt(
	event: WorkflowRunEventRow,
): ScorecardAssignmentReceiptV1 | undefined {
	const payload = record(event.payload);
	const basis = record(payload?.basis);
	const assignedAt = utcTimestamp(event.at);
	if (
		!payload ||
		!basis ||
		!event.node_id ||
		event.event_uid !==
			`design_model_arm_assigned:${event.run_id}:${event.node_id}` ||
		!boundedString(basis.ruleVersion, 128) ||
		!boundedString(payload.arm, 128) ||
		!boundedString(payload.model) ||
		!assignedAt
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		runId: event.run_id,
		nodeId: event.node_id,
		policyVersion: basis.ruleVersion,
		arm: payload.arm,
		resolvedModel: payload.model,
		assignedAt,
	};
}

/** Read frozen assignment evidence without selecting, rewriting, or inferring an arm. */
export function readScorecardAssignment(
	events: readonly WorkflowRunEventRow[],
	identity: { runId: string; nodeId: string },
): ScorecardAssignmentRead {
	const relevant = events.filter(
		(event) =>
			event.run_id === identity.runId &&
			event.node_id === identity.nodeId &&
			(event.kind === "model_arm_assigned" ||
				event.kind === "design_model_arm_assigned"),
	);
	if (relevant.length === 0) return { state: "unassigned" };

	const normalized = relevant.map((event) => ({
		event,
		receipt:
			event.kind === "model_arm_assigned"
				? canonicalReceipt(event)
				: legacyReceipt(event),
	}));
	if (normalized.some(({ receipt }) => !receipt)) {
		return {
			state: "unknown",
			reason: "malformed_or_non_utc_assignment",
			eventUids: relevant.map((event) => event.event_uid),
		};
	}
	const digests = new Set(
		normalized.map(({ receipt }) => canonicalSubmissionDigest(receipt)),
	);
	if (digests.size !== 1) {
		return {
			state: "invalid_assignment",
			reason: "conflicting_assignment_receipts",
			eventUids: relevant.map((event) => event.event_uid),
		};
	}
	const first =
		normalized.find(({ event }) => event.kind === "model_arm_assigned") ??
		normalized[0]!;
	return {
		state: "assigned",
		receipt: first.receipt!,
		eventUid: first.event.event_uid,
		digest: digests.values().next().value!,
	};
}

/** Validate explicit degradation authority; a model mismatch alone is never degradation. */
export function readScorecardDegradation(
	events: readonly WorkflowRunEventRow[],
	identity: {
		runId: string;
		nodeId: string;
		activationId: string;
		launchModel: string;
		assignment: ScorecardAssignmentRead;
	},
): ScorecardDegradationRead {
	const expectedEventUid = `model_arm_degraded:${identity.runId}:${identity.nodeId}:${identity.activationId}`;
	const relevant = events.filter((event) => {
		const payload = record(event.payload);
		return (
			event.kind === "model_arm_degraded" &&
			event.run_id === identity.runId &&
			event.node_id === identity.nodeId &&
			(event.event_uid === expectedEventUid ||
				payload?.activationId === identity.activationId)
		);
	});
	if (relevant.length === 0) return { state: "not_degraded" };
	if (identity.assignment.state !== "assigned") {
		return {
			state: "invalid_degradation",
			reason: "degradation_without_canonical_assignment",
			eventUids: relevant.map((event) => event.event_uid),
		};
	}
	const assignment = identity.assignment;
	const expectedAssignmentUid = `model_arm_assigned:${identity.runId}:${identity.nodeId}`;
	const normalized = relevant.map((event) => {
		const payload = record(event.payload);
		const degradedAt = utcTimestamp(payload?.degradedAt);
		if (
			event.event_uid !== expectedEventUid ||
			!payload ||
			payload.schemaVersion !== 1 ||
			payload.runId !== identity.runId ||
			payload.nodeId !== identity.nodeId ||
			payload.activationId !== identity.activationId ||
			payload.assignmentEventUid !== expectedAssignmentUid ||
			assignment.eventUid !== expectedAssignmentUid ||
			payload.arm !== assignment.receipt.arm ||
			payload.degraded !== true ||
			payload.assignedModel !== assignment.receipt.resolvedModel ||
			payload.actualModel !== identity.launchModel ||
			payload.actualModel === payload.assignedModel ||
			payload.reason !== "codex_pool_exhausted" ||
			!degradedAt
		) {
			return undefined;
		}
		return {
			schemaVersion: 1 as const,
			runId: identity.runId,
			nodeId: identity.nodeId,
			activationId: identity.activationId,
			assignmentEventUid: expectedAssignmentUid,
			arm: assignment.receipt.arm,
			degraded: true as const,
			assignedModel: assignment.receipt.resolvedModel,
			actualModel: identity.launchModel,
			reason: "codex_pool_exhausted" as const,
			degradedAt,
		};
	});
	if (normalized.some((receipt) => !receipt)) {
		return {
			state: "invalid_degradation",
			reason: "degradation_authority_mismatch",
			eventUids: relevant.map((event) => event.event_uid),
		};
	}
	const digests = new Set(
		normalized.map((receipt) => canonicalSubmissionDigest(receipt)),
	);
	if (digests.size !== 1) {
		return {
			state: "invalid_degradation",
			reason: "conflicting_degradation_receipts",
			eventUids: relevant.map((event) => event.event_uid),
		};
	}
	return {
		state: "degraded",
		receipt: normalized[0]!,
		eventUid: relevant[0]!.event_uid,
		digest: digests.values().next().value!,
	};
}

/** Validate the frozen percentage basis at both materialization and dispatch replay. */
export function assertPercentageModelAssignment(
	assignment: WorkflowModelAssignmentReceipt,
): void {
	if (assignment.basis.rule !== "issue_number_percentage")
		throw new Error("percentage assignment required");
	const basis = assignment.basis;
	const policy = parsePercentageModelSplit({
		enabled: true,
		rule: basis.rule,
		codexPercent: basis.codexPercent,
		codex: basis.codex,
		fable: basis.fable,
	});
	const choice = resolvePercentageModelSplit(policy, basis.issueNumber);
	const suffix = /-(\d+)$/.exec(basis.issueIdentifier);
	if (
		!suffix ||
		Number(suffix[1]) !== basis.issueNumber ||
		policy.version !== basis.ruleVersion ||
		choice.bucket !== basis.bucket ||
		choice.arm.arm !== assignment.arm ||
		choice.arm.model !== assignment.modelAlias
	)
		throw new Error("invalid basis");
}

export function assertWeightedModelAssignment(
	assignment: WorkflowModelAssignmentReceipt,
): void {
	if (assignment.basis.rule !== "issue_node_weighted")
		throw new Error("weighted assignment required");
	const basis = assignment.basis;
	const policy = parseWeightedModelSplit({
		enabled: true,
		rule: basis.rule,
		balance: { enabled: basis.weightAudit.enabled },
		nodes: basis.nodes,
	});
	const choice = resolveWeightedModelSplit(
		policy,
		basis.issueKey,
		basis.nodeId,
	);
	if (
		policy.version !== basis.ruleVersion ||
		choice.bucket !== basis.bucket ||
		choice.arm.arm !== assignment.arm ||
		choice.arm.model !== assignment.modelAlias ||
		JSON.stringify(choice.weightAudit) !== JSON.stringify(basis.weightAudit)
	)
		throw new Error("invalid basis");
}

export function finalizeWeightedModelAssignment(
	assignment: WorkflowModelAssignmentReceipt,
	input: { runId: string; nodeId: string; assignedAt: string },
): FrozenWeightedModelAssignmentReceipt {
	assertWeightedModelAssignment(assignment);
	if (
		assignment.basis.rule !== "issue_node_weighted" ||
		assignment.basis.nodeId !== input.nodeId ||
		!input.runId ||
		!Number.isFinite(Date.parse(input.assignedAt))
	)
		throw new Error("invalid frozen basis");
	return {
		...assignment,
		schemaVersion: 1,
		runId: input.runId,
		nodeId: assignment.basis.nodeId,
		policyVersion: assignment.basis.ruleVersion,
		resolvedModel: assignment.model,
		assignedAt: input.assignedAt,
	};
}

export function assertFrozenWeightedModelAssignment(
	assignment: WorkflowModelAssignmentReceipt,
	input: { runId: string; nodeId: string },
): asserts assignment is FrozenWeightedModelAssignmentReceipt {
	assertWeightedModelAssignment(assignment);
	const frozen = assignment as Partial<FrozenWeightedModelAssignmentReceipt>;
	if (
		assignment.basis.rule !== "issue_node_weighted" ||
		frozen.schemaVersion !== 1 ||
		frozen.runId !== input.runId ||
		frozen.nodeId !== input.nodeId ||
		frozen.nodeId !== assignment.basis.nodeId ||
		frozen.policyVersion !== assignment.basis.ruleVersion ||
		frozen.resolvedModel !== assignment.model ||
		typeof frozen.assignedAt !== "string" ||
		!Number.isFinite(Date.parse(frozen.assignedAt))
	)
		throw new Error("invalid frozen basis");
}
