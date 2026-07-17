import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import {
	applyWorkflowOverride,
	ensureDefaultWorkflowBindings,
	importBundledWorkflowSeeds,
	isGeneralizedTemplatesEnabled,
	loadBundledWorkflowSeeds,
	parseWorkflowManifestYaml,
	validateWorkflowManifest,
	WORKFLOW_OUTCOME_VOCABULARY,
} from "../workflow-template.js";

describe("bundled workflow default bindings", () => {
	it("fills the engineering three-tier defaults without repointing existing category authority", async () => {
		const store = await StateStore.create(":memory:");
		importBundledWorkflowSeeds(store);
		store.bindWorkflowCategory({
			project: "custom",
			taskCategory: "light",
			templateId: "tpl_eng_light",
			updatedBy: "founder",
		});

		ensureDefaultWorkflowBindings(store, ["beta", "alpha", "alpha", "custom"]);
		expect(store.listWorkflowCategoryBindings("alpha")).toMatchObject([
			{ task_category: "*", template_id: "tpl_eng_heavy" },
			{ task_category: "light", template_id: "tpl_eng_light" },
			{ task_category: "trivial", template_id: "tpl_eng_trivial" },
		]);
		expect(store.listWorkflowCategoryBindings("beta")).toMatchObject([
			{ task_category: "*", template_id: "tpl_eng_heavy" },
			{ task_category: "light", template_id: "tpl_eng_light" },
			{ task_category: "trivial", template_id: "tpl_eng_trivial" },
		]);
		expect(store.listWorkflowCategoryBindings("custom")).toMatchObject([
			{ task_category: "*", template_id: "tpl_eng_heavy" },
			{ task_category: "light", template_id: "tpl_eng_light" },
			{ task_category: "trivial", template_id: "tpl_eng_trivial" },
		]);
		const auditCount = store.listWorkflowTemplateAudit().length;

		ensureDefaultWorkflowBindings(store, ["alpha", "beta", "custom"]);
		expect(store.listWorkflowTemplateAudit()).toHaveLength(auditCount);
		store.close();
	});
});

const generalizedManifest = () => ({
	schema_version: 2,
	nodes: [
		{
			id: "produce",
			type: "generic",
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "low",
			agent_file: "agents/product-producer.md",
			produces_output: true,
			output: { schema: "json_v1", max_bytes: 262_144 },
		},
		{
			id: "review",
			type: "review",
			vendor: "claude",
			model: "claude-opus-4-8",
		},
		{ id: "founder_gate", type: "gate" },
	],
	edges: [
		{
			id: "produce_done",
			from: "produce",
			to: "review",
			condition: "node_done",
		},
		{
			id: "review_pass",
			from: "review",
			to: "founder_gate",
			condition: "review_pass",
		},
	],
	loops: [
		{
			id: "review_retry",
			from: "review",
			to: "produce",
			loop_when: "review_fail",
			exit_when: "review_pass",
			max_iterations: 3,
			on_limit: "escalate",
		},
	],
	terminal_gate: { node: "founder_gate", predicate: "founder_approved" },
	ship_claims: ["design_review_approved", "founder_approved"],
});

describe("workflow template manifest v1", () => {
	it("loads the founder-revised engineering seeds plus the default-off generalized set", () => {
		const seeds = loadBundledWorkflowSeeds();
		expect(seeds.map((seed) => seed.templateId)).toEqual([
			"tpl_eng_heavy",
			"tpl_eng_light",
			"tpl_eng_trivial",
			"tpl_product_v1",
			"tpl_research_light",
			"tpl_ops_light",
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
		for (const seed of seeds.slice(0, 3)) {
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
		expect(seeds.slice(3).map((seed) => seed.manifest.schema_version)).toEqual([
			2, 2, 2,
		]);
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
				schema_version: 99,
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

	it("rejects model/vendor/effort combinations outside the canonical registry", () => {
		const valid = loadBundledWorkflowSeeds()[0]!.manifest;
		expect(() =>
			validateWorkflowManifest({
				...valid,
				nodes: valid.nodes.map((node) =>
					node.id === "design" ? { ...node, model: "claude-invented" } : node,
				),
			}),
		).toThrow(/registry|supported/i);
		expect(() =>
			validateWorkflowManifest({
				...valid,
				nodes: valid.nodes.map((node) =>
					node.id === "implement" ? { ...node, effort: "high" } : node,
				),
			}),
		).toThrow(/registry|supported|effort/i);
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

describe("workflow template manifest v2", () => {
	it("is independently default-off", () => {
		expect(isGeneralizedTemplatesEnabled({})).toBe(false);
		expect(
			isGeneralizedTemplatesEnabled({
				FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "true",
			}),
		).toBe(false);
		expect(
			isGeneralizedTemplatesEnabled({
				FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
			}),
		).toBe(true);
	});

	it("accepts a linear no-code generic→review→gate graph with output and review loop contracts", () => {
		const parsed = validateWorkflowManifest(generalizedManifest());
		expect(parsed.schema_version).toBe(2);
		expect(parsed.nodes[0]).toMatchObject({
			type: "generic",
			agent_file: "agents/product-producer.md",
			produces_output: true,
			output: { schema: "json_v1", max_bytes: 262_144 },
		});
		expect(parsed.loops[0]).toMatchObject({
			loop_when: "review_fail",
			exit_when: "review_pass",
		});
	});

	it("enforces the capability-driven independent-QA invariant", () => {
		const base = generalizedManifest();
		for (const writerType of ["design", "implement"] as const) {
			expect(() =>
				validateWorkflowManifest({
					...base,
					nodes: [
						{
							id: "writer",
							type: writerType,
							vendor: "codex",
							model: "gpt-5.6-sol",
						},
						{ id: "founder_gate", type: "gate" },
					],
					edges: [
						{
							id: "writer_done",
							from: "writer",
							to: "founder_gate",
							condition:
								writerType === "design" ? "design_done" : "implement_done",
						},
					],
					loops: [],
					ship_claims: ["founder_approved"],
				}),
			).toThrow(/exactly one independent QA|qa_passed/i);
		}

		expect(() =>
			validateWorkflowManifest({
				...base,
				ship_claims: ["qa_passed", ...base.ship_claims],
			}),
		).toThrow(/qa_passed.*qa|qa.*qa_passed/i);
	});

	it("requires review evidence, strict output contracts, and safe agent paths", () => {
		const base = generalizedManifest();
		expect(() =>
			validateWorkflowManifest({
				...base,
				ship_claims: ["founder_approved"],
			}),
		).toThrow(/design_review_approved/i);
		expect(() =>
			validateWorkflowManifest({
				...base,
				nodes: base.nodes.map((node) =>
					node.id === "produce"
						? { ...node, output: { schema: "json_v1", max_bytes: 262_145 } }
						: node,
				),
			}),
		).toThrow(/max_bytes/i);
		expect(() =>
			validateWorkflowManifest({
				...base,
				nodes: base.nodes.map((node) =>
					node.id === "produce"
						? { ...node, agent_file: "../escape.md" }
						: node,
				),
			}),
		).toThrow(/agent_file/i);
	});

	it("allows reasoned generic overrides but never skips review or a reviewed producer", () => {
		const base = generalizedManifest();
		const applied = applyWorkflowOverride(base, {
			reason: "Lead selected a lighter producer",
			nodes: { produce: { model: "gpt-5.5", effort: "medium" } },
		});
		expect(applied.manifest.nodes[0]).toMatchObject({
			model: "gpt-5.5",
			effort: "medium",
		});
		expect(() =>
			applyWorkflowOverride(base, {
				reason: "reviews are mandatory",
				nodes: { review: { skip: true } },
			}),
		).toThrow(/cannot skip.*review/i);
		expect(() =>
			applyWorkflowOverride(base, {
				reason: "review still depends on the output",
				nodes: { produce: { skip: true } },
			}),
		).toThrow(/cannot skip.*produce/i);

		const research = loadBundledWorkflowSeeds().find(
			(seed) => seed.templateId === "tpl_research_light",
		)!.manifest;
		expect(() =>
			applyWorkflowOverride(research, {
				reason: "the deliverable is still mandatory",
				nodes: { research: { skip: true } },
			}),
		).toThrow(/cannot skip.*research.*output|output.*research/i);
	});
});
