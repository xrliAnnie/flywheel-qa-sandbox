import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundledRegistry } from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	compileWorkflowMenuSeed,
	loadWorkflowMenuLibrary,
	resolveLeadMenus,
	resolveNodeAgentFile,
} from "../workflow-menu.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const REGISTRY_PATH = join(REPO_ROOT, ".flywheel", "agents", "registry.yaml");
const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("FLY-2121 registry-backed workflow menus", () => {
	it("defines stable graph ids, template ids, and display labels in one registry", () => {
		const registry = loadBundledRegistry(REGISTRY_PATH);

		expect(
			Object.entries(registry.graphs).map(([name, graph]) => ({
				name,
				templateId: graph.templateId,
				label: graph.label,
			})),
		).toEqual([
			{ name: "code", templateId: "tpl_code", label: "工程开发" },
			{
				name: "simple_code",
				templateId: "tpl_simple_code",
				label: "轻量开发",
			},
			{ name: "prd", templateId: "tpl_prd", label: "产品需求" },
			{
				name: "product_design_flow",
				templateId: "tpl_design",
				label: "产品设计",
			},
			{
				name: "prototype",
				templateId: "tpl_prototype",
				label: "原型验证",
			},
			{
				name: "generic",
				templateId: "tpl_generic_menu",
				label: "通用",
			},
		]);
	});

	it("uses distinct descriptive ids for graph, engineering design, and product design", () => {
		const menus = loadWorkflowMenuLibrary();
		const code = menus.find((menu) => menu.shape === "code")!;
		const productDesign = menus.find(
			(menu) => menu.shape === "product_design_flow",
		)!;

		expect(code.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "eng_design",
					label: "设计(工程)",
					type: "design",
				}),
			]),
		);
		expect(productDesign.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "product_design",
					label: "产品设计",
					type: "generic",
				}),
			]),
		);
		expect(
			new Set([
				code.nodes[0]?.id,
				productDesign.nodes[0]?.id,
				productDesign.shape,
			]).size,
		).toBe(3);
	});

	it("gives every compiled node a backend label and writes no role in new manifests", () => {
		for (const menu of loadWorkflowMenuLibrary()) {
			const seed = compileWorkflowMenuSeed(menu);
			expect(seed.templateId, menu.shape).toBe(menu.templateId);
			expect(seed.name, menu.shape).toBe(menu.label);
			for (const node of seed.manifest.nodes) {
				expect(node, `${menu.shape}:${node.id}`).toHaveProperty("label");
				expect(
					String((node as unknown as { label?: string }).label).trim().length,
					`${menu.shape}:${node.id}`,
				).toBeGreaterThan(0);
				expect(Object.hasOwn(node, "role"), `${menu.shape}:${node.id}`).toBe(
					false,
				);
			}
		}
	});

	it("renames repeated single-session ids so node names are globally descriptive", () => {
		const executableIds = Object.fromEntries(
			loadWorkflowMenuLibrary().map((menu) => [
				menu.shape,
				menu.nodes.find((node) => node.type !== "gate" && node.type !== "land")
					?.id,
			]),
		);

		expect(executableIds).toMatchObject({
			prd: "pm",
			product_design_flow: "product_design",
			prototype: "proto",
			generic: "general",
		});
	});

	it("resolves every adopted self-host node and pins registered agent content", () => {
		expect(
			resolveLeadMenus({
				projectRoot: REPO_ROOT,
				leadId: "flywheel-eng-lead",
			}).map((menu) => menu.shape),
		).toEqual(["code", "simple_code", "generic"]);

		const code = loadWorkflowMenuLibrary().find(
			(menu) => menu.shape === "code",
		)!;
		const seed = compileWorkflowMenuSeed(code);
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: seed.templateId, revision: 2 },
			manifest: seed.manifest,
			canonicalRoot: REPO_ROOT,
		});

		for (const nodeId of ["eng_design", "implement", "qa"]) {
			const node = snapshot.resolved.nodes.find(
				(candidate) => candidate.id === nodeId,
			);
			expect(node?.agent?.content.trim().length, nodeId).toBeGreaterThan(0);
			expect(node?.agent?.digest, nodeId).toMatch(/^[a-f0-9]{64}$/);
		}
	});

	it("keeps the retained self-host roster canonical and non-dangling", () => {
		const roster = parse(
			readFileSync(
				join(REPO_ROOT, ".flywheel", "menus", "ic-roster.yaml"),
				"utf8",
			),
		) as Record<string, string>;

		expect(Object.keys(roster)).toEqual([
			"eng_design",
			"implement",
			"qa",
			"pm",
			"product_design",
			"proto",
			"general",
		]);
		for (const [nodeId, agentFile] of Object.entries(roster)) {
			expect(existsSync(join(REPO_ROOT, agentFile)), nodeId).toBe(true);
		}
	});

	it("resolves canonical node ids directly from an unactivated project roster", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "fly2121-legacy-project-"));
		fixtureRoots.push(projectRoot);
		mkdirSync(join(projectRoot, ".flywheel", "menus"), { recursive: true });
		mkdirSync(join(projectRoot, ".flywheel", "agents", "life"), {
			recursive: true,
		});
		writeFileSync(
			join(projectRoot, ".flywheel", "config.yaml"),
			"project: personal-assistant\n",
		);
		writeFileSync(
			join(projectRoot, ".flywheel", "menus", "adoption.yaml"),
			"belle-lead: [generic]\n",
		);
		writeFileSync(
			join(projectRoot, ".flywheel", "menus", "ic-roster.yaml"),
			"general: .flywheel/agents/life/life-executor.md\n",
		);
		writeFileSync(
			join(projectRoot, ".flywheel", "agents", "life", "life-executor.md"),
			"# Life executor\n",
		);

		expect(
			resolveLeadMenus({ projectRoot, leadId: "belle-lead" }).map(
				(menu) => menu.shape,
			),
		).toEqual(["generic"]);
		expect(resolveNodeAgentFile(projectRoot, "general")).toBe(
			".flywheel/agents/life/life-executor.md",
		);
		expect(() => resolveNodeAgentFile(projectRoot, "generic")).toThrowError(
			expect.objectContaining({
				code: "NODE_NOT_REGISTERED",
				legal: ["general"],
			}),
		);
	});

	it("preserves the unchanged proto role for an unactivated project", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "fly2121-legacy-proto-"));
		fixtureRoots.push(projectRoot);
		mkdirSync(join(projectRoot, ".flywheel", "menus"), { recursive: true });
		mkdirSync(join(projectRoot, ".flywheel", "agents"), { recursive: true });
		writeFileSync(
			join(projectRoot, ".flywheel", "config.yaml"),
			"project: legacy-proto\n",
		);
		writeFileSync(
			join(projectRoot, ".flywheel", "menus", "ic-roster.yaml"),
			"proto: .flywheel/agents/proto.md\n",
		);
		writeFileSync(
			join(projectRoot, ".flywheel", "agents", "proto.md"),
			"# Prototype executor\n",
		);

		expect(resolveNodeAgentFile(projectRoot, "proto")).toBe(
			".flywheel/agents/proto.md",
		);
	});
});
