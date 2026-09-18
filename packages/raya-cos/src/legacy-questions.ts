import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";
import type { BusinessRoundView } from "./business-round.js";
import {
	type JsonValue,
	OperationStore,
	type StoredOperation,
} from "./operation-store.js";
import { prepareQuestionIntent } from "./question-intent.js";
import { parseStoredQuestions } from "./question-store.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sourcePath = "state/lead-questions/questions.json";
function readSource(workspace: string): string | null {
	let path = realpathSync(workspace);
	for (const part of ["state", "lead-questions"]) {
		path = join(path, part);
		try {
			const stat = lstatSync(path);
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new Error("unsafe legacy questions directory");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	let fd: number;
	try {
		fd = openSync(
			join(path, "questions.json"),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 512 * 1024)
			throw new Error("invalid legacy questions file");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
export function planLegacyQuestions(workspace: string) {
	const raw = readSource(workspace),
		rows = raw === null ? [] : parseStoredQuestions(raw);
	return {
		schemaVersion: 1,
		kind: "legacy_questions_migration",
		path: sourcePath,
		digest: hash(raw ?? ""),
		questions: rows.map((row) => ({
			askId: row.askId,
			status: row.status,
			action: ["delivered", "expired", "failed"].includes(row.status)
				? "preserve_terminal"
				: row.transportUnavailableReason === "lead_transport_not_available"
					? "reconcile_unavailable"
					: "reconcile",
		})),
	};
}
export function applyLegacyQuestions(
	workspace: string,
	digest: string,
	identity: { flywheelSha: string; rayaSha: string },
) {
	if (
		!/^[a-f0-9]{64}$/.test(digest) ||
		Object.keys(identity).length !== 2 ||
		![identity.flywheelSha, identity.rayaSha].every((sha) =>
			/^[a-f0-9]{40}$/.test(sha),
		)
	)
		throw new Error("legacy questions require digest and paired SHAs");
	const plan = planLegacyQuestions(workspace);
	if (plan.digest !== digest)
		throw new Error("legacy questions inventory changed");
	const raw = readSource(workspace);
	if (raw === null) return { digest, operations: [] };
	if (hash(raw) !== digest) throw new Error("legacy questions source changed");
	const rows = parseStoredQuestions(raw),
		store = new OperationStore(workspace),
		binding = hash(JSON.stringify({ digest, ...identity }));
	const operations = rows.map((row) => `legacy-question:${row.askId}`);
	for (const operationId of operations) {
		const old = store.read(operationId);
		if (old && (old.kind !== "legacy_question" || old.inputDigest !== binding))
			throw new Error("legacy question target conflict");
	}
	const backupId = `legacy-questions-backup:${binding}`,
		backup = store.read(backupId);
	const backupMaterial = { rawState: raw, path: sourcePath, digest, identity };
	if (backup) {
		if (
			backup.inputDigest !== binding ||
			JSON.stringify(backup.material) !== JSON.stringify(backupMaterial)
		)
			throw new Error("legacy question backup conflict");
	} else
		store.commit(
			{
				operationId: backupId,
				kind: "migration_backup",
				inputDigest: binding,
				stage: "complete",
				sourceRefs: [sourcePath],
				material: backupMaterial,
			},
			0,
		);
	for (const [index, row] of rows.entries()) {
		if (readSource(workspace) !== raw)
			throw new Error("legacy question source changed after backup");
		const operationId = operations[index],
			old = store.read(operationId);
		if (old) {
			if (old.kind !== "legacy_question" || old.inputDigest !== binding)
				throw new Error("legacy question target conflict");
			continue;
		}
		const terminal = plan.questions[index].action === "preserve_terminal";
		store.commit(
			{
				operationId,
				kind: "legacy_question",
				inputDigest: binding,
				stage: terminal ? row.status : "legacy_reconciliation",
				sourceRefs: [sourcePath, `discord-message:${row.sourceMessageId}`],
				material: {
					legacy: row as unknown as JsonValue,
					backupId,
					action: plan.questions[index].action,
					receipts: [{ action: "import_legacy_question", digest, identity }],
				},
			},
			0,
		);
	}
	return { digest, operations };
}
export function legacyQuestionView(
	current: StoredOperation,
	store?: OperationStore,
): BusinessRoundView {
	const material = current.material as { [key: string]: JsonValue },
		legacy = material.legacy as { [key: string]: JsonValue };
	const recovery = material.recovery as Obj | undefined;
	if (recovery) {
		const child = store?.read(String(recovery.operationId));
		return {
			schemaVersion: 2,
			operationId: current.operationId,
			revision: current.revision,
			stage: current.stage,
			next: {
				tool: "current_turn",
				arguments: child
					? { action: "resume", operationId: child.operationId }
					: { action: "prepare", input: recovery },
			},
			needsReconciliation: false,
			receipts: material.receipts as Obj[],
			material,
		};
	}
	return {
		schemaVersion: 2,
		operationId: current.operationId,
		revision: current.revision,
		stage: current.stage,
		next:
			current.stage === "legacy_reconciliation"
				? {
						tool: "current_turn",
						arguments: {
							action: "reconcile_legacy_question",
							askId: legacy.askId,
							backupId: material.backupId,
							recovery: material.action,
							instructions:
								"Preserve the original askId and actual target/message evidence. Missing revision or expiry is unknown; do not create a new request or infer delivery from posting. Only proven unavailable requests may be prepared after original identity and current capability are established.",
						},
					}
				: null,
		needsReconciliation: current.stage === "legacy_reconciliation",
		receipts: material.receipts as { [key: string]: JsonValue }[],
		material,
	};
}

type Obj = { [key: string]: JsonValue };
function object(value: JsonValue | undefined): Obj {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid legacy question metadata");
	return value;
}
export function recoverLegacyQuestion(
	store: OperationStore,
	current: StoredOperation,
	input: Obj,
	now: number,
): StoredOperation {
	const material = object(current.material),
		legacy = object(material.legacy),
		result = object(input.result);
	if (
		input.tool !== "current_turn" ||
		result.action !== "recover_unavailable_question" ||
		typeof input.callId !== "string" ||
		!input.callId.trim() ||
		Object.keys(result).some(
			(key) =>
				!["action", "metadataSourceRef", "original", "directory"].includes(key),
		)
	)
		throw new Error("invalid legacy question recovery receipt");
	if (
		legacy.status !== "posting" ||
		legacy.transportUnavailableReason !== "lead_transport_not_available" ||
		[
			"postedMessageId",
			"postedAt",
			"answerMessageId",
			"answerAuthorLeadId",
			"answerObservedAt",
			"answerReceiptMessageId",
			"finishedAt",
		].some((key) => legacy[key] !== undefined) ||
		(legacy.deliveredMessageIds !== undefined &&
			(!Array.isArray(legacy.deliveredMessageIds) ||
				legacy.deliveredMessageIds.length !== 0))
	)
		throw new Error("legacy terminal or ambiguous delivery cannot be retried");
	const original = object(result.original),
		to = object(original.to),
		target = object(legacy.to);
	if (
		original.askId !== legacy.askId ||
		original.body !== legacy.question ||
		to.project !== target.project ||
		to.leadId !== target.leadId ||
		typeof result.metadataSourceRef !== "string" ||
		!result.metadataSourceRef.trim()
	)
		throw new Error("legacy original identity evidence required");
	const recovery: Obj = {
		schemaVersion: 2,
		kind: "question",
		operationId: `question:legacy:${legacy.askId}`,
		sourceRefs: [
			current.operationId,
			...current.sourceRefs,
			result.metadataSourceRef,
		],
		requestId: legacy.askId,
		requestRevision: original.revision,
		to: original.to,
		body: original.body,
		expiresAt: original.expiresAt,
		directory: result.directory,
	};
	prepareQuestionIntent(recovery, now);
	if (material.recovery) {
		if (JSON.stringify(material.recovery) !== JSON.stringify(recovery))
			throw new Error("legacy recovery binding conflict");
		return current;
	}
	if (
		current.stage !== "legacy_reconciliation" ||
		Number(original.expiresAt) <= now
	)
		throw new Error("legacy recovery requires unexpired original request");
	if (store.read(String(recovery.operationId)))
		throw new Error("legacy recovery operation conflict");
	return store.commit(
		{
			...current,
			stage: "recovery_prepared",
			material: {
				...material,
				recovery,
				receipts: [
					...(material.receipts as JsonValue[]),
					{ tool: input.tool, callId: input.callId, result: input.result },
				],
			},
		},
		current.revision,
	);
}
/** Imported requests may only enter the standard flow through their frozen recovery. */
export function validateLegacyQuestionPreparation(
	store: OperationStore,
	input: Obj,
): void {
	const refs = input.sourceRefs as string[];
	const ids = new Set(refs.filter((ref) => ref.startsWith("legacy-question:")));
	const originalId = `legacy-question:${input.requestId}`;
	if (store.read(originalId)) ids.add(originalId);
	for (const id of ids) {
		const legacy = store.read(id);
		if (
			!legacy ||
			legacy.kind !== "legacy_question" ||
			JSON.stringify(object(legacy.material).recovery) !== JSON.stringify(input)
		)
			throw new Error("legacy question recovery binding conflict");
	}
}
