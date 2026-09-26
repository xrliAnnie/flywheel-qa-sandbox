import { describe, expect, it } from "vitest";
import {
	applyWorkflowOverride,
	loadBundledWorkflowSeeds,
	parseWorkflowManifestYaml,
	validateWorkflowManifest,
	WORKFLOW_OUTCOME_VOCABULARY,
} from "../workflow-template.js";

describe("workflow template manifest v1", () => {
	it("loads the three founder-revised seeds with independent QA and pointer handoffs", () => {
		const seeds = loadBundledWorkflowSeeds();
		expect(seeds.map((seed) => seed.templateId)).toEqual([
			"tpl_eng_heavy",
			"tpl_eng_light",
			"tpl_eng_trivial",
		]);

		const heavy = seeds[0]!.manifest;
		expect(heavy.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "design",
					vendor: "claude",
					model: "claude-fable-5",
				}),
				expect.objectContaining({
					id: "implement",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				}),
				expect.objectContaining({
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "claude-opus-4-8",
				}),
			]),
		);
		expect(heavy.loops).toEqual([
			expect.objectContaining({
				from: "qa",
				to: "implement",
				loop_when: "qa_fail",
				exit_when: "qa_pass",
				max_iterations: 3,
				on_limit: "escalate",
			}),
		]);
		expect(heavy.ship_claims).toEqual(["qa_passed", "founder_approved"]);

		const light = seeds[1]!.manifest;
		expect(light.nodes.find((node) => node.id === "design")).toMatchObject({
			vendor: "codex",
			model: "gpt-5.6-sol",
		});
		const trivial = seeds[2]!.manifest;
		expect(trivial.nodes.find((node) => node.id === "design")).toMatchObject({
			vendor: "codex",
			model: "gpt-5.6-sol",
		});
		expect(trivial.nodes.find((node) => node.id === "qa")).toMatchObject({
			type: "qa",
			vendor: "claude",
			model: "claude-fable-5",
		});
		for (const seed of seeds) {
			expect(() => validateWorkflowManifest(seed.manifest)).not.toThrow();
			expect(
				seed.manifest.nodes.filter((node) => node.type === "qa"),
			).toHaveLength(1);
			for (const node of seed.manifest.nodes.filter(
				(node) => node.type !== "gate",
			)) {
				expect(node.handoff_pointer).toEqual({
					worktree: true,
					design_doc: true,
				});
			}
		}
	});

	it("rejects unknown keys, inline handoffs, unsupported schemas, and invalid graphs", () => {
		const valid = loadBundledWorkflowSeeds()[0]!.manifest;
		expect(WORKFLOW_OUTCOME_VOCABULARY.qa_fail).toEqual({
			claim: "qa_failed",
			edge: "qa_fail",
		});
		expect(() =>
			validateWorkflowManifest({
				...valid,
				nodes: valid.nodes.map((node) =>
					node.type === "gate"
						? node
						: {
								id: node.id,
								type: node.type,
							},
				),
			}),
		).not.toThrow();
		expect(() =>
			validateWorkflowManifest({ ...valid, surprise: true }),
		).toThrow(/unknown key.*surprise/i);
		expect(() =>
			validateWorkflowManifest({
				...valid,
				schema_version: 2,
			}),
		).toThrow(/schema_version/i);
		expect(() =>
			validateWorkflowManifest({
				...valid,
				nodes: valid.nodes.map((node) =>
					node.id === "design" ? { ...node, prompt: "full design body" } : node,
				),
			}),
		).toThrow(/unknown key.*prompt/i);
		expect(() =>
			validateWorkflowManifest({
				...valid,
				nodes: [...valid.nodes, { ...valid.nodes[0] }],
			}),
		).toThrow(/duplicate node/i);
		expect(() =>
			validateWorkflowManifest({
				...valid,
				edges: valid.edges.filter((edge) => edge.from !== "implement"),
			}),
		).toThrow(/start|unreachable|outgoing/i);
		expect(() =>
			parseWorkflowManifestYaml("schema_version: 1\nnodes: []\nextra: true\n"),
		).toThrow(/unknown key|edges/i);
	});

	it("rejects an engineering manifest that omits the independent QA node", () => {
		const valid = loadBundledWorkflowSeeds()[0]!.manifest;
		expect(() =>
			validateWorkflowManifest({
				...valid,
				nodes: valid.nodes.filter((node) => node.type !== "qa"),
				edges: [
					valid.edges.find((edge) => edge.id === "design_done")!,
					{
						id: "implement_done",
						from: "implement",
						to: "founder_gate",
						condition: "implement_done",
					},
				],
				loops: [],
			}),
		).toThrow(/independent QA node/i);
	});

	it("applies only reasoned model/effort/skip overrides and consumes skip before validation", () => {
		const heavy = loadBundledWorkflowSeeds()[0]!.manifest;
		expect(() => applyWorkflowOverride(heavy, { reason: "" })).toThrow(
			/reason/i,
		);
		expect(() =>
			applyWorkflowOverride(heavy, {
				reason: "founder chose a cheaper design pass",
				nodes: { design: { model: "gpt-5.6-sol" } },
			}),
		).toThrow(/vendor.*model|model.*vendor/i);
		expect(() =>
			applyWorkflowOverride(heavy, {
				reason: "never skip independent QA",
				nodes: { qa: { skip: true } },
			}),
		).toThrow(/cannot skip.*qa/i);
		expect(() =>
			applyWorkflowOverride(heavy, {
				reason: "edge mutation is not an override",
				edges: [],
			} as never),
		).toThrow(/unknown key.*edges/i);

		const applied = applyWorkflowOverride(heavy, {
			reason: "tiny change; start directly at implementation",
			nodes: { design: { skip: true } },
		});
		expect(applied.manifest.nodes.some((node) => node.id === "design")).toBe(
			false,
		);
		expect(JSON.stringify(applied.manifest)).not.toContain("skip");
		expect(applied.override.reason).toContain("tiny change");
		expect(() => validateWorkflowManifest(applied.manifest)).not.toThrow();
	});
});
