import type { MailboxSettlement } from "flywheel-comm/mailbox-queue";
import type { SummaryGranularitySelection } from "flywheel-comm/summary-config";
import { founderLocalIso } from "flywheel-config";
import {
	type AlertPayload,
	FLEET_ALERT_PROJECT,
} from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { canonicalLeadEventDeliveryId } from "./lead-event-queue.js";
import { leadEventEnvelopeFromJournalRow } from "./legacy-lead-event-reconciler.js";
import type { DurableQueueReceipt } from "./runtime-registry.js";
import type {
	SummaryLedgerResult,
	SummaryPull,
} from "./summary-delivery-ledger.js";
import { resolveSummaryProducers } from "./summary-producer-roster.js";
import {
	classifyRound,
	type SummaryDueRoundRow,
	type SummaryRoundResult,
} from "./summary-round-classify.js";

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

async function runSummaryDueFirstBeat(
	deps: SummaryAbsorptionPassDeps,
	slotStartMs: number,
	cadenceMs: number,
): Promise<void> {
	const slotStart = new Date(slotStartMs).toISOString();
	let rows = deps.store.listSummaryDueRows(slotStart);
	if (rows.length === 0) {
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

		const ledger = await deps.listSummaryPulls();
		const period = periodFor(slotStartMs, cadenceMs);
		deps.store.appendSummaryDueRows(
			producers.map(({ projectName, leadId }) => {
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
					payload: JSON.stringify({
						event_type: "summary_due",
						execution_id: eventId,
						issue_id: "FLY-2382",
						project_name: projectName,
						status: "scheduled",
						generated_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
						summary_due: {
							slot_start: slotStart,
							cadence_ms: cadenceMs,
							period,
							last_delivered: lastDelivered,
							command_hint: `flywheel-comm summary --file <your-summary.md> --project ${projectName} --period ${period}`,
						},
					}),
				};
			}),
		);
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
	return payload as SummaryRoundResult;
}

function appendRayaRound(
	deps: SummaryAbsorptionPassDeps,
	raya: { projectName: string; leadId: string },
	slotStartMs: number,
	nowMs: number,
	result: SummaryRoundResult,
): void {
	const roundId = summaryAbsorptionRoundId(slotStartMs);
	const generatedAt = new Date(nowMs).toISOString();
	const payload = {
		...result,
		event_type: "summary_absorption_round",
		execution_id: roundId,
		issue_id: "FLY-2131",
		project_name: raya.projectName,
		status: "scheduled",
		generated_at: generatedAt,
		summary:
			`[${roundId}] 开始一轮 summary review/吸收：先对账已 merge summary 与 MEMORY.md provenance，` +
			"review 未读 PR；看不懂时按 roundId+PR 聚合追问该项目 Lead；" +
			"有 review/吸收/追问活动时在 #raya 发可见汇报。",
		notification_context:
			`This event id is the roundId: ${roundId}. Carry it through summary merge --round, ` +
			"MEMORY.md provenance/commit, Lead questions, the durable round ledger, and the #raya report.\n" +
			"【本轮对账(FLY-2382)】无论本轮有没有 review/吸收/追问活动,都要在 #raya 发一条汇报,\n" +
			"并逐字包含下面这几行(不要改写、不要省略):\n" +
			result.report_line,
	};
	const seq = deps.store.appendLeadEvent(
		raya.leadId,
		roundId,
		"summary_absorption_round",
		JSON.stringify(payload),
		SUMMARY_ABSORPTION_SESSION_KEY,
	);
	const durable = deps.store.getLeadEventBySeq(seq);
	if (!durable) {
		throw new Error(
			`summary absorption journal row missing after append seq=${seq}`,
		);
	}
	deps.enqueueLeadEvent(leadEventEnvelopeFromJournalRow(durable, 2));
}

async function settleSummarySlot(
	deps: SummaryAbsorptionPassDeps,
	raya: { projectName: string; leadId: string } | null,
	slotStartMs: number,
	nowMs: number,
	ledgerForSettlement: () => Promise<SummaryLedgerResult>,
	degradedSlots: Set<string>,
): Promise<void> {
	const slotStart = new Date(slotStartMs).toISOString();
	const dueJournalRows = deps.store.listSummaryDueRows(slotStart);
	if (dueJournalRows.length === 0) return;

	const frozenEventId = `summary_slot_settled:${slotStart}`;
	let frozen = deps.store.getLeadEventByLeadAndId(
		"summary-clock",
		frozenEventId,
	);
	if (!frozen) {
		const dueRows = dueRoundRows(dueJournalRows);
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
		const result = classifyRound(
			dueRows,
			await ledgerForSettlement(),
			settlements,
		);
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

	if (raya) {
		try {
			appendRayaRound(deps, raya, slotStartMs, nowMs, result);
		} catch (error) {
			deps.log?.(
				`[summary_due] Raya replay failed for ${slotStart}: ${error instanceof Error ? error.message : String(error)}; ${result.report_line}`,
			);
		}
	} else if (!degradedSlots.has(slotStart)) {
		degradedSlots.add(slotStart);
		deps.log?.(
			`[summary-due] slot ${slotStart} settled without Raya recipient (DEGRADED: no #raya report): ${result.report_line}`,
		);
	}

	if (result.undelivered.length > 0) {
		try {
			const undeliveredProducers = result.producers.filter(
				(producer) => producer.due_delivery === "undelivered",
			);
			await deps.alertFailure({
				leadId: "patrol-roster:summary-due",
				projectName: FLEET_ALERT_PROJECT,
				eventId: `summary_due_undelivered:${slotStart}`,
				eventType: "inbox_loop_stalled",
				title: `summary_due not delivered to ${undeliveredProducers.length} Lead inbox(es)`,
				body: [
					`slot=${slotStart}`,
					...undeliveredProducers.map(
						(producer) =>
							`${producer.project}/${producer.lead}: ${producer.due_delivery}`,
					),
					result.report_line,
				].join("\n"),
				severity: "warning",
			});
		} catch (error) {
			deps.log?.(
				`[summary_due] alert replay failed for ${slotStart}: ${error instanceof Error ? error.message : String(error)}; ${result.report_line}`,
			);
		}
	}
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
	for (const candidate of [slotStartMs, slotStartMs - cadenceMs]) {
		if (candidate < 0 || nowMs < candidate + graceMs) continue;
		try {
			await settleSummarySlot(
				deps,
				raya,
				candidate,
				nowMs,
				ledgerForSettlement,
				degradedSlots,
			);
		} catch (error) {
			deps.log?.(
				`[summary_due] slot settlement failed for ${new Date(candidate).toISOString()}: ${error instanceof Error ? error.message : String(error)}`,
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
