import { createHash } from "node:crypto";

export interface PercentageModelSplitPolicy {
	readonly enabled: true;
	readonly rule: "issue_number_percentage";
	readonly version: string;
	readonly codexPercent: number;
	readonly codex: { readonly arm: "A"; readonly model: "astra" };
	readonly fable: { readonly arm: "B"; readonly model: "fable" };
}

/** Frozen fly2570-v1 serialization: retain this algorithm for historical replay. */
export function parsePercentageModelSplit(
	value: unknown,
): PercentageModelSplitPolicy {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("modelSplit must be an object");
	const raw = value as Record<string, unknown>;
	const allowed = new Set([
		"enabled",
		"rule",
		"version",
		"codexPercent",
		"codex",
		"fable",
	]);
	for (const key of Object.keys(raw))
		if (!allowed.has(key)) throw new Error(`modelSplit unknown key: ${key}`);
	if (raw.rule !== "issue_number_percentage")
		throw new Error("modelSplit.rule must be issue_number_percentage");
	if (raw.enabled !== true)
		throw new Error(
			"percentage modelSplit.enabled must be true; use set --codex-percent 0 for Fable-only design routing",
		);
	if (
		typeof raw.codexPercent !== "number" ||
		!Number.isFinite(raw.codexPercent) ||
		raw.codexPercent < 0 ||
		raw.codexPercent > 100
	)
		throw new Error(
			"modelSplit.codexPercent must be a finite number from 0 to 100",
		);
	for (const [key, arm, model] of [
		["codex", "A", "astra"],
		["fable", "B", "fable"],
	] as const) {
		const v = raw[key];
		if (!v || typeof v !== "object" || Array.isArray(v))
			throw new Error(`modelSplit.${key} must be an arm object`);
		const entry = v as Record<string, unknown>;
		if (
			Object.keys(entry).some((k) => k !== "arm" && k !== "model") ||
			entry.arm !== arm ||
			entry.model !== model
		)
			throw new Error(`modelSplit.${key} must be ${arm}/${model}`);
	}
	const semantics = {
		rule: "issue_number_percentage" as const,
		codexPercent: raw.codexPercent === 0 ? 0 : raw.codexPercent,
		codex: Object.freeze({ arm: "A" as const, model: "astra" as const }),
		fable: Object.freeze({ arm: "B" as const, model: "fable" as const }),
	};
	// Input version is deliberately not authority; manual percent edits derive a new cohort.
	const version = `fly2570-v1:${createHash("sha256").update(JSON.stringify(semantics)).digest("hex")}`;
	return Object.freeze({ enabled: true, ...semantics, version });
}

export function resolvePercentageModelSplit(
	policy: PercentageModelSplitPolicy,
	issueNumber: number,
) {
	if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
		throw new Error(
			"model split requires a positive safe integer issue number",
		);
	const bucket =
		(Number.parseInt(
			createHash("sha256")
				.update(`fly2570-v1:${issueNumber}`)
				.digest("hex")
				.slice(0, 13),
			16,
		) /
			2 ** 52) *
		100;
	return {
		bucket,
		arm: bucket < policy.codexPercent ? policy.codex : policy.fable,
	};
}
