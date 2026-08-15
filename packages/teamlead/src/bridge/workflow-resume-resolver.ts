import { createHash } from "node:crypto";
import { canonicalSubmissionDigest } from "flywheel-config";
import { isOperationalTerminalStatus } from "../operational-terminal-status.js";
import type {
	Session,
	WorkflowDeadExecutionWatchRow,
	WorkflowExecutionRuntimeRow,
	WorkflowGateHolderRow,
	WorkflowLaunchCancellationRow,
	WorkflowResumeAdmissionRow,
	WorkflowResumeAttachmentRow,
	WorkflowResumeAttachmentStateRow,
	WorkflowResumeFailureReason,
	WorkflowRunEventRow,
	WorkflowRunNodeRow,
	WorkflowRunRow,
} from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";

export type WorkflowResumeEnvelopeObservation =
	| { source: string; digest: string }
	| { source: string; unavailable: true };

export interface WorkflowResumeResolverStore {
	getWorkflowRun(runId: string): WorkflowRunRow | undefined;
	listWorkflowRunNodes(runId: string, nodeId: string): WorkflowRunNodeRow[];
	listWorkflowResumeAttachments(input: {
		runId: string;
		nodeId?: string;
		attempt?: number;
	}): WorkflowResumeAttachmentRow[];
	getWorkflowResumeAttachmentState(
		attachmentId: string,
	): WorkflowResumeAttachmentStateRow | undefined;
	listWorkflowRunEvents(runId: string): WorkflowRunEventRow[];
	getWorkflowExecutionRuntime(
		executionId: string,
	): WorkflowExecutionRuntimeRow | undefined;
	getSession(executionId: string): Session | undefined;
	getWorkflowLaunchCancellation(
		executionId: string,
	): WorkflowLaunchCancellationRow | undefined;
	getWorkflowDeadExecutionWatch(
		executionId: string,
	): WorkflowDeadExecutionWatchRow | undefined;
	isUnlaunchedWorkflowResumeReplacement(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		sourceExecutionId: string;
		newExecutionId: string;
		launchOrdinal: number;
	}): boolean;
	getCurrentWorkflowGateHolder(
		runId: string,
		gateNodeId: string,
	): WorkflowGateHolderRow | undefined;
	getWorkflowResumeAdmission?(
		admissionKey: string,
	): WorkflowResumeAdmissionRow | undefined;
	getWorkflowReworkRequest?(
		requestId: string,
	): { authority_context_digest: string } | undefined;
}

export interface WorkflowResumeAnchorVerification {
	attachment: WorkflowResumeAttachmentRow;
	effectiveAnchor: string;
}

export type WorkflowResumeResolution =
	| {
			ok: true;
			runId: string;
			targetNodeId: string;
			targetAttempt: number;
			attachmentId: string;
			actionKind: "redispatch_execution" | "reconcile_state_only";
			effectiveAnchor?: string;
			runtimeSemanticsDigest: string;
	  }
	| {
			ok: false;
			reason: WorkflowResumeFailureReason;
			detail: Record<string, unknown>;
	  };

export interface ResolveWorkflowResumeTargetInput {
	runId: string;
	requestedEntry?: string;
	envelopeObservation: WorkflowResumeEnvelopeObservation;
	env: Record<string, string | undefined>;
	verifyAnchor: (input: WorkflowResumeAnchorVerification) => boolean;
}

const receiptEventKinds: Record<
	WorkflowResumeAttachmentRow["receipt_kind"],
	string
> = {
	start_reservation: "start_reservation",
	edge_traversed: "edge_traversed",
	writer_replacement: "writer_replacement",
	rework_replacement: "rework_replacement",
	operator_rework: "operator_rework_requested",
	route_revision: "route_revision",
	admission_frontier: "admission_frontier",
	resume_replacement: "resume_replacement",
};

function refused(
	reason: WorkflowResumeFailureReason,
	detail: Record<string, unknown> = {},
): WorkflowResumeResolution {
	return { ok: false, reason, detail };
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function parseObject(
	value: string | null,
): Record<string, unknown> | undefined {
	if (value === null) return undefined;
	try {
		return object(JSON.parse(value));
	} catch {
		return undefined;
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function validateBaseline(
	events: WorkflowRunEventRow[],
	attachment: WorkflowResumeAttachmentRow,
	state: WorkflowResumeAttachmentStateRow,
):
	| { ok: true; uid: string; digest: string }
	| { ok: false; resolution: WorkflowResumeResolution } {
	const envelope = parseObject(attachment.envelope_json);
	const baselineUid = envelope?.issueBaselineUid;
	if (typeof baselineUid !== "string") {
		return {
			ok: false,
			resolution: refused("receipt_digest_mismatch", {
				cause: "baseline_link_malformed",
			}),
		};
	}
	const baseline = events.find((event) => event.event_uid === baselineUid);
	if (!baseline) {
		return {
			ok: false,
			resolution: refused("receipt_missing", { receipt: baselineUid }),
		};
	}
	const payload = object(baseline.payload);
	if (
		baseline.kind !== "issue_input_baseline" ||
		payload?.outcome !== "authoritative" ||
		typeof payload.bodyDigest !== "string" ||
		!/^[0-9a-f]{64}$/i.test(payload.bodyDigest)
	) {
		return {
			ok: false,
			resolution: refused(
				payload?.outcome === "unavailable"
					? "input_fallback"
					: "receipt_digest_mismatch",
				{ cause: "baseline_not_authoritative" },
			),
		};
	}
	const stamp = parseObject(state.envelope_stamped_json);
	const stampedBaseline = object(stamp?.issueBaseline);
	if (
		stamp?.schemaVersion !== 1 ||
		stampedBaseline?.uid !== baselineUid ||
		stampedBaseline.bodyDigest !== payload.bodyDigest
	) {
		return {
			ok: false,
			resolution: refused("receipt_digest_mismatch", {
				cause: "baseline_stamp_mismatch",
			}),
		};
	}
	return { ok: true, uid: baselineUid, digest: payload.bodyDigest };
}

type DeliveryValidation =
	| { ok: true; runtimeExecutionId: string; migrated: boolean }
	| { ok: false; resolution: WorkflowResumeResolution };

function validateDelivery(input: {
	store: WorkflowResumeResolverStore;
	events: WorkflowRunEventRow[];
	attachments: WorkflowResumeAttachmentRow[];
	runId: string;
	node: WorkflowRunNodeRow;
	baselineDigest: string;
}): DeliveryValidation {
	const executionId = input.node.execution_id;
	if (!executionId) {
		return {
			ok: false,
			resolution: refused("receipt_missing", {
				cause: "writer_execution_missing",
			}),
		};
	}
	const delivery = input.events
		.filter(
			(event) =>
				event.kind === "issue_delivery" &&
				event.node_id === input.node.node_id &&
				event.execution_id === executionId,
		)
		.at(-1);
	if (!delivery) {
		return {
			ok: false,
			resolution: refused("receipt_missing", { receipt: "issue_delivery" }),
		};
	}
	const validate = (
		candidate: WorkflowRunEventRow,
		candidateExecutionId: string,
		visited: Set<string>,
	): DeliveryValidation => {
		if (visited.has(candidate.event_uid)) {
			return {
				ok: false,
				resolution: refused("receipt_digest_mismatch", {
					cause: "writer_migration_cycle",
				}),
			};
		}
		visited.add(candidate.event_uid);
		const payload = object(candidate.payload);
		if (
			candidate.kind !== "issue_delivery" ||
			candidate.execution_id !== candidateExecutionId ||
			!payload ||
			typeof payload.body !== "string" ||
			typeof payload.bodyDigest !== "string" ||
			sha256(payload.body) !== payload.bodyDigest
		) {
			return {
				ok: false,
				resolution: refused("receipt_digest_mismatch", {
					cause: "issue_delivery_malformed",
				}),
			};
		}
		if (payload.bodyDigest !== input.baselineDigest) {
			return {
				ok: false,
				resolution: refused("envelope_changed:issue_body", {
					baselineDigest: input.baselineDigest,
					deliveryDigest: payload.bodyDigest,
				}),
			};
		}
		if (payload.sourceKind === "fallback") {
			return {
				ok: false,
				resolution: refused("input_fallback", {
					source: "issue_delivery",
				}),
			};
		}
		if (payload.sourceKind === "writer_migration") {
			const binding =
				typeof payload.migrationBindingUid === "string"
					? input.events.find(
							(event) => event.event_uid === payload.migrationBindingUid,
						)
					: undefined;
			const bindingPayload = object(binding?.payload);
			const sourceDelivery =
				typeof bindingPayload?.sourceIssueDeliveryUid === "string"
					? input.events.find(
							(event) =>
								event.event_uid === bindingPayload.sourceIssueDeliveryUid,
						)
					: undefined;
			const sourceAttachment = input.attachments.find(
				(attachment) =>
					attachment.attachment_id === bindingPayload?.sourceAttachmentId,
			);
			const writerReceipt =
				typeof bindingPayload?.writerTransitionUid === "string"
					? input.events.find(
							(event) => event.event_uid === bindingPayload.writerTransitionUid,
						)
					: undefined;
			const writerPayload = object(writerReceipt?.payload);
			const sourceAttachmentState = sourceAttachment
				? input.store.getWorkflowResumeAttachmentState(
						sourceAttachment.attachment_id,
					)
				: undefined;
			const sourceExecutionId =
				typeof bindingPayload?.sourceExecutionId === "string"
					? bindingPayload.sourceExecutionId
					: undefined;
			const sourceWatch = sourceExecutionId
				? input.store.getWorkflowDeadExecutionWatch(sourceExecutionId)
				: undefined;
			const currentMigration = candidateExecutionId === input.node.execution_id;
			const migrationWriterFenced =
				sourceExecutionId !== undefined &&
				sourceWatch?.run_id === input.runId &&
				sourceWatch.node_id === input.node.node_id &&
				sourceWatch.attempt === input.node.attempt &&
				sourceWatch.new_execution_id === candidateExecutionId &&
				(currentMigration
					? input.store.isUnlaunchedWorkflowResumeReplacement({
							runId: input.runId,
							nodeId: input.node.node_id,
							attempt: input.node.attempt,
							sourceExecutionId,
							newExecutionId: candidateExecutionId,
							launchOrdinal: Number(bindingPayload?.launchOrdinal),
						})
					: Boolean(
							input.store.getWorkflowLaunchCancellation(candidateExecutionId),
						) ||
						isOperationalTerminalStatus(
							input.store.getSession(candidateExecutionId)?.status,
						));
			if (
				binding?.kind !== "resume_writer_binding" ||
				binding.execution_id !== candidateExecutionId ||
				binding.node_id !== input.node.node_id ||
				bindingPayload?.targetNodeId !== input.node.node_id ||
				bindingPayload.targetAttempt !== input.node.attempt ||
				bindingPayload.newExecutionId !== candidateExecutionId ||
				typeof bindingPayload.sourceExecutionId !== "string" ||
				!Number.isInteger(bindingPayload.launchOrdinal) ||
				payload.sourceIssueDeliveryUid !==
					bindingPayload.sourceIssueDeliveryUid ||
				payload.sourceIssueDeliveryDigest !==
					bindingPayload.sourceIssueDeliveryDigest ||
				!sourceDelivery ||
				canonicalSubmissionDigest(sourceDelivery.payload ?? null) !==
					bindingPayload.sourceIssueDeliveryDigest ||
				!sourceAttachment ||
				sourceAttachmentState?.state !== "ready" ||
				sourceAttachment.target_node_id !== input.node.node_id ||
				sourceAttachment.target_attempt !== input.node.attempt ||
				writerReceipt?.kind !== "writer_replacement" ||
				writerReceipt.execution_id !== candidateExecutionId ||
				writerPayload?.deadExecutionId !== bindingPayload.sourceExecutionId ||
				writerPayload.newExecutionId !== candidateExecutionId ||
				writerPayload.launchOrdinal !== bindingPayload.launchOrdinal ||
				!migrationWriterFenced
			) {
				return {
					ok: false,
					resolution: refused("receipt_digest_mismatch", {
						cause: "writer_migration_chain_invalid",
					}),
				};
			}
			const source = validate(sourceDelivery, sourceExecutionId!, visited);
			return source.ok ? { ...source, migrated: true } : source;
		}
		if (
			payload.sourceKind !== "authoritative" &&
			payload.sourceKind !== "frozen_replay"
		) {
			return {
				ok: false,
				resolution: refused("receipt_digest_mismatch", {
					cause: "issue_delivery_malformed",
				}),
			};
		}
		if (payload.sourceKind === "frozen_replay") {
			const admission =
				typeof payload.admissionKey === "string"
					? input.store.getWorkflowResumeAdmission?.(payload.admissionKey)
					: undefined;
			if (
				!admission ||
				admission.run_id !== input.runId ||
				admission.action_kind !== "redispatch_execution" ||
				admission.new_execution_id !== candidateExecutionId ||
				admission.source_attachment_id !== payload.sourceAttachmentId ||
				admission.frozen_s3_body !== payload.body
			) {
				return {
					ok: false,
					resolution: refused("receipt_digest_mismatch", {
						cause: "frozen_replay_chain_invalid",
					}),
				};
			}
		}
		return {
			ok: true,
			runtimeExecutionId: candidateExecutionId,
			migrated: false,
		};
	};
	return validate(delivery, executionId, new Set());
}

function validateGateAuthority(input: {
	store: WorkflowResumeResolverStore;
	events: WorkflowRunEventRow[];
	runId: string;
	node: WorkflowRunNodeRow;
	receipt: WorkflowRunEventRow;
}): WorkflowResumeResolution | undefined {
	const holder = input.store.getCurrentWorkflowGateHolder(
		input.runId,
		input.node.node_id,
	);
	if (
		!holder ||
		holder.attempt !== input.node.attempt ||
		holder.state !== "awaiting_review" ||
		input.node.state !== "review" ||
		holder.source_execution_id !== input.receipt.execution_id
	) {
		return refused("authority_context_mismatch", {
			cause: "gate_holder_not_current",
		});
	}
	const holderReceipt = input.events.find(
		(event) => event.event_uid === `gate_holder:${holder.question_id}`,
	);
	const payload = object(holderReceipt?.payload);
	const legacyHead =
		typeof payload?.head === "string" ? payload.head : undefined;
	const subjectHead =
		payload?.subjectKind === "git_head" &&
		typeof payload.subjectDigest === "string"
			? payload.subjectDigest
			: undefined;
	const receiptHead =
		legacyHead && subjectHead && legacyHead !== subjectHead
			? undefined
			: (legacyHead ?? subjectHead);
	if (
		holderReceipt?.kind !== "gate_holder_created" ||
		holderReceipt.node_id !== input.node.node_id ||
		holderReceipt.execution_id !== holder.source_execution_id ||
		payload?.attempt !== holder.attempt ||
		payload.questionId !== holder.question_id ||
		receiptHead !== holder.head_sha
	) {
		return refused("receipt_missing", {
			receipt: `gate_holder:${holder.question_id}`,
		});
	}
	return undefined;
}

/** Read-only V0-V5 resolution. External observations and Git verification are injected. */
export function resolveWorkflowResumeTarget(
	store: WorkflowResumeResolverStore,
	input: ResolveWorkflowResumeTargetInput,
): WorkflowResumeResolution {
	void input.env;
	const run = store.getWorkflowRun(input.runId);
	if (!run || run.status !== "active" || run.engine_owned !== 1) {
		return refused("run_not_active", { status: run?.status ?? "missing" });
	}
	if (!run.current_node_id) {
		return refused("target_moved", { cause: "current_target_missing" });
	}
	const nodes = store.listWorkflowRunNodes(input.runId, run.current_node_id);
	const node = nodes.at(-1);
	if (!node) {
		return refused("target_moved", { cause: "current_attempt_missing" });
	}
	if (
		input.requestedEntry !== undefined &&
		input.requestedEntry !== node.node_id
	) {
		return refused("target_moved", {
			requestedEntry: input.requestedEntry,
			currentNodeId: node.node_id,
		});
	}
	const attachments = store.listWorkflowResumeAttachments({
		runId: input.runId,
	});
	const frontier = attachments.at(-1);
	if (!frontier) return refused("attachment_missing");
	if (
		frontier.target_node_id !== node.node_id ||
		frontier.target_attempt !== node.attempt
	) {
		return refused("attachment_frontier_divergence", {
			attachmentId: frontier.attachment_id,
		});
	}
	const events = store.listWorkflowRunEvents(input.runId);
	const receipt = events.find(
		(event) => event.event_uid === frontier.transition_uid,
	);
	if (!receipt) {
		return refused("receipt_missing", { receipt: frontier.transition_uid });
	}
	const receiptPayload = object(receipt.payload);
	if (
		receipt.kind !== receiptEventKinds[frontier.receipt_kind] ||
		receipt.run_id !== input.runId ||
		receiptPayload?.targetNodeId !== node.node_id ||
		receiptPayload.targetAttempt !== node.attempt ||
		canonicalSubmissionDigest(receipt.payload ?? null) !==
			frontier.receipt_digest
	) {
		return refused("receipt_digest_mismatch", {
			receipt: frontier.transition_uid,
		});
	}

	const state = store.getWorkflowResumeAttachmentState(frontier.attachment_id);
	if (!state) return refused("attachment_missing", { cause: "state_missing" });
	if (state.state === "invalid") {
		return refused(state.invalid_reason ?? "attachment_missing", {
			attachmentId: frontier.attachment_id,
		});
	}
	if (state.state !== "ready") {
		return refused("anchor_pending", { state: state.state });
	}

	let effectiveAnchor: string | undefined;
	if (frontier.carrier_kind === "git_checkpoint") {
		effectiveAnchor =
			frontier.anchor_commit ?? state.resolved_anchor_commit ?? "";
		if (
			!/^[0-9a-f]{40}$/i.test(effectiveAnchor) ||
			!frontier.anchor_ref ||
			!frontier.repo_identity
		) {
			return refused("anchor_unreachable", {
				cause: "anchor_identity_invalid",
			});
		}
		try {
			if (!input.verifyAnchor({ attachment: frontier, effectiveAnchor })) {
				return refused("anchor_unreachable", { anchor: effectiveAnchor });
			}
		} catch {
			return refused("anchor_unreachable", { anchor: effectiveAnchor });
		}
	} else if (frontier.carrier_kind !== "state_only_checkpoint") {
		return refused("carrier_unknown");
	}

	const baseline = validateBaseline(events, frontier, state);
	if (!baseline.ok) return baseline.resolution;
	if ("unavailable" in input.envelopeObservation) {
		return refused(`envelope_unavailable:${input.envelopeObservation.source}`);
	}
	if (input.envelopeObservation.digest !== baseline.digest) {
		return refused(`envelope_changed:${input.envelopeObservation.source}`, {
			baselineDigest: baseline.digest,
			observedDigest: input.envelopeObservation.digest,
		});
	}
	let deliveryRuntimeExecutionId = node.execution_id;
	let writerMigrationFenced = false;
	if (frontier.carrier_kind === "git_checkpoint") {
		const delivery = validateDelivery({
			store,
			events,
			attachments,
			runId: input.runId,
			node,
			baselineDigest: baseline.digest,
		});
		if (!delivery.ok) return delivery.resolution;
		deliveryRuntimeExecutionId = delivery.runtimeExecutionId;
		writerMigrationFenced = delivery.migrated;
	} else {
		const invalid = validateGateAuthority({
			store,
			events,
			runId: input.runId,
			node,
			receipt,
		});
		if (invalid) return invalid;
	}

	if (!run.snapshot) return refused("snapshot_mismatch");
	let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
	try {
		snapshot = parseWorkflowRunSnapshot(run.snapshot);
	} catch {
		return refused("snapshot_mismatch", { cause: "snapshot_invalid" });
	}
	const target = snapshot.resolved.nodes.find(
		(candidate) => candidate.id === node.node_id,
	);
	if (
		!target ||
		frontier.snapshot_digest !== snapshot.snapshot_digest ||
		frontier.resolved_node_digest !== canonicalSubmissionDigest(target)
	) {
		return refused("snapshot_mismatch");
	}
	let expectedRuntime: string;
	if (frontier.carrier_kind === "state_only_checkpoint") {
		expectedRuntime = canonicalSubmissionDigest({
			type: target.type,
			capabilities: target.capabilities,
		});
	} else {
		const runtime = deliveryRuntimeExecutionId
			? store.getWorkflowExecutionRuntime(deliveryRuntimeExecutionId)
			: undefined;
		if (
			!runtime ||
			runtime.run_id !== input.runId ||
			runtime.node_id !== node.node_id ||
			runtime.attempt !== node.attempt
		) {
			return refused("runtime_mismatch", { cause: "runtime_receipt_missing" });
		}
		expectedRuntime = canonicalSubmissionDigest({
			vendor: runtime.vendor,
			model: runtime.model,
			effort: runtime.effort ?? "",
			resolvedFamily: runtime.resolved_family,
			capabilitiesDigest: runtime.capabilities_digest,
		});
	}
	const effectiveRuntime =
		frontier.runtime_semantics_digest ?? state.runtime_semantics_stamped;
	if (
		!effectiveRuntime ||
		effectiveRuntime !== expectedRuntime ||
		(frontier.runtime_semantics_digest !== null &&
			state.runtime_semantics_stamped !== null &&
			frontier.runtime_semantics_digest !== state.runtime_semantics_stamped)
	) {
		return refused("runtime_mismatch");
	}
	const reworkRequestId =
		typeof receiptPayload.reworkRequestId === "string"
			? receiptPayload.reworkRequestId
			: typeof receiptPayload.requestId === "string"
				? receiptPayload.requestId
				: undefined;
	if (reworkRequestId) {
		const request = store.getWorkflowReworkRequest?.(reworkRequestId);
		if (
			!request ||
			request.authority_context_digest !== frontier.rework_authority_digest
		) {
			return refused("authority_context_mismatch", { reworkRequestId });
		}
	} else if (frontier.rework_authority_digest !== "none") {
		// Inherited writer-replacement attachments retain the immutable source
		// authority digest even though their own receipt has no request id.
		const inherited = attachments.some(
			(candidate) =>
				candidate.attachment_id !== frontier.attachment_id &&
				candidate.rework_authority_digest === frontier.rework_authority_digest,
		);
		if (!inherited) return refused("authority_context_mismatch");
	}

	if (frontier.carrier_kind === "git_checkpoint") {
		const executionId = node.execution_id!;
		const session = store.getSession(executionId);
		const cancellation = store.getWorkflowLaunchCancellation(executionId);
		const dead = store.getWorkflowDeadExecutionWatch(executionId);
		const fenced =
			writerMigrationFenced ||
			Boolean(cancellation) ||
			isOperationalTerminalStatus(session?.status) ||
			(dead?.run_id === input.runId &&
				dead.node_id === node.node_id &&
				dead.attempt === node.attempt);
		if (!fenced) {
			return refused(
				session ? "writer_not_fenced" : "writer_liveness_unknown",
				{ executionId, status: session?.status ?? "unknown" },
			);
		}
	}

	return {
		ok: true,
		runId: input.runId,
		targetNodeId: node.node_id,
		targetAttempt: node.attempt,
		attachmentId: frontier.attachment_id,
		actionKind:
			frontier.carrier_kind === "git_checkpoint"
				? "redispatch_execution"
				: "reconcile_state_only",
		...(effectiveAnchor ? { effectiveAnchor } : {}),
		runtimeSemanticsDigest: effectiveRuntime,
	};
}
