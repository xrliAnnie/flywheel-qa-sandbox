import { createHash } from "node:crypto";
import type { BusinessRoundView } from "../business-round.js";
import {
	containsSecretLikeText,
	type Goal,
	nextGoalId,
	parseGoalsFile,
	renderGoalsFile,
} from "../contracts/index.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "../operation-store.js";

type Obj = { [key: string]: JsonValue };
const obj = (value: unknown): Obj => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid goal update object");
	return value as Obj;
};
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bodyHash = (body: string) =>
	createHash("sha256").update(body).digest("hex");
const sha = (value: unknown) =>
	typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const id = (value: unknown) =>
	typeof value === "string" && /^\d{17,20}$/.test(value);
const keys = (value: Obj, allowed: string[]) => {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error("unknown goal update field");
};
export function prepareGoalUpdate(
	store: OperationStore,
	input: Obj,
): BusinessRoundView {
	keys(input, [
		"schemaVersion",
		"kind",
		"founderUserId",
		"source",
		"projects",
		"memory",
	]);
	const source = obj(input.source),
		memory = obj(input.memory);
	keys(source, [
		"authorId",
		"messageId",
		"channelId",
		"sourceUrl",
		"at",
		"body",
	]);
	keys(memory, ["status", "commit", "body"]);
	if (!id(input.founderUserId) || source.authorId !== input.founderUserId)
		throw new Error("goal source must match the platform founder identity");
	if (
		!id(source.messageId) ||
		!id(source.channelId) ||
		typeof source.sourceUrl !== "string" ||
		!new RegExp(
			`^https://discord\\.com/channels/\\d+/${source.channelId}/${source.messageId}$`,
		).test(source.sourceUrl) ||
		typeof source.at !== "string" ||
		!Number.isFinite(Date.parse(source.at)) ||
		typeof source.body !== "string" ||
		!source.body.trim() ||
		source.body.length > 8192 ||
		containsSecretLikeText(source.body)
	)
		throw new Error("invalid goal source material");
	if (
		memory.status !== "clean" ||
		!sha(memory.commit) ||
		typeof memory.body !== "string" ||
		Buffer.byteLength(memory.body) > 256 * 1024
	)
		throw new Error("clean observed goals base required");
	if (memory.body) parseGoalsFile(memory.body);
	if (
		!Array.isArray(input.projects) ||
		!input.projects.length ||
		input.projects.length > 100 ||
		input.projects.some(
			(p) => typeof p !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p),
		) ||
		new Set(input.projects).size !== input.projects.length
	)
		throw new Error("complete project scope required");
	const frozen = {
		source,
		founderUserId: input.founderUserId,
		projects: input.projects,
		memory,
	};
	const operationId = `goals:${source.channelId}:${source.messageId}`,
		inputDigest = hash(frozen),
		old = store.read(operationId);
	if (old) {
		if (old.kind !== "goal_update" || old.inputDigest !== inputDigest)
			throw new Error("goal source/base binding conflict");
		return goalUpdateView(old);
	}
	return goalUpdateView(
		store.commit(
			{
				operationId,
				inputDigest,
				kind: "goal_update",
				stage: "reviewing",
				sourceRefs: [source.sourceUrl],
				material: { frozen, receipts: [] },
			},
			0,
		),
	);
}
function planGoals(frozen: Obj, result: Obj): Obj {
	keys(result, ["action", "decisions"]);
	if (!Array.isArray(result.decisions) || result.decisions.length > 5)
		throw new Error("bounded goal decisions required");
	const source = obj(frozen.source),
		memory = obj(frozen.memory),
		sourceUrl = String(source.sourceUrl),
		recordedAt = new Date(String(source.at)).toISOString();
	const goals = memory.body ? parseGoalsFile(String(memory.body)) : [];
	const originalBody = String(memory.body);
	for (const [index, raw] of result.decisions.entries()) {
		const decision = obj(raw);
		keys(decision, ["action", "kind", "text", "projects", "goalId"]);
		if (!["record", "correct", "withdraw"].includes(String(decision.action)))
			throw new Error("unsupported goal decision");
		let previous: Goal | undefined;
		if (decision.action !== "record") {
			previous = goals.find((goal) => goal.id === decision.goalId);
			if (!previous || previous.status !== "active")
				throw new Error("goal is not active");
			previous.status = "withdrawn";
			previous.withdrawnAt = recordedAt;
			previous.withdrawnSourceUrl = sourceUrl;
			previous.withdrawOperationId = `${source.messageId}:withdraw:${index}`;
		}
		if (decision.action === "withdraw") continue;
		if (
			!["inference", "commitment"].includes(String(decision.kind)) ||
			typeof decision.text !== "string" ||
			!decision.text.trim() ||
			Array.from(decision.text).length > 500 ||
			/[\r\n]/.test(decision.text) ||
			containsSecretLikeText(decision.text)
		)
			throw new Error("invalid goal text or kind");
		if (
			decision.kind === "commitment" &&
			!String(source.body).includes(decision.text)
		)
			throw new Error("commitment must preserve the source quotation");
		if (
			!Array.isArray(decision.projects) ||
			!decision.projects.length ||
			new Set(decision.projects).size !== decision.projects.length ||
			decision.projects.some(
				(project) => !(frozen.projects as JsonValue[]).includes(project),
			)
		)
			throw new Error("goal project scope mismatch");
		goals.push({
			id: nextGoalId(goals, recordedAt.slice(0, 10)),
			operationId: `${source.messageId}:record:${index}`,
			recordedAt,
			sourceUrl,
			status: "active",
			text: decision.text,
			kind: decision.kind as "inference" | "commitment",
			projects: decision.projects as string[],
			revision: (previous?.revision ?? (previous ? 1 : 0)) + 1,
			...(previous ? { supersedes: previous.id } : {}),
		});
	}
	const body = result.decisions.length ? renderGoalsFile(goals) : originalBody;
	if (body) parseGoalsFile(body);
	return {
		body,
		bodySha256: bodyHash(body),
		baseCommit: memory.commit,
		baseSha256: bodyHash(originalBody),
		path: "goals.md",
		commitMessage: `Update goals from ${source.messageId}`,
		goals: JSON.parse(JSON.stringify(goals)) as JsonValue,
		changed: body !== originalBody,
	};
}
export function recordGoalUpdate(
	store: OperationStore,
	current: StoredOperation,
	input: Obj,
): BusinessRoundView {
	goalUpdateView(current);
	if (
		input.tool !== "current_turn" ||
		typeof input.callId !== "string" ||
		!input.callId.trim() ||
		current.stage === "complete"
	)
		throw new Error("invalid goal result source or stage");
	const material = obj(current.material),
		frozen = obj(material.frozen),
		result = obj(input.result);
	let stage = current.stage,
		updated: Obj = { ...material };
	if (result.action === "plan") {
		if (stage !== "reviewing") throw new Error("goal plan already frozen");
		const plan = planGoals(frozen, result);
		updated.plan = plan;
		stage = plan.changed ? "prepared" : "complete";
	} else if (result.action === "commit") {
		keys(result, [
			"action",
			"outcome",
			"commit",
			"parent",
			"bodySha256",
			"changedPaths",
			"message",
		]);
		if (!["prepared", "unknown"].includes(stage))
			throw new Error("goal commit is not pending");
		if (result.outcome === "unknown") stage = "unknown";
		else {
			const plan = obj(material.plan);
			if (
				result.outcome !== "committed" ||
				!sha(result.commit) ||
				result.commit === plan.baseCommit ||
				result.parent !== plan.baseCommit ||
				result.bodySha256 !== plan.bodySha256 ||
				result.message !== plan.commitMessage ||
				!Array.isArray(result.changedPaths) ||
				result.changedPaths.length !== 1 ||
				result.changedPaths[0] !== "goals.md"
			)
				throw new Error("goal commit does not match frozen plan");
			stage = "committed";
			updated.commit = result.commit;
			updated.push = "pending";
		}
	} else if (result.action === "push") {
		keys(result, ["action", "outcome", "commit"]);
		if (
			stage !== "committed" ||
			result.commit !== material.commit ||
			!["pushed", "failed", "unknown"].includes(String(result.outcome))
		)
			throw new Error("invalid goal push receipt");
		updated.push = result.outcome;
		if (result.outcome === "pushed") stage = "complete";
	} else throw new Error("unsupported goal result");
	updated.receipts = [
		...(material.receipts as JsonValue[]),
		{ tool: input.tool, callId: input.callId, result },
	];
	return goalUpdateView(
		store.commit({ ...current, stage, material: updated }, current.revision),
	);
}
export function goalUpdateView(current: StoredOperation): BusinessRoundView {
	const material = obj(current.material);
	if (
		current.kind !== "goal_update" ||
		hash(material.frozen) !== current.inputDigest ||
		!Array.isArray(material.receipts)
	)
		throw new Error("corrupt goal update");
	const task =
		current.stage === "reviewing"
			? "Read the actual founder message and propose bounded goal decisions. No marker syntax is required. Label inferred priorities as inference; commitments preserve exact source words. Corrections withdraw the old goal and link a successor; Lead/summary text cannot override founder goals. An empty decision list is valid."
			: current.stage === "committed"
				? "Use standard git tools to reconcile and push this exact recorded memory-repository commit without force. Record action push and its real outcome; preserve failures and report them visibly."
				: "Use standard read-only git tools in the memory repository to reconcile this single frozen goals.md commit before any write. If absent, require the unchanged base and clean goals path, then apply exactly the planned body with only goals.md in the commit. Dirty/ambiguous states pause writes. Record action commit with actual commit, parent, bodySha256, changedPaths and message; never blindly create another commit.";
	return {
		schemaVersion: 2,
		operationId: current.operationId,
		revision: current.revision,
		stage: current.stage,
		next:
			current.stage === "complete"
				? null
				: { tool: "current_turn", arguments: { task } },
		needsReconciliation: current.stage === "unknown",
		receipts: (material.receipts as JsonValue[]).map(obj),
		material,
	};
}
