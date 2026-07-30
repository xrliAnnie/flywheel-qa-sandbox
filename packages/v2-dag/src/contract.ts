import type { CanonicalValue } from "./digests.js";
import { DagContractError } from "./errors.js";
import type {
	DeclaredContractItem,
	ExecutorDescriptor,
	TaskDescriptor,
} from "./types.js";

export interface TaskPayload {
	contract: DeclaredContractItem[];
	writes_repo: boolean;
	worktree_id: string | null;
	executor: ExecutorDescriptor;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DagContractError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	label: string,
): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new DagContractError(`${label} has unexpected fields`);
	}
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new DagContractError(`${label} must be non-empty`);
	}
	return value;
}

function parseItem(value: unknown): DeclaredContractItem {
	const item = record(value, "contract item");
	if (item.kind === "verdict") {
		exactKeys(item, ["kind"], "verdict contract");
		return { kind: "verdict" };
	}
	if (item.kind === "review_approval") {
		exactKeys(item, ["kind", "review"], "review contract");
		return {
			kind: "review_approval",
			review: text(item.review, "review"),
		};
	}
	if (item.kind === "artifact") {
		const keys =
			item.digest === undefined
				? ["cardinality", "kind", "path"]
				: ["cardinality", "digest", "kind", "path"];
		exactKeys(item, keys, "artifact contract");
		if (item.cardinality !== "one" && item.cardinality !== "many") {
			throw new DagContractError("artifact cardinality is invalid");
		}
		return {
			kind: "artifact",
			path: text(item.path, "artifact path"),
			cardinality: item.cardinality,
			...(item.digest === undefined
				? {}
				: { digest: text(item.digest, "artifact digest") }),
		};
	}
	throw new DagContractError("contract item kind is invalid");
}

export function parseDeclaredContractConfig(
	source: string,
): DeclaredContractItem[] {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new DagContractError("declared contract config is invalid JSON");
	}
	if (!Array.isArray(value)) {
		throw new DagContractError("declared contract config must be an array");
	}
	return value.map(parseItem);
}

function parseExecutor(value: unknown): ExecutorDescriptor {
	const executor = record(value, "executor");
	// FLY-1544 ①: the role layer is deleted. A `logicalAgentId` key is still
	// TOLERATED (and dropped) so durable pre-FLY-1544 task payloads keep
	// parsing; new payloads carry exactly the four executor fields.
	const keys =
		executor.logicalAgentId === undefined
			? ["effort", "family", "model", "vendor"]
			: ["effort", "family", "logicalAgentId", "model", "vendor"];
	exactKeys(executor, keys, "executor");
	return {
		family: text(executor.family, "family"),
		vendor: text(executor.vendor, "vendor"),
		model: text(executor.model, "model"),
		effort: text(executor.effort, "effort"),
	};
}

export function taskPayloadFromDescriptor(task: TaskDescriptor): TaskPayload {
	return parseTaskPayload({
		contract: task.contract,
		writes_repo: task.writesRepo,
		worktree_id: task.worktreeId,
		executor: task.executor,
	});
}

export function parseTaskPayload(value: unknown): TaskPayload {
	const payload = record(value, "task payload");
	exactKeys(
		payload,
		["contract", "executor", "worktree_id", "writes_repo"],
		"task payload",
	);
	if (!Array.isArray(payload.contract)) {
		throw new DagContractError("contract must be an array");
	}
	if (typeof payload.writes_repo !== "boolean") {
		throw new DagContractError("writes_repo must be boolean");
	}
	if (
		payload.worktree_id !== null &&
		(typeof payload.worktree_id !== "string" ||
			payload.worktree_id.trim().length === 0)
	) {
		throw new DagContractError("worktree_id is invalid");
	}
	if (payload.writes_repo && payload.worktree_id === null) {
		throw new DagContractError("writes_repo task requires worktree_id");
	}
	return {
		contract: payload.contract.map(parseItem),
		writes_repo: payload.writes_repo,
		worktree_id: payload.worktree_id,
		executor: parseExecutor(payload.executor),
	};
}

export function taskPayloadJson(payload: TaskPayload): CanonicalValue {
	return payload as unknown as CanonicalValue;
}
