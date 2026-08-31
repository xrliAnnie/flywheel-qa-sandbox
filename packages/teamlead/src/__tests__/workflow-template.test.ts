import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildWorkflowRunSnapshotV1,
	buildWorkflowRunSnapshotV2,
	resolveWorkflowGateAuthority,
} from "../workflow-run-snapshot.js";
import {
	applyWorkflowOverride,
	isWorkflowManifestV1Land,
	parseWorkflowManifestYaml,
	validatePinnedWorkflowManifest,
	validateWorkflowManifest,
	WORKFLOW_OUTCOME_VOCABULARY,
} from "../workflow-template.js";
import {
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "./fixtures/legacy-workflow-manifests.js";

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
			model: "claude-opus-5",
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
	});

	it("rejects mixed legacy and land_v1 vocabularies", () => {
		const legacy = legacyWorkflowSeeds()[0]!.manifest;
		expect(() =>
			validateWorkflowManifest({
				...legacy,
				manifest_variant: "land_v1",
				approval_gate: legacy.terminal_gate,
				terminal_node: { node: "land" },
			}),
		).toThrow(/mixed|unknown key|land_v1/i);
	});

	it("allows any v1 loop to omit its iteration limit pair", () => {
		const manifest = structuredClone(
			legacyWorkflowSeeds().find(
				(seed) => seed.templateId === "tpl_eng_heavy_land_v1",
			)!.manifest,
		);
		const founderLoop = manifest.loops.find(
			(loop) => loop.loop_when === "founder_feedback_kickback",
		)! as unknown as Record<string, unknown>;
		delete founderLoop.max_iterations;
		delete founderLoop.on_limit;

		const parsed = validateWorkflowManifest(manifest);
		const parsedFounderLoop = parsed.loops.find(
			(loop) => loop.loop_when === "founder_feedback_kickback",
		)!;
		expect(parsedFounderLoop).not.toHaveProperty("max_iterations");
		expect(parsedFounderLoop).not.toHaveProperty("on_limit");

		const unboundedQa = structuredClone(manifest);
		const qaLoop = unboundedQa.loops.find(
			(loop) => loop.loop_when === "qa_fail",
		)! as unknown as Record<string, unknown>;
		delete qaLoop.max_iterations;
		delete qaLoop.on_limit;
		const parsedQaLoop = validateWorkflowManifest(unboundedQa).loops.find(
			(loop) => loop.loop_when === "qa_fail",
		)!;
		expect(parsedQaLoop).not.toHaveProperty("max_iterations");
		expect(parsedQaLoop).not.toHaveProperty("on_limit");

		for (const missing of ["max_iterations", "on_limit"] as const) {
			const invalid = structuredClone(manifest);
			const qaLoop = invalid.loops.find(
				(loop) => loop.loop_when === "qa_fail",
			)! as unknown as Record<string, unknown>;
			delete qaLoop[missing];
			expect(() => validateWorkflowManifest(invalid)).toThrow(
				/max_iterations.*on_limit|on_limit.*max_iterations|positive integer/i,
			);
		}

		const halfBounded = structuredClone(manifest);
		(
			halfBounded.loops.find(
				(loop) => loop.loop_when === "founder_feedback_kickback",
			)! as unknown as Record<string, unknown>
		).max_iterations = 3;
		expect(() => validateWorkflowManifest(halfBounded)).toThrow(
			/max_iterations.*on_limit|on_limit.*max_iterations/i,
		);
	});

	it("rejects unknown keys, inline handoffs, unsupported schemas, and invalid graphs", () => {
		const valid = legacyWorkflowSeeds()[0]!.manifest;
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
		const valid = legacyWorkflowSeeds()[0]!.manifest;
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
		const valid = legacyWorkflowSeeds()[0]!.manifest;
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
					node.id === "implement" ? { ...node, effort: "ultra" } : node,
				),
			}),
		).toThrow(/registry|supported|effort/i);
	});

	it("applies only reasoned model/effort/skip overrides and consumes skip before validation", () => {
		const heavy = legacyWorkflowSeeds()[0]!.manifest;
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
	it("allows a v2 review loop to be unbounded while rejecting half a limit pair", () => {
		const unbounded = generalizedManifest();
		delete (unbounded.loops[0] as Record<string, unknown>).max_iterations;
		delete (unbounded.loops[0] as Record<string, unknown>).on_limit;
		const parsedLoop = validateWorkflowManifest(unbounded).loops[0]!;
		expect(parsedLoop).not.toHaveProperty("max_iterations");
		expect(parsedLoop).not.toHaveProperty("on_limit");

		const halfBounded = generalizedManifest();
		delete (halfBounded.loops[0] as Record<string, unknown>).on_limit;
		expect(() => validateWorkflowManifest(halfBounded)).toThrow(
			/max_iterations.*on_limit|on_limit.*max_iterations/i,
		);
	});

	it("accepts an engine-owned terminal land node without relying on node ids", () => {
		const manifest = validateWorkflowManifest({
			schema_version: 2,
			nodes: [
				{
					id: "craft",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic.md",
				},
				{ id: "decision", type: "gate" },
				{ id: "publish", type: "land", execution: "engine" },
			],
			edges: [
				{
					id: "crafted",
					from: "craft",
					to: "decision",
					condition: "node_done",
				},
				{
					id: "approved",
					from: "decision",
					to: "publish",
					condition: "founder_approved",
				},
			],
			loops: [],
			approval_gate: { node: "decision", predicate: "founder_approved" },
			terminal_node: { node: "publish" },
			ship_claims: ["founder_approved"],
		});

		expect(manifest).toMatchObject({
			approval_gate: { node: "decision" },
			terminal_node: { node: "publish" },
		});
		expect(manifest.nodes.at(-1)).toEqual({
			id: "publish",
			type: "land",
			execution: "engine",
		});
	});

	it("legacy-repair keeps an existing legacy pin parseable", () => {
		// A published revision naming a legacy id must stay readable so it can be
		// inspected and republished — there is no blocklist to trip over.
		const v2 = generalizedManifest();
		v2.nodes[1]!.model = "claude-opus-4-8";
		expect(() =>
			validateWorkflowManifest(v2, { allowUnsupportedModels: true }),
		).not.toThrow();
		expect(() => validatePinnedWorkflowManifest(v2)).not.toThrow();

		const v1 = structuredClone(legacyWorkflowSeeds()[0]!.manifest);
		const claudeNode = v1.nodes.find((node) => node.vendor === "claude");
		expect(claudeNode).toBeDefined();
		if (claudeNode) claudeNode.model = "claude-opus-4-8[1m]";
		expect(() =>
			validateWorkflowManifest(v1, { allowUnsupportedModels: true }),
		).not.toThrow();
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

	it("accepts submission windows only on nodes identified by verdict topology", () => {
		const heavy = structuredClone(
			legacyWorkflowSeeds().find((seed) => seed.templateId === "tpl_eng_heavy")!
				.manifest,
		);
		for (const value of [0, -1, 1.5, "180"]) {
			const invalid = structuredClone(heavy);
			const qa = invalid.nodes.find((node) => node.id === "qa")!;
			(qa as unknown as Record<string, unknown>).submissionWindowMinutes =
				value;
			expect(() => validateWorkflowManifest(invalid)).toThrow(
				/submissionWindowMinutes.*positive integer/i,
			);
		}

		for (const nodeId of ["implement", "founder_gate"]) {
			const invalid = structuredClone(heavy);
			const node = invalid.nodes.find((candidate) => candidate.id === nodeId)!;
			(node as unknown as Record<string, unknown>).submissionWindowMinutes =
				180;
			expect(() => validateWorkflowManifest(invalid)).toThrow(
				/submissionWindowMinutes.*decision/i,
			);
		}

		for (const nodeId of ["produce", "founder_gate"]) {
			const invalid = generalizedManifest();
			const node = invalid.nodes.find((candidate) => candidate.id === nodeId)!;
			(node as unknown as Record<string, unknown>).submissionWindowMinutes =
				180;
			expect(() => validateWorkflowManifest(invalid)).toThrow(
				/submissionWindowMinutes.*decision/i,
			);
		}

		const review = generalizedManifest();
		(
			review.nodes.find((node) => node.id === "review")! as unknown as Record<
				string,
				unknown
			>
		).submissionWindowMinutes = 180;
		expect(
			validateWorkflowManifest(review).nodes.find(
				(node) => node.id === "review",
			),
		).toMatchObject({ submissionWindowMinutes: 180 });
	});

	it("enforces the independent-QA invariant for implement pipelines only", () => {
		const base = generalizedManifest();
		const singleWriterGraph = (writerType: "design" | "implement") => ({
			...base,
			nodes: [
				{
					id: "writer",
					type: writerType,
					vendor: "codex" as const,
					model: "gpt-5.6-sol",
				},
				{ id: "founder_gate", type: "gate" as const },
			],
			edges: [
				{
					id: "writer_done",
					from: "writer",
					to: "founder_gate",
					condition: (writerType === "design"
						? "design_done"
						: "implement_done") as "design_done" | "implement_done",
				},
			],
			loops: [],
			ship_claims: ["founder_approved" as const],
		});

		// An `implement` node means the formal engineering pipeline: independent QA
		// guards its merge point, so it stays mandatory.
		expect(() =>
			validateWorkflowManifest(singleWriterGraph("implement")),
		).toThrow(/exactly one independent QA|qa_passed/i);

		// A design-only graph produces documents, not merged code. It has nowhere
		// to put an independent QA node and must not be sentenced to death by this
		// rule — same reason a single-stage `generic` graph must not be.
		expect(() =>
			validateWorkflowManifest(singleWriterGraph("design")),
		).not.toThrow();

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
							model: "claude-opus-5",
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
			model: "claude-opus-5",
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

	it("resolves coherent gate authority for every bundled seed snapshot", () => {
		const canonicalRoot = resolve(process.cwd(), "../..");
		for (const seed of legacyWorkflowSeeds()) {
			const template = { id: seed.templateId, revision: 1 };
			const executableSeed =
				seed.manifest.schema_version === 1
					? seed
					: pinLegacyWorkflowSeedAgents(seed);
			const snapshot =
				executableSeed.manifest.schema_version === 1
					? buildWorkflowRunSnapshotV1({
							template,
							manifest: executableSeed.manifest,
						})
					: buildWorkflowRunSnapshotV2({
							template,
							manifest: executableSeed.manifest,
							canonicalRoot,
						});

			expect(
				() => resolveWorkflowGateAuthority(snapshot),
				seed.templateId,
			).not.toThrow();
		}
	});

	it("ships bounded product-design and prototype node contracts", () => {
		const root = resolve(process.cwd(), "../..");
		const designer = readFileSync(
			resolve(root, ".flywheel/agents/nodes/product_design.md"),
			"utf8",
		);
		const prototype = readFileSync(
			resolve(root, ".flywheel/agents/nodes/proto.md"),
			"utf8",
		);
		for (const source of [designer, prototype]) {
			expect(source.trim()).not.toBe("");
			expect(source.length).toBeLessThanOrEqual(40_000);
			expect(source).toContain("founder-html-delivery");
			expect(source).toContain("flywheel-comm ask");
		}

		const deliveryOrder = [
			"concept images",
			"Publish WITHOUT",
			"founder_review",
			"approved high-fidelity artifact",
		].map((anchor) => designer.indexOf(anchor));
		expect(deliveryOrder.every((position) => position >= 0)).toBe(true);
		expect(deliveryOrder).toEqual([...deliveryOrder].sort((a, b) => a - b));
		expect(designer).toContain("do not hand off or complete");
		expect(prototype).toContain("doable / not-doable");
		expect(prototype).toContain("no answer → BLOCKED");
		expect(prototype).toContain("not doable → drop");
	});
});
