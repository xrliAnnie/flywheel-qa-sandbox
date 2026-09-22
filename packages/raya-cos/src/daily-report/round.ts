import { createHash } from "node:crypto";
import type { BusinessRoundView } from "../business-round.js";
import {
	parseReportDocument,
	type ReportMetaInput,
	type ReportSilent,
	type ReportSource,
	serializeReportDocument,
} from "../contracts/daily-report.js";
import { sanitizeDiscordText } from "../formatting/discord-text.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "../operation-store.js";
import {
	assertDailyReportBody,
	buildDailyReportPrompt,
	type ReportGenerationSource,
} from "./generator.js";
import { prepareLegacyNotice, reconcileLegacyNotice } from "./legacy-notice.js";
import {
	reconcileLegacyDelivery,
	reconcileLegacyRepository,
	recoverLegacyDraft,
} from "./legacy-recovery.js";
import { recordReportRepository } from "./repository-round.js";

type Obj = { [key: string]: JsonValue };
const obj = (v: unknown): Obj => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new Error("invalid report object");
	return v as Obj;
};
const hash = (v: unknown) =>
	createHash("sha256").update(JSON.stringify(v)).digest("hex");
function exact(v: Obj, fields: string[]) {
	if (
		Object.keys(v).length !== fields.length ||
		fields.some((f) => !Object.hasOwn(v, f))
	)
		throw new Error("invalid report fields");
}
function date(v: unknown): string {
	if (
		typeof v !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(v) ||
		!Number.isFinite(Date.parse(v)) ||
		new Date(v).toISOString().slice(0, 10) !== v
	)
		throw new Error("invalid report date");
	return v;
}
function meta(material: Obj): ReportMetaInput {
	const wake = obj(material.wake);
	return {
		issue: "FLY-2380",
		date: String(wake.localDate),
		timezone: String(wake.timezone),
		generated_at: String(material.generatedAt),
		generation_turn_key: `daily-report:${wake.localDate}:gen:1`,
		main_commit: String(material.mainCommit),
		sources: material.sources as unknown as ReportSource[],
		silent: material.silent as unknown as ReportSilent[],
	};
}
export function prepareDailyReport(
	store: OperationStore,
	input: Obj,
	now: number,
): BusinessRoundView {
	exact(input, ["schemaVersion", "kind", "wake", "sourceRefs"]);
	const wake = obj(input.wake);
	exact(wake, [
		"scheduleId",
		"revision",
		"configDigest",
		"localDate",
		"dueAt",
		"timezone",
	]);
	const localDate = date(wake.localDate);
	if (
		wake.scheduleId !== "daily-report" ||
		!Number.isSafeInteger(wake.revision) ||
		Number(wake.revision) < 1 ||
		typeof wake.configDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(wake.configDigest) ||
		typeof wake.timezone !== "string" ||
		typeof wake.dueAt !== "string" ||
		!Number.isFinite(Date.parse(wake.dueAt)) ||
		Date.parse(wake.dueAt) > now
	)
		throw new Error("invalid report wake");
	const local = new Intl.DateTimeFormat("en-CA", {
		timeZone: wake.timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(wake.dueAt));
	if (local !== localDate) throw new Error("report wake date mismatch");
	if (
		!Array.isArray(input.sourceRefs) ||
		!input.sourceRefs.length ||
		input.sourceRefs.some(
			(ref) => typeof ref !== "string" || !ref.trim() || ref.length > 500,
		)
	)
		throw new Error("report source identity required");
	const operationId = `daily-report:${localDate}`,
		old = store.read(operationId);
	if (old) {
		if (old.kind !== "daily_report")
			throw new Error("report identity conflict");
		const material = obj(old.material);
		if (material.legacyMigration && old.stage === "legacy_reconciliation") {
			const legacy = obj(material.legacyMigration),
				state = obj(legacy.state);
			if (
				state.status === "generating" &&
				legacy.repositoryObservation === "absent" &&
				!legacy.generationResumed &&
				state.bodyFile === undefined &&
				state.fileSha === undefined &&
				state.receipts !== "unknown" &&
				!(state.deliver && obj(state.deliver).inFlight !== undefined) &&
				(!state.messageIds || Object.keys(obj(state.messageIds)).length === 0)
			) {
				return dailyReportView(
					store.commit(
						{
							...old,
							stage: "prepared",
							sourceRefs: [
								...new Set([
									...old.sourceRefs,
									...(input.sourceRefs as string[]),
								]),
							],
							material: {
								...material,
								wake,
								preparedAt: now,
								legacyMigration: { ...legacy, generationResumed: true },
								receipts: [
									...(material.receipts as JsonValue[]),
									{
										action: "resume_legacy_generation",
										sourceRefs: input.sourceRefs,
										wake,
										recordedAt: now,
									},
								],
							},
						},
						old.revision,
					),
				);
			}
		}
		return dailyReportView(old);
	}
	return dailyReportView(
		store.commit(
			{
				operationId,
				kind: "daily_report",
				inputDigest: hash({ wake, sourceRefs: input.sourceRefs }),
				stage: "prepared",
				sourceRefs: input.sourceRefs as string[],
				material: { wake, preparedAt: now, receipts: [] },
			},
			0,
		),
	);
}
export function recordDailyReport(
	store: OperationStore,
	current: StoredOperation,
	input: Obj,
	now: number,
): BusinessRoundView {
	if (
		input.tool !== "current_turn" ||
		typeof input.callId !== "string" ||
		!input.callId.trim()
	)
		throw new Error("report current turn result required");
	const result = obj(input.result),
		material = obj(current.material);
	let next: Obj, stage: string;
	if (
		material.legacyMigration &&
		result.action === "reconcile_legacy_repository"
	) {
		const recovered = reconcileLegacyRepository(
			current.stage,
			material,
			result,
		);
		next = recovered.material;
		stage = recovered.stage;
	} else if (
		material.legacyMigration &&
		result.action === "reconcile_legacy_delivery"
	) {
		const recovered = reconcileLegacyDelivery(
			current.stage,
			material,
			result,
			now,
		);
		next = recovered.material;
		stage = recovered.stage;
	} else if (
		material.legacyMigration &&
		result.action === "recover_legacy_draft"
	) {
		const recovered = recoverLegacyDraft(store, material, result, now);
		next = recovered.material;
		stage = recovered.stage;
	} else if (
		material.legacyMigration &&
		result.action === "reconcile_legacy_failure_notice"
	) {
		const recovered = reconcileLegacyNotice(
			current.stage,
			material,
			result,
			now,
		);
		next = recovered.material;
		stage = recovered.stage;
	} else if (
		material.legacyMigration &&
		result.action === "prepare_legacy_failure_notice"
	) {
		const prepared = prepareLegacyNotice(current.stage, material, result);
		next = prepared.material;
		stage = prepared.stage;
	} else if (current.stage === "prepared" && result.action === "collect") {
		exact(result, ["action", "mainCommit", "sources", "silent"]);
		if (
			!Array.isArray(result.sources) ||
			result.sources.length > 500 ||
			!Array.isArray(result.silent)
		)
			throw new Error("invalid report source manifest");
		const contents: Obj[] = [];
		const sources = result.sources.map((value) => {
			const source = obj(value);
			if (
				typeof source.content !== "string" ||
				Buffer.byteLength(source.content, "utf8") > 65536
			)
				throw new Error("invalid report source content");
			const { content, ...manifest } = source;
			if (source.omitted === true && content !== "")
				throw new Error("omitted report source contains content");
			contents.push({ ...manifest, content: sanitizeDiscordText(content) });
			return manifest;
		});
		if (Buffer.byteLength(JSON.stringify(contents), "utf8") > 512 * 1024)
			throw new Error("report source budget exceeded");
		next = {
			...material,
			mainCommit: result.mainCommit,
			sources,
			silent: result.silent,
			contents,
			generatedAt: new Date(now).toISOString(),
		};
		// Reuse the existing strict source/frontmatter contract before freezing any inputs.
		serializeReportDocument(meta(next), "validation");
		stage = "collecting_complete";
	} else if (
		current.stage === "collecting_complete" &&
		result.action === "generate"
	) {
		exact(result, ["action", "body", "sourceRefs"]);
		if (typeof result.body !== "string" || !Array.isArray(result.sourceRefs))
			throw new Error("invalid report body or source references");
		const sources = material.sources as Obj[];
		const refs = result.sourceRefs;
		if (
			new Set(refs).size !== refs.length ||
			refs.some(
				(ref) =>
					!Number.isInteger(ref) ||
					Number(ref) < 0 ||
					Number(ref) >= sources.length ||
					sources[Number(ref)]?.omitted === true,
			)
		)
			throw new Error("report source reference outside readable manifest");
		let body = sanitizeDiscordText(result.body);
		const cited = Array.from(body.matchAll(/\[source:(\d+)\]/g), (m) =>
			Number(m[1]),
		);
		if (
			cited.some((ref) => !refs.includes(ref)) ||
			refs.some((ref) => !cited.includes(Number(ref)))
		)
			throw new Error("report source citation mismatch");
		// Summary paths and raw links must not bypass the frozen indexed citation protocol.
		if (/summaries\/|https?:\/\//i.test(body))
			throw new Error("report source links must use indexed citations");
		body = body.replace(/\[source:(\d+)\]/g, (_match, index) => {
			const source = sources[Number(index)];
			if (!source) throw new Error("report source missing");
			const label = sanitizeDiscordText(
				`${source.project}/${source.lead}`,
			).replace(/[[\]\\]/g, "");
			const path = String(source.path)
				.split("/")
				.map(encodeURIComponent)
				.join("/");
			const status =
				source.state === "open" ? `未吸收 PR #${source.pr}` : "已合并";
			return `[${label}（${status}）](https://github.com/xrliAnnie/raya/blob/${source.head}/${path})`;
		});
		assertDailyReportBody(body);
		const document = serializeReportDocument(
				meta({ ...material, generatedAt: new Date(now).toISOString() }),
				body,
			),
			parsed = parseReportDocument(document, {
				date: String(obj(material.wake).localDate),
			});
		next = {
			...material,
			body,
			document,
			generatedAt: parsed.meta.generated_at,
			bodySha256: parsed.meta.body_sha256,
			bodyBytes: parsed.meta.body_bytes,
			citedSources: refs,
		};
		stage = "generated";
	} else if (["probe", "create"].includes(String(result.action))) {
		const updated = recordReportRepository(current.stage, material, result);
		next = updated.material;
		stage = updated.stage;
	} else throw new Error("report stage does not accept this result");
	// Store sanitized output and manifest rather than retaining secret-bearing raw generation receipts.
	next.receipts = [
		...(material.receipts as JsonValue[]),
		{
			tool: "current_turn",
			callId: input.callId,
			action: result.action,
			recordedAt: now,
			...(["probe", "create", "reconcile_legacy_repository"].includes(
				String(result.action),
			)
				? {
						status: result.status,
						repo: result.repo,
						ref: result.ref,
						path: result.path,
						...(result.fileSha === undefined
							? {}
							: { fileSha: result.fileSha }),
					}
				: {}),
		},
	];
	return dailyReportView(
		store.commit({ ...current, stage, material: next }, current.revision),
	);
}
export function dailyReportView(
	current: StoredOperation,
	now = Date.now(),
): BusinessRoundView {
	const material = obj(current.material);
	if (
		material.legacyMigration &&
		((!obj(material.legacyMigration).repositoryConfirmed &&
			!obj(material.legacyMigration).draftRecovered &&
			!obj(material.legacyMigration).generationResumed) ||
			current.stage === "legacy_reconciliation" ||
			(current.stage === "send_unknown" &&
				obj(material.legacyMigration).deliveryReconciliationRequired === true))
	) {
		const legacy = obj(material.legacyMigration);
		return {
			schemaVersion: 2,
			operationId: current.operationId,
			revision: current.revision,
			stage: current.stage,
			next: ["posted", "failed"].includes(current.stage)
				? null
				: material.failureNotice &&
						obj(material.failureNotice).status === "pending"
					? {
							tool: "current_turn",
							arguments: {
								action: "prepare_failure_notice",
								input: obj(material.failureNotice).input,
							},
						}
					: {
							tool: "current_turn",
							arguments: {
								action: "reconcile_legacy_report",
								...(!legacy.repositoryConfirmed
									? {
											recordAction: "reconcile_legacy_repository",
											repo: "xrliAnnie/raya",
											ref: "main",
											path: `reports/${legacy.date}.md`,
											requiredEvidence:
												"Actual existing document and its Git blob SHA. Missing or unknown stays pending.",
										}
									: {}),
								...(legacy.repositoryConfirmed &&
								current.stage === "send_unknown"
									? {
											recordAction: "reconcile_legacy_delivery",
											requiredEvidence:
												"Read each original message using its stored ID or original nonce. Provide index, Raya bot/channel identity, and the actual Discord message including author and content. No resend on missing evidence.",
										}
									: {}),
								...(legacy.repositoryObservation === "absent" &&
								obj(legacy.state).status === "generated"
									? {
											recordAction: "recover_legacy_draft",
											requiredEvidence:
												"Provide the historical report timezone. The business module reads the frozen backup body and source manifest; it will probe again and create only.",
										}
									: {}),
								...(legacy.repositoryObservation === "absent" &&
								obj(legacy.state).status === "generating"
									? {
											recordAction: "prepare",
											requiredEvidence:
												"Prepare daily_report with the actual original-date wake and sourceRefs. Preserve its date; do not synthesize a platform receipt.",
										}
									: {}),
								date: legacy.date,
								recovery: legacy.action,
								backupId: legacy.backupId,
								instructions:
									"Read the preserved backup and gather repository, context or platform delivery evidence. Do not generate a new report or send from legacy uncertainty. Legacy ingest is not a runtime command.",
							},
						},
			needsReconciliation: !["posted", "failed"].includes(current.stage),
			receipts: material.receipts as Obj[],
			material,
		};
	}
	const wake = obj(material.wake);
	let args: Obj | null = null;
	if (current.stage === "prepared")
		args = {
			action: "collect_report_sources",
			date: wake.localDate,
			timezone: wake.timezone,
			repo: "xrliAnnie/raya",
			ref: "main",
			instructions:
				"Freeze mainCommit and exact summary PR head/blob; retain all unavailable/omitted/unsubmitted distinctions and memory provenance gaps.",
		};
	if (current.stage === "collecting_complete")
		args = {
			action: "generate_report",
			prompt: buildDailyReportPrompt({
				date: String(wake.localDate),
				timeZone: String(wake.timezone),
				mainCommit: String(material.mainCommit),
				sources: material.contents as unknown as ReportGenerationSource[],
			}),
			instructions:
				"Return action generate, body and sourceRefs indexes. Cite [source:N]; never cite omitted content. No raw URLs or summary paths; publication preserves the complete source manifest.",
		};
	if (["generated", "reconciling_file"].includes(current.stage))
		args = {
			action: "probe_report",
			repo: "xrliAnnie/raya",
			ref: "main",
			path: `reports/${wake.localDate}.md`,
		};
	if (current.stage === "creating_file")
		args = {
			action: "create_report",
			repo: "xrliAnnie/raya",
			ref: "main",
			path: `reports/${wake.localDate}.md`,
			createOnly: true,
			document: material.document,
			instructions:
				"Use the standard GitHub contents create operation without an update sha. Record created with the actual fileSha; conflict or unknown requires probe, never overwrite.",
		};
	if (current.stage === "file_written")
		args = {
			action: "prepare_report_context",
			fileSha: material.fileSha,
			bodySha256: material.bodySha256,
		};
	if (
		["context_ready", "posting"].includes(current.stage) &&
		Number(material.nextAttemptAt ?? 0) <= now
	)
		args = { action: "begin_send" };
	return {
		schemaVersion: 2,
		operationId: current.operationId,
		revision: current.revision,
		stage: current.stage,
		next: args ? { tool: "current_turn", arguments: args } : null,
		needsReconciliation: [
			"reconciling_file",
			"sending",
			"send_unknown",
		].includes(current.stage),
		...(typeof material.nextAttemptAt === "number"
			? { nextAttemptAt: material.nextAttemptAt }
			: {}),
		receipts: material.receipts as Obj[],
		material,
	};
}
