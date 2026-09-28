import {
	isCodexIdentityLabel,
	isCodexSlotName,
} from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { resetTimestamp } from "../account-heal/account-switch-notification.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { leadEventEnvelopeFromJournalRow } from "../bridge/legacy-lead-event-reconciler.js";
import type { DurableQueueReceipt } from "../bridge/runtime-registry.js";
import type {
	AlertAttemptOptions,
	AlertPayload,
} from "../LeadAlertNotifier.js";
import type { StateStore } from "../StateStore.js";
import {
	type CodexQuotaManualReason,
	formatCodexQuotaManualReason,
} from "./availability.js";
import {
	formatPoolExhaustedAlert,
	type PoolExhaustedAlertDetails,
	type PoolExhaustedAlertSnapshot,
	parsePoolExhaustedAlertDetails,
	parsePoolExhaustedAlertSnapshot,
} from "./pool-exhausted-alert.js";
import {
	type CodexSwitchNotificationSnapshot,
	formatCodexSwitchNotification,
	parseCodexSwitchNotificationSnapshot,
} from "./switch-notification.js";

const MANUAL_REASONS = new Set<CodexQuotaManualReason>([
	"flag_disabled",
	"readiness_receipt_missing",
	"readiness_receipt_invalid",
	"authority_unavailable",
	"credential_not_shared",
	"canonical_unavailable",
	"runtime_unavailable",
	"readiness_unchecked",
	"manual_handoff",
	"legacy_capacity_evidence_missing",
]);
export interface CodexQuotaOutboxOptions {
	store: StateStore;
	send(payload: AlertPayload, attempt: AlertAttemptOptions): Promise<unknown>;
	founderUserId?: string;
	resolveLead?(executionId: string): string | undefined;
	enqueueLead?(
		envelope: LeadEventEnvelope,
		content: string,
	): DurableQueueReceipt;
	now?: () => number;
	timezone?: () => string;
	log?: (line: string) => void;
	/**
	 * FLY-2900: post one line into the execution's issue thread. "posted" and
	 * "undeliverable" are final (an undeliverable line becomes a Lead
	 * diagnostic); "retry" keeps the row pending for the next claim window.
	 */
	notifyIssueThread?(input: {
		executionId: string;
		kind: string;
		text: string;
	}): Promise<
		{ kind: "posted" | "retry" } | { kind: "undeliverable"; reason: string }
	>;
}

/** FLY-2900 §7: human-readable minutes/hours for a standby duration. */
function formatStandbyDuration(ms: unknown): string | null {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

const SAFE_NODE = /^[a-z0-9_-]{1,64}$/;
const SAFE_PROFILE = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_SHA = /^[0-9a-f]{7,40}$/;

/**
 * FLY-2900 §7: the one issue-thread line for a resume or a fallback, rendered
 * only from the durable payload (identifiers re-validated, nothing free-form).
 */
export function codexQuotaResumeNoticeText(
	payload: Record<string, unknown>,
): string | null {
	const node =
		typeof payload.nodeId === "string" && SAFE_NODE.test(payload.nodeId)
			? payload.nodeId
			: "节点";
	if (payload.notice === "resumed") {
		const profile =
			typeof payload.toProfile === "string" &&
			SAFE_PROFILE.test(payload.toProfile)
				? payload.toProfile
				: null;
		const how =
			payload.permitKind === "switch_committed"
				? profile
					? `已切到 ${profile}`
					: "已切号"
				: profile
					? `${profile} 额度已恢复`
					: "额度已恢复";
		const waited = formatStandbyDuration(payload.standbyMs);
		return `⚙️ Codex 额度恢复：${node} 已在原会话续上（${how}${waited ? `，待命 ${waited}` : ""}）。`;
	}
	const checkpoint =
		typeof payload.checkpointCommit === "string" &&
		SAFE_SHA.test(payload.checkpointCommit)
			? payload.checkpointCommit.slice(0, 7)
			: null;
	if (payload.notice === "fallback_claude")
		return `⚙️ Codex 全部账号额度用尽，${node} 改由 Claude 接手${checkpoint ? `（WIP 已提交 ${checkpoint}）` : ""}。`;
	if (payload.notice === "fallback_codex")
		return `⚙️ 原会话无法恢复，${node} 换新 Codex 体接手（进度账本 + 已推提交保留${checkpoint ? `，WIP 已提交 ${checkpoint}` : ""}）。`;
	return null;
}

const STANDBY_DIAGNOSTIC_TEXT: Record<string, string> = {
	standby_entry_limit:
		"同一节点 24 小时内额度待命已达上限，本次撞墙按原失败路径处理",
	standby_permit_precondition:
		"额度待命放行条件不满足（canonical 凭据链未就绪或身份不符），暂不能自动续上",
	continue_reconcile_unavailable:
		"续跑回合连续 3 次无法对账，保持待命、未盲发第二回合",
	fallback_exhausted: "兜底替身已用满 2 次仍未接上，保持待命",
	fallback_blocked: "兜底被阻止（WIP 提交失败），保持待命",
	standby_overdue: "额度待命已超 12 小时仍无放行证据",
	resume_notice_undeliverable: "续跑/兜底的 issue thread 通知投递失败",
};

/** FLY-2900: Lead-facing body of a quota standby diagnostic (payload only). */
export function codexQuotaStandbyDiagnosticText(
	payload: Record<string, unknown>,
): string | null {
	const reason = typeof payload.reason === "string" ? payload.reason : "";
	const text = STANDBY_DIAGNOSTIC_TEXT[reason];
	if (!text) return null;
	const exec =
		typeof payload.executionId === "string" &&
		/^[A-Za-z0-9._:-]{1,128}$/.test(payload.executionId)
			? payload.executionId
			: null;
	const detail =
		typeof payload.detail === "string" &&
		/^[a-z0-9_:.-]{1,80}$/.test(payload.detail)
			? payload.detail
			: null;
	return `⚙️ Codex 额度待命：${text}${exec ? `（execution ${exec}）` : ""}${detail ? ` [${detail}]` : ""}。`;
}
function resolveTimezone(options: Pick<CodexQuotaOutboxOptions, "timezone">) {
	try {
		const timezone = options.timezone?.() ?? "America/Los_Angeles";
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return timezone;
	} catch {
		return "America/Los_Angeles";
	}
}

/**
 * FLY-2869: the "readings stopped" body is rendered only from the durable
 * payload, so an ambiguous replay of the same event id says exactly the same.
 */
function readingStaleBody(
	row: Record<string, unknown>,
	timezone: string,
): string | null {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(String(row.payload_json));
	} catch {
		return null;
	}
	const minutes = data?.staleMinutesAtAlert;
	if (!Number.isSafeInteger(minutes) || (minutes as number) < 0) return null;
	const baseline =
		typeof data.baselineObservedAt === "string" &&
		Number.isFinite(Date.parse(data.baselineObservedAt))
			? data.baselineObservedAt
			: null;
	const failure =
		typeof data.failureCode === "string" &&
		/^[a-z0-9_:.-]{1,80}$/i.test(data.failureCode)
			? data.failureCode
			: null;
	const last =
		baseline === null
			? "：从未观测到"
			: ` ${resetTimestamp(baseline, timezone)}${timezone === "America/Los_Angeles" ? " PT" : ""}`;
	return `⚠️ Codex 额度读数已 ${minutes} 分钟没有刷新成功（最后一次成功读数${last}）。capacity / tick / codex-profile list 已把各号显示为「读数过期」，不据此判断无号可切；需要时请真探。${failure ? `最近一次失败：${failure}` : ""}`;
}

/**
 * FLY-2869: the durable manual-switch row. `undefined` = not a manual row;
 * `null` = a manual row whose recorded generation is missing (stays pending,
 * never invents a target). The snapshot is trusted only when it agrees with
 * the recorded generation; otherwise only verified profile names survive.
 */
function manualSwitchNotification(
	store: StateStore,
	row: Record<string, unknown>,
):
	| {
			rootKey: string;
			generation: number;
			snapshot: CodexSwitchNotificationSnapshot;
	  }
	| null
	| undefined {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(String(row.payload_json));
	} catch {
		return undefined;
	}
	if (data?.reason !== "manual_switch") return undefined;
	const rootKey = data.rootKey;
	const generation = data.generation;
	if (
		typeof rootKey !== "string" ||
		!rootKey ||
		!Number.isSafeInteger(generation)
	)
		return null;
	const recorded = store.codexQuota.getExternalGeneration(
		rootKey,
		generation as number,
	);
	if (!recorded) return null;
	let parsed: CodexSwitchNotificationSnapshot | null = null;
	try {
		parsed =
			typeof data.notification === "string"
				? parseCodexSwitchNotificationSnapshot(JSON.parse(data.notification), {
						manual: true,
					})
				: null;
	} catch {
		parsed = null;
	}
	const agrees =
		parsed !== null &&
		parsed.to.profile === recorded.profile &&
		parsed.to.accountKey === recorded.accountKey;
	return {
		rootKey,
		generation: generation as number,
		snapshot: agrees
			? parsed!
			: {
					version: 1,
					from: {
						profile: parsed?.from.profile ?? "unknown",
						accountKey: "unknown",
						email: null,
						windows: [],
					},
					to: {
						profile: recorded.profile,
						accountKey: recorded.accountKey,
						email: null,
						windows: [],
					},
				},
	};
}

/** The existing notifier owns Discord retries; claims never substitute for its receipt. */
export function createCodexQuotaOutboxDelivery(
	options: CodexQuotaOutboxOptions,
): () => Promise<void> {
	return async () => {
		for (const row of options.store.codexQuota.listOutbox()) {
			if (row.delivery_state !== "pending") continue;
			const eventId = String(row.event_id);
			if (row.kind === "lead_summary") {
				if (!options.resolveLead || !options.enqueueLead) continue;
				const targets = options.store.codexQuota
					.listTargets(String(row.incident_id))
					.filter((t) => t.target_kind === "runner");
				const groups = new Map<string, typeof targets>();
				let complete = targets.length > 0;
				for (const target of targets) {
					const lead = options.resolveLead(String(target.old_execution_id));
					if (!lead) {
						complete = false;
						continue;
					}
					groups.set(lead, [...(groups.get(lead) ?? []), target]);
				}
				for (const [lead, owned] of groups) {
					const session = options.store.getSession(
						String(owned[0]!.old_execution_id),
					);
					if (!session) {
						complete = false;
						continue;
					}
					const incident = options.store.codexQuota.getIncident(
						String(row.incident_id),
					);
					const source =
						options.store.codexQuota.getRunnerBindings(session.execution_id)[0]
							?.profile ?? "unknown";
					const content =
						`Codex quota recovery ${source} -> ${String(incident?.target_profile ?? "unknown")}: ` +
						owned
							.map(
								(t) =>
									`${String(t.run_id)} -> ${String(t.new_run_id ?? "none")} (${String(t.state)})`,
							)
							.join("; ");
					const deliveryId = `${eventId}:lead:${lead}`;
					try {
						const seq = options.store.appendLeadEvent(
							lead,
							deliveryId,
							"codex_quota_recovery",
							JSON.stringify({
								event_type: "codex_quota_recovery",
								execution_id: session.execution_id,
								issue_id: session.issue_id,
								project_name: session.project_name,
								summary: content,
							}),
							session.execution_id,
						);
						const durable = options.store.getLeadEventBySeq(seq);
						if (!durable) {
							complete = false;
							continue;
						}
						const accepted = options.enqueueLead(
							leadEventEnvelopeFromJournalRow(durable, 2),
							content,
						);
						if (accepted.queued !== true || !accepted.deliveryId)
							complete = false;
					} catch {
						complete = false;
					}
				}
				if (complete)
					options.store.codexQuota.markOutboxDelivered(
						eventId,
						`${eventId}:lead-queues`,
					);
				continue;
			}
			if (row.kind === "resume_notice") {
				if (!options.notifyIssueThread) continue;
				let payload: Record<string, unknown>;
				try {
					payload = JSON.parse(String(row.payload_json));
				} catch {
					continue;
				}
				const text = codexQuotaResumeNoticeText(payload);
				const executionId =
					typeof payload.executionId === "string" ? payload.executionId : "";
				if (!text || !executionId) continue;
				const claim = options.store.codexQuota.claimOutboxAttempt(
					eventId,
					(options.now ?? Date.now)(),
				);
				if (!claim) continue;
				let outcome:
					| { kind: "posted" | "retry" }
					| { kind: "undeliverable"; reason: string };
				try {
					outcome = await options.notifyIssueThread({
						executionId,
						kind: `codex_quota_${String(payload.notice)}`,
						text,
					});
				} catch {
					continue;
				}
				if (outcome.kind === "retry") continue;
				if (outcome.kind === "undeliverable")
					options.store.codexQuota.enqueueOutbox({
						incidentId: `codex-standby:${executionId}`,
						kind: "lead_diagnostic",
						eventId: `${eventId}:undeliverable`,
						destination: "lead",
						payload: {
							reason: "resume_notice_undeliverable",
							executionId,
							detail: /^[a-z0-9_:.-]{1,80}$/.test(outcome.reason)
								? outcome.reason
								: "undeliverable",
						},
					});
				options.store.codexQuota.markOutboxDelivered(
					eventId,
					outcome.kind === "posted"
						? `${eventId}:thread`
						: `${eventId}:undeliverable`,
				);
				continue;
			}
			const receipt = options.store.getAlertDeliveryReceipt(eventId);
			if (receipt) {
				options.store.codexQuota.markOutboxDelivered(
					eventId,
					`${receipt.outcome}:${receipt.recorded_at}`,
				);
				continue;
			}
			const founder = row.kind === "founder_alert";
			const notification = row.kind === "switch_notification";
			const founderVisible = founder || notification;
			if (founderVisible && !/^\d{16,22}$/.test(options.founderUserId ?? ""))
				continue;
			// FLY-2869: a manual canonical switch has no incident; it is keyed by the
			// external generation it recorded and is resolved before any claim.
			const manual = notification
				? manualSwitchNotification(options.store, row)
				: undefined;
			if (manual === null) continue;
			const claim = options.store.codexQuota.claimOutboxAttempt(
				eventId,
				(options.now ?? Date.now)(),
			);
			if (!claim) continue;
			if (manual) {
				const payload: AlertPayload = {
					leadId: "codex-quota",
					projectName: "machine",
					eventId,
					eventType: "quota_switch_confirmation",
					title: "Codex quota recovery update",
					body: formatCodexSwitchNotification(
						manual.snapshot,
						resolveTimezone(options),
						"manual",
					),
					severity: "info",
					metadata: {
						codexQuota: {
							vendor: "codex",
							incidentId: `codex:${manual.rootKey}:${manual.generation}`,
							generation: manual.generation,
						},
					},
					deliveryStyle: "plain",
				};
				try {
					await options.send(payload, {
						replayAfterAmbiguousAttempt: claim.replay,
					});
				} catch {
					continue;
				}
				const delivered = options.store.getAlertDeliveryReceipt(eventId);
				if (delivered)
					options.store.codexQuota.markOutboxDelivered(
						eventId,
						`${delivered.outcome}:${delivered.recorded_at}`,
					);
				continue;
			}
			if (row.kind === "reading_stale") {
				const body = readingStaleBody(row, resolveTimezone(options));
				if (body === null) continue;
				const payload: AlertPayload = {
					leadId: "codex-quota",
					projectName: "machine",
					eventId,
					eventType: "codex_quota_reading_stale",
					title: "Codex 额度读数停更",
					body,
					severity: "warning",
					deliveryStyle: "plain",
				};
				try {
					await options.send(payload, {
						replayAfterAmbiguousAttempt: claim.replay,
					});
				} catch {
					continue;
				}
				const delivered = options.store.getAlertDeliveryReceipt(eventId);
				if (delivered)
					options.store.codexQuota.markOutboxDelivered(
						eventId,
						`${delivered.outcome}:${delivered.recorded_at}`,
					);
				continue;
			}
			if (
				row.kind === "lead_diagnostic" &&
				String(row.incident_id ?? "").startsWith("codex-standby")
			) {
				let payload: Record<string, unknown> = {};
				try {
					payload = JSON.parse(String(row.payload_json));
				} catch {
					// Malformed durable row: rendered as the generic line below.
				}
				const body =
					codexQuotaStandbyDiagnosticText(payload) ??
					"⚙️ Codex 额度待命需要 Lead 查看。";
				try {
					await options.send(
						{
							leadId: "codex-quota",
							projectName: "machine",
							eventId,
							eventType: "codex_quota_standby_diagnostic",
							title: "Codex 额度待命",
							body,
							severity: "warning",
							deliveryStyle: "plain",
						},
						{ replayAfterAmbiguousAttempt: claim.replay },
					);
				} catch {
					continue;
				}
				const delivered = options.store.getAlertDeliveryReceipt(eventId);
				if (delivered)
					options.store.codexQuota.markOutboxDelivered(
						eventId,
						`${delivered.outcome}:${delivered.recorded_at}`,
					);
				continue;
			}
			if (row.kind === "automation_disabled") {
				let reasons: CodexQuotaManualReason[] = [];
				let legacy:
					| {
							totalCount: number;
							manualCount: number;
							guardedCount: number;
							skippedCount: number;
							failedCount: number;
					  }
					| undefined;
				try {
					const data = JSON.parse(String(row.payload_json)) as Record<
						string,
						unknown
					>;
					if (
						data.scope === "legacy_batch" &&
						[
							"totalCount",
							"manualCount",
							"guardedCount",
							"skippedCount",
							"failedCount",
						].every(
							(key) =>
								typeof data[key] === "number" &&
								Number.isInteger(data[key]) &&
								Number(data[key]) >= 0,
						)
					)
						legacy = {
							totalCount: Number(data.totalCount),
							manualCount: Number(data.manualCount),
							guardedCount: Number(data.guardedCount),
							skippedCount: Number(data.skippedCount),
							failedCount: Number(data.failedCount),
						};
					if (Array.isArray(data.reasons))
						reasons = data.reasons.filter(
							(reason): reason is CodexQuotaManualReason =>
								typeof reason === "string" &&
								MANUAL_REASONS.has(reason as CodexQuotaManualReason),
						);
				} catch {
					// A malformed durable row remains pending for operator repair.
				}
				if (!reasons.length && !legacy) continue;
				const body = legacy
					? `⚙️ 自动切号关着：已核对 ${legacy.totalCount} 条历史记录，其中 ${legacy.manualCount} 条已交手工，${legacy.guardedCount} 条仍有当前容量或安装保护，${legacy.skippedCount} 条已跳过${legacy.failedCount ? `（${legacy.failedCount} 条因迁移上限或连续失败）` : ""}。已交手工的当前 generation 不会因首次开旗自动接管；手工切号进入新 generation 后才按新事件重新判断。`
					: `⚙️ 自动切号关着：${reasons
							.map(formatCodexQuotaManualReason)
							.join("；")}。需要手工切号。`;
				const payload: AlertPayload = {
					leadId: "codex-quota",
					projectName: "machine",
					eventId,
					eventType: "codex_quota_automation_disabled",
					title: "Codex 自动切号关着",
					body,
					severity: "info",
					deliveryStyle: "plain",
				};
				try {
					await options.send(payload, {
						replayAfterAmbiguousAttempt: claim.replay,
					});
				} catch {
					continue;
				}
				const delivered = options.store.getAlertDeliveryReceipt(eventId);
				if (delivered)
					options.store.codexQuota.markOutboxDelivered(
						eventId,
						`${delivered.outcome}:${delivered.recorded_at}`,
					);
				continue;
			}
			const incidentId = String(row.incident_id);
			const incident = options.store.codexQuota.getIncident(incidentId);
			let reason = "quota_incident";
			let notificationJson: string | null = null;
			let alertSnapshotRaw: unknown;
			let alertDetailsRaw: unknown;
			try {
				const data = JSON.parse(String(row.payload_json));
				if (
					typeof data.reason === "string" &&
					/^[a-z_]{1,80}$/.test(data.reason)
				)
					reason = data.reason;
				if (typeof data.notification === "string")
					notificationJson = data.notification;
				alertSnapshotRaw = data.alertSnapshot;
				alertDetailsRaw = data.alertDetails;
			} catch {}
			// FLY-2830: rendered only from the frozen payload, re-validated here.
			let alertSnapshot: PoolExhaustedAlertSnapshot | null = null;
			let alertDetails: PoolExhaustedAlertDetails | null = null;
			const log = options.log ?? ((line: string) => console.warn(line));
			if (
				founder &&
				reason === "pool_exhausted" &&
				alertSnapshotRaw !== undefined
			) {
				alertSnapshot = parsePoolExhaustedAlertSnapshot(alertSnapshotRaw);
				if (alertSnapshot === null)
					log(
						`[codex-quota] pool_exhausted_snapshot_invalid incident=${incidentId}`,
					);
				else if (alertDetailsRaw !== undefined) {
					alertDetails = parsePoolExhaustedAlertDetails(alertDetailsRaw);
					if (alertDetails === null)
						log(
							`[codex-quota] pool_exhausted_details_invalid incident=${incidentId}`,
						);
				}
			}
			let sourceProfile = "unknown";
			let reset = "unknown";
			try {
				const source = options.store.codexQuota
					.listOutbox()
					.find((item) => item.event_id === `${incidentId}:usage_limit`);
				const data = JSON.parse(String(source?.payload_json ?? "{}"));
				if (isCodexIdentityLabel(data.profile)) sourceProfile = data.profile;
				if (typeof data.resetsAt === "number" && Number.isFinite(data.resetsAt))
					reset = new Date(data.resetsAt).toISOString();
			} catch {}
			const runs = options.store.codexQuota
				.listTargets(incidentId)
				.filter((target) => target.target_kind === "runner");
			const targetProfile = isCodexSlotName(incident?.target_profile)
				? String(incident?.target_profile)
				: "none";
			const material =
				options.store.codexQuota.getInstallationMaterial(incidentId);
			let notificationSnapshot: CodexSwitchNotificationSnapshot | null = null;
			try {
				notificationSnapshot = parseCodexSwitchNotificationSnapshot(
					notificationJson === null ? null : JSON.parse(notificationJson),
				);
			} catch {
				// A malformed historical snapshot degrades to explicit n/a cells.
			}
			if (
				!material ||
				notificationSnapshot?.to.profile !== material.profile ||
				notificationSnapshot.to.accountKey !== material.accountKey
			)
				notificationSnapshot = null;
			if (!notificationSnapshot && notification) {
				notificationSnapshot = {
					version: 1,
					from: {
						profile: sourceProfile,
						accountKey: "unknown",
						email: null,
						windows: [],
					},
					to: {
						profile: targetProfile,
						accountKey: "unknown",
						email: null,
						windows: [],
					},
				};
			}
			const timezone = resolveTimezone(options);
			const details = `Trigger=usageLimited from=${sourceProfile} reset=${reset} to=${targetProfile} affected_runs=${runs.length} restarted_runs=${runs.filter((target) => target.state === "recovered").length}`;
			const payload: AlertPayload = {
				leadId: "codex-quota",
				projectName: "machine",
				eventId,
				eventType: founder
					? "quota_no_target"
					: row.kind === "usage_limit"
						? "usage_limit"
						: "quota_switch_confirmation",
				title: founder
					? "Codex quota recovery needs attention"
					: row.kind === "usage_limit"
						? "Codex usage limit observed"
						: "Codex quota recovery update",
				body: founder
					? alertSnapshot
						? // Payload only: an ambiguous replay must say exactly the same.
							formatPoolExhaustedAlert(alertSnapshot, timezone, alertDetails)
						: `Codex fleet remains paused (${reason}). No blind replacement is allowed. Check account resets or add credits. ${details}`
					: notification
						? formatCodexSwitchNotification(notificationSnapshot!, timezone)
						: `Codex incident ${incidentId}: ${reason}. Recovery is tracked by the fleet coordinator.`,
				severity: founder ? "severe" : notification ? "info" : "warning",
				metadata: {
					codexQuota: {
						vendor: "codex",
						incidentId,
						generation: Number(incident?.generation ?? 0),
					},
				},
				...(founder ? { mentionUserId: options.founderUserId } : {}),
				...(notification ? { deliveryStyle: "plain" as const } : {}),
			};
			try {
				await options.send(payload, {
					replayAfterAmbiguousAttempt: claim.replay,
				});
			} catch {
				continue;
			}
			const delivered = options.store.getAlertDeliveryReceipt(eventId);
			if (delivered)
				options.store.codexQuota.markOutboxDelivered(
					eventId,
					`${delivered.outcome}:${delivered.recorded_at}`,
				);
		}
	};
}
