import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BusinessRoundView } from "./business-round.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "./operation-store.js";
import {
	memoryAllowsUnread,
	memoryTask,
	prepareMemoryDraft,
	recordMemoryProgress,
} from "./summary-memory.js";

import { recordRoundPresentation } from "./summary-report.js";

type Obj = { [key: string]: JsonValue };
function obj(value: unknown): Obj {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid summary round object");
	return value as Obj;
}
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (value: unknown) =>
	typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export const summaryRoundId = (roundId: string): string =>
	`summary-round:${roundId}`;
export function appendLegacyReceipt(workspace: string, receipt: Obj): boolean {
	let ready = true;
	const state = join(realpathSync(workspace), "state");
	const stat = lstatSync(state);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("invalid summary state directory");
	const path = join(state, "summary-merge-receipts.jsonl"),
		lockPath = join(state, ".summary-round.lock");
	const owner = randomUUID(),
		lock = openSync(lockPath, "wx", 0o600);
	const failures: unknown[] = [];
	try {
		writeFileSync(lock, owner);
		fsyncSync(lock);
		const fd = openSync(
			path,
			constants.O_RDWR |
				constants.O_CREAT |
				constants.O_APPEND |
				constants.O_NOFOLLOW |
				constants.O_NONBLOCK,
			0o600,
		);
		try {
			const file = fstatSync(fd);
			if (!file.isFile() || file.size > 8 * 1024 * 1024)
				throw new Error("summary ledger is not a bounded regular file");
			const raw = readFileSync(fd, "utf8");
			if (raw && !raw.endsWith("\n"))
				throw new Error("summary ledger has an incomplete tail");
			const rows = raw
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => obj(JSON.parse(line)));
			const prior = rows.filter(
				(row) =>
					row.type === receipt.type &&
					row.roundId === receipt.roundId &&
					(receipt.type !== "question" || row.pr === receipt.pr),
			);

			const question = receipt.type === "question";
			if (
				question &&
				receipt.status === "posting" &&
				prior.some(
					(row) =>
						row.eventId !== receipt.eventId ||
						row.payloadDigest !== receipt.payloadDigest ||
						row.status === "posted",
				)
			)
				ready = false;
			const same = question
				? prior.filter(
						(row) =>
							row.status === receipt.status && row.eventId === receipt.eventId,
					)
				: prior;
			if (
				ready &&
				same.some((row) =>
					Object.keys(receipt).some(
						(key) => JSON.stringify(row[key]) !== JSON.stringify(receipt[key]),
					),
				)
			)
				throw new Error("legacy summary round inventory conflict");
			if (ready && !same.length) {
				writeFileSync(
					fd,
					`${JSON.stringify({ ...receipt, ts: new Date().toISOString() })}\n`,
				);
				fsyncSync(fd);
			}
		} finally {
			closeSync(fd);
		}
		const directory = openSync(
			state,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} catch (error) {
		failures.push(error);
	}
	try {
		closeSync(lock);
		const fd = openSync(
			lockPath,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const file = fstatSync(fd);
			if (
				!file.isFile() ||
				file.size > 100 ||
				readFileSync(fd, "utf8") !== owner
			)
				throw new Error("summary lock owner changed");
		} finally {
			closeSync(fd);
		}
		unlinkSync(lockPath);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length)
		throw new AggregateError(
			failures,
			"summary registration and lock cleanup failed",
		);
	return ready;
}
export function prepareSummaryRound(
	store: OperationStore,
	workspace: string,
	value: Obj,
): BusinessRoundView {
	if (
		Object.keys(value).some(
			(key) =>
				![
					"schemaVersion",
					"kind",
					"roundId",
					"mainCommit",
					"sourceStatus",
					"inventory",
					"frozenEvent",
				].includes(key),
		)
	)
		throw new Error("unknown summary round field");
	const roundId = value.roundId;
	if (
		typeof roundId !== "string" ||
		!roundId.startsWith("summary-absorption:") ||
		!Number.isFinite(Date.parse(roundId.slice(19)))
	)
		throw new Error("invalid summary round identity");
	if (value.sourceStatus !== "available")
		throw new Error(
			"summary source unavailable; cannot register an empty inventory",
		);
	if (
		!sha(value.mainCommit) ||
		!Array.isArray(value.inventory) ||
		value.inventory.length > 100
	)
		throw new Error("invalid summary round inventory");
	const inventory = value.inventory
		.map(obj)
		.sort((a, b) => Number(a.pr) - Number(b.pr));
	const seen = new Set<number>();
	for (const item of inventory) {
		if (
			!Number.isSafeInteger(item.pr) ||
			Number(item.pr) < 1 ||
			seen.has(Number(item.pr)) ||
			!sha(item.head) ||
			typeof item.project !== "string" ||
			!item.project ||
			typeof item.lead !== "string" ||
			!item.lead
		)
			throw new Error("invalid summary inventory entry");
		seen.add(Number(item.pr));
	}
	const event = obj(value.frozenEvent);
	if (
		!["ok", "unavailable"].includes(String(event.round_ledger)) ||
		typeof event.report_line !== "string" ||
		!event.report_line.trim() ||
		![
			event.producers,
			event.absent,
			event.undelivered,
			event.delivery_unknown,
		].every(Array.isArray)
	)
		throw new Error("invalid frozen summary event");
	const snapshot = {
		roundId,
		mainCommit: value.mainCommit,
		sourceStatus: value.sourceStatus,
		inventory,
		frozenEvent: event,
	};
	const inputDigest = hash(snapshot),
		operationId = summaryRoundId(roundId);
	let current = store.read(operationId);
	if (
		current &&
		(current.kind !== "summary_round" || current.inputDigest !== inputDigest)
	)
		throw new Error("summary round input binding conflict");
	if (!current)
		current = store.commit(
			{
				operationId,
				inputDigest,
				kind: "summary_round",
				stage: "registering",
				sourceRefs: [roundId],
				material: snapshot,
			},
			0,
		);
	appendLegacyReceipt(workspace, {
		type: "round",
		roundId,
		reviewedPrs: inventory.map((item) => Number(item.pr)),
	});
	if (current.stage === "registering")
		current = store.commit(
			{ ...current, stage: "registered" },
			current.revision,
		);
	return summaryRoundView(projectSummaryRound(store, workspace, current));
}
export function assertSummaryRegistered(
	store: OperationStore,
	snapshot: Obj,
): void {
	const round = store.read(summaryRoundId(String(snapshot.roundId)));
	if (!round || round.kind !== "summary_round" || round.stage !== "registered")
		throw new Error("summary round is not registered");
	const material = obj(round.material);
	if (
		hash(frozenSnapshot(material)) !== round.inputDigest ||
		!Array.isArray(material.inventory)
	)
		throw new Error("corrupt summary round");
	if (!material.progress || !memoryAllowsUnread(obj(material.progress)))
		throw new Error("summary provenance reconciliation is not ready");
	if (
		material.mainCommit !== snapshot.mainCommit ||
		!material.inventory
			.map(obj)
			.some(
				(item) =>
					item.pr === snapshot.pr &&
					item.head === snapshot.head &&
					item.project === snapshot.project &&
					item.lead === snapshot.lead,
			)
	)
		throw new Error("summary does not match frozen round inventory");
}

function frozenSnapshot(material: Obj): Obj {
	const { progress: _progress, ...snapshot } = material;
	return snapshot;
}
function retireLegacyReport(
	store: OperationStore,
	current: StoredOperation,
): StoredOperation {
	if (current.stage !== "reporting") return current;
	const material = obj(current.material);
	const progress = obj(material.progress);
	const report = obj(progress.report);
	const prepareInput = obj(report.prepareInput);
	const roundId = String(material.roundId);
	const eventId = `summary:${roundId}:report`;
	if (
		prepareInput.kind !== "announcement" ||
		prepareInput.operationId !== eventId ||
		prepareInput.eventId !== eventId ||
		prepareInput.target !== "chat" ||
		!Array.isArray(prepareInput.sourceRefs) ||
		!prepareInput.sourceRefs.includes(roundId)
	) {
		throw new Error("corrupt legacy summary report");
	}
	const announcement = store.read(eventId);
	let retiredStage = "missing";
	if (announcement) {
		const sourceRefs = prepareInput.sourceRefs as JsonValue[];
		const expectedDigest = hash({
			operationId: eventId,
			kind: "announcement",
			sourceRefs,
			payload: {
				target: prepareInput.target,
				text: prepareInput.text,
				eventId: prepareInput.eventId,
			},
		});
		if (
			announcement.kind !== "announcement" ||
			!announcement.sourceRefs.includes(roundId) ||
			announcement.inputDigest !== expectedDigest
		) {
			throw new Error("legacy summary report binding mismatch");
		}
		retiredStage = announcement.stage;
		const retirementStage =
			announcement.stage === "prepared"
				? "cancelled"
				: announcement.stage === "pending"
					? "unknown"
					: undefined;
		if (retirementStage) {
			const announcementMaterial = obj(announcement.material);
			const receipts = Array.isArray(announcementMaterial.receipts)
				? announcementMaterial.receipts
				: [];
			store.commit(
				{
					...announcement,
					stage: retirementStage,
					material: {
						...announcementMaterial,
						receipts: [
							...receipts,
							{
								tool: "business_migration",
								callId: `retire:${eventId}`,
								result: {
									action: "retire_per_round_report",
									sourceRef: current.operationId,
									previousStage: announcement.stage,
								},
							},
						],
					},
				},
				announcement.revision,
			);
			retiredStage = retirementStage;
		} else if (
			!["complete", "unknown", "cancelled"].includes(announcement.stage)
		) {
			throw new Error("unsupported legacy summary report stage");
		}
	}
	const receipts = Array.isArray(progress.receipts) ? progress.receipts : [];
	return store.commit(
		{
			...current,
			stage: "registered",
			material: {
				...material,
				progress: {
					...progress,
					retiredReport: { eventId, announcementStage: retiredStage },
					receipts: [
						...receipts,
						{
							tool: "business_migration",
							callId: `retire:${eventId}`,
							result: {
								action: "retire_per_round_report",
								announcementStage: retiredStage,
							},
						},
					],
				},
			},
		},
		current.revision,
	);
}
export function projectSummaryRound(
	store: OperationStore,
	workspace: string,
	current: StoredOperation,
): StoredOperation {
	summaryRoundView(current);
	current = retireLegacyReport(store, current);
	const material = obj(current.material);
	if (!material.progress) return current;
	const progress = obj(material.progress);
	if (!progress.presentation) return current;
	const presentation = obj(progress.presentation);
	appendLegacyReceipt(workspace, {
		type: "presentation_record",
		roundId: material.roundId,
		groupId: presentation.groupId,
		sourceSeq: presentation.sourceSeq,
		slotStartMs: presentation.slotStartMs,
		businessState: presentation.businessState,
		evidenceRef: presentation.evidenceRef,
		memberDigest: presentation.memberDigest,
	});
	return current;
}
export function recordSummaryRound(
	store: OperationStore,
	workspace: string,
	current: StoredOperation,
	input: Obj,
): BusinessRoundView {
	summaryRoundView(current);
	if (
		![
			"registered",
			"reporting",
			"reported_pending",
			"presented_pending",
		].includes(current.stage) ||
		typeof input.callId !== "string" ||
		!input.callId.trim()
	)
		throw new Error("invalid summary reconciliation stage or source");
	const material = obj(current.material),
		result = obj(input.result);

	if (
		result.action === "report_prepare" ||
		result.action === "report_confirm"
	) {
		throw new Error(
			"per-round report disabled; use summary_presentation grouping",
		);
	}
	if (input.tool === "lead_actions.summary_presentation") {
		if (current.stage !== "registered")
			throw new Error("summary presentation already recorded");
		const previous =
			material.progress === undefined ? {} : obj(material.progress);
		const presentation = recordRoundPresentation(store, material, result);
		return summaryRoundView(
			projectSummaryRound(
				store,
				workspace,
				store.commit(
					{
						...current,
						stage:
							presentation.memoryStatus === "committed_push_pending"
								? "presented_pending"
								: "complete",
						material: {
							...material,
							progress: {
								...previous,
								presentation,
								receipts: [
									...(Array.isArray(previous.receipts)
										? previous.receipts
										: []),
									{ tool: input.tool, callId: input.callId, result },
								],
							},
						},
					},
					current.revision,
				),
			),
		);
	}
	if (input.tool !== "current_turn")
		throw new Error("invalid summary reconciliation stage or source");
	if (
		current.stage !== "registered" &&
		!(
			(current.stage === "reported_pending" &&
				result.action === "memory_push") ||
			(current.stage === "presented_pending" &&
				["memory_result", "memory_push"].includes(String(result.action)))
		)
	)
		throw new Error("summary presentation already frozen");
	if (
		["memory_plan", "memory_finalize", "memory_result", "memory_push"].includes(
			String(result.action),
		)
	) {
		const previous = obj(material.progress),
			draft =
				result.action === "memory_plan"
					? prepareMemoryDraft(store, material, result)
					: recordMemoryProgress(store, material, result);
		return summaryRoundView(
			store.commit(
				{
					...current,
					stage:
						["reported_pending", "presented_pending"].includes(current.stage) &&
						draft.push === "pushed"
							? "complete"
							: current.stage,
					material: {
						...material,
						progress: {
							...previous,
							memoryDraft: draft,
							receipts: [
								...(Array.isArray(previous.receipts) ? previous.receipts : []),
								{ tool: input.tool, callId: input.callId, result },
							],
						},
					},
				},
				current.revision,
			),
		);
	}
	const memory = obj(result.memory);
	if (
		!["available", "unavailable"].includes(String(result.canonicalStatus)) ||
		!["clean", "dirty", "unavailable"].includes(String(memory.status))
	)
		throw new Error("invalid reconciliation source status");
	const missing: Obj[] = [];
	let status = "unknown";
	if (result.canonicalStatus === "available") {
		if (result.canonicalMainCommit !== material.mainCommit)
			throw new Error("reconciliation main commit mismatch");
		if (!Array.isArray(result.canonicalMerged))
			throw new Error("complete canonical merged inventory required");
		if (
			memory.status !== "unavailable" &&
			(!sha(memory.commit) || !Array.isArray(memory.provenance))
		)
			throw new Error("invalid memory observation");
		const provenance = Array.isArray(memory.provenance)
			? memory.provenance.map(obj)
			: [];
		const seen = new Set<string>();
		for (const raw of result.canonicalMerged) {
			const summary = obj(raw);
			if (
				!Number.isSafeInteger(summary.pr) ||
				Number(summary.pr) < 1 ||
				!sha(summary.head) ||
				typeof summary.project !== "string" ||
				!summary.project ||
				typeof summary.roundId !== "string" ||
				!summary.roundId.startsWith("summary-absorption:") ||
				!Number.isFinite(Date.parse(summary.roundId.slice(19))) ||
				!Array.isArray(summary.files) ||
				!summary.files.length
			)
				throw new Error("invalid canonical summary identity");
			for (const path of summary.files) {
				if (
					typeof path !== "string" ||
					!/^summaries\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\.md$/.test(path) ||
					!path.startsWith(`summaries/${summary.project}/`)
				)
					throw new Error("canonical summary project/path mismatch");
				const identity = `${summary.pr}:${summary.head}:${path}`;
				if (seen.has(identity))
					throw new Error("duplicate canonical summary file");
				seen.add(identity);
				if (
					!provenance.some(
						(row) =>
							row.pr === summary.pr &&
							row.head === summary.head &&
							row.path === path &&
							row.roundId === summary.roundId,
					)
				)
					missing.push({
						pr: summary.pr,
						head: summary.head,
						project: summary.project,
						roundId: summary.roundId,
						path,
					});
			}
		}
		status =
			memory.status === "dirty"
				? "memory_dirty"
				: memory.status === "unavailable"
					? "unknown"
					: missing.length
						? "memory_needed"
						: "ready";
	}
	const previous =
		material.progress === undefined ? {} : obj(material.progress);
	const receipts = Array.isArray(previous.receipts) ? previous.receipts : [];
	return summaryRoundView(
		store.commit(
			{
				...current,
				material: {
					...material,
					progress: {
						...previous,
						reconciliation: {
							status,
							missing,
							...(sha(memory.commit) ? { memoryCommit: memory.commit } : {}),
							...(typeof memory.bodySha256 === "string" &&
							/^[a-f0-9]{64}$/.test(memory.bodySha256)
								? { memoryBodySha256: memory.bodySha256 }
								: {}),
						},
						receipts: [
							...receipts,
							{ tool: input.tool, callId: input.callId, result },
						],
					},
				},
			},
			current.revision,
		),
	);
}
export function summaryRoundView(
	operation: StoredOperation,
): BusinessRoundView {
	const material = obj(operation.material);
	if (
		operation.kind !== "summary_round" ||
		hash(frozenSnapshot(material)) !== operation.inputDigest
	)
		throw new Error("corrupt summary round");
	const progress =
		material.progress === undefined ? undefined : obj(material.progress);
	const reconciliation =
		progress?.reconciliation === undefined
			? undefined
			: obj(progress.reconciliation);
	const presentation =
		progress?.presentation === undefined
			? undefined
			: obj(progress.presentation);
	const memoryDraft =
		progress?.memoryDraft === undefined ? undefined : obj(progress.memoryDraft);
	const retiredReport =
		progress?.retiredReport === undefined
			? undefined
			: obj(progress.retiredReport);
	const memoryNeedsAction =
		memoryDraft !== undefined &&
		!(memoryDraft.stage === "committed" && memoryDraft.push === "pushed");
	const presentationReady =
		reconciliation?.status === "ready" ||
		(memoryDraft?.stage === "committed" && memoryDraft.push === "pushed");
	return {
		schemaVersion: 2,
		operationId: operation.operationId,
		revision: operation.revision,
		stage: operation.stage,
		next:
			operation.stage === "reporting"
				? null
				: ["registered", "reported_pending", "presented_pending"].includes(
							operation.stage,
						)
					? {
							tool: "current_turn",
							arguments: {
								task: memoryNeedsAction
									? memoryTask(memoryDraft)
									: presentationReady
										? retiredReport?.announcementStage === "complete"
											? "The retired per-round report was already delivered. Record this round in summary_presentation with outcome alreadyPresented=true and substantive=false, and exclude its content from any new founder-visible group text. Do not resend the legacy announcement."
											: "Use lead_actions.summary_presentation begin, then record this exact round with its real business outcome and evidence. Record that tool's structuredContent on this operation with tool lead_actions.summary_presentation. Finalize the group only after every returned member is recorded; silent is valid and sends nothing. Never use report_prepare, discord_send, or assistant final for a summary round."
										: "Reconcile canonical merged summary files at mainCommit against memory provenance with standard read-only tools. Preserve unavailable/dirty status; never reset memory. Record canonicalStatus, canonicalMainCommit, canonicalMerged and memory status/commit/provenance.",
								mainCommit: material.mainCommit,
							},
						}
					: null,
		needsReconciliation:
			presentation?.businessState === "failed"
				? memoryDraft?.stage === "unknown"
				: operation.stage === "registering" ||
					operation.stage === "reporting" ||
					!progress ||
					!reconciliation ||
					reconciliation.status === "unknown",
		receipts:
			progress && Array.isArray(progress.receipts)
				? (progress.receipts as JsonValue[]).map(obj)
				: [],
		material,
	};
}
