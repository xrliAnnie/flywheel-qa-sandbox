import type {
	LeadAuditSummaryReceipt,
	MailboxQueue,
} from "flywheel-comm/mailbox-queue";
import type { StateStore } from "../StateStore.js";
import { storeLeadTokenSavingsEnabled } from "./flag-store-runtime.js";
import type { NotificationAuditStore } from "./notification-audit-store.js";

type Snapshot = ReturnType<NotificationAuditStore["snapshot"]>;
type SummaryStore = Pick<
	StateStore,
	"getFlagValueRow" | "getNotificationAuditGeneration" | "readLeadAuditSummary"
>;
const escapeSummaryText = (value: unknown) =>
	String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
const clip = (value: unknown, limit: number) =>
	[...String(value ?? "")].slice(0, limit).join("");

export function formatLeadAuditSummary(
	data: Snapshot,
	scope: { projectName: string; leadId: string },
): string {
	if (data.total === 0) return "";
	const kinds = [
		"stage_changed",
		"session_started",
		"session_monitoring_reestablished",
		"workflow_replacement_eligibility",
	];
	const category = kinds
		.map((kind) => `${kind}=${data.counts[kind] ?? 0}`)
		.join(", ");
	const other = Object.entries(data.counts).reduce(
		(sum, [kind, count]) => sum + (kinds.includes(kind) ? 0 : count),
		0,
	);
	const link = `/api/bootstrap/${encodeURIComponent(scope.leadId)}/audit-events?afterSeq=${data.fromSeq}&throughSeq=${data.throughSeq}&storeEpoch=${encodeURIComponent(data.generation)}&limit=50`;
	const header = `以下为只读账目概览，不要求逐条回复，不属于上方消息正文。\n${category}, other=${other}${data.recovered ? "\n账本恢复后可能重复。" : ""}`;
	const candidates = data.representatives.slice(0, 8).map((row) => {
		const payload = JSON.parse(row.payload) as Record<string, unknown>;
		// Execution IDs are exact; overlong representatives are omitted as a whole.
		return `- ${escapeSummaryText(clip(row.event_type, 64))} execution=${escapeSummaryText(payload.execution_id ?? "unknown")} event=${escapeSummaryText(row.event_id)} ${escapeSummaryText(clip(payload.stage ?? payload.status ?? "", 48))} ${escapeSummaryText(clip(payload.title, 120))}`;
	});
	const lines: string[] = [];
	const render = () =>
		`${header}\ntotal=${data.total}; representatives=${lines.length}; omittedCount=${data.total - lines.length}\n${lines.join("\n")}\n完整范围（需 master 凭证）：${link}`;
	for (const candidate of candidates) {
		lines.push(candidate);
		if ([...render()].length > 2000) lines.pop();
	}
	const content = render();
	if ([...content].length > 2000)
		throw new Error("audit_summary_header_too_large");
	return content;
}

/** Called only after a real, nonempty inbox batch is leased. Never schedules work. */
export function buildLeadAuditSummaryOffer(input: {
	store: SummaryStore;
	queue: MailboxQueue;
	projectName: string;
	leadId: string;
	ownerEpoch: string;
	batchId: string;
	transportBatchId: string;
	memberIds: readonly string[];
	canBuildSummary: boolean;
	now: string;
}): { content: string; receipt: LeadAuditSummaryReceipt } | undefined {
	const { queue } = input;
	if (!queue.isCurrentOwner(input.ownerEpoch, input.now))
		throw new Error("audit summary owner fence lost");
	const receiptFor = (storeEpoch: string): LeadAuditSummaryReceipt => ({
		projectName: input.projectName,
		leadId: input.leadId,
		storeEpoch,
		transportBatchId: input.transportBatchId,
		memberIds: input.memberIds,
	});
	const frozen = queue.getLeadAuditSummaryOffer(input);
	if (frozen)
		return { content: frozen.content, receipt: receiptFor(frozen.storeEpoch) };
	const freezeEmpty = () => {
		const offer = queue.freezeLeadAuditSummaryOffer({
			...input,
			storeEpoch: "unavailable",
			fromSeq: 0,
			throughSeq: 0,
			anchorEventId: null,
			content: "",
		});
		if (!offer) throw new Error("audit summary empty offer not frozen");
		return { content: offer.content, receipt: receiptFor(offer.storeEpoch) };
	};
	// OFF must pin empty bytes too: enabling between attempts cannot change an
	// already accepted payload. Older binaries left no offer, so an unfrozen
	// resumed batch also keeps its original, attachment-free transport bytes.
	if (
		!input.canBuildSummary ||
		!storeLeadTokenSavingsEnabled({ store: input.store }, input.projectName)
	)
		return freezeEmpty();
	let generation: ReturnType<SummaryStore["getNotificationAuditGeneration"]>;
	try {
		generation = input.store.getNotificationAuditGeneration();
	} catch {
		return freezeEmpty();
	}
	const cursor = queue.getLeadAuditSummaryCursor({
		...input,
		storeEpoch: generation.generation,
	});
	let snapshot: Snapshot, content: string;
	try {
		snapshot = input.store.readLeadAuditSummary(
			{ projectName: input.projectName, leadId: input.leadId },
			cursor,
		);
		content = formatLeadAuditSummary(snapshot, input);
	} catch {
		return freezeEmpty();
	}
	const initialized = queue.initializeLeadAuditSummaryCursor({
		...input,
		storeEpoch: snapshot.generation,
		throughSeq: snapshot.startSeq,
		anchorEventId: snapshot.startEventId,
	});
	if (!initialized) throw new Error("audit summary cursor owner fence lost");
	const offer = queue.freezeLeadAuditSummaryOffer({
		...input,
		storeEpoch: snapshot.generation,
		fromSeq: snapshot.fromSeq,
		throughSeq: snapshot.throughSeq,
		anchorEventId: snapshot.anchorEventId,
		content,
	});
	if (!offer) throw new Error("audit summary offer not frozen");
	return { content: offer.content, receipt: receiptFor(offer.storeEpoch) };
}
