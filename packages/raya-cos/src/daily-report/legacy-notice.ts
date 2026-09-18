import { createHash } from "node:crypto";
import { sanitizeDiscordText } from "../formatting/discord-text.js";
import type { JsonValue } from "../operation-store.js";
import { dailyReportEventId } from "./delivery.js";

type Obj = { [key: string]: JsonValue };
const obj = (v: JsonValue): Obj => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new Error("invalid legacy notice object");
	return v;
};
export function legacyNoticeText(state: Obj): string {
	if (state.failStage === "write")
		return `⚠️ 今天的 Report 没写入：${state.failCategory ?? "unknown"}`;
	if (state.failStage === "deliver")
		return `⚠️ 今天的 Report 未完整投递(${Object.keys(obj(state.messageIds ?? {})).length}/${state.chunkPlan ? (obj(state.chunkPlan).chunks as JsonValue[]).length : 0})，全文见 https://github.com/xrliAnnie/raya/blob/main/reports/${state.date}.md`;
	return `⚠️ 今天的 Report 没生成：${state.failCategory ?? "unknown"}`;
}
export function reconcileLegacyNotice(
	stage: string,
	material: Obj,
	result: Obj,
	now: number,
): { stage: string; material: Obj } {
	const legacy = obj(material.legacyMigration),
		state = obj(legacy.state),
		notice = obj(state.failedNotice ?? {});
	if (
		stage !== "legacy_reconciliation" ||
		state.status !== "failed_pending_notice"
	)
		throw new Error("legacy notice stage mismatch");
	if (
		Object.keys(result).some(
			(key) => !["action", "identity", "message"].includes(key),
		)
	)
		throw new Error("invalid notice fields");
	const identity = obj(result.identity),
		message = obj(result.message),
		author = obj(message.author);
	const id = (v: JsonValue) => typeof v === "string" && /^\d{17,20}$/.test(v);
	if (
		Object.keys(identity).length !== 4 ||
		identity.project !== "raya" ||
		identity.leadId !== "raya" ||
		!id(identity.botUserId) ||
		!id(identity.channelId) ||
		!id(message.id) ||
		message.channel_id !== identity.channelId ||
		author.id !== identity.botUserId ||
		author.bot !== true
	)
		throw new Error("legacy notice identity mismatch");
	if (message.content !== legacyNoticeText(state))
		throw new Error("legacy notice content mismatch");
	const nonce = createHash("sha256")
		.update(
			`daily-report:${legacy.date}:${state.fileSha ?? "0".repeat(40)}:notice:0`,
		)
		.digest("hex")
		.slice(0, 25);
	if (
		notice.messageId !== undefined
			? message.id !== notice.messageId
			: message.nonce !== nonce
	)
		throw new Error("legacy notice receipt mismatch");
	return {
		stage: "failed",
		material: {
			...material,
			legacyFailureNotice: {
				status: "sent",
				messageId: message.id,
				channelId: identity.channelId,
				authorId: identity.botUserId,
				contentSha256: createHash("sha256")
					.update(String(message.content))
					.digest("hex"),
				observedAt: now,
			},
		},
	};
}

export function prepareLegacyNotice(
	stage: string,
	material: Obj,
	result: Obj,
): { stage: string; material: Obj } {
	const state = obj(obj(material.legacyMigration).state),
		notice = obj(state.failedNotice ?? {});
	if (
		stage !== "legacy_reconciliation" ||
		state.status !== "failed_pending_notice" ||
		Object.keys(result).length !== 1
	)
		throw new Error("legacy notice prepare stage mismatch");
	if (
		Number(notice.attempts ?? 0) !== 0 ||
		notice.inFlight ||
		notice.result ||
		notice.messageId
	)
		throw new Error(
			"legacy notice already attempted; reconcile actual message",
		);
	if (material.failureNotice) return { stage, material };
	const text = legacyNoticeText(state);
	if (sanitizeDiscordText(text) !== text)
		throw new Error("unsafe legacy notice text");
	return {
		stage,
		material: {
			...material,
			failureNotice: {
				status: "pending",
				input: {
					schemaVersion: 2,
					kind: "announcement",
					operationId: `report-notice:${state.date}`,
					sourceRefs: [`daily-report:${state.date}`],
					target: "chat",
					text,
					eventId: dailyReportEventId(
						String(state.date),
						String(state.fileSha ?? "0".repeat(40)),
						"notice",
						0,
					),
				},
			},
		},
	};
}
