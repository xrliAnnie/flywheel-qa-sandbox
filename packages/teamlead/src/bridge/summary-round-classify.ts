import type { MailboxSettlement } from "flywheel-comm/mailbox-queue";
import { summaryDeliveryBranch } from "flywheel-comm/summary-contract";
import type {
	SummaryLedgerResult,
	SummaryPull,
} from "./summary-delivery-ledger.js";

export interface SummaryDueRoundRow {
	projectName: string;
	leadId: string;
	period: string;
}

export type SummarySkippedRoundRow = SummaryDueRoundRow;
export type ProducerDisposition =
	| "due"
	| "skipped_no_activity"
	| "skipped_but_delivered";
export type DueDelivery =
	| "delivered"
	| "undelivered"
	| "unknown"
	| "not_issued";

export interface SummaryRoundProducer {
	project: string;
	lead: string;
	period: string;
	disposition: ProducerDisposition;
	delivered: boolean | "unknown";
	due_delivery: DueDelivery;
	delivered_pr?: Pick<SummaryPull, "number" | "url" | "state">;
}

export interface SummaryRoundResult {
	round_ledger: "ok" | "unavailable";
	raya_round?: "issued" | "not_issued";
	not_issued_reason?: "nothing_to_read";
	roster_count?: number;
	producer_count?: number;
	delivered_count?: number;
	skipped_count?: number;
	skipped_delivered_count?: number;
	open_unread_count?: number;
	producers: SummaryRoundProducer[];
	absent: string[];
	undelivered: string[];
	delivery_unknown: string[];
	skipped: string[];
	report_line: string;
}

type InspectedSettlement = MailboxSettlement | "unknown";

function producerKey(row: SummaryDueRoundRow): string {
	return `${row.projectName}/${row.leadId}`;
}

function dueDelivery(settlement: InspectedSettlement): DueDelivery {
	if (settlement === "unknown") return "unknown";
	if (
		settlement.kind === "absent_identity" ||
		settlement.kind === "torn_identity"
	) {
		return "undelivered";
	}
	if (settlement.state === "ACKED") return "delivered";
	if (settlement.state === "DEAD" || settlement.state === "QUEUED") {
		return "undelivered";
	}
	return settlement.deliveredAt === null ? "undelivered" : "delivered";
}

function deliveredPullFor(
	row: SummaryDueRoundRow,
	ledger: Extract<SummaryLedgerResult, { status: "ok" }>,
): SummaryPull | undefined {
	const expectedBranch = summaryDeliveryBranch({
		project: row.projectName,
		author: row.leadId,
		period: row.period,
	});
	return ledger.pulls.find(
		(pull) => pull.headRefName === expectedBranch && pull.state !== "CLOSED",
	);
}

function deliveredPr(
	pull: SummaryPull,
): Pick<SummaryPull, "number" | "url" | "state"> {
	return { number: pull.number, url: pull.url, state: pull.state };
}

function reportToken(value: string): string {
	return value.replace(/[^A-Za-z0-9._:/+-]/g, "?");
}

function replaceControls(value: string): string {
	return [...value]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 ? "?" : character;
		})
		.join("");
}

function safeReason(reason: string): string {
	return replaceControls(reason).replace(/\s+/g, " ");
}

function reportNames(values: string[]): string {
	return values.map(reportToken).join("、");
}

/** Classify one frozen cadence slot without turning unknown evidence into absence. */
export function classifyRound(
	dueRows: readonly SummaryDueRoundRow[],
	skippedRows: readonly SummarySkippedRoundRow[],
	ledger: SummaryLedgerResult,
	settlements: ReadonlyMap<string, InspectedSettlement>,
): SummaryRoundResult {
	const leadCounts = new Map<string, number>();
	for (const row of [...dueRows, ...skippedRows]) {
		leadCounts.set(row.leadId, (leadCounts.get(row.leadId) ?? 0) + 1);
	}
	const displayName = (row: SummaryDueRoundRow) =>
		(leadCounts.get(row.leadId) ?? 0) > 1
			? `${row.projectName}/${row.leadId}`
			: row.leadId;

	const absent: string[] = [];
	const undelivered: string[] = [];
	const deliveryUnknown: string[] = [];
	const skipped: string[] = [];
	const producers: SummaryRoundProducer[] = [];
	let deliveredCount = 0;
	let skippedDeliveredCount = 0;

	for (const row of dueRows) {
		const dueState = dueDelivery(
			settlements.get(producerKey(row)) ?? "unknown",
		);
		const deliveredPull =
			ledger.status === "ok" ? deliveredPullFor(row, ledger) : undefined;
		const delivered =
			ledger.status === "unavailable" ? "unknown" : deliveredPull !== undefined;
		const producer: SummaryRoundProducer = {
			project: row.projectName,
			lead: row.leadId,
			period: row.period,
			disposition: "due",
			delivered,
			due_delivery: dueState,
		};
		if (dueState === "undelivered") {
			undelivered.push(displayName(row));
		} else if (dueState === "unknown") {
			deliveryUnknown.push(displayName(row));
		}
		if (deliveredPull) {
			deliveredCount += 1;
			producer.delivered_pr = deliveredPr(deliveredPull);
		} else if (dueState === "delivered" && delivered === false) {
			absent.push(displayName(row));
		}
		producers.push(producer);
	}

	for (const row of skippedRows) {
		const deliveredPull =
			ledger.status === "ok" ? deliveredPullFor(row, ledger) : undefined;
		const delivered =
			ledger.status === "unavailable" ? "unknown" : deliveredPull !== undefined;
		const producer: SummaryRoundProducer = {
			project: row.projectName,
			lead: row.leadId,
			period: row.period,
			disposition: deliveredPull
				? "skipped_but_delivered"
				: "skipped_no_activity",
			delivered,
			due_delivery: "not_issued",
		};
		if (deliveredPull) {
			skippedDeliveredCount += 1;
			producer.delivered_pr = deliveredPr(deliveredPull);
		}
		skipped.push(displayName(row));
		producers.push(producer);
	}

	const lines: string[] = [];
	if (ledger.status === "unavailable") {
		lines.push(
			`本轮交付状态不可得(${safeReason(ledger.reason)}),只报吸收不报缺席。`,
		);
	} else if (absent.length > 0) {
		lines.push(
			`本轮 ${deliveredCount}/${dueRows.length} 份已交;未交:${reportNames(absent)}`,
		);
	} else if (deliveredCount === dueRows.length) {
		lines.push(`本轮 ${dueRows.length}/${dueRows.length} 份已交。`);
	} else {
		lines.push(
			`本轮 ${deliveredCount}/${dueRows.length} 份已交;无人「未交」——差额见下。`,
		);
	}
	if (undelivered.length > 0) {
		lines.push(`未送达(机制问题,已告警):${reportNames(undelivered)}`);
	}
	if (deliveryUnknown.length > 0) {
		lines.push(`送达状态不可得(不计未交):${reportNames(deliveryUnknown)}`);
	}
	if (skipped.length > 0) {
		lines.push(`无变化跳过:${reportNames(skipped)}`);
	}
	const openUnreadCount =
		ledger.status === "ok"
			? ledger.pulls.filter((pull) => pull.state === "OPEN").length
			: undefined;
	if (openUnreadCount) {
		lines.push(`未读 open PR:${openUnreadCount}`);
	}

	return {
		round_ledger: ledger.status,
		roster_count: dueRows.length + skippedRows.length,
		skipped_count: skippedRows.length,
		...(ledger.status === "ok"
			? {
					producer_count: dueRows.length,
					delivered_count: deliveredCount,
					skipped_delivered_count: skippedDeliveredCount,
					open_unread_count: openUnreadCount,
				}
			: {}),
		producers,
		absent: ledger.status === "ok" ? absent : [],
		undelivered,
		delivery_unknown: deliveryUnknown,
		skipped,
		report_line: replaceControls(lines.join(" ")),
	};
}

/** Decide whether the frozen slot contains anything Raya still needs to read. */
export function issueRayaRound(result: SummaryRoundResult): boolean {
	return (
		result.round_ledger === "unavailable" ||
		(result.delivered_count ?? 0) > 0 ||
		(result.skipped_delivered_count ?? 0) > 0 ||
		(result.open_unread_count ?? 0) > 0 ||
		result.undelivered.length > 0 ||
		result.delivery_unknown.length > 0
	);
}
