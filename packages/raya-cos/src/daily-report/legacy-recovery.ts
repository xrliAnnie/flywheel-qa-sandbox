import { createHash } from "node:crypto";
import {
	parseReportDocument,
	type ReportSilent,
	type ReportSource,
	serializeReportDocument,
} from "../contracts/daily-report.js";
import { sanitizeDiscordText } from "../formatting/discord-text.js";
import type { JsonValue, OperationStore } from "../operation-store.js";
import { assertDailyReportBody } from "./generator.js";
import { recordReportRepository } from "./repository-round.js";

type Obj = { [key: string]: JsonValue };
function obj(v: JsonValue): Obj {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new Error("invalid legacy recovery object");
	return v;
}
export function reconcileLegacyRepository(
	stage: string,
	material: Obj,
	result: Obj,
): { stage: string; material: Obj } {
	const legacy = obj(material.legacyMigration),
		state = obj(legacy.state);
	if (
		legacy.repositoryConfirmed ||
		!["legacy_reconciliation", "posted"].includes(stage)
	)
		throw new Error("legacy repository already reconciled");
	if (
		result.repo !== "xrliAnnie/raya" ||
		result.ref !== "main" ||
		result.path !== `reports/${legacy.date}.md`
	)
		throw new Error("legacy repository binding mismatch");
	if (result.status === "absent" || result.status === "unknown") {
		if (
			Object.keys(result).some(
				(key) => !["action", "repo", "ref", "path", "status"].includes(key),
			)
		)
			throw new Error("invalid legacy repository observation fields");
		return {
			stage,
			material: {
				...material,
				legacyMigration: { ...legacy, repositoryObservation: result.status },
			},
		};
	}
	if (result.status !== "exists" || typeof result.document !== "string")
		throw new Error("legacy recovery requires an existing repository document");
	const parsed = parseReportDocument(result.document, {
		date: String(legacy.date),
	});
	if (
		["posting", "posted", "posted_unknown"].includes(String(state.status)) &&
		typeof state.fileSha === "string" &&
		state.fileSha !== result.fileSha
	)
		throw new Error("legacy delivered blob binding changed");
	const updated = recordReportRepository(
		"reconciling_file",
		{
			...material,
			document: result.document,
			wake: {
				localDate: legacy.date,
				timezone: parsed.meta.timezone,
				origin: "legacy_report_metadata",
			},
		},
		{ ...result, action: "probe" },
	);
	const deliveryUncertain =
		state.receipts === "unknown" ||
		(state.deliver && obj(state.deliver).inFlight !== undefined) ||
		(state.messageIds && Object.keys(obj(state.messageIds)).length > 0);
	const recoveredStage =
		state.status === "posted"
			? "posted"
			: deliveryUncertain
				? "send_unknown"
				: [
							"generating",
							"generated",
							"file_written",
							"ingesting",
							"ingested",
						].includes(String(state.status))
					? "file_written"
					: ["posting", "posted_unknown", "recovered_unknown"].includes(
								String(state.status),
							)
						? "send_unknown"
						: "legacy_reconciliation";
	return {
		stage: recoveredStage,
		material: {
			...updated.material,
			legacyMigration: {
				...legacy,
				repositoryConfirmed: true,
				deliveryReconciliationRequired: recoveredStage === "send_unknown",
			},
		},
	};
}

export function reconcileLegacyDelivery(
	stage: string,
	material: Obj,
	result: Obj,
	now: number,
): { stage: string; material: Obj } {
	const legacy = obj(material.legacyMigration),
		state = obj(legacy.state);
	if (
		!legacy.repositoryConfirmed ||
		!["send_unknown", "posted"].includes(stage)
	)
		throw new Error("legacy delivery requires repository evidence");
	if (
		Object.keys(result).some(
			(key) => !["action", "index", "identity", "message"].includes(key),
		)
	)
		throw new Error("invalid legacy delivery fields");
	const identity = obj(result.identity),
		message = obj(result.message),
		author = obj(message.author);
	if (
		Object.keys(identity).length !== 4 ||
		Object.keys(identity).some(
			(key) => !["project", "leadId", "botUserId", "channelId"].includes(key),
		)
	)
		throw new Error("invalid legacy identity fields");
	const id = (v: JsonValue) => typeof v === "string" && /^\d{17,20}$/.test(v);
	if (
		identity.project !== "raya" ||
		identity.leadId !== "raya" ||
		!id(identity.botUserId) ||
		!id(identity.channelId) ||
		!id(message.id) ||
		message.channel_id !== identity.channelId ||
		author.id !== identity.botUserId ||
		author.bot !== true
	)
		throw new Error("legacy message identity mismatch");
	const chunks = obj(state.chunkPlan).chunks;
	if (!Array.isArray(chunks)) throw new Error("legacy chunk plan unavailable");
	const chunk = chunks.find((value) => obj(value).index === result.index);
	if (!chunk) throw new Error("legacy chunk identity mismatch");
	const planned = obj(chunk);
	if (
		typeof message.content !== "string" ||
		createHash("sha256").update(message.content).digest("hex") !==
			planned.sha256
	)
		throw new Error("legacy message content mismatch");
	const oldIds = obj(state.messageIds ?? {}),
		known = oldIds[String(result.index)];
	const nonce = createHash("sha256")
		.update(
			`daily-report:${legacy.date}:${material.fileSha}:${planned.kind}:${planned.index}`,
		)
		.digest("hex")
		.slice(0, 25);
	if (known !== undefined ? known !== message.id : message.nonce !== nonce)
		throw new Error("legacy message receipt identity mismatch");
	const prior = material.legacyDeliveryIdentity;
	if (
		prior &&
		["project", "leadId", "botUserId", "channelId"].some(
			(key) => obj(prior)[key] !== identity[key],
		)
	)
		throw new Error("legacy delivery identity changed");
	const messages = obj(material.messageIds ?? {}),
		receipts = obj(material.legacyDelivery ?? {});
	if (
		messages[String(result.index)] !== undefined &&
		messages[String(result.index)] !== message.id
	)
		throw new Error("legacy message binding changed");
	if (
		Object.entries(messages).some(
			([index, value]) =>
				index !== String(result.index) && value === message.id,
		)
	)
		throw new Error("legacy message reused");
	const updatedMessages = { ...messages, [String(result.index)]: message.id };
	const receipt = {
		messageId: message.id,
		channelId: identity.channelId,
		authorId: identity.botUserId,
		contentSha256: planned.sha256,
		observedAt: now,
	};
	return {
		stage: chunks.every(
			(value) => updatedMessages[String(obj(value).index)] !== undefined,
		)
			? "posted"
			: stage,
		material: {
			...material,
			channelId: identity.channelId,
			messageIds: updatedMessages,
			legacyDeliveryIdentity: identity,
			legacyDelivery: {
				...receipts,
				[String(result.index)]: receipts[String(result.index)] ?? receipt,
			},
		},
	};
}

export function recoverLegacyDraft(
	store: OperationStore,
	material: Obj,
	result: Obj,
	now: number,
): { stage: string; material: Obj } {
	const legacy = obj(material.legacyMigration),
		state = obj(legacy.state);
	if (
		legacy.repositoryObservation !== "absent" ||
		legacy.draftRecovered ||
		state.status !== "generated" ||
		state.receipts === "unknown" ||
		(state.deliver && obj(state.deliver).inFlight !== undefined) ||
		(state.messageIds && Object.keys(obj(state.messageIds)).length > 0)
	)
		throw new Error("legacy draft cannot safely resume");
	if (Object.keys(result).length !== 2 || typeof result.timezone !== "string")
		throw new Error("legacy draft requires timezone");
	new Intl.DateTimeFormat("en-CA", { timeZone: result.timezone }).format(
		new Date(now),
	);
	const backup = store.read(String(legacy.backupId));
	if (
		!backup ||
		backup.kind !== "migration_backup" ||
		backup.inputDigest !== material.migrationBinding
	)
		throw new Error("legacy backup identity mismatch");
	const evidence = obj(backup.material),
		body = evidence.rawBody;
	if (
		typeof body !== "string" ||
		createHash("sha256").update(body).digest("hex") !== state.bodySha256 ||
		Buffer.byteLength(body) !== state.bodyBytes ||
		sanitizeDiscordText(body) !== body
	)
		throw new Error("legacy backup body mismatch or unsafe content");
	assertDailyReportBody(body);
	const document = serializeReportDocument(
		{
			issue: "FLY-2380",
			date: String(legacy.date),
			timezone: result.timezone,
			generated_at: new Date(now).toISOString(),
			generation_turn_key: String(state.generationTurnKey),
			main_commit: String(state.mainCommit),
			sources: state.sources as unknown as ReportSource[],
			silent: state.silent as unknown as ReportSilent[],
		},
		body,
	);
	return {
		stage: "generated",
		material: {
			...material,
			body,
			document,
			bodySha256: state.bodySha256,
			bodyBytes: state.bodyBytes,
			generatedAt: new Date(now).toISOString(),
			mainCommit: state.mainCommit,
			sources: state.sources,
			silent: state.silent,
			citedSources: [],
			wake: {
				localDate: legacy.date,
				timezone: result.timezone,
				origin: "legacy_draft_recovery",
			},
			legacyMigration: { ...legacy, draftRecovered: true },
		},
	};
}
