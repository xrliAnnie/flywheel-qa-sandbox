import { createHash } from "node:crypto";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "./operation-store.js";
import { hasConfirmedQuestionSend } from "./question-intent.js";

type Obj = { [key: string]: JsonValue };
const obj = (value: unknown): Obj => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid summary presentation object");
	return value as Obj;
};
const canonical = (value: JsonValue, depth = 0): string => {
	if (depth > 64)
		throw new Error("summary presentation outcome exceeds depth limit");
	if (Array.isArray(value))
		return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as { [key: string]: JsonValue };
		return `{${Object.keys(record)
			.sort()
			.map((key) => {
				const item = record[key];
				if (item === undefined)
					throw new Error("summary presentation member is not JSON");
				return `${JSON.stringify(key)}:${canonical(item, depth + 1)}`;
			})
			.join(",")}}`;
	}
	return JSON.stringify(value);
};
const canonicalHash = (value: JsonValue) =>
	createHash("sha256").update(canonical(value)).digest("hex");
const exactKeys = (value: Obj, expected: string[]) => {
	const actual = Object.keys(value).sort();
	const wanted = expected.slice().sort();
	return (
		actual.length === wanted.length &&
		actual.every((key, index) => key === wanted[index])
	);
};

function failedBusinessState(material: Obj): { memoryStatus?: string } {
	if (material.progress === undefined) return {};
	const progress = obj(material.progress);
	if (progress.memoryDraft === undefined) return {};
	const draft = obj(progress.memoryDraft);
	if (draft.stage === "draft") return {};
	return {
		memoryStatus:
			draft.stage === "committed" && draft.push === "pushed"
				? "committed_pushed"
				: "committed_push_pending",
	};
}

function completedBusinessState(
	store: OperationStore,
	material: Obj,
): {
	memoryStatus: string;
	reviewed: number;
	absorbed: number;
	questionNeeded: number;
	asked: number;
	reviews: Array<{ operationId: string; revision: number; stage: string }>;
} {
	const progress = obj(material.progress);
	const reconciliation = obj(progress.reconciliation);
	const draft =
		progress.memoryDraft === undefined ? undefined : obj(progress.memoryDraft);
	const all = store.list();
	const reviews: StoredOperation[] = [];
	for (const item of (material.inventory as JsonValue[]).map(obj)) {
		const candidates = all.filter((operation) => {
			if (operation.kind !== "summary") return false;
			const snapshot = obj(obj(operation.material).snapshot);
			return (
				snapshot.roundId === material.roundId &&
				snapshot.pr === item.pr &&
				snapshot.head === item.head &&
				snapshot.project === item.project &&
				snapshot.lead === item.lead
			);
		});
		const operation = candidates[0];
		if (
			candidates.length !== 1 ||
			!operation ||
			!["merged", "question_needed", "closed", "head_changed"].includes(
				operation.stage,
			)
		) {
			throw new Error("summary presentation inventory unfinished");
		}
		reviews.push(operation);
	}
	const absorbed = reviews.filter(
		(operation) => operation.stage === "merged",
	).length;
	let memoryStatus: string;
	if (draft) {
		if (draft.stage !== "committed")
			throw new Error("memory commit unfinished");
		memoryStatus =
			draft.push === "pushed" ? "committed_pushed" : "committed_push_pending";
	} else {
		if (
			reconciliation.status !== "ready" ||
			absorbed !== 0 ||
			!Array.isArray(reconciliation.missing) ||
			reconciliation.missing.length
		) {
			throw new Error("memory is not clean and unchanged");
		}
		memoryStatus = "unchanged";
	}
	const questions = reviews.filter(
		(operation) => operation.stage === "question_needed",
	);
	const asked = questions.filter((summary) =>
		all.some((operation) => {
			if (
				operation.kind !== "question" ||
				!operation.sourceRefs.includes(summary.operationId)
			) {
				return false;
			}
			const question = obj(operation.material);
			const to = obj(obj(question.question).to);
			const snapshot = obj(obj(summary.material).snapshot);
			return (
				to.project === snapshot.project &&
				to.leadId === snapshot.lead &&
				hasConfirmedQuestionSend(question)
			);
		}),
	).length;
	return {
		memoryStatus,
		reviewed: reviews.length,
		absorbed,
		questionNeeded: questions.length,
		asked,
		reviews: reviews.map((operation) => ({
			operationId: operation.operationId,
			revision: operation.revision,
			stage: operation.stage,
		})),
	};
}

/**
 * Bind one completed business round to the canonical Bridge presentation
 * member receipt. This stores no founder-visible body and cannot send.
 */
export function recordRoundPresentation(
	store: OperationStore,
	material: Obj,
	result: Obj,
): Obj {
	if (!exactKeys(result, ["status", "member"]) || result.status !== "recorded")
		throw new Error("summary presentation receipt shape mismatch");
	const member = obj(result.member);
	let outcomeJson: string | undefined;
	try {
		outcomeJson = JSON.stringify(member.outcome);
	} catch {
		throw new Error("summary presentation receipt shape mismatch");
	}
	if (
		!exactKeys(member, [
			"projectName",
			"leadId",
			"roundId",
			"groupId",
			"sourceSeq",
			"slotStartMs",
			"businessState",
			"outcome",
			"evidenceRef",
		]) ||
		!Number.isSafeInteger(member.sourceSeq) ||
		Number(member.sourceSeq) < 0 ||
		!Number.isSafeInteger(member.slotStartMs) ||
		Number(member.slotStartMs) < 0 ||
		outcomeJson === undefined ||
		Buffer.byteLength(outcomeJson) > 32_000
	) {
		throw new Error("summary presentation receipt shape mismatch");
	}
	if (
		typeof member.groupId !== "string" ||
		!member.groupId.trim() ||
		member.groupId.length > 200 ||
		member.roundId !== material.roundId ||
		member.slotStartMs !==
			Date.parse(
				String(material.roundId).slice("summary-absorption:".length),
			) ||
		member.projectName !== "raya" ||
		member.leadId !== "raya" ||
		!["complete", "failed"].includes(String(member.businessState)) ||
		typeof member.evidenceRef !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,511}$/.test(member.evidenceRef) ||
		member.evidenceRef.includes("..")
	) {
		throw new Error("summary presentation member binding mismatch");
	}
	const presentation = {
		groupId: member.groupId,
		roundId: member.roundId,
		sourceSeq: member.sourceSeq,
		slotStartMs: member.slotStartMs,
		businessState: member.businessState,
		evidenceRef: member.evidenceRef,
		memberDigest: canonicalHash(member),
	};
	return member.businessState === "failed"
		? { ...failedBusinessState(material), ...presentation }
		: { ...completedBusinessState(store, material), ...presentation };
}
