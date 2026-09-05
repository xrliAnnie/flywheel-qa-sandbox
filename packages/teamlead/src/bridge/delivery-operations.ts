import type { CommDB, RunnerShutdownControl } from "flywheel-comm/db";
import type { StateStore, WorkflowEngineAlertIdentity } from "../StateStore.js";
import { collectRecipientLivenessEvidence } from "./delivery-contract/liveness.js";
import { DELIVERY_MAINTENANCE_PAGE_SIZE } from "./delivery-contract/policy.js";
import type { WorkflowDeliveryAttemptRow } from "./delivery-contract/types.js";

export interface DeliveryOperationsCursor {
	lane: "hold" | "episode" | "stalled";
	after?: string;
	afterFamily?: WorkflowDeliveryAttemptRow["family"];
}

export interface DeliveryOperationsPassResult {
	examined: number;
	rerouted: number;
	operatorRequired: number;
	nextCursor?: DeliveryOperationsCursor;
}

function isLegacyRunnerShutdownSchemaError(error: unknown): boolean {
	return (error instanceof Error ? error.message : String(error)).includes(
		"no such column: settlement_reason",
	);
}

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
			residentExpiry?: {
				terminateClaude(
					executionId: string,
				): Promise<{ ok: boolean; error?: string }>;
				probeClaude(
					executionId: string,
				): Promise<"alive" | "dead_pin" | "absent" | "indeterminate">;
			};
		},
	) {}

	async runResidentExpiryPass(now: string): Promise<{
		examined: number;
		requested: number;
		projected: number;
		failed: number;
	}> {
		this.deps.store.expireResidentHoldsTx(now);
		const result = { examined: 0, requested: 0, projected: 0, failed: 0 };
		for (const operation of this.deps.store.listPendingResidentExpiryOperations()) {
			if (
				this.deps.projectName &&
				this.deps.store.getWorkflowRun(operation.runId)?.project_name !==
					this.deps.projectName
			) {
				continue;
			}
			result.examined++;
			let state = operation.state;
			const fail = (error: string): void => {
				const failed = this.deps.store.markResidentExpiryFailed({
					operationId: operation.operationId,
					now,
					error,
					alertIdentity: this.deps.resolveAlertIdentity({
						projectName:
							this.deps.store.getWorkflowRun(operation.runId)?.project_name ??
							this.deps.projectName ??
							"unknown",
						issueId:
							this.deps.store.getWorkflowRun(operation.runId)?.issue_id ??
							"unknown",
						runId: operation.runId,
					}),
				});
				if (failed.ok && !failed.idempotentReplay) result.failed++;
			};
			try {
				if (state === "staged") {
					if (operation.vendor === "codex") {
						let shutdown: RunnerShutdownControl;
						try {
							this.deps.commDb.settleFailedRunnerShutdowns(
								operation.executionId,
								`superseded:${operation.operationId}`,
							);
							shutdown = this.deps.commDb.requestRunnerShutdown(
								operation.executionId,
								operation.operationId,
								Date.parse(now),
							);
						} catch (error) {
							if (isLegacyRunnerShutdownSchemaError(error)) {
								fail("runner_shutdown_schema_incompatible");
								continue;
							}
							console.warn(
								`[delivery-operations] resident expiry ${operation.operationId} CommDB deferred: ${error instanceof Error ? error.message : String(error)}`,
							);
							continue;
						}
						if (shutdown.state === "failed") {
							fail(shutdown.error ?? "runner_shutdown_failed");
							continue;
						}
					} else {
						if (!this.deps.residentExpiry) {
							fail("claude_resident_expiry_effects_missing");
							continue;
						}
						const terminated = await this.deps.residentExpiry.terminateClaude(
							operation.executionId,
						);
						if (!terminated.ok) {
							fail(terminated.error ?? "claude_resident_expiry_failed");
							continue;
						}
					}
					const applied = this.deps.store.applyResidentExpiry({
						operationId: operation.operationId,
						now,
					});
					if (!applied.ok) throw new Error(applied.reason);
					state = "applied";
					result.requested++;
				}

				if (state === "applied") {
					let acknowledged = false;
					if (operation.vendor === "codex") {
						let shutdown: RunnerShutdownControl | null;
						try {
							shutdown = this.deps.commDb.getRunnerShutdownRequest(
								operation.executionId,
								operation.operationId,
							);
						} catch (error) {
							console.warn(
								`[delivery-operations] resident expiry ${operation.operationId} CommDB deferred: ${error instanceof Error ? error.message : String(error)}`,
							);
							continue;
						}
						if (!shutdown || shutdown.state === "requested") continue;
						if (shutdown.state === "failed") {
							fail(shutdown.error ?? "runner_shutdown_failed");
							continue;
						}
						acknowledged = shutdown.state === "acked";
					} else {
						if (!this.deps.residentExpiry) {
							fail("claude_resident_expiry_effects_missing");
							continue;
						}
						const liveness = await this.deps.residentExpiry.probeClaude(
							operation.executionId,
						);
						acknowledged = liveness === "dead_pin" || liveness === "absent";
					}
					if (!acknowledged) continue;
					const sent = this.deps.store.markResidentExpirySent({
						operationId: operation.operationId,
						now,
					});
					if (!sent.ok) throw new Error(sent.reason);
					state = "sent";
				}

				if (state === "sent") {
					const projected = this.deps.store.projectResidentExpiry({
						operationId: operation.operationId,
						now,
					});
					if (!projected.ok) throw new Error(projected.reason);
					if (!projected.idempotentReplay) result.projected++;
				}
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
			}
		}
		return result;
	}

	runPass(
		_now: string,
		cursor?: DeliveryOperationsCursor,
	): DeliveryOperationsPassResult {
		const result: DeliveryOperationsPassResult = {
			examined: 0,
			rerouted: 0,
			operatorRequired: 0,
		};
		let lane = cursor?.lane ?? "hold";
		let after = cursor?.after;
		let afterFamily = cursor?.afterFamily;
		let remaining = DELIVERY_MAINTENANCE_PAGE_SIZE;
		try {
			if (lane === "hold") {
				const candidates =
					this.deps.store.listPendingWorkflowHoldResumeOperations({
						...(this.deps.projectName
							? { projectName: this.deps.projectName }
							: {}),
						...(after ? { afterOperationId: after } : {}),
						limit: remaining + 1,
					});
				const operations = candidates.slice(0, remaining);
				for (const operation of operations) {
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
									const applied = this.deps.store.markWorkflowHoldResumeApplied(
										{
											operationId: operation.operationId,
											now: _now,
										},
									);
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
											this.deps.store.getWorkflowRun(operation.runId)
												?.issue_id ??
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
				remaining -= operations.length;
				if (candidates.length > operations.length) {
					result.nextCursor = {
						lane,
						after: operations[operations.length - 1]!.operationId,
					};
					return result;
				}
				lane = "episode";
				after = undefined;
				afterFamily = undefined;
				if (remaining === 0) {
					result.nextCursor = { lane };
					return result;
				}
			}
			if (lane === "episode") {
				const candidates =
					this.deps.store.listOpenUndeliverableDeliveryEpisodes({
						...(this.deps.projectName
							? { projectName: this.deps.projectName }
							: {}),
						...(after && afterFamily
							? { afterRootId: after, afterFamily }
							: {}),
						limit: remaining + 1,
					});
				const episodes = candidates.slice(0, remaining);
				for (const episode of episodes) {
					let stagedRerouteOperationId: string | undefined;
					let physicalRerouteCommitted = false;
					let rerouteAlertIdentity: WorkflowEngineAlertIdentity | undefined;
					try {
						const rootParts = episode.root_id.split(":");
						const run = this.deps.store.getWorkflowRun(episode.run_id);
						const projectName = run?.project_name ?? rootParts[0] ?? "unknown";
						if (
							this.deps.projectName &&
							projectName !== this.deps.projectName
						) {
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
				remaining -= episodes.length;
				if (candidates.length > episodes.length) {
					result.nextCursor = {
						lane,
						after: episodes[episodes.length - 1]!.root_id,
						afterFamily: episodes[episodes.length - 1]!.family,
					};
					return result;
				}
				lane = "stalled";
				if (remaining === 0) {
					result.nextCursor = { lane };
					return result;
				}
			}
		} finally {
			if (lane === "stalled" && remaining > 0) {
				this.deps.store.alertStalledWorkflowDeliveryOperations(
					_now,
					this.deps.resolveAlertIdentity,
					{
						...(this.deps.projectName
							? { projectName: this.deps.projectName }
							: {}),
						limit: remaining,
					},
				);
			}
		}
		return result;
	}
}
