import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BusinessRoundView } from "../business-round.js";
import {
	parseDriftEnvelope,
	type ScopedDriftContext,
	validateScopedDriftEnvelope,
} from "../contracts/drift-envelope.js";
import { parseGoalsFile } from "../contracts/goals.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "../operation-store.js";
import { SnapshotStore } from "./snapshot-store.js";

type Obj = { [key: string]: JsonValue };
const obj = (v: unknown): Obj => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new Error("invalid patrol object");
	return v as Obj;
};
const hash = (v: unknown) =>
	createHash("sha256").update(JSON.stringify(v)).digest("hex");
function goalsBody(workspace: string): string {
	const directory = join(workspace, "memory");
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("invalid memory directory");
	let fd: number;
	try {
		fd = openSync(
			join(directory, "goals.md"),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
	try {
		const file = fstatSync(fd);
		if (!file.isFile() || file.size > 1024 * 1024)
			throw new Error("invalid goals file");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
export function preparePatrol(
	store: OperationStore,
	workspace: string,
	input: Obj,
): StoredOperation {
	const allowed = [
		"schemaVersion",
		"kind",
		"operationId",
		"sourceRefs",
		"snapshotOperationId",
	];
	if (
		Object.keys(input).some((k) => !allowed.includes(k)) ||
		typeof input.operationId !== "string" ||
		!input.operationId.trim() ||
		typeof input.snapshotOperationId !== "string" ||
		!Array.isArray(input.sourceRefs) ||
		!input.sourceRefs.length ||
		input.sourceRefs.some((r) => typeof r !== "string" || !r.trim())
	)
		throw new Error("invalid patrol identity");
	const digest = hash(input),
		old = store.read(input.operationId);
	if (old) {
		if (old.kind !== "patrol" || old.inputDigest !== digest)
			throw new Error("patrol binding conflict");
		return old;
	}
	const sample = store.read(input.snapshotOperationId);
	if (
		!sample ||
		sample.kind !== "portfolio_sample" ||
		sample.stage !== "complete" ||
		obj(sample.material).snapshotProjected !== true
	)
		throw new Error("completed projected sample required");
	const snapshot = obj(obj(sample.material).snapshot),
		latest = new SnapshotStore(join(workspace, "state")).readLatest();
	if (hash(latest) !== hash(snapshot))
		throw new Error("latest snapshot required");
	const body = goalsBody(workspace);
	if (body) parseGoalsFile(body);
	return store.commit(
		{
			kind: "patrol",
			operationId: input.operationId,
			inputDigest: digest,
			stage: "judging",
			sourceRefs: input.sourceRefs as string[],
			material: {
				snapshot,
				goalsBody: body,
				goalsDigest: hash(body),
				receipts: [],
			},
		},
		0,
	);
}
export function patrolBlock(
	workspace: string,
	current: StoredOperation,
	now: number,
	text: string,
): string | null {
	const material = obj(current.material);
	try {
		const body = goalsBody(workspace);
		if (hash(body) !== material.goalsDigest) return "goals_changed";
		const latest = new SnapshotStore(join(workspace, "state")).readLatest();
		if (hash(latest) !== hash(material.snapshot)) return "snapshot_changed";
		const validation = validateScopedDriftEnvelope(parseDriftEnvelope(text), {
			snapshot: latest as unknown as ScopedDriftContext["snapshot"],
			goals: body ? parseGoalsFile(body) : [],
			now: new Date(now),
			staleAfterMs: 300000,
		});
		return validation.kind === "valid"
			? null
			: validation.kind === "invalid"
				? validation.reason
				: "observation_required";
	} catch {
		return "evidence_unavailable";
	}
}
function bindQuestion(
	store: OperationStore,
	current: StoredOperation,
	result: Obj,
): StoredOperation {
	if (
		Object.keys(result).some(
			(k) =>
				!["action", "questionOperationId", "target", "evidenceRefs"].includes(
					k,
				),
		) ||
		typeof result.questionOperationId !== "string"
	)
		throw new Error("invalid patrol question");
	const question = store.read(result.questionOperationId);
	if (
		!question ||
		question.kind !== "question" ||
		!question.sourceRefs.includes(current.operationId)
	)
		throw new Error("patrol question source mismatch");
	const target = obj(result.target),
		recipient = obj(obj(question.material).question).to;
	if (hash(target) !== hash(recipient))
		throw new Error("patrol question target mismatch");
	const snapshot = obj(obj(current.material).snapshot),
		projects = snapshot.projects as Obj[];
	const project = projects.find((p) => p.projectName === target.project);
	if (
		!project ||
		!Array.isArray(result.evidenceRefs) ||
		!result.evidenceRefs.length ||
		result.evidenceRefs.length > 20 ||
		new Set(result.evidenceRefs).size !== result.evidenceRefs.length
	)
		throw new Error("patrol question evidence required");
	for (const ref of result.evidenceRefs) {
		if (typeof ref !== "string") throw new Error("invalid question evidence");
		const [name, group, key, ...rest] = ref.split(".");
		if (
			name !== target.project ||
			!group ||
			!key ||
			rest.length ||
			!Object.hasOwn(project, group)
		)
			throw new Error("invalid question evidence");
		const fields = obj(project[group]);
		if (!Object.hasOwn(fields, key) || typeof obj(fields[key]).ok !== "boolean")
			throw new Error("invalid question evidence");
	}
	return question;
}
export function resumePatrolQuestion(
	store: OperationStore,
	current: StoredOperation,
): StoredOperation {
	if (current.stage !== "awaiting_question") return current;
	const material = obj(current.material),
		decision = obj(material.decision);
	const question = bindQuestion(store, current, decision);
	if (question.inputDigest !== material.questionDigest)
		throw new Error("patrol question binding changed");
	const qm = obj(question.material);
	const sent =
		Array.isArray(qm.receipts) &&
		qm.receipts.map(obj).some((receipt) => {
			const result = obj(receipt.result);
			return (
				receipt.tool === "lead_actions.discord_send" &&
				result.status === "sent" &&
				result.engagement === "ready" &&
				result.threadId === qm.messageId &&
				result.messageId === qm.messageId &&
				result.eventId === obj(qm.prepared).eventId
			);
		});
	if (!sent && !["cancelled", "expired"].includes(question.stage))
		return current;
	return store.commit(
		{
			...current,
			stage: "complete",
			material: {
				...material,
				questionOutcome: sent ? "asked" : question.stage,
				questionReceipt: {
					operationId: question.operationId,
					revision: question.revision,
					stage: question.stage,
					messageId: qm.messageId ?? null,
					channelId: qm.channelId ?? null,
				},
			},
		},
		current.revision,
	);
}
export function recordPatrol(
	store: OperationStore,
	workspace: string,
	current: StoredOperation,
	input: Obj,
	now: number,
): StoredOperation {
	if (
		current.stage !== "judging" ||
		typeof input.callId !== "string" ||
		!input.callId.trim()
	)
		throw new Error("patrol is not awaiting judgment");
	const result = obj(input.result),
		material = obj(current.material);
	if (result.action === "question") {
		const question = bindQuestion(store, current, result);
		return store.commit(
			{
				...current,
				stage: "awaiting_question",
				material: {
					...material,
					decision: result,
					questionDigest: question.inputDigest,
					receipts: [{ tool: "current_turn", callId: input.callId, result }],
				},
			},
			current.revision,
		);
	}
	if (result.action === "silent") {
		if (
			Object.keys(result).some((k) => !["action", "reason"].includes(k)) ||
			typeof result.reason !== "string" ||
			!result.reason.trim() ||
			result.reason.length > 1800
		)
			throw new Error("silent reason required");
		return store.commit(
			{
				...current,
				stage: "complete",
				material: {
					...material,
					decision: result,
					receipts: [{ tool: "current_turn", callId: input.callId, result }],
				},
			},
			current.revision,
		);
	}
	if (
		result.action !== "observation" ||
		typeof result.text !== "string" ||
		Object.keys(result).some((k) => !["action", "text"].includes(k))
	)
		throw new Error("invalid patrol decision");
	const blocked = patrolBlock(workspace, current, now, result.text);
	if (blocked) throw new Error(`patrol evidence rejected: ${blocked}`);
	const context = {
		snapshot: material.snapshot as unknown as ScopedDriftContext["snapshot"],
		goals: parseGoalsFile(String(material.goalsBody)),
		now: new Date(now),
		staleAfterMs: 300000,
	};
	const validated = validateScopedDriftEnvelope(
		parseDriftEnvelope(result.text),
		context,
	);
	if (validated.kind !== "valid") throw new Error("invalid observation");
	const eventId = `portfolio:${obj(material.snapshot).snapshotId}:judgment`,
		payload = { target: "chat", text: validated.content, eventId };
	return store.commit(
		{
			...current,
			stage: "prepared",
			material: {
				...material,
				decision: result,
				prepared: {
					tool: "lead_actions.discord_send",
					eventId,
					target: "chat",
					payloadDigest: hash(payload),
					payload,
				},
				receipts: [{ tool: "current_turn", callId: input.callId, result }],
			},
		},
		current.revision,
	);
}
export function patrolSpecialView(
	current: StoredOperation,
	store: OperationStore,
): BusinessRoundView {
	const material = obj(current.material);
	const question =
		current.stage === "awaiting_question"
			? store.read(String(obj(material.decision).questionOperationId))
			: null;
	const uncertain = question?.stage === "unknown";
	return {
		schemaVersion: 2,
		operationId: current.operationId,
		revision: current.revision,
		stage: current.stage,
		next:
			current.stage === "judging"
				? {
						tool: "current_turn",
						arguments: {
							action: "judge_patrol",
							snapshot: material.snapshot,
							goalsBody: material.goalsBody,
						},
					}
				: question && !uncertain
					? {
							tool: "current_turn",
							arguments: {
								action: "resume_question",
								operationId: question.operationId,
							},
						}
					: null,
		needsReconciliation: uncertain,
		receipts: material.receipts as Obj[],
		material,
	};
}
