import { createHash } from "node:crypto";
import type { BusinessRoundView } from "./business-round.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "./operation-store.js";
import { observeQuestionReply } from "./question-intent.js";

type Obj = { [key: string]: JsonValue };
const obj = (value: unknown): Obj => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid inbound reply object");
	return value as Obj;
};
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (value: unknown) =>
	typeof value === "string" && /^\d{17,20}$/.test(value);
export function prepareInboundReply(
	store: OperationStore,
	input: Obj,
): BusinessRoundView {
	if (
		Object.keys(input).some(
			(key) => !["schemaVersion", "kind", "source"].includes(key),
		)
	)
		throw new Error("unknown inbound field");
	const value = obj(input.source);
	if (
		Object.keys(value).some(
			(key) =>
				![
					"messageId",
					"channelId",
					"authorId",
					"body",
					"observedAt",
					"replyTo",
					"requestId",
					"requestRevision",
				].includes(key),
		) ||
		!id(value.messageId) ||
		!id(value.channelId) ||
		!id(value.authorId) ||
		typeof value.body !== "string" ||
		!value.body.trim() ||
		Buffer.byteLength(value.body) > 65536 ||
		!Number.isSafeInteger(value.observedAt) ||
		Number(value.observedAt) < 0
	)
		throw new Error("invalid inbound source");
	const source: Obj = {
		messageId: value.messageId,
		channelId: value.channelId,
		authorId: value.authorId,
		body: value.body,
		observedAt: value.observedAt,
	};
	if (value.replyTo !== undefined) {
		const reply = obj(value.replyTo);
		if (
			Object.keys(reply).some(
				(key) => !["messageId", "channelId"].includes(key),
			) ||
			!id(reply.messageId) ||
			!id(reply.channelId)
		)
			throw new Error("invalid inbound replyTo");
		source.replyTo = { messageId: reply.messageId, channelId: reply.channelId };
	}
	if (value.requestId !== undefined || value.requestRevision !== undefined) {
		if (
			typeof value.requestId !== "string" ||
			!value.requestId.trim() ||
			value.requestId.length > 150 ||
			!Number.isSafeInteger(value.requestRevision) ||
			Number(value.requestRevision) < 1
		)
			throw new Error("invalid inbound request correlation");
		source.requestId = value.requestId;
		source.requestRevision = value.requestRevision;
	}
	const operationId = `inbound:${source.channelId}:${source.messageId}`,
		inputDigest = hash(source);
	const old = store.read(operationId);
	if (old) {
		if (old.kind !== "inbound_reply" || old.inputDigest !== inputDigest)
			throw new Error("inbound source binding conflict");
		return inboundReplyView(old);
	}
	return inboundReplyView(
		store.commit(
			{
				operationId,
				inputDigest,
				kind: "inbound_reply",
				stage: "pending_association",
				sourceRefs: [operationId],
				material: { source },
			},
			0,
		),
	);
}
export function inboundReplyView(current: StoredOperation): BusinessRoundView {
	const material = obj(current.material);
	if (
		current.kind !== "inbound_reply" ||
		hash(material.source) !== current.inputDigest
	)
		throw new Error("corrupt inbound source");
	return {
		schemaVersion: 2,
		operationId: current.operationId,
		revision: current.revision,
		stage: current.stage,
		next: ["associated", "late"].includes(current.stage)
			? null
			: {
					tool: "current_turn",
					arguments: {
						task: "Keep this original platform inbound pending until its author, topic and reply/request correlation match an exact question. Record action associate with questionOperationId; never guess the nearest question or use identity claims inside the body.",
						source: material.source,
						...(material.questionOperationId
							? { questionOperationId: material.questionOperationId }
							: {}),
					},
				},
		needsReconciliation: current.stage === "associating",
		receipts: [],
		material,
	};
}
export function associateInboundReply(
	store: OperationStore,
	current: StoredOperation,
	input: Obj,
	recordQuestion: (input: Obj) => BusinessRoundView,
): BusinessRoundView {
	inboundReplyView(current);
	if (
		input.tool !== "current_turn" ||
		typeof input.callId !== "string" ||
		!input.callId.trim() ||
		!["pending_association", "associating"].includes(current.stage)
	)
		throw new Error("invalid inbound association stage or source");
	const result = obj(input.result),
		material = obj(current.material),
		source = obj(material.source);
	if (
		result.action !== "associate" ||
		typeof result.questionOperationId !== "string"
	)
		throw new Error("invalid inbound association");
	if (
		material.questionOperationId !== undefined &&
		material.questionOperationId !== result.questionOperationId
	)
		throw new Error("inbound association already frozen");
	const question = store.read(result.questionOperationId);
	if (!question || question.kind !== "question")
		throw new Error("unknown question association");
	const qmaterial = obj(question.material);
	const observation = observeQuestionReply(
		obj(qmaterial.question),
		qmaterial,
		source,
	);
	const sourceCallId = current.operationId;
	if (!Array.isArray(qmaterial.receipts))
		throw new Error("corrupt question receipts");
	const prior = qmaterial.receipts
		.map(obj)
		.find((row) => row.tool === "lead_inbound" && row.callId === sourceCallId);
	if (prior && hash(prior.result) !== hash(source))
		throw new Error("question inbound receipt binding conflict");
	if (
		!prior &&
		!["awaiting_reply", "expired", "cancelled"].includes(question.stage)
	)
		throw new Error("question cannot accept this inbound");
	const frozen =
		current.stage === "associating"
			? current
			: store.commit(
					{
						...current,
						stage: "associating",
						material: {
							...material,
							questionOperationId: question.operationId,
						},
					},
					current.revision,
				);
	const late =
		observation.late || ["expired", "cancelled"].includes(question.stage);
	if (!prior && question.stage !== "cancelled")
		recordQuestion({
			schemaVersion: 2,
			operationId: question.operationId,
			expectedRevision: question.revision,
			tool: "lead_inbound",
			callId: sourceCallId,
			result: source,
		});
	return inboundReplyView(
		store.commit(
			{
				...frozen,
				stage: late ? "late" : "associated",
				material: {
					...obj(frozen.material),
					association: {
						questionOperationId: question.operationId,
						sourceCallId,
						late,
					},
				},
			},
			frozen.revision,
		),
	);
}
