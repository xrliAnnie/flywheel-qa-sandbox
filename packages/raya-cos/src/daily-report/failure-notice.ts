import type { BusinessRoundView } from "../business-round.js";
import { sanitizeDiscordText } from "../formatting/discord-text.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "../operation-store.js";
import { dailyReportEventId } from "./delivery.js";
import { dailyReportView } from "./round.js";

type Obj = { [key: string]: JsonValue };
const obj = (value: unknown): Obj => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid report failure object");
	return value as Obj;
};
export function recordReportFailure(
	store: OperationStore,
	current: StoredOperation,
	input: Obj,
	now: number,
): BusinessRoundView {
	const material = obj(current.material),
		result = obj(input.result);
	if (
		input.tool !== "current_turn" ||
		typeof input.callId !== "string" ||
		!input.callId.trim()
	)
		throw new Error("report failure current turn required");
	let next: Obj, noticeInput: Obj | undefined;
	if (result.action === "failure") {
		if (
			material.legacyMigration &&
			["failed", "failed_pending_notice"].includes(
				String(obj(obj(material.legacyMigration).state).status),
			)
		)
			throw new Error(
				"legacy failure notice requires its original recovery flow",
			);
		if (current.stage === "posted")
			throw new Error("posted report cannot create a failure notice");
		if (
			Object.keys(result).some(
				(k) => !["action", "reason", "sourceRef"].includes(k),
			) ||
			typeof result.reason !== "string" ||
			!result.reason.trim() ||
			result.reason.length > 1000 ||
			typeof result.sourceRef !== "string" ||
			!result.sourceRef.trim() ||
			result.sourceRef.length > 500
		)
			throw new Error("report failure evidence required");
		const failure = {
			stage: current.stage,
			reason: sanitizeDiscordText(result.reason),
			sourceRef: sanitizeDiscordText(result.sourceRef),
			at: now,
		};
		let notice =
			material.failureNotice === undefined
				? undefined
				: obj(material.failureNotice);
		if (!notice) {
			const date = String(obj(material.wake).localDate),
				eventId = dailyReportEventId(
					date,
					typeof material.fileSha === "string"
						? material.fileSha
						: "0".repeat(40),
					"notice",
					0,
				);
			const text = `⚠️ ${date} 的日报暂未完成：${failure.reason}\n我会保留当前进度并继续恢复。${typeof material.fileSha === "string" ? `\n仓内日报：https://github.com/xrliAnnie/raya/blob/main/reports/${date}.md` : ""}`;
			notice = {
				status: "pending",
				input: {
					schemaVersion: 2,
					kind: "announcement",
					operationId: `report-notice:${date}`,
					sourceRefs: [current.operationId],
					eventId,
					target: "chat",
					text,
				},
			};
		}
		next = { ...material, failure, failureNotice: notice };
		if (notice.status !== "sent") noticeInput = obj(notice.input);
	} else if (result.action === "confirm_failure_notice") {
		if (
			Object.keys(result).some(
				(k) => !["action", "noticeOperationId"].includes(k),
			)
		)
			throw new Error("invalid notice confirmation");
		const notice = obj(material.failureNotice),
			expected = obj(notice.input);
		if (result.noticeOperationId !== expected.operationId)
			throw new Error("notice operation binding mismatch");
		const announcement = store.read(String(result.noticeOperationId));
		if (
			!announcement ||
			announcement.kind !== "announcement" ||
			announcement.stage !== "complete" ||
			!announcement.sourceRefs.includes(current.operationId)
		)
			throw new Error("notice not confirmed");
		const am = obj(announcement.material),
			prepared = obj(am.prepared),
			payload = obj(prepared.payload);
		if (
			payload.eventId !== expected.eventId ||
			payload.target !== "chat" ||
			payload.text !== expected.text ||
			!(am.receipts as Obj[]).some(
				(r) =>
					r.tool === "lead_actions.discord_send" &&
					obj(r.result).status === "sent" &&
					obj(r.result).eventId === expected.eventId &&
					obj(r.result).messageId === am.messageId,
			)
		)
			throw new Error("notice not confirmed with expected payload");
		next = {
			...material,
			failureNotice: {
				...notice,
				status: "sent",
				messageId: am.messageId,
				channelId: am.channelId,
			},
		};
	} else throw new Error("unsupported report failure decision");
	next.receipts = [
		...(material.receipts as JsonValue[]),
		{
			tool: input.tool,
			callId: input.callId,
			action: result.action,
			recordedAt: now,
			...(result.action === "failure"
				? { failure: next.failure }
				: { noticeOperationId: result.noticeOperationId }),
		},
	];
	const view = dailyReportView(
		store.commit(
			{
				...current,
				material: next,
				stage:
					result.action === "confirm_failure_notice" &&
					material.legacyMigration &&
					obj(obj(material.legacyMigration).state).status ===
						"failed_pending_notice"
						? "failed"
						: current.stage,
			},
			current.revision,
		),
		now,
	);
	return noticeInput
		? {
				...view,
				next: {
					tool: "current_turn",
					arguments: {
						action: "prepare_failure_notice",
						input: noticeInput,
						instructions:
							"Prepare or resume this exact announcement and record the standard tool result there. Confirm only after its sent receipt. Continue the report's saved stage independently; unknown notice delivery never permits another eventId.",
					},
				},
			}
		: view;
}
