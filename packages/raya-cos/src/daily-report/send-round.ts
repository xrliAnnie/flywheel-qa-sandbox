import { createHash } from "node:crypto";
import type { BusinessRoundView } from "../business-round.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "../operation-store.js";
import { dailyReportView } from "./round.js";

type Obj = { [key: string]: JsonValue };
const obj = (v: unknown): Obj => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new Error("invalid report send object");
	return v as Obj;
};
const id = (v: unknown) => typeof v === "string" && /^\d{17,20}$/.test(v);
/** One shared CAS ledger reserves attempts across dates before any send intention. */
function reserve(store: OperationStore, now: number): number | null {
	const key = "daily-report:send-budget",
		old = store.read(key);
	if (old && old.kind !== "report_send_budget")
		throw new Error("report budget identity conflict");
	const times = old
		? (obj(old.material).times as number[]).filter((at) => at > now - 60000)
		: [];
	if (times.length >= 4) return Math.min(...times) + 60000;
	store.commit(
		{
			operationId: key,
			kind: "report_send_budget",
			stage: "complete",
			sourceRefs: ["daily-report"],
			inputDigest: createHash("sha256")
				.update("daily-report-send-budget-v1")
				.digest("hex"),
			material: { times: [...times, now] },
		},
		old?.revision ?? 0,
	);
	return null;
}
export function recordReportSend(
	store: OperationStore,
	current: StoredOperation,
	input: Obj,
	now: number,
): BusinessRoundView {
	const material = obj(current.material),
		result = obj(input.result),
		chunks = obj(material.context).chunks as Obj[];
	if (typeof input.callId !== "string" || !input.callId.trim())
		throw new Error("report send call identity required");
	if (input.tool === "current_turn") {
		if (
			Object.keys(result).length !== 1 ||
			result.action !== "begin_send" ||
			!["context_ready", "posting"].includes(current.stage)
		)
			throw new Error("report cannot start another send");
		const deadline = Number(material.nextAttemptAt ?? 0);
		let wait = deadline > now ? deadline : null;
		if (wait === null) wait = reserve(store, now);
		if (wait !== null) {
			const held = store.commit(
				{ ...current, material: { ...material, nextAttemptAt: wait } },
				current.revision,
			);
			return dailyReportView(held, now);
		}
		const messages = obj(material.messageIds ?? {});
		const chunk = chunks.find((c) => messages[String(c.index)] === undefined);
		if (!chunk) throw new Error("report has no remaining chunk");
		const next = {
			...material,
			inFlight: {
				index: chunk.index,
				eventId: chunk.eventId,
				attemptedAt: now,
			},
			nextAttemptAt: null,
		};
		const stored = store.commit(
			{ ...current, stage: "sending", material: next },
			current.revision,
		);
		return {
			...dailyReportView(stored, now),
			needsReconciliation: false,
			next: {
				tool: "lead_actions.discord_send",
				arguments: { target: "chat", eventId: chunk.eventId, text: chunk.text },
			},
		};
	}
	if (
		input.tool !== "lead_actions.discord_send" ||
		!["sending", "send_unknown"].includes(current.stage)
	)
		throw new Error("report send receipt not expected");
	const flight = obj(material.inFlight),
		chunk = chunks[Number(flight.index)];
	if (
		!chunk ||
		result.project !== "raya" ||
		result.leadId !== "raya" ||
		result.target !== "chat" ||
		result.eventId !== chunk.eventId
	)
		throw new Error("report send receipt binding mismatch");
	if (
		![
			"sent",
			"ambiguous",
			"pending",
			"rate_limited",
			"unavailable",
			"rejected",
		].includes(String(result.status))
	)
		throw new Error("invalid report send status");
	let stage = "posting",
		next: Obj = { ...material };
	if (result.status === "sent") {
		if (!id(result.messageId) || !id(result.channelId))
			throw new Error("report sent receipt lacks message identity");
		if (
			material.channelId !== undefined &&
			material.channelId !== result.channelId
		)
			throw new Error("report channel changed");
		const messages = obj(material.messageIds ?? {});
		if (Object.values(messages).includes(result.messageId))
			throw new Error("report chunk reused another message");
		next = {
			...next,
			messageIds: { ...messages, [String(chunk.index)]: result.messageId },
			channelId: result.channelId,
			inFlight: null,
			nextAttemptAt: null,
		};
		if (Object.keys(obj(next.messageIds)).length === chunks.length)
			stage = "posted";
	} else if (
		current.stage === "send_unknown" ||
		result.status === "ambiguous" ||
		result.status === "pending"
	) {
		stage = "send_unknown";
	} else {
		next.inFlight = null;
		if (result.status === "rate_limited") {
			if (
				!Number.isSafeInteger(result.retryAfterMs) ||
				Number(result.retryAfterMs) <= 0 ||
				!Number.isSafeInteger(now + Number(result.retryAfterMs))
			)
				throw new Error("invalid report retry deadline");
			next.nextAttemptAt = now + Number(result.retryAfterMs);
		} else next.nextAttemptAt = now + 60000;
	}
	next.receipts = [
		...(material.receipts as JsonValue[]),
		{
			tool: input.tool,
			callId: input.callId,
			recordedAt: now,
			index: chunk.index,
			result: {
				project: "raya",
				leadId: "raya",
				target: "chat",
				eventId: result.eventId,
				status: result.status,
				...(result.messageId === undefined
					? {}
					: { messageId: result.messageId }),
				...(result.channelId === undefined
					? {}
					: { channelId: result.channelId }),
				...(result.retryAfterMs === undefined
					? {}
					: { retryAfterMs: result.retryAfterMs }),
			},
		},
	];
	return dailyReportView(
		store.commit({ ...current, stage, material: next }, current.revision),
		now,
	);
}
