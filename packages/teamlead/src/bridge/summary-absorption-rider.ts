import {
	MAILBOX_RETENTION_MS,
	type MailboxSettlement,
} from "flywheel-comm/mailbox-queue";
import type { SummaryGranularitySelection } from "flywheel-comm/summary-config";
import { founderLocalIso } from "flywheel-config";
import type { AlertPayload } from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { TERMINAL_ROW_RETENTION_MS } from "../terminal-row-archive.js";
import { canonicalLeadEventDeliveryId } from "./lead-event-queue.js";
import { leadEventEnvelopeFromJournalRow } from "./legacy-lead-event-reconciler.js";
import type { DurableQueueReceipt } from "./runtime-registry.js";
import {
	type ActivityProbeResult,
	type ActivityWindow,
	activityRetentionFailure,
	captureActivitySource,
	classifyActivitySources,
	classifyMailboxSnapshot,
	type MailboxActivitySnapshot,
	type MailboxCursor,
	type PreviousDecisionEvidence,
	parsePreviousDecisionRows,
	type SourceResult,
	SUMMARY_ACTIVITY_PROBE_VERSION,
	safeActivityReason,
} from "./summary-activity-probe.js";
import type {
	SummaryLedgerResult,
	SummaryPull,
} from "./summary-delivery-ledger.js";
import { resolveSummaryProducers } from "./summary-producer-roster.js";
import {
	classifyRound,
	issueRayaRound,
	type SummaryDueRoundRow,
	type SummaryRoundResult,
} from "./summary-round-classify.js";
import {
	formatSummaryVisibleFailureAlert,
	formatSummaryVisibleStaleAlert,
} from "./summary-visible-alert.js";

export const SUMMARY_ABSORPTION_SESSION_KEY = "summary-absorption";

export function summaryAbsorptionRoundId(slotStartMs: number): string {
	if (!Number.isSafeInteger(slotStartMs) || slotStartMs < 0) {
		throw new Error(`invalid summary absorption slot: ${slotStartMs}`);
	}
	return `summary-absorption:${new Date(slotStartMs).toISOString()}`;
}

export interface SummaryAbsorptionPassDeps {
	projects: readonly ProjectEntry[];
	store: Pick<
		StateStore,
		| "appendLeadEvent"
		| "getLeadEventBySeq"
		| "appendSummaryDueRows"
		| "listSummaryDueRows"
		| "getLeadEventByLeadAndId"
		| "tryClaimLeadEvent"
	> &
		Partial<
			Pick<
				StateStore,
				| "appendSummaryDecisionRows"
				| "countLeadEventActivity"
				| "listLatestSummaryDecisionRows"
				| "listSummaryDueSkippedRows"
				| "appendSummaryPresentationRounds"
				| "claimSummaryPresentationStaleSignals"
			>
		>;
	enqueueLeadEvent(
		envelope: ReturnType<typeof leadEventEnvelopeFromJournalRow>,
	): DurableQueueReceipt;
	inspectDeliveryState(
		projectName: string,
		deliveryId: string,
	): MailboxSettlement;
	readSummaryGranularity(): SummaryGranularitySelection;
	listSummaryPulls(): Promise<SummaryLedgerResult>;
	activityGateEnabled?(): boolean;
	readMailboxActivity?(input: {
		projectName: string;
		leadId: string;
		leadBotUserId: string;
		recipientBotUserId: string;
		senderBotUserIds: string[];
		fromIso: string;
		toIso: string;
		allocatedSeq: number | null;
		contiguous: boolean;
	}): Promise<MailboxActivitySnapshot>;
	readLinearActivity?(
		projectName: string,
		window: ActivityWindow,
	): Promise<SourceResult>;
	alertFailure(payload: AlertPayload): Promise<void>;
	/** Named call-time flag accessor; the DB value is intentionally not cached. */
	cadenceMs(): number;
	now?: () => number;
	log?(message: string): void;
}

function periodFor(slotStartMs: number, cadenceMs: number): string {
	return `${founderLocalIso(new Date(slotStartMs - cadenceMs))}/${founderLocalIso(new Date(slotStartMs))}`;
}

function newestDelivery(
	pulls: readonly SummaryPull[],
	projectName: string,
	leadId: string,
): SummaryPull | undefined {
	return pulls
		.filter((pull) => pull.project === projectName && pull.lead === leadId)
		.sort((left, right) => right.createdAt - left.createdAt)[0];
}

function unavailable(reason: string): SourceResult {
	return { status: "unavailable", reason };
}

function activityIdentity(deps: SummaryAbsorptionPassDeps) {
	const recipients = deps.projects.flatMap((project) =>
		project.leads
			.filter((lead) => lead.summaryRole === "recipient")
			.map((lead) => lead.botUserId),
	);
	const recipientBotUserId =
		recipients.length === 1 && recipients[0] ? recipients[0] : null;
	const senderBotUserIds = [
		...new Set(
			deps.projects.flatMap((project) =>
				project.leads.flatMap((lead) =>
					lead.botUserId && lead.botUserId !== recipientBotUserId
						? [lead.botUserId]
						: [],
				),
			),
		),
	];
	return { recipientBotUserId, senderBotUserIds };
}

function producerBotUserId(
	projects: readonly ProjectEntry[],
	projectName: string,
	leadId: string,
): string | null {
	return (
		projects
			.find((project) => project.projectName === projectName)
			?.leads.find((lead) => lead.agentId === leadId)?.botUserId ?? null
	);
}

function continuityFailure(
	previous: PreviousDecisionEvidence,
	window: ActivityWindow,
	nowMs: number,
	retentionMs: number,
): "corrupt_cursor" | "retention_window_exceeded" | null {
	if (previous.error) return previous.error;
	if (previous.decisionAtMs === null) return null;
	return activityRetentionFailure({
		nowMs,
		fromMs: window.fromMs,
		previousDecisionAtMs: previous.decisionAtMs,
		retentionMs,
	});
}

function leadEventActivity(input: {
	previous: PreviousDecisionEvidence;
	window: ActivityWindow;
	nowMs: number;
	leadId: string;
	countActivity: StateStore["countLeadEventActivity"];
}): SourceResult {
	if (input.previous.error) return unavailable(input.previous.error);
	if (
		input.previous.decisionSeq === null ||
		input.previous.decisionAtMs === null
	) {
		return unavailable("no_previous_decision");
	}
	const retentionFailure = continuityFailure(
		input.previous,
		input.window,
		input.nowMs,
		TERMINAL_ROW_RETENTION_MS,
	);
	if (retentionFailure) return unavailable(retentionFailure);
	const contiguous = input.previous.window?.toMs === input.window.fromMs;
	try {
		const count = input.countActivity(
			input.leadId,
			input.window.fromMs,
			input.window.toMs,
			input.previous.decisionSeq,
			contiguous,
		);
		return contiguous
			? { status: "ok", count }
			: unavailable("window_discontinuous");
	} catch (error) {
		return unavailable(safeActivityReason(error));
	}
}

function previousDecisionAt(previous: PreviousDecisionEvidence): string | null {
	return previous.decisionAtMs === null
		? null
		: new Date(previous.decisionAtMs).toISOString();
}

interface PreparedActivityProducer {
	projectName: string;
	leadId: string;
	previous: PreviousDecisionEvidence;
	mailbox: { source: SourceResult; cursor: MailboxCursor | null };
	linear: SourceResult;
}

async function prepareActivityProducer(input: {
	deps: SummaryAbsorptionPassDeps;
	projectName: string;
	leadId: string;
	window: ActivityWindow;
	nowMs: number;
	recipientBotUserId: string | null;
	senderBotUserIds: string[];
	linearForProject(projectName: string): Promise<SourceResult>;
}): Promise<PreparedActivityProducer> {
	const rows = input.deps.store.listLatestSummaryDecisionRows?.(
		input.leadId,
		8,
	);
	const previous = parsePreviousDecisionRows(rows ?? []);
	const contiguous = previous.window?.toMs === input.window.fromMs;
	const priorCursor = previous.mailboxCursor;
	let mailbox: PreparedActivityProducer["mailbox"];
	const leadBotUserId = producerBotUserId(
		input.deps.projects,
		input.projectName,
		input.leadId,
	);
	if (!leadBotUserId) {
		mailbox = {
			source: unavailable("producer_bot_id_missing"),
			cursor: priorCursor,
		};
	} else if (!input.recipientBotUserId) {
		mailbox = {
			source: unavailable("recipient_bot_id_missing"),
			cursor: priorCursor,
		};
	} else if (input.senderBotUserIds.length === 0) {
		mailbox = {
			source: unavailable("sender_bot_ids_missing"),
			cursor: priorCursor,
		};
	} else if (!input.deps.readMailboxActivity) {
		mailbox = {
			source: unavailable("mailbox_collector_missing"),
			cursor: priorCursor,
		};
	} else {
		try {
			const snapshot = await input.deps.readMailboxActivity({
				projectName: input.projectName,
				leadId: input.leadId,
				leadBotUserId,
				recipientBotUserId: input.recipientBotUserId,
				senderBotUserIds: input.senderBotUserIds,
				fromIso: new Date(input.window.fromMs).toISOString(),
				toIso: new Date(input.window.toMs).toISOString(),
				allocatedSeq: priorCursor?.allocated_seq ?? null,
				contiguous,
			});
			mailbox = classifyMailboxSnapshot({
				previousCursor: priorCursor,
				snapshot,
				contiguous,
				continuityFailure: continuityFailure(
					previous,
					input.window,
					input.nowMs,
					MAILBOX_RETENTION_MS,
				),
			});
		} catch (error) {
			mailbox = {
				source: unavailable(safeActivityReason(error)),
				cursor: priorCursor,
			};
		}
	}
	return {
		projectName: input.projectName,
		leadId: input.leadId,
		previous,
		mailbox,
		linear: await input.linearForProject(input.projectName),
	};
}

async function runSummaryDueFirstBeat(
	deps: SummaryAbsorptionPassDeps,
	slotStartMs: number,
	cadenceMs: number,
): Promise<void> {
	const slotStart = new Date(slotStartMs).toISOString();
	let rows = deps.store.listSummaryDueRows(slotStart);
	const skippedRows = deps.store.listSummaryDueSkippedRows?.(slotStart) ?? [];
	if (rows.length === 0 && skippedRows.length === 0) {
		let producers: ReturnType<typeof resolveSummaryProducers>;
		try {
			producers = resolveSummaryProducers(
				deps.projects,
				deps.readSummaryGranularity(),
			);
		} catch (error) {
			deps.log?.(
				`[summary_due] roster unavailable for ${slotStart}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (producers.length === 0) return;

		const gateOn = deps.activityGateEnabled?.() ?? false;
		const ledger = await deps.listSummaryPulls();
		const period = periodFor(slotStartMs, cadenceMs);
		const generatedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
		const dueRow = (
			projectName: string,
			leadId: string,
			activity?: ActivityProbeResult,
		) => {
			const eventId = `summary_due:${projectName}/${leadId}:${slotStart}`;
			const last =
				ledger.status === "ok"
					? newestDelivery(ledger.pulls, projectName, leadId)
					: undefined;
			const lastDelivered =
				ledger.status === "unavailable"
					? { status: "unavailable" as const, reason: ledger.reason }
					: last
						? {
								status: "found" as const,
								pr: last.number,
								url: last.url,
								state: last.state,
								created_at: new Date(last.createdAt).toISOString(),
							}
						: { status: "none" as const };
			return {
				leadId,
				eventId,
				eventType: "summary_due" as const,
				payload: JSON.stringify({
					event_type: "summary_due",
					execution_id: eventId,
					issue_id: "FLY-2382",
					project_name: projectName,
					status: "scheduled",
					generated_at: generatedAt,
					summary_due: {
						slot_start: slotStart,
						cadence_ms: cadenceMs,
						period,
						last_delivered: lastDelivered,
						command_hint: `flywheel-comm summary --file <your-summary.md> --project ${projectName} --period ${period}`,
						...(activity ? { activity } : {}),
					},
				}),
			};
		};

		if (!gateOn) {
			deps.store.appendSummaryDueRows(
				producers.map(({ projectName, leadId }) => dueRow(projectName, leadId)),
			);
		} else {
			if (
				!deps.store.appendSummaryDecisionRows ||
				!deps.store.listLatestSummaryDecisionRows ||
				!deps.store.listSummaryDueSkippedRows
			) {
				throw new Error("summary_activity_store_missing");
			}
			const window = {
				fromMs: slotStartMs - cadenceMs,
				toMs: slotStartMs,
			};
			const nowMs = deps.now?.() ?? Date.now();
			const identities = activityIdentity(deps);
			const linearCache = new Map<string, Promise<SourceResult>>();
			const linearForProject = (projectName: string) => {
				let pending = linearCache.get(projectName);
				if (!pending) {
					pending = deps.readLinearActivity
						? captureActivitySource(() =>
								deps.readLinearActivity!(projectName, window),
							)
						: Promise.resolve(unavailable("linear_collector_missing"));
					linearCache.set(projectName, pending);
				}
				return pending;
			};
			const prepared = await Promise.all(
				producers.map(({ projectName, leadId }) =>
					prepareActivityProducer({
						deps,
						projectName,
						leadId,
						window,
						nowMs,
						recipientBotUserId: identities.recipientBotUserId,
						senderBotUserIds: identities.senderBotUserIds,
						linearForProject,
					}),
				),
			);
			deps.store.appendSummaryDecisionRows((countActivity) =>
				prepared.map((producer) => {
					const leadEvents = leadEventActivity({
						previous: producer.previous,
						window,
						nowMs,
						leadId: producer.leadId,
						countActivity,
					});
					const sources = {
						lead_events: leadEvents,
						mailbox: producer.mailbox.source,
						linear: producer.linear,
					};
					const activity: ActivityProbeResult = {
						verdict: classifyActivitySources(sources),
						window: {
							from: new Date(window.fromMs).toISOString(),
							to: new Date(window.toMs).toISOString(),
						},
						probe_version: SUMMARY_ACTIVITY_PROBE_VERSION,
						previous_decision_at: previousDecisionAt(producer.previous),
						sources,
						cursors: { mailbox: producer.mailbox.cursor },
					};
					if (activity.verdict !== "quiet") {
						return dueRow(producer.projectName, producer.leadId, activity);
					}
					const eventId = `summary_due_skipped:${producer.projectName}/${producer.leadId}:${slotStart}`;
					return {
						leadId: producer.leadId,
						eventId,
						eventType: "summary_due_skipped" as const,
						payload: JSON.stringify({
							event_type: "summary_due_skipped",
							execution_id: eventId,
							issue_id: "FLY-2634",
							project_name: producer.projectName,
							status: "skipped",
							generated_at: generatedAt,
							summary_due_skipped: {
								slot_start: slotStart,
								cadence_ms: cadenceMs,
								period,
								activity,
							},
						}),
					};
				}),
			);
		}
		rows = deps.store.listSummaryDueRows(slotStart);
	}

	for (const row of rows) {
		try {
			const envelope = leadEventEnvelopeFromJournalRow(row, 2);
			const projectName = envelope.event.project_name;
			if (!projectName)
				throw new Error("summary_due payload lacks project_name");
			const settlement = deps.inspectDeliveryState(
				projectName,
				canonicalLeadEventDeliveryId(envelope),
			);
			if (settlement.kind === "absent_identity") {
				deps.enqueueLeadEvent(envelope);
			}
		} catch (error) {
			deps.log?.(
				`[summary_due] enqueue failed for ${row.lead_id} ${row.event_id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

function resolveRaya(
	projects: readonly ProjectEntry[],
): { projectName: string; leadId: string } | null {
	const matches = projects.flatMap((project) =>
		project.leads
			.filter((lead) => lead.agentId === "raya")
			.map(() => ({ projectName: project.projectName, leadId: "raya" })),
	);
	if (matches.length > 1) {
		throw new Error(
			"summary absorption requires exactly one canonical Raya Lead",
		);
	}
	return matches[0] ?? null;
}

function dueRoundRows(
	rows: ReturnType<StateStore["listSummaryDueRows"]>,
): SummaryDueRoundRow[] {
	return rows.map((row) => {
		const event = JSON.parse(row.payload) as {
			project_name?: unknown;
			summary_due?: { period?: unknown };
		};
		if (
			typeof event.project_name !== "string" ||
			typeof event.summary_due?.period !== "string"
		) {
			throw new Error(`invalid summary_due payload: ${row.event_id}`);
		}
		return {
			projectName: event.project_name,
			leadId: row.lead_id,
			period: event.summary_due.period,
		};
	});
}

function skippedRoundRows(
	rows: ReturnType<StateStore["listSummaryDueSkippedRows"]>,
): SummaryDueRoundRow[] {
	return rows.map((row) => {
		const event = JSON.parse(row.payload) as {
			project_name?: unknown;
			summary_due_skipped?: { period?: unknown };
		};
		if (
			typeof event.project_name !== "string" ||
			typeof event.summary_due_skipped?.period !== "string"
		) {
			throw new Error(`invalid summary_due_skipped payload: ${row.event_id}`);
		}
		return {
			projectName: event.project_name,
			leadId: row.lead_id,
			period: event.summary_due_skipped.period,
		};
	});
}

function frozenRoundFromRow(
	row: NonNullable<ReturnType<StateStore["getLeadEventByLeadAndId"]>>,
): SummaryRoundResult {
	const payload = JSON.parse(row.payload) as Partial<SummaryRoundResult>;
	if (
		(payload.round_ledger !== "ok" && payload.round_ledger !== "unavailable") ||
		!Array.isArray(payload.producers) ||
		!Array.isArray(payload.absent) ||
		!Array.isArray(payload.undelivered) ||
		!Array.isArray(payload.delivery_unknown) ||
		typeof payload.report_line !== "string"
	) {
		throw new Error(`invalid frozen summary round: ${row.event_id}`);
	}
	const legacyProducers = payload.producers as unknown as Array<
		Record<string, unknown> & { disposition?: unknown }
	>;
	return {
		...(payload as SummaryRoundResult),
		roster_count:
			Number.isSafeInteger(payload.roster_count) &&
			(payload.roster_count ?? -1) >= 0
				? payload.roster_count
				: payload.producers.length,
		skipped_count:
			Number.isSafeInteger(payload.skipped_count) &&
			(payload.skipped_count ?? -1) >= 0
				? payload.skipped_count
				: 0,
		skipped_delivered_count:
			Number.isSafeInteger(payload.skipped_delivered_count) &&
			(payload.skipped_delivered_count ?? -1) >= 0
				? payload.skipped_delivered_count
				: 0,
		open_unread_count:
			Number.isSafeInteger(payload.open_unread_count) &&
			(payload.open_unread_count ?? -1) >= 0
				? payload.open_unread_count
				: 0,
		skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
		raya_round: payload.raya_round === "not_issued" ? "not_issued" : "issued",
		producers: legacyProducers.map((producer) => ({
			...producer,
			disposition:
				producer.disposition === "skipped_no_activity" ||
				producer.disposition === "skipped_but_delivered"
					? producer.disposition
					: "due",
		})) as SummaryRoundResult["producers"],
	};
}

interface PendingRayaRound {
	leadId: string;
	eventId: string;
	payload: string;
	projectName: string;
	slotStartMs: number;
}

function buildRayaRound(
	raya: { projectName: string; leadId: string },
	slotStartMs: number,
	nowMs: number,
	result: SummaryRoundResult,
): PendingRayaRound {
	const roundId = summaryAbsorptionRoundId(slotStartMs);
	const generatedAt = new Date(nowMs).toISOString();
	const payload = {
		...result,
		contract_version: 2,
		event_type: "summary_absorption_round",
		execution_id: roundId,
		issue_id: "FLY-2131",
		project_name: raya.projectName,
		status: "scheduled",
		generated_at: generatedAt,
		summary:
			"后台 summary 业务轮次；逐轮事实保持独立，founder 呈现由 v2 presentation group 统一决定。",
		notification_context:
			"使用 summary_presentation begin/record/finalize；没有实质内容可以 silent，且不要另发逐轮消息。",
	};
	return {
		leadId: raya.leadId,
		eventId: roundId,
		payload: JSON.stringify(payload),
		projectName: raya.projectName,
		slotStartMs,
	};
}

async function settleSummarySlot(
	deps: SummaryAbsorptionPassDeps,
	raya: { projectName: string; leadId: string } | null,
	slotStartMs: number,
	nowMs: number,
	ledgerForSettlement: () => Promise<SummaryLedgerResult>,
	degradedSlots: Set<string>,
): Promise<PendingRayaRound | null> {
	const slotStart = new Date(slotStartMs).toISOString();
	const dueJournalRows = deps.store.listSummaryDueRows(slotStart);
	const skippedJournalRows =
		deps.store.listSummaryDueSkippedRows?.(slotStart) ?? [];
	if (dueJournalRows.length === 0 && skippedJournalRows.length === 0)
		return null;

	const frozenEventId = `summary_slot_settled:${slotStart}`;
	let frozen = deps.store.getLeadEventByLeadAndId(
		"summary-clock",
		frozenEventId,
	);
	if (!frozen) {
		const dueRows = dueRoundRows(dueJournalRows);
		const skippedRows = skippedRoundRows(skippedJournalRows);
		const settlements = new Map<string, MailboxSettlement | "unknown">();
		for (let index = 0; index < dueJournalRows.length; index += 1) {
			const journalRow = dueJournalRows[index]!;
			const due = dueRows[index]!;
			try {
				const envelope = leadEventEnvelopeFromJournalRow(journalRow, 2);
				settlements.set(
					`${due.projectName}/${due.leadId}`,
					deps.inspectDeliveryState(
						due.projectName,
						canonicalLeadEventDeliveryId(envelope),
					),
				);
			} catch (error) {
				settlements.set(`${due.projectName}/${due.leadId}`, "unknown");
				deps.log?.(
					`[summary_due] settlement unavailable for ${due.projectName}/${due.leadId} ${slotStart}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const classified = classifyRound(
			dueRows,
			skippedRows,
			await ledgerForSettlement(),
			settlements,
		);
		const shouldIssueRayaRound = issueRayaRound(classified);
		const result: SummaryRoundResult = {
			...classified,
			raya_round: shouldIssueRayaRound ? "issued" : "not_issued",
			...(shouldIssueRayaRound
				? {}
				: { not_issued_reason: "nothing_to_read" as const }),
		};
		deps.store.tryClaimLeadEvent(
			"summary-clock",
			frozenEventId,
			"summary_slot_settled",
			JSON.stringify({
				event_type: "summary_slot_settled",
				execution_id: frozenEventId,
				issue_id: "FLY-2382",
				status: "settled",
				generated_at: new Date(nowMs).toISOString(),
				slot_start: slotStart,
				...result,
			}),
			"summary-due",
		);
		frozen = deps.store.getLeadEventByLeadAndId("summary-clock", frozenEventId);
		if (!frozen) {
			throw new Error(
				`summary slot result missing after claim: ${frozenEventId}`,
			);
		}
	}
	const result = frozenRoundFromRow(frozen);

	const pendingRound =
		raya && result.raya_round !== "not_issued"
			? buildRayaRound(raya, slotStartMs, nowMs, result)
			: null;
	if (
		!raya &&
		result.raya_round !== "not_issued" &&
		!degradedSlots.has(slotStart)
	) {
		degradedSlots.add(slotStart);
		deps.log?.(
			`[summary-due] slot ${slotStart} settled without Raya recipient (DEGRADED: no #raya report): ${result.report_line}`,
		);
	}

	if (result.undelivered.length > 0) {
		try {
			const alert = formatSummaryVisibleFailureAlert({ slotStart, result });
			deps.log?.(
				`[summary_due] ${alert.diagnosticRef} internal delivery detail: ${result.report_line}`,
			);
			await deps.alertFailure(alert.payload);
		} catch (error) {
			deps.log?.(
				`[summary_due] alert replay failed for ${slotStart}: ${error instanceof Error ? error.message : String(error)}; ${result.report_line}`,
			);
		}
	}
	return pendingRound;
}

async function runSummaryAbsorptionPass(
	deps: SummaryAbsorptionPassDeps,
	missedSlots: Set<string>,
	degradedSlots: Set<string>,
): Promise<void> {
	const cadenceMs = deps.cadenceMs();
	if (!Number.isSafeInteger(cadenceMs) || cadenceMs <= 0) {
		throw new Error(`invalid summary absorption cadence: ${cadenceMs}`);
	}
	const nowMs = deps.now?.() ?? Date.now();
	const slotStartMs = Math.floor(nowMs / cadenceMs) * cadenceMs;
	const graceMs = Math.min(30 * 60_000, cadenceMs);
	if (nowMs < slotStartMs + graceMs) {
		await runSummaryDueFirstBeat(deps, slotStartMs, cadenceMs);
	} else {
		const slotStart = new Date(slotStartMs).toISOString();
		if (
			deps.store.listSummaryDueRows(slotStart).length === 0 &&
			(deps.store.listSummaryDueSkippedRows?.(slotStart).length ?? 0) === 0 &&
			!missedSlots.has(slotStart)
		) {
			missedSlots.add(slotStart);
			deps.log?.(
				`[summary_due] slot ${slotStart} first observed after grace; no due or absence judgment was created`,
			);
		}
	}

	const raya = resolveRaya(deps.projects);
	let settlementLedger: Promise<SummaryLedgerResult> | null = null;
	const ledgerForSettlement = () => {
		if (!settlementLedger) settlementLedger = deps.listSummaryPulls();
		return settlementLedger;
	};
	const pendingRounds: PendingRayaRound[] = [];
	for (const candidate of [slotStartMs, slotStartMs - cadenceMs]) {
		if (candidate < 0 || nowMs < candidate + graceMs) continue;
		try {
			const pendingRound = await settleSummarySlot(
				deps,
				raya,
				candidate,
				nowMs,
				ledgerForSettlement,
				degradedSlots,
			);
			if (pendingRound) pendingRounds.push(pendingRound);
		} catch (error) {
			deps.log?.(
				`[summary_due] slot settlement failed for ${new Date(candidate).toISOString()}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (pendingRounds.length > 0) {
		try {
			const durableRows = deps.store.appendSummaryPresentationRounds
				? deps.store.appendSummaryPresentationRounds(pendingRounds)
				: pendingRounds.map((round) => {
						const seq = deps.store.appendLeadEvent(
							round.leadId,
							round.eventId,
							"summary_absorption_round",
							round.payload,
							SUMMARY_ABSORPTION_SESSION_KEY,
						);
						const durable = deps.store.getLeadEventBySeq(seq);
						if (!durable) {
							throw new Error(
								`summary absorption journal row missing after append seq=${seq}`,
							);
						}
						return durable;
					});
			for (const durable of durableRows) {
				deps.enqueueLeadEvent(leadEventEnvelopeFromJournalRow(durable, 2));
			}
		} catch (error) {
			deps.log?.(
				`[summary_due] Raya presentation batch failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (raya && deps.store.claimSummaryPresentationStaleSignals) {
		try {
			const signals = deps.store.claimSummaryPresentationStaleSignals({
				projectName: raya.projectName,
				leadId: raya.leadId,
				nowMs,
				cadenceMs,
			});
			for (const signal of signals) {
				deps.log?.(
					`[summary_due] ${signal.diagnosticRef} internal stale state: ${signal.kind} ${signal.internalRef}`,
				);
				await deps.alertFailure(
					formatSummaryVisibleStaleAlert({
						diagnosticRef: signal.diagnosticRef,
					}),
				);
			}
		} catch (error) {
			deps.log?.(
				`[summary_due] stale-state inspection failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/** Independent single-flight on the existing GatePoller timer. */
export function createSummaryAbsorptionPass(
	deps: SummaryAbsorptionPassDeps,
): () => Promise<void> {
	let inFlight: Promise<void> | null = null;
	const missedSlots = new Set<string>();
	const degradedSlots = new Set<string>();
	return () => {
		if (inFlight) return inFlight;
		const pass = Promise.resolve().then(() =>
			runSummaryAbsorptionPass(deps, missedSlots, degradedSlots),
		);
		const guarded = pass.finally(() => {
			if (inFlight === guarded) inFlight = null;
		});
		inFlight = guarded;
		return guarded;
	};
}
