import { createHash } from "node:crypto";
import type { JsonValue, OperationStore } from "./operation-store.js";

type Obj = { [key: string]: JsonValue };
function obj(value: unknown): Obj {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid memory draft object");
	return value as Obj;
}
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const identity = (entry: Obj) =>
	JSON.stringify([
		entry.pr,
		entry.head,
		entry.path,
		entry.roundId,
		entry.project,
	]);
export function prepareMemoryDraft(
	store: OperationStore,
	material: Obj,
	input: Obj,
): Obj {
	const progress = obj(material.progress),
		reconciliation = obj(progress.reconciliation);
	if (!["ready", "memory_needed"].includes(String(reconciliation.status)))
		throw new Error("clean known memory reconciliation required");
	if (
		input.baseCommit !== reconciliation.memoryCommit ||
		typeof input.baseBody !== "string" ||
		Buffer.byteLength(input.baseBody) > 256 * 1024 ||
		digest(input.baseBody) !== reconciliation.memoryBodySha256
	)
		throw new Error("memory base does not match observed content");
	if (!Array.isArray(input.entries) || !input.entries.length)
		throw new Error("memory draft entries required");
	const known = Array.isArray(reconciliation.missing)
		? reconciliation.missing.map(obj)
		: [];
	for (const operation of store.list()) {
		if (operation.kind !== "summary" || operation.stage !== "merged") continue;
		const snapshot = obj(obj(operation.material).snapshot);
		if (snapshot.roundId !== material.roundId || !Array.isArray(snapshot.files))
			continue;
		for (const file of snapshot.files.map(obj))
			known.push({
				pr: snapshot.pr,
				head: snapshot.head,
				path: file.path,
				project: snapshot.project,
				roundId: snapshot.roundId,
			});
	}
	const old =
		progress.memoryDraft === undefined ? undefined : obj(progress.memoryDraft);
	if (
		old &&
		(old.stage !== "draft" ||
			old.baseCommit !== input.baseCommit ||
			old.baseSha256 !== digest(input.baseBody))
	)
		throw new Error("memory draft base is already frozen");
	const entries = new Map<string, Obj>();
	if (old) {
		if (!Array.isArray(old.entries))
			throw new Error("corrupt memory draft entries");
		for (const entry of old.entries.map(obj))
			entries.set(identity(entry), entry);
	}
	for (const raw of input.entries) {
		const entry = obj(raw);
		if (
			typeof entry.understanding !== "string" ||
			!entry.understanding.trim() ||
			Buffer.byteLength(entry.understanding) > 8192
		)
			throw new Error("memory entry understanding required");
		const source = known.find((item) => identity(item) === identity(entry));
		if (!source)
			throw new Error(
				"memory entry source is not a reconciled or merged summary",
			);
		const normalized = {
			...source,
			origin: (reconciliation.missing as JsonValue[])
				.map(obj)
				.some((item) => identity(item) === identity(source))
				? "historical"
				: "current_round",
			understanding: entry.understanding,
		};
		const previous = entries.get(identity(entry));
		if (previous && JSON.stringify(previous) !== JSON.stringify(normalized))
			throw new Error("prepared memory entry cannot be replaced");
		entries.set(identity(entry), normalized);
	}
	const ordered = [...entries.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, entry]) => entry);
	const sections = ordered.map(
		(entry) =>
			`## ${entry.project}\n\n${entry.understanding}\n\nProvenance: PR #${entry.pr}; ${entry.path}; head=${entry.head}; roundId=${entry.roundId}\n`,
	);
	const body = `${input.baseBody}${input.baseBody.endsWith("\n") ? "\n" : "\n\n"}${sections.join("\n")}`;
	if (Buffer.byteLength(body) > 512 * 1024)
		throw new Error("memory draft exceeds limit");
	return {
		stage: "draft",
		baseCommit: input.baseCommit,
		baseSha256: digest(input.baseBody),
		body,
		bodySha256: digest(body),
		entries: ordered,
		commitMessage: `Absorb summaries ${material.roundId}`,
		path: "memory/MEMORY.md",
	};
}

export function recordMemoryProgress(
	store: OperationStore,
	material: Obj,
	input: Obj,
): Obj {
	const progress = obj(material.progress),
		draft = obj(progress.memoryDraft);
	if (input.action === "memory_finalize") {
		if (draft.stage !== "draft")
			throw new Error("memory finalization already frozen");
		const reconciliation = obj(progress.reconciliation);
		if (
			!["ready", "memory_needed"].includes(String(reconciliation.status)) ||
			reconciliation.memoryCommit !== draft.baseCommit ||
			reconciliation.memoryBodySha256 !== draft.baseSha256
		)
			throw new Error("memory base reconciliation changed");
		const required = (reconciliation.missing as JsonValue[]).map(obj);
		const summaries = store
			.list()
			.filter(
				(op) =>
					op.kind === "summary" &&
					obj(obj(op.material).snapshot).roundId === material.roundId,
			);
		for (const item of (material.inventory as JsonValue[]).map(obj)) {
			const matching = summaries.filter((op) => {
				const s = obj(obj(op.material).snapshot);
				return (
					s.pr === item.pr &&
					s.head === item.head &&
					s.project === item.project &&
					s.lead === item.lead
				);
			});
			const operation = matching[0];
			if (
				!operation ||
				matching.length !== 1 ||
				!["merged", "question_needed", "closed", "head_changed"].includes(
					operation.stage,
				)
			)
				throw new Error("summary inventory has unfinished review or merge");
			if (operation.stage === "merged") {
				const snapshot = obj(obj(operation.material).snapshot);
				for (const file of (snapshot.files as JsonValue[]).map(obj))
					required.push({
						pr: snapshot.pr,
						head: snapshot.head,
						project: snapshot.project,
						roundId: snapshot.roundId,
						path: file.path,
					});
			}
		}
		const entries = (draft.entries as JsonValue[]).map(obj);
		if (
			required.some(
				(source) =>
					!entries.some((entry) => identity(entry) === identity(source)),
			)
		)
			throw new Error("memory provenance coverage incomplete");
		return { ...draft, stage: "prepared" };
	}
	if (input.action === "memory_result") {
		if (!["prepared", "unknown"].includes(String(draft.stage)))
			throw new Error("memory commit is not pending");
		if (input.outcome === "unknown") return { ...draft, stage: "unknown" };
		if (
			input.outcome !== "committed" ||
			typeof input.commit !== "string" ||
			!/^[a-f0-9]{40}$/.test(input.commit) ||
			input.commit === draft.baseCommit ||
			input.parent !== draft.baseCommit ||
			input.bodySha256 !== draft.bodySha256 ||
			input.message !== draft.commitMessage ||
			!Array.isArray(input.changedPaths) ||
			input.changedPaths.length !== 1 ||
			input.changedPaths[0] !== "MEMORY.md"
		)
			throw new Error("memory commit does not match frozen plan");
		return {
			...draft,
			stage: "committed",
			commit: input.commit,
			push: "pending",
		};
	}
	if (input.action === "memory_push") {
		if (
			draft.stage !== "committed" ||
			input.commit !== draft.commit ||
			!["failed", "unknown", "pushed"].includes(String(input.outcome))
		)
			throw new Error("invalid memory push receipt");
		if (draft.push === "pushed" && input.outcome !== "pushed")
			throw new Error("confirmed memory push cannot regress");
		return { ...draft, push: input.outcome };
	}
	throw new Error("unsupported memory action");
}

export function memoryTask(draft: Obj): string {
	if (draft.stage === "draft")
		return "Keep the memory draft durable while reviewing the remaining frozen inventory. Do not write or commit until memory_finalize; draft is not committed provenance.";
	if (draft.stage === "prepared" || draft.stage === "unknown")
		return "Use standard read-only git tools in the memory repository to reconcile the frozen commit message, parent, MEMORY.md body hash and exclusive changed path before any write. If no matching commit exists, verify the unchanged base and clean worktree before applying exactly the frozen body and creating the single planned commit. Dirty or ambiguous state pauses writes. Record memory_result; never blindly repeat a commit.";
	if (draft.stage === "committed" && draft.push !== "pushed")
		return "Use standard git tools in the memory repository to reconcile the remote and push the recorded commit without force; do not create another commit. Record memory_push for this exact commit; preserve unknown outcomes and failures for recovery and reporting.";
	return "Memory commit and push recorded. Prepare the round report with the original report_line and actual review, absorption and question outcomes; report receipt is still required.";
}

export function memoryAllowsUnread(progress: Obj): boolean {
	const reconciliation = obj(progress.reconciliation);
	const draft =
		progress.memoryDraft === undefined ? undefined : obj(progress.memoryDraft);
	// Finalization closes this inventory against new work, including duplicate operations.
	if (draft && draft.stage !== "draft") return false;
	if (reconciliation.status === "ready") return true;
	if (
		reconciliation.status !== "memory_needed" ||
		!draft ||
		draft.baseCommit !== reconciliation.memoryCommit ||
		draft.baseSha256 !== reconciliation.memoryBodySha256 ||
		typeof draft.body !== "string" ||
		digest(draft.body) !== draft.bodySha256 ||
		!Array.isArray(draft.entries) ||
		!Array.isArray(reconciliation.missing)
	)
		return false;
	const entries = draft.entries.map(obj);
	return reconciliation.missing
		.map(obj)
		.every((source) =>
			entries.some(
				(entry) =>
					entry.origin === "historical" &&
					identity(entry) === identity(source) &&
					typeof entry.understanding === "string" &&
					entry.understanding.trim(),
			),
		);
}
