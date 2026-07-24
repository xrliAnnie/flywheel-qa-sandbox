import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { WORK_KIND_CATEGORIES } from "../work-kind.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";
import {
	applyWorkflowOverride,
	DEFAULT_ENGINEERING_WORKFLOW_BINDINGS,
	ensureDefaultWorkflowBindings,
	importBundledWorkflowSeeds,
	isGeneralizedTemplatesEnabled,
	isWorkflowManifestV1Land,
	loadBundledWorkflowSeeds,
	migrateSystemWorkflowBindingsToLand,
	parseWorkflowManifestYaml,
	rollbackSystemWorkflowBindingsFromLand,
	validateWorkflowManifest,
	WORKFLOW_OUTCOME_VOCABULARY,
} from "../workflow-template.js";
import { isLandNodeEnabled } from "../workflow-template-dispatch.js";

describe("bundled workflow default bindings", () => {
	it("seeds three-tier defaults only for empty projects and leaves existing project authority untouched", async () => {
		const store = await StateStore.create(":memory:");
		importBundledWorkflowSeeds(store);
		store.bindWorkflowCategory({
			project: "custom",
			taskCategory: "light",
			templateId: "tpl_eng_light",
			updatedBy: "founder",
		});
		store.bindWorkflowCategory({
			project: "production-shaped",
			taskCategory: "*",
			templateId: "tpl_eng_heavy",
			updatedBy: "system:bundled-default",
		});
		const productionBindingsBefore =
			store.listWorkflowCategoryBindings("production-shaped");
		const productionAuditBefore = store.listWorkflowTemplateAudit().length;

		ensureDefaultWorkflowBindings(store, [
			"beta",
			"alpha",
			"alpha",
			"custom",
			"production-shaped",
		]);
		expect(store.listWorkflowCategoryBindings("alpha")).toMatchObject([
			{ task_category: "*", template_id: "tpl_eng_heavy_land_v1" },
			{ task_category: "light", template_id: "tpl_eng_light_land_v1" },
			{ task_category: "trivial", template_id: "tpl_eng_trivial_land_v1" },
		]);
		expect(store.listWorkflowCategoryBindings("beta")).toMatchObject([
			{ task_category: "*", template_id: "tpl_eng_heavy_land_v1" },
			{ task_category: "light", template_id: "tpl_eng_light_land_v1" },
			{ task_category: "trivial", template_id: "tpl_eng_trivial_land_v1" },
		]);
		expect(store.listWorkflowCategoryBindings("custom")).toMatchObject([
			{ task_category: "light", template_id: "tpl_eng_light" },
		]);
		expect(store.listWorkflowCategoryBindings("production-shaped")).toEqual(
			productionBindingsBefore,
		);
		expect(store.listWorkflowTemplateAudit()).toHaveLength(
			productionAuditBefore + 6,
		);
		const auditCount = store.listWorkflowTemplateAudit().length;

		ensureDefaultWorkflowBindings(store, ["alpha", "beta", "custom"]);
		expect(store.listWorkflowTemplateAudit()).toHaveLength(auditCount);
		store.close();
	});

	it("migrates only system defaults to land, is idempotent, and supports explicit rollback", async () => {
		const store = await StateStore.create(":memory:");
		importBundledWorkflowSeeds(store);
		for (const [taskCategory, templateId] of [
			["*", "tpl_eng_heavy"],
			["light", "tpl_eng_light"],
			["trivial", "tpl_eng_trivial"],
		] as const) {
			store.bindWorkflowCategory({
				project: "system",
				taskCategory,
				templateId,
				updatedBy: "system:bundled-default",
			});
			store.bindWorkflowCategory({
				project: "custom",
				taskCategory,
				templateId,
				updatedBy: "founder",
			});
		}
		const warnings: string[] = [];
		expect(
			migrateSystemWorkflowBindingsToLand(
				store,
				["system", "custom"],
				(message) => warnings.push(message),
			),
		).toBe(3);
		expect(store.listWorkflowCategoryBindings("system")).toMatchObject([
			{ task_category: "*", template_id: "tpl_eng_heavy_land_v1" },
			{ task_category: "light", template_id: "tpl_eng_light_land_v1" },
			{ task_category: "trivial", template_id: "tpl_eng_trivial_land_v1" },
		]);
		expect(store.listWorkflowCategoryBindings("custom")).toMatchObject([
			{ task_category: "*", template_id: "tpl_eng_heavy" },
			{ task_category: "light", template_id: "tpl_eng_light" },
			{ task_category: "trivial", template_id: "tpl_eng_trivial" },
		]);
		expect(warnings).toHaveLength(3);
		const auditCount = store.listWorkflowTemplateAudit().length;
		expect(
			migrateSystemWorkflowBindingsToLand(
				store,
				["system", "custom"],
				() => {},
			),
		).toBe(0);
		expect(store.listWorkflowTemplateAudit()).toHaveLength(auditCount);

		expect(
			rollbackSystemWorkflowBindingsFromLand(store, ["system"], () => {}),
		).toBe(3);
		expect(store.listWorkflowCategoryBindings("system")).toMatchObject([
			{ task_category: "*", template_id: "tpl_eng_heavy" },
			{ task_category: "light", template_id: "tpl_eng_light" },
			{ task_category: "trivial", template_id: "tpl_eng_trivial" },
		]);
		store.close();
	});

	it("keeps every work-kind category out of the boot binding defaults", () => {
		expect(
			DEFAULT_ENGINEERING_WORKFLOW_BINDINGS.filter((binding) =>
				WORK_KIND_CATEGORIES.includes(
					binding.taskCategory as (typeof WORK_KIND_CATEGORIES)[number],
				),
			),
		).toEqual([]);
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
	it("ships the land engine default-on with an explicit emergency kill switch", () => {
		expect(isLandNodeEnabled({})).toBe(true);
		expect(isLandNodeEnabled({ FLYWHEEL_LAND_NODE: "1" })).toBe(true);
		expect(isLandNodeEnabled({ FLYWHEEL_LAND_NODE: "0" })).toBe(false);
	});

	it("accepts a land_v1 engine node with binding-engine tier presets", () => {
		const manifest = {
			schema_version: 1,
			manifest_variant: "land_v1",
			nodes: [
				{ id: "design", type: "design" },
				{ id: "implement", type: "implement" },
				{ id: "qa", type: "qa" },
				{ id: "founder_gate", type: "gate" },
				{ id: "land", type: "land", execution: "engine" },
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "implement",
					condition: "design_done",
				},
				{
					id: "implement_done",
					from: "implement",
					to: "qa",
					condition: "implement_done",
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass",
				},
				{
					id: "founder_approved",
					from: "founder_gate",
					to: "land",
					condition: "founder_approved",
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail",
					exit_when: "qa_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
				{
					id: "founder_feedback",
					from: "founder_gate",
					to: "implement",
					loop_when: "founder_feedback_kickback",
					exit_when: "founder_approved",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			approval_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			terminal_node: { node: "land" },
			ship_claims: ["qa_passed", "founder_approved"],
			tier_presets: {
				heavy: {
					reason: "land flow heavy tier",
					nodes: {
						implement: {
							vendor: "codex",
							model: "gpt-5.6-sol",
							effort: "xhigh",
						},
					},
				},
			},
		};

		const parsed = validateWorkflowManifest(manifest);
		expect(parsed).toMatchObject({
			schema_version: 1,
			manifest_variant: "land_v1",
			approval_gate: { node: "founder_gate" },
			terminal_node: { node: "land" },
		});
		expect(parsed.nodes.at(-1)).toEqual({
			id: "land",
			type: "land",
			execution: "engine",
		});
		expect(parsed.tier_presets?.heavy).toMatchObject({
			reason: "land flow heavy tier",
		});
		const applied = applyWorkflowOverride(parsed, parsed.tier_presets!.heavy!);
		expect(isWorkflowManifestV1Land(applied.manifest)).toBe(true);
		expect(
			applied.manifest.nodes.find((node) => node.id === "implement"),
		).toMatchObject({
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "xhigh",
		});
		expect(applied.manifest.nodes.at(-1)).toEqual({
			id: "land",
			type: "land",
			execution: "engine",
		});
		expect(loadBundledWorkflowSeeds().slice(0, 3)).toHaveLength(3);
	});

	it("rejects mixed legacy and land_v1 vocabularies", () => {
		const legacy = loadBundledWorkflowSeeds()[0]!.manifest;
		expect(() =>
			validateWorkflowManifest({
				...legacy,
				manifest_variant: "land_v1",
				approval_gate: legacy.terminal_gate,
				terminal_node: { node: "land" },
			}),
		).toThrow(/mixed|unknown key|land_v1/i);
	});

	it("loads the legacy rollback set plus the dormant work-kind templates", () => {
		const seeds = loadBundledWorkflowSeeds();
		expect(seeds.map((seed) => seed.templateId)).toEqual([
			"tpl_eng_heavy",
			"tpl_eng_light",
			"tpl_eng_trivial",
			"tpl_product_v1",
			"tpl_eng_heavy_land_v1",
			"tpl_eng_light_land_v1",
			"tpl_eng_trivial_land_v1",
			"tpl_eng",
			"tpl_eng_land_v1",
			"tpl_product_designer",
			"tpl_product_prototype",
			"tpl_generic",
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
			expect.objectContaining({
				from: "founder_gate",
				to: "implement",
				loop_when: "founder_feedback_kickback",
				exit_when: "founder_approved",
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
		for (const seed of seeds.slice(4, 7)) {
			expect(isWorkflowManifestV1Land(seed.manifest)).toBe(true);
			expect(seed.manifest.nodes.at(-1)).toEqual({
				id: "land",
				type: "land",
				execution: "engine",
			});
		}
		expect(
			seeds
				.filter((seed) =>
					[
						"tpl_product_v1",
						"tpl_product_designer",
						"tpl_product_prototype",
						"tpl_generic",
					].includes(seed.templateId),
				)
				.map((seed) => seed.manifest.schema_version),
		).toEqual([2, 2, 2, 2]);
	});

	it("reproduces every legacy engineering tier as a complete effective manifest", () => {
		const seeds = loadBundledWorkflowSeeds();
		const tiered = seeds.find((seed) => seed.templateId === "tpl_eng")!;
		const tieredLand = seeds.find(
			(seed) => seed.templateId === "tpl_eng_land_v1",
		)!;
		for (const tier of ["heavy", "light", "trivial"] as const) {
			const legacy = seeds.find(
				(seed) => seed.templateId === `tpl_eng_${tier}`,
			)!;
			const legacyLand = seeds.find(
				(seed) => seed.templateId === `tpl_eng_${tier}_land_v1`,
			)!;
			expect(
				applyWorkflowOverride(
					tiered.manifest,
					tiered.manifest.tier_presets![tier]!,
				).manifest,
			).toEqual(legacy.manifest);
			expect(
				applyWorkflowOverride(
					tieredLand.manifest,
					tieredLand.manifest.tier_presets![tier]!,
				).manifest,
			).toEqual(legacyLand.manifest);
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

		const product = loadBundledWorkflowSeeds().find(
			(seed) => seed.templateId === "tpl_product_v1",
		)!.manifest;
		expect(() =>
			applyWorkflowOverride(product, {
				reason: "the deliverable is still mandatory",
				nodes: { produce: { skip: true } },
			}),
		).toThrow(/cannot skip.*produce.*output|output.*produce/i);
	});

	it("validates tier presets and applies vendor plus model atomically", () => {
		const base = generalizedManifest();
		const manifest = validateWorkflowManifest({
			...base,
			tier_presets: {
				heavy: {
					reason: "heavy tier",
					nodes: {
						produce: {
							vendor: "claude",
							model: "claude-opus-4-8",
							effort: "high",
						},
					},
				},
			},
		});
		expect(manifest.tier_presets?.heavy).toMatchObject({
			reason: "heavy tier",
		});
		const applied = applyWorkflowOverride(
			manifest,
			manifest.tier_presets!.heavy!,
		);
		expect(applied.manifest.nodes[0]).toMatchObject({
			vendor: "claude",
			model: "claude-opus-4-8",
			effort: "high",
		});
		expect(() =>
			applyWorkflowOverride(base, {
				reason: "vendor cannot drift alone",
				nodes: { produce: { vendor: "claude" } },
			}),
		).toThrow(/vendor.*model|model.*vendor/i);
		expect(() =>
			validateWorkflowManifest({
				...base,
				tier_presets: {
					heavy: {
						reason: "invalid cross-vendor pair",
						nodes: {
							produce: { vendor: "claude", model: "gpt-5.6-sol" },
						},
					},
				},
			}),
		).toThrow(/incompatible/i);
	});

	it("materializes every bundled v2 seed from the real shipped agent files", () => {
		const canonicalRoot = resolve(process.cwd(), "../..");
		for (const seed of loadBundledWorkflowSeeds().filter(
			(candidate) => candidate.manifest.schema_version === 2,
		)) {
			const snapshot = buildWorkflowRunSnapshotV2({
				template: { id: seed.templateId, revision: 1 },
				manifest: seed.manifest,
				canonicalRoot,
			});
			expect(snapshot.template.id).toBe(seed.templateId);
			expect(snapshot.resolved.nodes).toHaveLength(seed.manifest.nodes.length);
			for (const node of snapshot.resolved.nodes.filter(
				(candidate) => candidate.type === "generic",
			)) {
				expect(node.agent?.content.trim()).not.toBe("");
			}
		}
	});

	it("ships bounded designer and prototype executor contracts", () => {
		const root = resolve(process.cwd(), "../..");
		const designer = readFileSync(
			resolve(root, "agents/designer-executor.md"),
			"utf8",
		);
		const prototype = readFileSync(
			resolve(root, "agents/prototype-executor.md"),
			"utf8",
		);
		for (const source of [designer, prototype]) {
			expect(source.trim()).not.toBe("");
			expect(source.length).toBeLessThanOrEqual(40_000);
			expect(source).toContain('"kind":"docs_v1"');
		}

		const deliveryOrder = [
			"publish-only URL",
			"交 Lead",
			"founder-html-delivery",
			"flywheel-comm check",
			"才开 question gate",
		].map((anchor) => designer.indexOf(anchor));
		expect(deliveryOrder.every((position) => position >= 0)).toBe(true);
		expect(deliveryOrder).toEqual([...deliveryOrder].sort((a, b) => a - b));
		expect(designer).toContain("screenshot:null / delivered:false");
		expect(designer).toContain("超时或无回复不等于批准");
		expect(prototype).toContain("自证能开");
		expect(prototype).toContain("判定归 founder gate");
		expect(prototype).toContain("不揣测结论");
	});
});
