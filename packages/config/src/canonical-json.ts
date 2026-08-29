import { createHash } from "node:crypto";

/**
 * Stable JSON encoding shared by CommDB source events and the StateStore
 * workflow ledger. Object keys are sorted recursively; array order is data.
 */
export function canonicalJsonString(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value
			.map((child) =>
				child === undefined ? "null" : canonicalJsonString(child),
			)
			.join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(
				([key, child]) =>
					`${JSON.stringify(key)}:${canonicalJsonString(child)}`,
			);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** One digest contract for capability submissions and cross-database events. */
export function canonicalSubmissionDigest(payload: unknown): string {
	return createHash("sha256")
		.update(canonicalJsonString(payload))
		.digest("hex");
}
