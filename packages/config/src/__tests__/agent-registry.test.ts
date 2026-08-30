import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
	loadBundledRegistry,
	loadProjectRegistryOverlay,
	resolveProjectRegistry,
} from "../agent-registry.js";

const tempRoots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "fly2121-registry-"));
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function validBundledRegistry(): Record<string, unknown> {
	return {
		nodes: {
			eng_design: {
				file: "nodes/eng_design.md",
				label: "设计(工程)",
				type: "design",
				department: "engineering",
			},
			implement: {
				file: "nodes/implement.md",
				label: "实现",
				type: "implement",
				department: "engineering",
			},
			qa: {
				file: "nodes/qa.md",
				label: "QA 验证",
				type: "qa",
				department: "engineering",
			},
		},
		structural: {
			founder_gate: { label: "创始人门" },
			land: { label: "合入" },
		},
		graphs: {
			code: {
				templateId: "tpl_code",
				label: "工程开发",
				nodes: ["eng_design", "implement", "qa", "founder_gate", "land"],
				policies: {
					eng_design: {
						defaultModel: "fable",
						models: [
							{
								model: "fable",
								allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
								defaultEffort: "xhigh",
							},
						],
					},
					implement: {
						defaultModel: "codex",
						models: [
							{
								model: "codex",
								allowedEfforts: ["low", "medium", "high", "xhigh", "max"],
								defaultEffort: "xhigh",
							},
						],
					},
					qa: {
						defaultModel: "opus",
						models: [
							{
								model: "opus",
								allowedEfforts: ["low", "medium", "high", "max"],
								defaultEffort: "high",
							},
						],
					},
				},
				edges: [
					{
						id: "design_done",
						from: "eng_design",
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
						loopWhen: "qa_fail",
						exitWhen: "qa_pass",
					},
					{
						id: "founder_rework",
						from: "founder_gate",
						to: "implement",
						loopWhen: "founder_feedback_kickback",
						exitWhen: "founder_approved",
					},
				],
			},
		},
	};
}

function writeYaml(root: string, relativePath: string, value: unknown): string {
	const path = join(root, relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, stringify(value), "utf8");
	return path;
}

describe("bundled agent registry", () => {
	it("loads a valid full registry", () => {
		const root = tempRoot();
		const path = writeYaml(root, "registry.yaml", validBundledRegistry());

		const registry = loadBundledRegistry(path);

		expect(Object.keys(registry.graphs)).toEqual(["code"]);
		expect(registry.graphs.code?.templateId).toBe("tpl_code");
		expect(registry.nodes.eng_design).toMatchObject({
			label: "设计(工程)",
			type: "design",
		});
	});

	it("requires node names to match their markdown filenames", () => {
		const root = tempRoot();
		const value = validBundledRegistry();
		(value.nodes as Record<string, Record<string, unknown>>).eng_design!.file =
			"nodes/system_design.md";

		expect(() =>
			loadBundledRegistry(writeYaml(root, "registry.yaml", value)),
		).toThrow(/eng_design.*system_design/i);
	});

	it("rejects graph references to unregistered names", () => {
		const root = tempRoot();
		const value = validBundledRegistry();
		(
			(value.graphs as Record<string, Record<string, unknown>>).code!
				.nodes as string[]
		).push("designer");

		expect(() =>
			loadBundledRegistry(writeYaml(root, "registry.yaml", value)),
		).toThrow(/designer.*not registered/i);
	});

	it("keeps node, structural, and graph namespaces globally disjoint", () => {
		const root = tempRoot();
		const value = validBundledRegistry();
		(value.structural as Record<string, unknown>).eng_design = {
			label: "冲突",
		};

		expect(() =>
			loadBundledRegistry(writeYaml(root, "registry.yaml", value)),
		).toThrow(/eng_design.*multiple registry namespaces/i);
	});

	it("requires graph nodes to carry a type and graph references to stay local", () => {
		const root = tempRoot();
		const missingType = validBundledRegistry();
		delete (missingType.nodes as Record<string, Record<string, unknown>>)
			.eng_design!.type;
		expect(() =>
			loadBundledRegistry(writeYaml(root, "missing-type.yaml", missingType)),
		).toThrow(/eng_design.*type/i);

		const outsidePolicy = validBundledRegistry();
		(
			(outsidePolicy.graphs as Record<string, Record<string, unknown>>).code!
				.policies as Record<string, unknown>
		).other = {};
		expect(() =>
			loadBundledRegistry(
				writeYaml(root, "outside-policy.yaml", outsidePolicy),
			),
		).toThrow(/policies\.other.*not in graph/i);
	});

	it("requires unique non-empty template ids and valid topology", () => {
		const root = tempRoot();
		const duplicateTemplate = validBundledRegistry();
		const graphs = duplicateTemplate.graphs as Record<string, unknown>;
		graphs.copy = {
			...(graphs.code as Record<string, unknown>),
			label: "重复图",
		};
		expect(() =>
			loadBundledRegistry(
				writeYaml(root, "duplicate-template.yaml", duplicateTemplate),
			),
		).toThrow(/templateId.*tpl_code.*duplicate/i);

		const invalidTopology = validBundledRegistry();
		(
			(invalidTopology.graphs as Record<string, Record<string, unknown>>).code!
				.edges as Array<Record<string, unknown>>
		)[0]!.to = "founder_gate";
		expect(() =>
			loadBundledRegistry(
				writeYaml(root, "invalid-topology.yaml", invalidTopology),
			),
		).toThrow(/code.*topology/i);
	});

	it("requires labels on every node, structural node, and graph", () => {
		const root = tempRoot();
		const value = validBundledRegistry();
		(value.nodes as Record<string, Record<string, unknown>>).qa!.label = " ";

		expect(() =>
			loadBundledRegistry(writeYaml(root, "registry.yaml", value)),
		).toThrow(/nodes\.qa\.label.*non-empty/i);
	});

	it("preserves the code QA and founder-rework topology contract", () => {
		const root = tempRoot();
		const value = validBundledRegistry();
		const code = (value.graphs as Record<string, Record<string, unknown>>)
			.code!;
		code.loops = (code.loops as Array<Record<string, unknown>>).filter(
			(loop) => loop.loopWhen !== "qa_fail",
		);

		expect(() =>
			loadBundledRegistry(writeYaml(root, "missing-qa-loop.yaml", value)),
		).toThrow(/code.*QA retry loop/i);
	});

	it("accepts a declared positive QA retry cap", () => {
		const root = tempRoot();
		const value = validBundledRegistry();
		const code = (value.graphs as Record<string, Record<string, unknown>>)
			.code!;
		const qaLoop = (code.loops as Array<Record<string, unknown>>).find(
			(loop) => loop.loopWhen === "qa_fail",
		)!;
		qaLoop.maxIterations = 7;
		qaLoop.onLimit = "escalate";

		const registry = loadBundledRegistry(
			writeYaml(root, "capped-qa-loop.yaml", value),
		);
		expect(
			registry.graphs.code?.loops.find((loop) => loop.loopWhen === "qa_fail"),
		).toMatchObject({ maxIterations: 7, onLimit: "escalate" });
	});

	it("preserves simple_code and single-session graph topology contracts", () => {
		const root = tempRoot();
		const simpleValue = validBundledRegistry();
		const simpleGraphs = simpleValue.graphs as Record<
			string,
			Record<string, unknown>
		>;
		const code = structuredClone(simpleGraphs.code!);
		code.templateId = "tpl_simple_code";
		code.label = "轻量开发";
		code.nodes = ["implement", "qa", "founder_gate", "land"];
		delete (code.policies as Record<string, unknown>).eng_design;
		code.edges = (code.edges as Array<Record<string, unknown>>).filter(
			(edge) => edge.from !== "eng_design",
		);
		code.loops = (code.loops as Array<Record<string, unknown>>).filter(
			(loop) => loop.loopWhen !== "qa_fail",
		);
		delete simpleGraphs.code;
		simpleGraphs.simple_code = code;
		expect(() =>
			loadBundledRegistry(
				writeYaml(root, "invalid-simple-code.yaml", simpleValue),
			),
		).toThrow(/simple_code.*QA retry loop/i);

		const singleValue = validBundledRegistry();
		const singleGraphs = singleValue.graphs as Record<
			string,
			Record<string, unknown>
		>;
		const prd = structuredClone(singleGraphs.code!);
		prd.templateId = "tpl_prd";
		prd.label = "产品需求";
		prd.nodes = ["eng_design", "implement", "founder_gate", "land"];
		delete (prd.policies as Record<string, unknown>).qa;
		prd.edges = [
			{
				id: "design_done",
				from: "eng_design",
				to: "implement",
				condition: "design_done",
			},
			{
				id: "node_done",
				from: "implement",
				to: "founder_gate",
				condition: "node_done",
			},
			{
				id: "founder_approved",
				from: "founder_gate",
				to: "land",
				condition: "founder_approved",
			},
		];
		prd.loops = [];
		delete singleGraphs.code;
		singleGraphs.prd = prd;
		expect(() =>
			loadBundledRegistry(
				writeYaml(root, "invalid-single-session.yaml", singleValue),
			),
		).toThrow(/prd.*one executable node.*no loops/i);
	});
});

describe("project registry overlay", () => {
	it("accepts implementation-only bindings for bundled names", () => {
		const root = tempRoot();
		const bundled = loadBundledRegistry(
			writeYaml(root, "bundle/registry.yaml", validBundledRegistry()),
		);
		const overlay = loadProjectRegistryOverlay(
			writeYaml(root, "project/.flywheel/agents/registry.yaml", {
				nodes: {
					eng_design: {
						file: "nodes/eng_design.md",
						department: "engineering",
					},
				},
			}),
			bundled,
		);

		expect(overlay.nodes.eng_design).toEqual({
			file: "nodes/eng_design.md",
			department: "engineering",
		});
	});

	it("rejects graph/structural sections and semantic overrides of bundled names", () => {
		const root = tempRoot();
		const bundled = loadBundledRegistry(
			writeYaml(root, "bundle/registry.yaml", validBundledRegistry()),
		);
		expect(() =>
			loadProjectRegistryOverlay(
				writeYaml(root, "project/graphs.yaml", { nodes: {}, graphs: {} }),
				bundled,
			),
		).toThrow(/graphs.*not allowed/i);

		expect(() =>
			loadProjectRegistryOverlay(
				writeYaml(root, "project/semantic.yaml", {
					nodes: {
						eng_design: {
							file: "nodes/eng_design.md",
							label: "本地改名",
							type: "generic",
						},
					},
				}),
				bundled,
			),
		).toThrow(/eng_design.*label.*not allowed/i);
	});

	it.each(["file", "label", "department"] as const)(
		"requires project-local nodes to define %s",
		(requiredKey) => {
			const root = tempRoot();
			const bundled = loadBundledRegistry(
				writeYaml(root, "bundle/registry.yaml", validBundledRegistry()),
			);
			const local: Record<string, unknown> = {
				file: "nodes/life_helper.md",
				label: "生活助理",
				department: "life",
			};
			delete local[requiredKey];

			expect(() =>
				loadProjectRegistryOverlay(
					writeYaml(root, `project/missing-${requiredKey}.yaml`, {
						nodes: { life_helper: local },
					}),
					bundled,
				),
			).toThrow(new RegExp(`life_helper.*${requiredKey}`, "i"));
		},
	);
});

describe("resolved project registry", () => {
	it("allows a managed project to bind only the nodes it implements", () => {
		const root = tempRoot();
		const bundled = loadBundledRegistry(
			writeYaml(root, "bundle/registry.yaml", validBundledRegistry()),
		);
		const projectRoot = join(root, "managed");
		writeYaml(projectRoot, ".flywheel/agents/registry.yaml", {
			nodes: { qa: { file: "nodes/qa.md", department: "engineering" } },
		});
		const qaPath = join(projectRoot, ".flywheel", "agents", "nodes", "qa.md");
		mkdirSync(join(qaPath, ".."), { recursive: true });
		writeFileSync(qaPath, "# qa\n", "utf8");

		const resolved = resolveProjectRegistry({
			bundled,
			projectName: "managed",
			projectRoot,
		});

		expect(Object.keys(resolved.nodes)).toEqual(["qa"]);
		expect(resolved.nodes.qa?.label).toBe("QA 验证");
	});

	it.each(["source", "packaged"] as const)(
		"projects flywheel self-host bindings from bundled nodes in %s mode",
		(mode) => {
			const root = tempRoot();
			const bundleRoot =
				mode === "source" ? root : join(root, "installed", "bundle");
			const projectRoot = mode === "source" ? root : join(root, "checkout");
			const bundled = loadBundledRegistry(
				writeYaml(
					bundleRoot,
					".flywheel/agents/registry.yaml",
					validBundledRegistry(),
				),
			);
			for (const name of ["eng_design", "implement", "qa"]) {
				const nodePath = join(
					projectRoot,
					".flywheel",
					"agents",
					"nodes",
					`${name}.md`,
				);
				mkdirSync(join(nodePath, ".."), { recursive: true });
				writeFileSync(nodePath, `# ${name}\n`, "utf8");
			}

			const resolved = resolveProjectRegistry({
				bundled,
				projectName: "flywheel",
				projectRoot,
			});

			expect(resolved.nodes.eng_design).toMatchObject({
				name: "eng_design",
				label: "设计(工程)",
				type: "design",
				department: "engineering",
			});
			expect(resolved.nodes.eng_design?.agentFile).toBe(
				join(projectRoot, ".flywheel", "agents", "nodes", "eng_design.md"),
			);
		},
	);
});
