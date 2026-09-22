import type { JsonValue } from "./operation-store.js";

type Obj = { [key: string]: JsonValue };
const obj = (value: unknown): Obj => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid question object");
	return value as Obj;
};
const str = (value: unknown): string => {
	if (typeof value !== "string" || !value.trim())
		throw new Error("invalid question text");
	return value;
};
const id = (value: unknown): boolean =>
	typeof value === "string" && /^\d{17,20}$/.test(value);
export function prepareQuestionIntent(
	input: Obj,
	now: number,
): { payload: Obj; question: Obj } {
	if (
		Object.keys(input).some(
			(key) =>
				![
					"schemaVersion",
					"operationId",
					"kind",
					"sourceRefs",
					"requestId",
					"requestRevision",
					"to",
					"body",
					"expiresAt",
					"directory",
				].includes(key),
		)
	)
		throw new Error("unknown question input field");
	const requestId = str(input.requestId);
	if (
		requestId.length > 150 ||
		!Number.isSafeInteger(input.requestRevision) ||
		Number(input.requestRevision) < 1
	)
		throw new Error("invalid request revision or identity");
	if (!Number.isSafeInteger(input.expiresAt) || Number(input.expiresAt) <= 0)
		throw new Error("invalid question expiry");
	const directory = obj(input.directory),
		to = obj(input.to);
	if (
		!/^[a-f0-9]{64}$/.test(str(directory.projectsDigest)) ||
		!Array.isArray(directory.leads)
	)
		throw new Error("invalid directory snapshot");
	const candidates = directory.leads.map(obj).filter((row) => {
		const ref = obj(row.ref);
		return ref.project === to.project && ref.leadId === to.leadId;
	});
	if (candidates.length !== 1)
		throw new Error("question target missing or ambiguous");
	const lead = candidates[0];
	if (
		!lead ||
		lead.external !== false ||
		!id(lead.botUserId) ||
		!id(lead.roundtableChannel)
	)
		throw new Error(
			"question target is not a configured roundtable participant",
		);
	if (!Array.isArray(input.sourceRefs) || !input.sourceRefs.length)
		throw new Error("question source required");
	const body = str(input.body);
	const text = `${str(lead.displayName)} <@${lead.botUserId}>\nrequestId: ${requestId}; revision: ${input.requestRevision}\n来源: ${input.sourceRefs.map(str).join(", ")}\n${body}\n请回复本话题并点名 Raya。`;
	if (text.length > 1800)
		throw new Error("question exceeds announcement limit");
	return {
		payload: {
			target: "roundtable",
			text,
			eventId: `question:${requestId}:${input.requestRevision}`,
		},
		question: {
			requestId,
			requestRevision: input.requestRevision,
			to: { project: str(to.project), leadId: str(to.leadId) },
			botUserId: lead.botUserId,
			parentChannelId: lead.roundtableChannel,
			projectsDigest: directory.projectsDigest,
			body,
			expiresAt: input.expiresAt,
			preparedAt: now,
		},
	};
}
export function observeQuestionReply(
	question: Obj,
	material: Obj,
	result: Obj,
): { late: boolean } {
	if (result.authorId !== question.botUserId)
		throw new Error("reply author does not match recipient");
	if (!id(result.messageId) || !id(material.messageId))
		throw new Error("reply message identity missing");
	if (
		result.channelId !== material.messageId &&
		result.channelId !== question.parentChannelId
	)
		throw new Error("reply channel is outside question topic");
	const reply = result.replyTo === undefined ? undefined : obj(result.replyTo);
	const quoted =
		reply?.messageId === material.messageId &&
		(reply?.channelId === question.parentChannelId ||
			reply?.channelId === material.messageId);
	const exact =
		result.requestId === question.requestId &&
		result.requestRevision === question.requestRevision;
	if (!quoted && !exact) throw new Error("reply correlation missing or stale");
	str(result.body);
	if (
		!Number.isSafeInteger(result.observedAt) ||
		Number(result.observedAt) < Number(question.preparedAt)
	)
		throw new Error("invalid reply observation time");
	return { late: Number(result.observedAt) > Number(question.expiresAt) };
}

/** A tentative message identifier alone is not confirmation of an external send. */
export function hasConfirmedQuestionSend(material: Obj): boolean {
	if (
		!Array.isArray(material.receipts) ||
		!id(material.messageId) ||
		!id(material.channelId)
	)
		return false;
	const prepared = obj(material.prepared);
	return material.receipts.map(obj).some((receipt) => {
		if (receipt.tool !== "lead_actions.discord_send") return false;
		const result = obj(receipt.result);
		return (
			(result.status === "sent" || result.sendStatus === "sent") &&
			result.messageId === material.messageId &&
			result.channelId === material.channelId &&
			result.eventId === prepared.eventId
		);
	});
}
