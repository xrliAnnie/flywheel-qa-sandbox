import { createHash } from "node:crypto";

export const WEIGHTED_MODEL_SPLIT_NODES = [
	"eng_design",
	"implement",
	"qa",
] as const;

export type WeightedModelSplitNodeId =
	(typeof WEIGHTED_MODEL_SPLIT_NODES)[number];

export interface WeightedModelSplitArm {
	readonly arm: string;
	readonly model: string;
	readonly weight: number;
}

export interface WeightedModelSplitPolicy {
	readonly enabled: true;
	readonly rule: "issue_node_weighted";
	readonly version: string;
	readonly balance: { readonly enabled: boolean };
	readonly nodes: Readonly<
		Record<WeightedModelSplitNodeId, readonly WeightedModelSplitArm[]>
	>;
}

export interface PercentageModelSplitPolicy {
	readonly enabled: true;
	readonly rule: "issue_number_percentage";
	readonly version: string;
	readonly codexPercent: number;
	readonly codex: { readonly arm: "A"; readonly model: "astra" };
	readonly fable: { readonly arm: "B"; readonly model: "fable" };
}

export class ModelSplitBalanceInputUnavailableError extends Error {
	readonly code = "MODEL_SPLIT_BALANCE_INPUT_UNAVAILABLE";
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

export function parseWeightedModelSplit(
	value: unknown,
): WeightedModelSplitPolicy {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("modelSplit must be an object");
	const raw = value as Record<string, unknown>;
	const allowed = new Set(["enabled", "rule", "version", "nodes", "balance"]);
	for (const key of Object.keys(raw))
		if (!allowed.has(key)) throw new Error(`modelSplit unknown key: ${key}`);
	if (raw.enabled !== true)
		throw new Error("weighted modelSplit.enabled must be true");
	if (raw.rule !== "issue_node_weighted")
		throw new Error("modelSplit.rule must be issue_node_weighted");
	if (!raw.nodes || typeof raw.nodes !== "object" || Array.isArray(raw.nodes))
		throw new Error("modelSplit.nodes must be an object");
	let balanceEnabled = false;
	if (raw.balance !== undefined) {
		if (
			!raw.balance ||
			typeof raw.balance !== "object" ||
			Array.isArray(raw.balance)
		)
			throw new Error("modelSplit.balance must be an object");
		const balance = raw.balance as Record<string, unknown>;
		const unknown = Object.keys(balance).find((key) => key !== "enabled");
		if (unknown) throw new Error(`modelSplit.balance unknown key: ${unknown}`);
		if (typeof balance.enabled !== "boolean")
			throw new Error("modelSplit.balance.enabled must be boolean");
		balanceEnabled = balance.enabled;
	}

	const inputNodes = raw.nodes as Record<string, unknown>;
	for (const key of Object.keys(inputNodes)) {
		if (!(WEIGHTED_MODEL_SPLIT_NODES as readonly string[]).includes(key))
			throw new Error(`modelSplit.nodes unknown key: ${key}`);
	}
	const nodes = {} as Record<
		WeightedModelSplitNodeId,
		readonly WeightedModelSplitArm[]
	>;
	for (const nodeId of WEIGHTED_MODEL_SPLIT_NODES) {
		const rawArms = inputNodes[nodeId];
		if (!Array.isArray(rawArms) || rawArms.length < 2)
			throw new Error(
				`modelSplit.nodes.${nodeId} must contain at least two arms`,
			);
		const armNames = new Set<string>();
		const models = new Set<string>();
		let totalWeight = 0;
		const arms = rawArms.map((value, index) => {
			const path = `modelSplit.nodes.${nodeId}[${index}]`;
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error(`${path} must be an object`);
			const rawArm = value as Record<string, unknown>;
			const unknown = Object.keys(rawArm).find(
				(key) => key !== "arm" && key !== "model" && key !== "weight",
			);
			if (unknown) throw new Error(`${path} unknown key: ${unknown}`);
			const arm = typeof rawArm.arm === "string" ? rawArm.arm.trim() : "";
			const model = typeof rawArm.model === "string" ? rawArm.model.trim() : "";
			const weight = rawArm.weight;
			if (!arm) throw new Error(`${path}.arm must be a non-empty string`);
			if (!model) throw new Error(`${path}.model must be a non-empty string`);
			if (!Number.isSafeInteger(weight) || (weight as number) <= 0)
				throw new Error(`${path}.weight must be a positive safe integer`);
			if (armNames.has(arm))
				throw new Error(
					`modelSplit.nodes.${nodeId} contains duplicate arm ${arm}`,
				);
			if (models.has(model))
				throw new Error(
					`modelSplit.nodes.${nodeId} contains duplicate model ${model}`,
				);
			armNames.add(arm);
			models.add(model);
			totalWeight += weight as number;
			if (!Number.isSafeInteger(totalWeight))
				throw new Error(
					`modelSplit.nodes.${nodeId} total weight must be a safe integer`,
				);
			return Object.freeze({ arm, model, weight: weight as number });
		});
		nodes[nodeId] = Object.freeze(arms);
	}
	const frozenNodes = Object.freeze(nodes);
	const semantics = {
		rule: "issue_node_weighted" as const,
		balance: Object.freeze({ enabled: balanceEnabled }),
		nodes: frozenNodes,
	};
	const version = `fly2788-v1:${createHash("sha256").update(JSON.stringify(semantics)).digest("hex")}`;
	return Object.freeze({ enabled: true, ...semantics, version });
}

export function resolveWeightedModelSplit(
	policy: WeightedModelSplitPolicy,
	issueKey: string,
	nodeId: WeightedModelSplitNodeId,
) {
	if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(issueKey))
		throw new Error("model split requires a lowercase canonical issue UUID");
	const arms = policy.nodes[nodeId];
	if (!arms) throw new Error(`model split does not support node ${nodeId}`);
	if (policy.balance.enabled)
		throw new ModelSplitBalanceInputUnavailableError(
			"model split balance inputs unavailable; disable balance until score and quota evidence are supported",
		);
	const baseWeights = Object.freeze(
		arms.map((arm) => Object.freeze({ arm: arm.arm, weight: arm.weight })),
	);
	const weightAudit = Object.freeze({
		enabled: false as const,
		applied: false as const,
		baseWeights,
		effectiveWeights: baseWeights,
	});
	const bucket =
		Number.parseInt(
			createHash("sha256")
				.update(JSON.stringify(["fly2788-v1", issueKey, nodeId]))
				.digest("hex")
				.slice(0, 13),
			16,
		) /
		2 ** 52;
	const target = bucket * arms.reduce((sum, arm) => sum + arm.weight, 0);
	let cumulative = 0;
	for (const arm of arms) {
		cumulative += arm.weight;
		if (target < cumulative) return { bucket, arm, weightAudit };
	}
	throw new Error(`model split failed to resolve node ${nodeId}`);
}
