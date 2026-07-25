import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	WORKFLOW_MENU_BINDINGS,
	workflowMenuTemplateId,
} from "flywheel-config";
import { describe, expect, it } from "vitest";
import { FLY1436_TARGET_BINDINGS } from "../bridge/workkind-cutover.js";
import { StateStore } from "../StateStore.js";
import {
	compileWorkflowMenuSeed,
	importWorkflowMenuSeeds,
	loadProjectMenuConfig,
	loadWorkflowMenuLibrary,
	resolveLeadMenus,
	resolveMenuOverrides,
	WorkflowMenuValidationError,
} from "../workflow-menu.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";
import { importBundledWorkflowSeeds } from "../workflow-template.js";
import { resolveWorkflowTemplateSelection } from "../workflow-template-selection.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

describe("founder-approved workflow menu source", () => {
	it("loads exactly five shapes and removes research", () => {
		const menus = loadWorkflowMenuLibrary();
		expect(menus.map((menu) => menu.shape)).toEqual([
			"code",
			"prd",
			"design",
			"prototype",
			"generic",
		]);
		expect(menus.some((menu) => menu.shape === "research")).toBe(false);
		expect(
			menus.flatMap((menu) => menu.nodes).some((node) => node.id === "review"),
		).toBe(false);
	});

	it("uses one category-to-template table for validation, compilation, and cutover projection", () => {
		expect(WORKFLOW_MENU_BINDINGS).toEqual([
			{ taskCategory: "code", templateId: "tpl_code" },
			{ taskCategory: "prd", templateId: "tpl_prd" },
			{ taskCategory: "design", templateId: "tpl_design" },
			{ taskCategory: "prototype", templateId: "tpl_prototype" },
			{ taskCategory: "generic", templateId: "tpl_generic_menu" },
		]);
		expect(FLY1436_TARGET_BINDINGS).toBe(WORKFLOW_MENU_BINDINGS);
	});

	it("pins the Code DAG, retry loop, exact models, defaults, and nested efforts", () => {
		const code = loadWorkflowMenuLibrary().find(
			(menu) => menu.shape === "code",
		)!;
		expect(
			code.nodes.map((node) => ({ id: node.id, role: node.role })),
		).toEqual([
			{ id: "design", role: "design" },
			{ id: "implement", role: "implement" },
			{ id: "qa", role: "qa" },
			{ id: "founder_gate", role: undefined },
		]);
		expect(code.edges).toEqual([
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
		]);
		expect(code.loops).toEqual([
			{
				id: "qa_retry",
				from: "qa",
				to: "implement",
				loopWhen: "qa_fail",
				exitWhen: "qa_pass",
				maxIterations: 3,
				onLimit: "escalate",
			},
		]);
		for (const [nodeId, models, defaultModel] of [
			["design", ["fable", "codex"], "fable"],
			["implement", ["fable", "codex"], "codex"],
			["qa", ["opus"], "opus"],
		] as const) {
			const node = code.nodes.find((candidate) => candidate.id === nodeId)!;
			expect(node.defaultModel).toBe(defaultModel);
			expect(node.models?.map((model) => model.model)).toEqual(models);
			for (const model of node.models ?? []) {
				expect(model.allowedEfforts).toEqual(ALL_EFFORTS);
				expect(model.defaultEffort).toBe("xhigh");
			}
		}
	});

	it("keeps every single-session menu to one executable node plus founder gate, defaulting to Opus xhigh", () => {
		const menus = loadWorkflowMenuLibrary().filter(
			(menu) => menu.shape !== "code",
		);
		expect(
			menus.map((menu) => ({
				shape: menu.shape,
				nodes: menu.nodes.map((node) => node.id),
				roles: menu.nodes.map((node) => node.role),
				edges: menu.edges,
			})),
		).toEqual([
			{
				shape: "prd",
				nodes: ["produce", "founder_gate"],
				roles: ["pm", undefined],
				edges: [
					{
						id: "produce_done",
						from: "produce",
						to: "founder_gate",
						condition: "node_done",
					},
				],
			},
			{
				shape: "design",
				nodes: ["produce", "founder_gate"],
				roles: ["designer", undefined],
				edges: [
					{
						id: "produce_done",
						from: "produce",
						to: "founder_gate",
						condition: "node_done",
					},
				],
			},
			{
				shape: "prototype",
				nodes: ["produce", "founder_gate"],
				roles: ["proto", undefined],
				edges: [
					{
						id: "produce_done",
						from: "produce",
						to: "founder_gate",
						condition: "node_done",
					},
				],
			},
			{
				shape: "generic",
				nodes: ["execute", "founder_gate"],
				roles: ["generic", undefined],
				edges: [
					{
						id: "execute_done",
						from: "execute",
						to: "founder_gate",
						condition: "node_done",
					},
				],
			},
		]);
		for (const menu of menus) {
			const executable = menu.nodes.find((node) => node.role)!;
			expect(executable.defaultModel).toBe("opus");
			expect(executable.models).toEqual([
				{
					model: "opus",
					allowedEfforts: ALL_EFFORTS,
					defaultEffort: "xhigh",
				},
			]);
			expect(menu.loops).toEqual([]);
		}
	});

	it("loads the Flywheel IC roster and Lead adoption without rewriting IC assets", () => {
		const config = loadProjectMenuConfig(REPO_ROOT);
		expect(config.roster).toEqual({
			design: ".flywheel/agents/engineering/engineer-executor.md",
			implement: ".flywheel/agents/engineering/engineer-executor.md",
			qa: ".flywheel/agents/engineering/qa-executor.md",
			pm: ".flywheel/agents/engineering/pm-executor.md",
			designer: ".flywheel/agents/engineering/designer-executor.md",
			proto: ".flywheel/agents/engineering/prototype-executor.md",
			generic: ".flywheel/agents/general-executor.md",
		});
		expect(config.adoption).toEqual({
			"flywheel-eng-lead": ["code", "generic"],
			"flywheel-product-lead": ["prd", "design", "prototype"],
		});
		expect(
			resolveLeadMenus({
				projectRoot: REPO_ROOT,
				leadId: "flywheel-eng-lead",
			}).map((menu) => menu.shape),
		).toEqual(["code", "generic"]);
		expect(
			resolveLeadMenus({
				projectRoot: REPO_ROOT,
				leadId: "flywheel-product-lead",
			}).map((menu) => menu.shape),
		).toEqual(["prd", "design", "prototype"]);
		const productIdentity = readFileSync(
			`${REPO_ROOT}/.lead/flywheel-product-lead/identity.md`,
			"utf8",
		);
		expect(productIdentity).toContain('"taskCategory":"prd"');
		expect(productIdentity).not.toContain('"taskCategory":"research"');
	});

	it("compiles every shape into a role-based v2 seed with no agent_file or review node", () => {
		for (const menu of loadWorkflowMenuLibrary()) {
			const seed = compileWorkflowMenuSeed(menu);
			expect(seed.templateId).toBe(workflowMenuTemplateId(menu.shape));
			expect(seed.projectScope).toBe("global");
			expect(seed.manifest.schema_version).toBe(2);
			expect(seed.manifest.nodes.some((node) => node.type === "review")).toBe(
				false,
			);
			for (const node of seed.manifest.nodes.filter(
				(candidate) => candidate.type !== "gate",
			)) {
				expect(node.role).toBeTruthy();
				expect(node.agent_file).toBeUndefined();
			}
		}
	});

	it("imports the five compiled identities into the SQLite registry", async () => {
		const store = await StateStore.create(":memory:");
		importWorkflowMenuSeeds(store);
		for (const binding of WORKFLOW_MENU_BINDINGS) {
			const row = store.getWorkflowTemplate(binding.templateId);
			expect(row).toMatchObject({
				template_id: binding.templateId,
				current_published_revision: 1,
			});
			expect(
				store.getWorkflowTemplateRevision(binding.templateId, 1)
					?.schema_version,
			).toBe(2);
		}
		store.close();
	});

	it("keeps bundled and menu seed imports idempotent across repeated boots", async () => {
		const store = await StateStore.create(":memory:");
		for (let boot = 0; boot < 3; boot += 1) {
			importBundledWorkflowSeeds(store);
			importWorkflowMenuSeeds(store);
		}
		expect(store.listWorkflowTemplateRevisions("tpl_generic")).toHaveLength(1);
		expect(
			store.listWorkflowTemplateRevisions("tpl_generic_menu"),
		).toHaveLength(1);
		expect(store.getWorkflowTemplate("tpl_generic")?.name).toBe(
			"Generic single-session task",
		);
		expect(store.getWorkflowTemplate("tpl_generic_menu")?.name).toBe(
			"generic menu",
		);
		store.close();
	});

	it("materializes every executable role from the project IC roster", () => {
		const seed = compileWorkflowMenuSeed(
			loadWorkflowMenuLibrary().find((menu) => menu.shape === "code")!,
		);
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: seed.templateId, revision: 1 },
			manifest: seed.manifest,
			canonicalRoot: REPO_ROOT,
		});
		const design = snapshot.resolved.nodes.find(
			(node) => node.id === "design",
		)!;
		const implement = snapshot.resolved.nodes.find(
			(node) => node.id === "implement",
		)!;
		const qa = snapshot.resolved.nodes.find((node) => node.id === "qa")!;
		expect(design.agent?.content).toBe(
			readFileSync(
				`${REPO_ROOT}/.flywheel/agents/engineering/engineer-executor.md`,
				"utf8",
			).slice(0, 40_000),
		);
		expect(implement.agent).toEqual(design.agent);
		expect(qa.agent?.content).toBe(
			readFileSync(
				`${REPO_ROOT}/.flywheel/agents/engineering/qa-executor.md`,
				"utf8",
			).slice(0, 40_000),
		);
	});

	it("pins a validated API override into the run snapshot and idempotency digest", async () => {
		const store = await StateStore.create(":memory:");
		importWorkflowMenuSeeds(store);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "code",
			templateId: "tpl_code",
			updatedBy: "test",
		});
		const menu = loadWorkflowMenuLibrary().find(
			(candidate) => candidate.shape === "code",
		)!;
		const firstOverride = resolveMenuOverrides(menu, {
			design: { model: "codex", effort: "max" },
		});
		const ids = ["run-menu", "exec-menu"];
		const first = await resolveWorkflowTemplateSelection(store, {
			project: "flywheel",
			issueId: "FLY-MENU",
			taskCategory: "code",
			selectedBy: "flywheel-eng-lead",
			actor: "master",
			authKind: "master",
			canonicalRoot: REPO_ROOT,
			idempotencyKey: "menu-start-1",
			candidateSchemaAtEntry: 2,
			workKindEnforced: true,
			categorySource: "task_category",
			entryKind: "workflow_v2",
			override: firstOverride.templateOverride,
			idFactory: () => ids.shift()!,
			env: {
				FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
				FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
				FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
				FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
			},
		});
		expect(first?.node.dispatch).toEqual({
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "max",
		});
		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-MENU",
				taskCategory: "code",
				selectedBy: "flywheel-eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: REPO_ROOT,
				idempotencyKey: "menu-start-1",
				candidateSchemaAtEntry: 2,
				workKindEnforced: true,
				categorySource: "task_category",
				entryKind: "workflow_v2",
				override: resolveMenuOverrides(menu, {
					design: { model: "fable" },
				}).templateOverride,
				env: {
					FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
					FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
				},
			}),
		).rejects.toThrow(/idempotency key payload mismatch/);
		store.close();
	});
});

describe("workflow menu override validation", () => {
	const code = () =>
		loadWorkflowMenuLibrary().find((menu) => menu.shape === "code")!;

	it("resolves aliases through the canonical registry and emits truthful receipts", () => {
		const resolved = resolveMenuOverrides(code(), {
			design: { model: "codex", effort: "max" },
		});
		expect(resolved.templateOverride).toEqual({
			reason: "menu_api_override",
			nodes: {
				design: {
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "max",
				},
			},
		});
		expect(resolved.receipts).toMatchObject({
			design: {
				model: "codex (= gpt-5.6-sol)",
				effort: "max",
				overridden: true,
			},
			implement: {
				model: "codex (= gpt-5.6-sol)",
				effort: "xhigh",
				overridden: false,
			},
			qa: {
				model: "opus (= claude-opus-5)",
				effort: "xhigh",
				overridden: false,
			},
		});
	});

	it.each([
		[
			{ missing: { model: "fable" } },
			"MENU_NODE_NOT_FOUND",
			["design", "implement", "qa"],
		],
		[
			{ design: { model: "opus" } },
			"MODEL_NOT_ALLOWED_FOR_NODE",
			["fable", "codex"],
		],
		[
			{ design: { model: "fable", effort: "ultra" } },
			"EFFORT_NOT_ALLOWED_FOR_MODEL",
			ALL_EFFORTS,
		],
	] as const)(
		"fails loud for invalid override %# with a legal set",
		(overrides, codeName, legal) => {
			try {
				resolveMenuOverrides(code(), overrides);
				throw new Error("expected validation failure");
			} catch (error) {
				expect(error).toBeInstanceOf(WorkflowMenuValidationError);
				expect(error).toMatchObject({ code: codeName, legal });
			}
		},
	);
});
