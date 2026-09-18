import { createHash } from "node:crypto";
import type { BusinessRoundView } from "../business-round.js";
import { parseReportDocument } from "../contracts/daily-report.js";
import { sanitizeDiscordText } from "../formatting/discord-text.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "../operation-store.js";
import { projectDailyReportArtifacts } from "./artifacts.js";
import { reportBlob } from "./repository-round.js";

type Obj = { [key: string]: JsonValue };
const obj = (v: unknown): Obj => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new Error("invalid report reply object");
	return v as Obj;
};
const id = (v: unknown) => typeof v === "string" && /^\d{17,20}$/.test(v);
const hash = (v: unknown) =>
	createHash("sha256").update(JSON.stringify(v)).digest("hex");
function allowed(v: Obj, keys: string[]) {
	if (Object.keys(v).some((key) => !keys.includes(key)))
		throw new Error("unknown report reply fields");
}
export function prepareReportReply(
	store: OperationStore,
	workspace: string,
	input: Obj,
): BusinessRoundView {
	allowed(input, ["schemaVersion", "kind", "founderUserId", "source"]);
	const value = obj(input.source);
	allowed(value, [
		"messageId",
		"channelId",
		"authorId",
		"body",
		"observedAt",
		"replyTo",
	]);
	if (!id(input.founderUserId) || value.authorId !== input.founderUserId)
		throw new Error("report reply founder mismatch");
	if (
		!id(value.messageId) ||
		!id(value.channelId) ||
		typeof value.body !== "string" ||
		!value.body.trim() ||
		Buffer.byteLength(value.body) > 16384 ||
		!Number.isSafeInteger(value.observedAt) ||
		Number(value.observedAt) < 0
	)
		throw new Error("invalid report reply source");
	let reply: Obj | undefined;
	if (value.replyTo !== undefined) {
		reply = obj(value.replyTo);
		allowed(reply, ["messageId", "channelId"]);
		if (!id(reply.messageId) || !id(reply.channelId))
			throw new Error("invalid report replyTo");
	}
	const operationId = `report-reply:${value.channelId}:${value.messageId}`,
		inputDigest = hash(input),
		old = store.read(operationId);
	if (old) {
		if (old.kind !== "report_reply" || old.inputDigest !== inputDigest)
			throw new Error("report reply binding conflict");
		return reportReplyView(old);
	}
	const source = { ...value, body: sanitizeDiscordText(value.body) };
	const dates = [...new Set(value.body.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [])];
	const candidates = store.list().filter((op) => {
		if (op.kind !== "daily_report") return false;
		const material = obj(op.material);
		if (!material.context) return false;
		if (reply) {
			if (
				value.channelId !== material.channelId ||
				reply.channelId !== material.channelId
			)
				return false;
			const receipt = (material.receipts as Obj[]).find(
				(r) =>
					r.tool === "lead_actions.discord_send" &&
					obj(r.result).status === "sent" &&
					obj(r.result).messageId === reply?.messageId &&
					obj(r.result).channelId === reply?.channelId &&
					Number(r.recordedAt) <= Number(value.observedAt),
			);
			const legacyReceipt = Object.values(
				obj(material.legacyDelivery ?? {}),
			).some((item) => {
				const r = obj(item);
				return (
					r.messageId === reply?.messageId &&
					r.channelId === reply?.channelId &&
					Number(r.observedAt) <= Number(value.observedAt)
				);
			});
			return (
				(!!receipt || legacyReceipt) &&
				Object.values(obj(material.messageIds ?? {})).includes(reply.messageId)
			);
		}
		return dates.length === 1 && obj(material.wake).localDate === dates[0];
	});
	let report: Obj | null = null;
	if (candidates.length === 1) {
		const op = projectDailyReportArtifacts(
				store,
				workspace,
				candidates[0] as StoredOperation,
			),
			material = obj(op.material);
		report = { operationId: op.operationId, context: material.context };
	}
	return reportReplyView(
		store.commit(
			{
				operationId,
				kind: "report_reply",
				stage: report ? "awaiting_report_read" : "needs_clarification",
				inputDigest,
				sourceRefs: [`discord:${value.channelId}:${value.messageId}`],
				material: { source, report, receipts: [] },
			},
			0,
		),
	);
}
export function recordReportReply(
	store: OperationStore,
	current: StoredOperation,
	input: Obj,
): BusinessRoundView {
	if (
		input.tool !== "current_turn" ||
		typeof input.callId !== "string" ||
		!input.callId.trim()
	)
		throw new Error("report reply current turn required");
	const result = obj(input.result),
		material = obj(current.material);
	let next: Obj, stage: string;
	if (
		current.stage === "awaiting_report_read" &&
		result.action === "verify_report"
	) {
		allowed(result, ["action", "document", "fileSha"]);
		const context = obj(obj(material.report).context);
		if (
			typeof result.document !== "string" ||
			result.document.length > 512 * 1024 ||
			result.fileSha !== context.fileSha ||
			reportBlob(result.document) !== context.fileSha
		)
			throw new Error("report reply blob mismatch");
		const parsed = parseReportDocument(result.document, {
			date: String(context.date),
		});
		if (parsed.meta.body_sha256 !== context.bodySha256)
			throw new Error("report reply body mismatch");
		next = {
			...material,
			reportBody: parsed.body,
			reportDocument: result.document,
		};
		stage = "discussing";
	} else if (current.stage === "discussing" && result.action === "interpret") {
		allowed(result, ["action", "note"]);
		if (
			typeof result.note !== "string" ||
			!result.note.trim() ||
			Buffer.byteLength(result.note) > 4096
		)
			throw new Error("report feedback note required");
		next = { ...material, note: sanitizeDiscordText(result.note) };
		stage = "complete";
	} else throw new Error("report reply stage mismatch");
	next.receipts = [
		...(material.receipts as JsonValue[]),
		{ tool: input.tool, callId: input.callId, action: result.action },
	];
	return reportReplyView(
		store.commit({ ...current, stage, material: next }, current.revision),
	);
}
export function reportReplyView(current: StoredOperation): BusinessRoundView {
	const material = obj(current.material);
	let args: Obj | null = null;
	if (current.stage === "awaiting_report_read") {
		const context = obj(obj(material.report).context);
		args = {
			action: "read_report",
			repo: context.repo,
			path: context.path,
			fileSha: context.fileSha,
			bodySha256: context.bodySha256,
			instructions:
				"Read this exact repository Git blob with standard tools, then record verify_report with its full document and fileSha.",
		};
	} else if (current.stage === "discussing")
		args = {
			action: "discuss_report",
			source: material.source,
			reportBody: material.reportBody,
			instructions:
				"Record interpret with a faithful note; discuss using this source. If a goal update is warranted, use goal_update with the original platform source identity. This feedback record itself creates no commitment.",
		};
	else if (current.stage === "needs_clarification")
		args = {
			action: "clarify_report",
			eventId: `clarify:${current.operationId}`,
			source: material.source,
			instructions:
				"Use a durable announcement with this stable eventId and reply operation in sourceRefs to ask naturally which report she means. Resume that same announcement on replay; do not send another clarification. Do not associate the latest report by default. Process her clarification as its own actual source message.",
		};
	return {
		schemaVersion: 2,
		operationId: current.operationId,
		revision: current.revision,
		stage: current.stage,
		next: args ? { tool: "current_turn", arguments: args } : null,
		needsReconciliation: false,
		receipts: material.receipts as Obj[],
		material,
	};
}
