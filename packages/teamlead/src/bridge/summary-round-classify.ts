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

export type DueDelivery = "delivered" | "undelivered" | "unknown";

export interface SummaryRoundProducer {
	project: string;
	lead: string;
	delivered: boolean | "unknown";
	due_delivery: DueDelivery;
	delivered_pr?: Pick<SummaryPull, "number" | "url" | "state">;
}

export interface SummaryRoundResult {
	round_ledger: "ok" | "unavailable";
	producer_count?: number;
	delivered_count?: number;
	producers: SummaryRoundProducer[];
	absent: string[];
	undelivered: string[];
	delivery_unknown: string[];
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
	ledger: SummaryLedgerResult,
	settlements: ReadonlyMap<string, InspectedSettlement>,
): SummaryRoundResult {
	const leadCounts = new Map<string, number>();
	for (const row of dueRows) {
		leadCounts.set(row.leadId, (leadCounts.get(row.leadId) ?? 0) + 1);
	}
	const displayName = (row: SummaryDueRoundRow) =>
		(leadCounts.get(row.leadId) ?? 0) > 1
			? `${row.projectName}/${row.leadId}`
			: row.leadId;

	const absent: string[] = [];
	const undelivered: string[] = [];
	const deliveryUnknown: string[] = [];
	const producers: SummaryRoundProducer[] = [];
	let deliveredCount = 0;

	for (const row of dueRows) {
		const dueState = dueDelivery(
			settlements.get(producerKey(row)) ?? "unknown",
		);
		const expectedBranch = summaryDeliveryBranch({
			project: row.projectName,
			author: row.leadId,
			period: row.period,
		});
		const deliveredPull =
			ledger.status === "ok"
				? ledger.pulls.find((pull) => pull.headRefName === expectedBranch)
				: undefined;
		const delivered =
			ledger.status === "unavailable" ? "unknown" : deliveredPull !== undefined;
		const producer: SummaryRoundProducer = {
			project: row.projectName,
			lead: row.leadId,
			delivered,
			due_delivery: dueState,
		};
		if (deliveredPull) {
			deliveredCount += 1;
			producer.delivered_pr = {
				number: deliveredPull.number,
				url: deliveredPull.url,
				state: deliveredPull.state,
			};
		} else if (dueState === "undelivered") {
			undelivered.push(displayName(row));
		} else if (dueState === "unknown") {
			deliveryUnknown.push(displayName(row));
		} else if (delivered === false) {
			absent.push(displayName(row));
		}
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

	return {
		round_ledger: ledger.status,
		...(ledger.status === "ok"
			? {
					producer_count: dueRows.length,
					delivered_count: deliveredCount,
				}
			: {}),
		producers,
		absent: ledger.status === "ok" ? absent : [],
		undelivered,
		delivery_unknown: deliveryUnknown,
		report_line: replaceControls(lines.join(" ")),
	};
}
