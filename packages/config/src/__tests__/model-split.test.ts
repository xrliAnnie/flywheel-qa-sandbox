import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	getModelConfigSnapshot,
	resetModelConfigCacheForTests,
} from "../model-config.js";
import {
	ModelSplitBalanceInputUnavailableError,
	parseWeightedModelSplit,
	resolveWeightedModelSplit,
} from "../model-split.js";

const dirs: string[] = [];
const previous = process.env.FLYWHEEL_MODELS_CONFIG;
afterEach(() => {
	if (previous === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
	else process.env.FLYWHEEL_MODELS_CONFIG = previous;
	resetModelConfigCacheForTests();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const policy = (codexPercent: unknown) => ({
	enabled: true,
	rule: "issue_number_percentage",
	codexPercent,
	codex: { arm: "A", model: "astra" },
	fable: { arm: "B", model: "fable" },
});
const weightedPolicy = () => ({
	enabled: true,
	rule: "issue_node_weighted",
	nodes: {
		eng_design: [
			{ arm: "design_astra", model: "astra", weight: 1 },
			{ arm: "design_opus", model: "opus", weight: 1 },
			{ arm: "design_fable", model: "fable", weight: 1 },
		],
		implement: [
			{ arm: "impl_opus", model: "opus", weight: 2 },
			{ arm: "impl_sol56", model: "codex", weight: 1 },
			{ arm: "impl_sol6", model: "sol", weight: 1 },
		],
		qa: [
			{ arm: "qa_sol56", model: "codex", weight: 2 },
			{ arm: "qa_sol6", model: "sol", weight: 1 },
			{ arm: "qa_opus", model: "opus", weight: 1 },
		],
	},
});
const preSol6Policy = () => ({
	...weightedPolicy(),
	nodes: {
		...weightedPolicy().nodes,
		implement: [
			{ arm: "impl_opus", model: "opus", weight: 2 },
			{ arm: "impl_sol56", model: "codex", weight: 2 },
		],
		qa: [
			{ arm: "qa_sol56", model: "codex", weight: 3 },
			{ arm: "qa_opus", model: "opus", weight: 1 },
		],
	},
});
function snapshot(value: unknown, models?: unknown[]) {
	const dir = mkdtempSync(join(tmpdir(), "fly2570-config-"));
	dirs.push(dir);
	process.env.FLYWHEEL_MODELS_CONFIG = join(dir, "models.json");
	writeFileSync(
		process.env.FLYWHEEL_MODELS_CONFIG,
		JSON.stringify({
			version: 1,
			modelSplit: value,
			...(models ? { models } : {}),
		}),
	);
	return getModelConfigSnapshot();
}
it.each([0, 100, 75, 37.125])(
	"accepts runtime percentage %s and derives its version",
	(percent) => {
		const result = snapshot(policy(percent));
		expect(result.runtimeModelSplitStatus).toBe("valid");
		expect(result.modelSplit).toMatchObject({
			codexPercent: percent,
			version: expect.stringMatching(/^fly2570-v1:[a-f0-9]{64}$/),
		});
	},
);
it("derives a new version for a manual ratio edit despite stale supplied version", () => {
	const old = snapshot(policy(75)).modelSplit;
	const changed = snapshot({ ...policy(0), version: old?.version });
	expect(changed.runtimeModelSplitStatus).toBe("valid");
	expect(changed.modelSplit?.version).not.toBe(old?.version);
	expect(changed.modelSplit?.version).toBe(
		snapshot(policy(0)).modelSplit?.version,
	);
});
it.each([-1, 101, "75", null])("rejects invalid percentage %s", (value) => {
	expect(snapshot(policy(value)).runtimeModelSplitStatus).toBe("invalid");
});
it("rejects malformed arms and unknown keys", () => {
	for (const value of [
		{ ...policy(75), codex: { arm: "A", model: "fable" } },
		{ ...policy(75), typo: 1 },
		{ ...policy(75), enabled: false },
	]) {
		expect(snapshot(value).runtimeModelSplitStatus).toBe("invalid");
	}
});

it("uses a frozen deterministic bucket and exact endpoints", async () => {
	const { parsePercentageModelSplit, resolvePercentageModelSplit } =
		await import("../model-split.js");
	const p = parsePercentageModelSplit(policy(75));
	const first = resolvePercentageModelSplit(p, 2570);
	expect(first).toEqual(resolvePercentageModelSplit(p, 2570));
	// Golden value independently computed with Python hashlib, freezes the v1 hash input.
	expect(first.bucket).toBe(80.939447054086);
	expect(first.arm.arm).toBe("B");
	expect(first.bucket).toBeGreaterThanOrEqual(0);
	expect(first.bucket).toBeLessThan(100);
	let count = 0;
	for (let n = 1; n <= 10000; n++) {
		if (resolvePercentageModelSplit(p, n).arm.arm === "A") count++;
		expect(
			resolvePercentageModelSplit(parsePercentageModelSplit(policy(0)), n).arm
				.arm,
		).toBe("B");
		expect(
			resolvePercentageModelSplit(parsePercentageModelSplit(policy(100)), n).arm
				.arm,
		).toBe("A");
	}
	expect(count).toBeGreaterThan(7300);
	expect(count).toBeLessThan(7700);
	for (const n of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
		expect(() => resolvePercentageModelSplit(p, n)).toThrow();
	for (const n of [NaN, Infinity, -Infinity])
		expect(() => parsePercentageModelSplit(policy(n))).toThrow();
});

it("parses the three-node weighted policy and freezes the approved vectors", () => {
	const parsed = parseWeightedModelSplit(weightedPolicy());
	expect(parsed.version).toMatch(/^fly2788-v1:[a-f0-9]{64}$/);
	expect(parsed.balance).toEqual({ enabled: false });
	expect(
		parseWeightedModelSplit({
			...weightedPolicy(),
			balance: { enabled: false },
		}),
	).toEqual(parsed);
	expect(
		parseWeightedModelSplit({ ...weightedPolicy(), version: "stale" }),
	).toEqual(parsed);

	const counts: Record<string, number> = {};
	const pairs: Record<string, number> = {};
	for (let n = 1; n <= 120; n++) {
		const issueKey = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
		const design = resolveWeightedModelSplit(parsed, issueKey, "eng_design");
		const implement = resolveWeightedModelSplit(parsed, issueKey, "implement");
		const qa = resolveWeightedModelSplit(parsed, issueKey, "qa");
		for (const result of [design, implement, qa]) {
			counts[result.arm.arm] = (counts[result.arm.arm] ?? 0) + 1;
		}
		for (const key of [
			`${design.arm.arm}/${implement.arm.arm}`,
			`${implement.arm.arm}/${qa.arm.arm}`,
			`${design.arm.arm}/${qa.arm.arm}`,
		]) {
			pairs[key] = (pairs[key] ?? 0) + 1;
		}
	}
	expect(counts).toEqual({
		design_astra: 44,
		design_opus: 38,
		design_fable: 38,
		impl_opus: 58,
		impl_sol56: 30,
		impl_sol6: 32,
		qa_sol56: 56,
		qa_sol6: 35,
		qa_opus: 29,
	});
	expect(pairs).toEqual({
		"design_astra/impl_opus": 21,
		"design_astra/impl_sol56": 10,
		"design_astra/impl_sol6": 13,
		"design_opus/impl_opus": 17,
		"design_opus/impl_sol56": 13,
		"design_opus/impl_sol6": 8,
		"design_fable/impl_opus": 20,
		"design_fable/impl_sol56": 7,
		"design_fable/impl_sol6": 11,
		"impl_opus/qa_sol56": 28,
		"impl_opus/qa_sol6": 14,
		"impl_opus/qa_opus": 16,
		"impl_sol56/qa_sol56": 15,
		"impl_sol56/qa_sol6": 6,
		"impl_sol56/qa_opus": 9,
		"impl_sol6/qa_sol56": 13,
		"impl_sol6/qa_sol6": 15,
		"impl_sol6/qa_opus": 4,
		"design_astra/qa_sol56": 15,
		"design_astra/qa_sol6": 14,
		"design_astra/qa_opus": 15,
		"design_opus/qa_sol56": 24,
		"design_opus/qa_sol6": 7,
		"design_opus/qa_opus": 7,
		"design_fable/qa_sol56": 17,
		"design_fable/qa_sol6": 14,
		"design_fable/qa_opus": 7,
	});
	const thousand: Record<string, number> = {};
	for (let n = 1; n <= 1_000; n++) {
		const issueKey = `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
		const arm = resolveWeightedModelSplit(parsed, issueKey, "implement").arm
			.arm;
		thousand[arm] = (thousand[arm] ?? 0) + 1;
	}
	expect(thousand.impl_opus).toBeGreaterThan(450);
	expect(thousand.impl_opus).toBeLessThan(550);
	expect(thousand.impl_sol56).toBeGreaterThan(200);
	expect(thousand.impl_sol56).toBeLessThan(300);
	expect(thousand.impl_sol6).toBeGreaterThan(200);
	expect(thousand.impl_sol6).toBeLessThan(300);

	const issueKey = "00000000-0000-4000-8000-000000000001";
	for (const nodeId of ["eng_design", "implement", "qa"] as const) {
		const result = resolveWeightedModelSplit(parsed, issueKey, nodeId);
		expect(result).toEqual(resolveWeightedModelSplit(parsed, issueKey, nodeId));
		expect(result.weightAudit).toEqual({
			enabled: false,
			applied: false,
			baseWeights: parsed.nodes[nodeId].map(({ arm, weight }) => ({
				arm,
				weight,
			})),
			effectiveWeights: parsed.nodes[nodeId].map(({ arm, weight }) => ({
				arm,
				weight,
			})),
		});
	}
	expect(
		resolveWeightedModelSplit(parsed, issueKey, "eng_design").bucket,
	).not.toBe(resolveWeightedModelSplit(parsed, issueKey, "qa").bucket);
});

it("validates the default-off balance switch and fails closed when enabled", () => {
	const off = parseWeightedModelSplit(weightedPolicy());
	const on = parseWeightedModelSplit({
		...weightedPolicy(),
		balance: { enabled: true },
	});
	expect(on.balance).toEqual({ enabled: true });
	expect(on.version).not.toBe(off.version);
	expect(ModelSplitBalanceInputUnavailableError).toBeTypeOf("function");
	expect(() =>
		resolveWeightedModelSplit(
			on,
			"00000000-0000-4000-8000-000000000001",
			"implement",
		),
	).toThrow(ModelSplitBalanceInputUnavailableError);
	for (const balance of [
		true,
		{},
		{ enabled: "false" },
		{ enabled: false, extra: 1 },
	]) {
		expect(() =>
			parseWeightedModelSplit({ ...weightedPolicy(), balance }),
		).toThrow();
	}
});

it("uses a distinct pre-Sol-6 policy version while assigning its shares to 5.6 Sol", () => {
	const formal = parseWeightedModelSplit(weightedPolicy());
	const preSol6 = parseWeightedModelSplit(preSol6Policy());
	expect(preSol6.version).not.toBe(formal.version);
	const counts: Record<string, number> = {};
	for (let n = 1; n <= 120; n++) {
		const issueKey = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
		for (const nodeId of ["implement", "qa"] as const) {
			const arm = resolveWeightedModelSplit(preSol6, issueKey, nodeId).arm.arm;
			counts[arm] = (counts[arm] ?? 0) + 1;
		}
	}
	expect(counts).toEqual({
		impl_opus: 58,
		impl_sol56: 62,
		qa_sol56: 91,
		qa_opus: 29,
	});
});

it("rejects malformed weighted policies and unstable identities", () => {
	const base = weightedPolicy();
	const invalid = [
		{ ...base, enabled: false },
		{ ...base, extra: true },
		{ ...base, nodes: { ...base.nodes, extra: base.nodes.qa } },
		{
			...base,
			nodes: { eng_design: base.nodes.eng_design, qa: base.nodes.qa },
		},
		{
			...base,
			nodes: {
				...base.nodes,
				qa: [{ arm: "qa_sol", model: "sol", weight: 1 }],
			},
		},
		{
			...base,
			nodes: {
				...base.nodes,
				qa: [
					{ arm: "same", model: "sol", weight: 1 },
					{ arm: "same", model: "opus", weight: 1 },
				],
			},
		},
		{
			...base,
			nodes: {
				...base.nodes,
				qa: [
					{ arm: "qa_sol", model: "same", weight: 1 },
					{ arm: "qa_opus", model: "same", weight: 1 },
				],
			},
		},
		...(
			[0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY] as const
		).map((weight) => ({
			...base,
			nodes: {
				...base.nodes,
				qa: [
					{ arm: "qa_sol", model: "sol", weight },
					{ arm: "qa_opus", model: "opus", weight: 1 },
				],
			},
		})),
	];
	for (const candidate of invalid) {
		expect(() => parseWeightedModelSplit(candidate)).toThrow();
	}

	const parsed = parseWeightedModelSplit(base);
	for (const issueKey of [
		"FLY-2788",
		"00000000-0000-4000-8000-00000000001",
		"00000000-0000-4000-8000-00000000000A",
	]) {
		expect(() => resolveWeightedModelSplit(parsed, issueKey, "qa")).toThrow();
	}
	expect(() =>
		resolveWeightedModelSplit(
			parsed,
			"00000000-0000-4000-8000-000000000001",
			"other" as "qa",
		),
	).toThrow();
});

it("accepts a weighted policy only when every arm model is workflow-capable", () => {
	const sol = {
		id: "gpt-6-sol",
		provider: "openai",
		runtimeVendor: "codex",
		label: "GPT-6 Sol",
		aliases: ["sol"],
		surfaces: ["runner", "workflow"],
	};
	const valid = snapshot(weightedPolicy());
	expect(valid.runtimeModelSplitStatus).toBe("valid");
	expect(valid.modelSplit).toMatchObject({
		rule: "issue_node_weighted",
		version: expect.stringMatching(/^fly2788-v1:[a-f0-9]{64}$/),
	});

	expect(
		snapshot(weightedPolicy(), [{ ...sol, surfaces: ["runner"] }])
			.runtimeModelSplitStatus,
	).toBe("invalid");
	expect(
		snapshot(
			{
				...weightedPolicy(),
				nodes: {
					...weightedPolicy().nodes,
					eng_design: [
						{ arm: "design_missing", model: "missing", weight: 1 },
						...weightedPolicy().nodes.eng_design.slice(1),
					],
				},
			},
			[sol],
		).runtimeModelSplitStatus,
	).toBe("invalid");
});
