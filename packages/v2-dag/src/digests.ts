import { createHash } from "node:crypto";

export type CanonicalValue =
	| null
	| boolean
	| number
	| string
	| CanonicalValue[]
	| { [key: string]: CanonicalValue };

export function canonicalJson(value: CanonicalValue): string {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("canonical JSON requires a plain object");
	}
	return `{${Object.entries(value)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(",")}}`;
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function digestJson(value: CanonicalValue): string {
	return sha256(canonicalJson(value));
}

export interface ActionLogicalLineage {
	taskId: string;
	attemptId: string;
	attemptGeneration: number;
}

export function actionLogicalKey(input: {
	actorAgentId: string;
	cutoverEpoch: number;
	kind: string;
	logicalEffectId: string;
	lineage?: ActionLogicalLineage | null;
}): string {
	const lineage = input.lineage ?? null;
	return digestJson({
		attemptGeneration: lineage?.attemptGeneration ?? null,
		attemptId: lineage?.attemptId ?? null,
		cutoverEpoch: input.cutoverEpoch,
		kind: input.kind,
		logicalEffectId: input.logicalEffectId,
		taskId: lineage?.taskId ?? null,
		unboundActorAgentId: lineage ? null : input.actorAgentId,
	});
}

export function unboundActionLogicalKey(
	input: Omit<Parameters<typeof actionLogicalKey>[0], "lineage">,
): string {
	return actionLogicalKey(input);
}
