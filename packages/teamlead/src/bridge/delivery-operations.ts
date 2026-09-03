import type { CommDB } from "flywheel-comm/db";
import type { StateStore, WorkflowEngineAlertIdentity } from "../StateStore.js";
import { collectRecipientLivenessEvidence } from "./delivery-contract/liveness.js";

export class DeliveryOperations {
	constructor(
		private readonly deps: {
			store: StateStore;
			commDb: CommDB;
			projectName?: string;
			resolveRecipient(input: {
				family: string;
				rootId: string;
				sourceExecutionId?: string;
			}): string | null;
			resolveAlertIdentity(input: {
				projectName: string;
				issueId: string;
				runId: string;
			}): WorkflowEngineAlertIdentity;
		},
	) {}

	runPass(_now: string): {
		examined: number;
		rerouted: number;
		operatorRequired: number;
	} {
		const result = { examined: 0, rerouted: 0, operatorRequired: 0 };
		try {
			for (const operation of this.deps.store.listPendingWorkflowHoldResumeOperations()) {
				let stagedRerouteOperationId: string | undefined;
				let physicalRerouteCommitted = false;
				try {
					if (
						this.deps.projectName &&
						this.deps.store.getWorkflowRun(operation.runId)?.project_name !==
							this.deps.projectName
					) {
						continue;
					}
					if (operation.shape === "delivery_undeliverable_no_recipient") {
						if (
							!operation.physicalId ||
							!operation.family ||
							!operation.rootId ||
							!operation.sourceAttemptId ||
							!operation.episodeId
						) {
							continue;
						}
						if (operation.state === "staged") {
							if (operation.targetActivationId) {
								const staged = this.deps.store.stageWorkflowDeliveryReroute({
									episodeId: operation.episodeId,
									targetExecutionId: operation.targetActivationId,
									now: _now,
									allowOverCap: true,
								});
								if (staged.kind !== "staged") continue;
								stagedRerouteOperationId = staged.operationId;
								const rerouteInput = {
									sourceId: staged.sourcePhysicalId,
									childId: staged.childPhysicalId,
									rootId: staged.rootId,
									parentAttemptId: staged.sourceAttemptId,
									targetExecutionId: operation.targetActivationId,
									now: _now,
								};
								switch (staged.family) {
									case "mailbox":
										this.deps.commDb.rerouteMailboxDelivery(rerouteInput);
										break;
									case "phase_wake":
										this.deps.commDb.rerouteRunnerPhaseWake(rerouteInput);
										break;
									case "turn_wake":
										this.deps.commDb.rerouteTurnWake(rerouteInput);
										break;
									case "rework":
									case "carrier": {
										const applied =
											this.deps.store.applyWorkflowDeliveryReroute({
												operationId: staged.operationId,
												now: _now,
											});
										if (!applied.ok) continue;
										break;
									}
									default:
										continue;
								}
								if (!["rework", "carrier"].includes(staged.family)) {
									physicalRerouteCommitted = true;
									const applied =
										this.deps.store.markWorkflowDeliveryRerouteApplied({
											operationId: staged.operationId,
											now: _now,
										});
									if (!applied.ok) continue;
								}
								const run = this.deps.store.getWorkflowRun(operation.runId);
								const rootParts = operation.rootId.split(":");
								const projectName =
									run?.project_name ?? rootParts[0] ?? "unknown";
								this.deps.store.projectWorkflowDeliveryReroute({
									operationId: staged.operationId,
									episodeId: operation.episodeId,
									childAttemptId: staged.childAttemptId,
									now: _now,
									alertIdentity: this.deps.resolveAlertIdentity({
										projectName,
										issueId: run?.issue_id ?? rootParts[1] ?? "unknown",
										runId: operation.runId,
									}),
								});
								const applied = this.deps.store.markWorkflowHoldResumeApplied({
									operationId: operation.operationId,
									now: _now,
								});
								if (!applied.ok) continue;
								result.rerouted++;
							} else {
								const cancellation = {
									sourceId: operation.physicalId,
									operationId: operation.operationId,
									now: _now,
								};
								const cancelled =
									operation.family === "mailbox"
										? this.deps.commDb.cancelMailboxDelivery(cancellation)
										: operation.family === "turn_wake"
											? this.deps.commDb.cancelTurnWakeDelivery(cancellation)
											: undefined;
								if (!cancelled) continue;
								if (!cancelled.ok) continue;
								const applied =
									this.deps.store.applyWorkflowDeliveryCancellation({
										operationId: operation.operationId,
										now: _now,
									});
								if (!applied.ok) continue;
							}
						}
						this.deps.store.projectWorkflowHoldResume({
							operationId: operation.operationId,
							now: _now,
						});
						continue;
					}
					if (!operation.physicalId) continue;
					if (operation.state === "staged") {
						switch (operation.shape) {
							case "mailbox_inflight_slots_exhausted":
								this.deps.commDb.resumeMailboxInflightHold({
									sourceId: operation.physicalId,
									receiptId: operation.operationId,
									now: _now,
								});
								break;
							case "three_stage_turn_stuck":
								this.deps.commDb.resumeTurnWakeHold({
									sourceId: operation.physicalId,
									receiptId: operation.operationId,
								});
								break;
							default:
								continue;
						}
						const applied = this.deps.store.markWorkflowHoldResumeApplied({
							operationId: operation.operationId,
							now: _now,
						});
						if (!applied.ok) continue;
					}
					this.deps.store.projectWorkflowHoldResume({
						operationId: operation.operationId,
						now: _now,
					});
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (stagedRerouteOperationId && !physicalRerouteCommitted) {
						try {
							this.deps.store.markWorkflowDeliveryRerouteFailed({
								operationId: stagedRerouteOperationId,
								now: _now,
								error: message,
								alertIdentity: this.deps.resolveAlertIdentity({
									projectName:
										this.deps.store.getWorkflowRun(operation.runId)
											?.project_name ??
										operation.rootId?.split(":")[0] ??
										"unknown",
									issueId:
										this.deps.store.getWorkflowRun(operation.runId)?.issue_id ??
										operation.rootId?.split(":")[1] ??
										"unknown",
									runId: operation.runId,
								}),
							});
						} catch (compensationError) {
							console.warn(
								`[delivery-operations] reroute compensation ${stagedRerouteOperationId} failed: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`,
							);
						}
					}
					this.deps.store.markWorkflowHoldResumeFailed({
						operationId: operation.operationId,
						now: _now,
						error: message,
					});
					console.warn(
						`[delivery-operations] hold resume ${operation.operationId} failed: ${message}`,
					);
				}
			}
			for (const episode of this.deps.store.listOpenUndeliverableDeliveryEpisodes()) {
				let stagedRerouteOperationId: string | undefined;
				let physicalRerouteCommitted = false;
				let rerouteAlertIdentity: WorkflowEngineAlertIdentity | undefined;
				try {
					const rootParts = episode.root_id.split(":");
					const run = this.deps.store.getWorkflowRun(episode.run_id);
					const projectName = run?.project_name ?? rootParts[0] ?? "unknown";
					if (this.deps.projectName && projectName !== this.deps.projectName) {
						continue;
					}
					result.examined++;
					if (
						this.deps.store.hasWorkflowDeliveryRerouteOperatorRequired(
							episode.episode_id,
						)
					) {
						continue;
					}
					const alertIdentity = this.deps.resolveAlertIdentity({
						projectName,
						issueId: run?.issue_id ?? rootParts[1] ?? "unknown",
						runId: episode.run_id,
					});
					rerouteAlertIdentity = alertIdentity;
					const ref = JSON.parse(episode.contract_ref_json) as {
						pk?: unknown;
					};
					const sourcePhysicalId =
						typeof ref.pk === "string" ? ref.pk : undefined;
					const sourceExecutionId = sourcePhysicalId
						? episode.family === "mailbox"
							? this.deps.commDb.getMessageById(sourcePhysicalId)?.to_agent
							: episode.family === "phase_wake"
								? this.deps.commDb.getRunnerPhaseWakeProjectionRow(
										sourcePhysicalId,
									)?.execution_id
								: episode.family === "turn_wake"
									? (this.deps.commDb.getTurnWake(sourcePhysicalId)
											?.execution_id ?? undefined)
									: episode.family === "rework"
										? this.deps.store.getLatestWorkflowReworkRoute(
												sourcePhysicalId,
											)?.preferred_actor_execution_id
										: episode.family === "carrier"
											? this.deps.store.getWorkflowCarrierDelivery(
													sourcePhysicalId,
												)?.source_execution_id
											: undefined
						: undefined;
					const targetExecutionId = this.deps.resolveRecipient({
						family: episode.family,
						rootId: episode.root_id,
						...(sourceExecutionId ? { sourceExecutionId } : {}),
					});
					if (!targetExecutionId) {
						if (sourceExecutionId) {
							const evidence = collectRecipientLivenessEvidence({
								store: this.deps.store,
								commDb: this.deps.commDb,
								executionId: sourceExecutionId,
								nowMs: Date.parse(_now),
							});
							const held = this.deps.store.holdWorkflowUndeliverable({
								episodeId: episode.episode_id,
								recipientExecutionId: sourceExecutionId,
								commEvidence: evidence,
								now: _now,
								alertIdentity,
							});
							if (held.held) result.operatorRequired++;
						}
						continue;
					}
					if (episode.family === "rework" || episode.family === "carrier") {
						const rerouted = this.deps.store.rerouteWorkflowStateDelivery({
							episodeId: episode.episode_id,
							targetExecutionId,
							now: _now,
							allowOverCap: false,
							alertIdentity,
						});
						if (rerouted.ok) {
							result.rerouted++;
						} else if (
							rerouted.reason === "reroute_limit_exhausted" &&
							sourceExecutionId
						) {
							const evidence = collectRecipientLivenessEvidence({
								store: this.deps.store,
								commDb: this.deps.commDb,
								executionId: sourceExecutionId,
								nowMs: Date.parse(_now),
							});
							this.deps.store.recordWorkflowDeliveryRerouteOperatorRequired({
								episodeId: episode.episode_id,
								now: _now,
								reason: "delivery_reroute_limit_exhausted",
								runHeld: false,
								recipientExecutionId: sourceExecutionId,
								commEvidence: evidence,
								alertIdentity,
							});
							result.operatorRequired++;
						}
						continue;
					}
					const staged = this.deps.store.stageWorkflowDeliveryReroute({
						episodeId: episode.episode_id,
						targetExecutionId,
						...(sourceExecutionId ? { sourceExecutionId } : {}),
						now: _now,
					});
					if (staged.kind === "operator_required" && sourceExecutionId) {
						const evidence = collectRecipientLivenessEvidence({
							store: this.deps.store,
							commDb: this.deps.commDb,
							executionId: sourceExecutionId,
							nowMs: Date.parse(_now),
						});
						this.deps.store.recordWorkflowDeliveryRerouteOperatorRequired({
							episodeId: episode.episode_id,
							now: _now,
							reason: staged.reason ?? "delivery_reroute_limit_exhausted",
							runHeld: false,
							recipientExecutionId: sourceExecutionId,
							commEvidence: evidence,
							alertIdentity,
						});
						result.operatorRequired++;
						continue;
					}
					if (staged.kind !== "staged") continue;
					stagedRerouteOperationId = staged.operationId;
					const rerouteInput = {
						sourceId: staged.sourcePhysicalId,
						childId: staged.childPhysicalId,
						rootId: staged.rootId,
						parentAttemptId: staged.sourceAttemptId,
						targetExecutionId,
						now: _now,
					};
					switch (staged.family) {
						case "mailbox":
							this.deps.commDb.rerouteMailboxDelivery(rerouteInput);
							break;
						case "phase_wake":
							this.deps.commDb.rerouteRunnerPhaseWake(rerouteInput);
							break;
						case "turn_wake":
							this.deps.commDb.rerouteTurnWake(rerouteInput);
							break;
						default:
							continue;
					}
					physicalRerouteCommitted = true;
					const applied = this.deps.store.markWorkflowDeliveryRerouteApplied({
						operationId: staged.operationId,
						now: _now,
					});
					if (!applied.ok) continue;
					this.deps.store.projectWorkflowDeliveryReroute({
						operationId: staged.operationId,
						episodeId: episode.episode_id,
						childAttemptId: staged.childAttemptId,
						now: _now,
						alertIdentity,
					});
					result.rerouted++;
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (stagedRerouteOperationId && !physicalRerouteCommitted) {
						try {
							this.deps.store.markWorkflowDeliveryRerouteFailed({
								operationId: stagedRerouteOperationId,
								now: _now,
								error: message,
								...(rerouteAlertIdentity
									? { alertIdentity: rerouteAlertIdentity }
									: {}),
							});
						} catch (compensationError) {
							console.warn(
								`[delivery-operations] reroute compensation ${stagedRerouteOperationId} failed: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`,
							);
						}
					}
					console.warn(
						`[delivery-operations] episode ${episode.episode_id} failed: ${message}`,
					);
				}
			}
		} finally {
			this.deps.store.alertStalledWorkflowDeliveryOperations(
				_now,
				this.deps.resolveAlertIdentity,
			);
		}
		return result;
	}
}
