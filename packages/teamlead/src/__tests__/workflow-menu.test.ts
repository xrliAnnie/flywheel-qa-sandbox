import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	resetModelConfigCacheForTests,
	validateModelConfigDocument,
} from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLY1436_TARGET_BINDINGS } from "../bridge/workkind-cutover.js";
import { StateStore } from "../StateStore.js";
import { migrateFly2121WorkflowCatalog } from "../workflow-catalog-migration.js";
import {
	compileWorkflowMenuSeed,
	importWorkflowMenuSeeds,
	loadBundledWorkflowNodeNames,
	loadProjectMenuConfig,
	loadWorkflowMenuLibrary,
	loadWorkflowMenuSeeds,
	reconcileMenuCategoryBindings,
	resolveLeadMenus,
	resolveMenuOverrides,
	WorkflowMenuValidationError,
	workflowMenuBindings,
	workflowMenuTemplateId,
} from "../workflow-menu.js";
import {
	buildWorkflowRunSnapshotV3,
	nodeRequiresFounderReview,
	resolveWorkflowGateAuthority,
} from "../workflow-run-snapshot.js";
import {
	validateManifestForPersistence,
	validateWorkflowManifest,
	workflowSeedContentHash,
} from "../workflow-template.js";
import { resolveWorkflowTemplateSelection } from "../workflow-template-selection.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const OPUS_EFFORTS = ["low", "medium", "high", "max"];

describe("founder-approved workflow menu source", () => {
	it("loads exactly six registered graphs and removes research", () => {
		const menus = loadWorkflowMenuLibrary();
		expect(menus.map((menu) => menu.shape)).toEqual([
			"code",
			"simple_code",
			"prd",
			"product_design_flow",
			"prototype",
			"generic",
		]);
		expect(menus.some((menu) => menu.shape === "research")).toBe(false);
		expect(
			menus.flatMap((menu) => menu.nodes).some((node) => node.id === "review"),
		).toBe(false);
	});

	it("derives one category-to-template projection from the registry", () => {
		const bindings = workflowMenuBindings();
		expect(bindings).toEqual([
			{ taskCategory: "code", templateId: "tpl_code" },
			{ taskCategory: "simple_code", templateId: "tpl_simple_code" },
			{ taskCategory: "prd", templateId: "tpl_prd" },
			{ taskCategory: "product_design_flow", templateId: "tpl_design" },
			{ taskCategory: "prototype", templateId: "tpl_prototype" },
			{ taskCategory: "generic", templateId: "tpl_generic_menu" },
		]);
		expect(FLY1436_TARGET_BINDINGS).toEqual(bindings);
	});

	it("pins the Simple Code DAG defaults to Opus implement and Opus QA", () => {
		const menu = loadWorkflowMenuLibrary().find(
			(candidate) => candidate.shape === "simple_code",
		)!;
		expect(
			menu.nodes.map((node) => ({
				id: node.id,
				label: node.label,
				type: node.type,
				defaultModel: node.defaultModel,
			})),
		).toEqual([
			{
				id: "implement",
				label: "实现",
				type: "implement",
				defaultModel: "opus",
			},
			{
				id: "qa",
				label: "QA 验证",
				type: "qa",
				defaultModel: "opus",
			},
			{
				id: "founder_gate",
				label: "创始人门",
				type: "gate",
				defaultModel: undefined,
			},
		]);
		expect(menu.edges).toEqual([
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
		expect(menu.loops).toEqual([
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
		]);
		expect(menu.nodes.find((node) => node.id === "implement")?.models).toEqual([
			{
				model: "opus",
				allowedEfforts: ALL_EFFORTS,
				defaultEffort: "xhigh",
			},
			{
				model: "sol",
				allowedEfforts: ALL_EFFORTS,
				defaultEffort: "xhigh",
			},
			{
				model: "fable",
				allowedEfforts: ALL_EFFORTS,
				defaultEffort: "high",
			},
			{
				model: "codex",
				allowedEfforts: ALL_EFFORTS,
				defaultEffort: "xhigh",
			},
			{
				model: "astra",
				allowedEfforts: ALL_EFFORTS,
				defaultEffort: "xhigh",
			},
		]);

		const seed = compileWorkflowMenuSeed(menu);
		expect(seed).toMatchObject({
			templateId: "tpl_simple_code",
			manifest: {
				ship_claims: ["qa_passed", "founder_approved"],
				approval_gate: { node: "founder_gate" },
			},
		});
		expect(seed.manifest.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "implement",
					type: "implement",
					vendor: "claude",
					model: "opus",
				}),
				// FLY-2775: the seed persists the family alias; each run resolves it.
				expect.objectContaining({
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "opus",
				}),
				expect.objectContaining({ type: "land", execution: "engine" }),
			]),
		);
		const qaLoop = seed.manifest.loops.find(
			(loop) => loop.loop_when === "qa_fail",
		)!;
		expect(qaLoop).not.toHaveProperty("max_iterations");
		expect(qaLoop).not.toHaveProperty("on_limit");
	});

	it("pins the Code DAG, unbounded retry loop, exact models, defaults, and nested efforts", () => {
		const code = loadWorkflowMenuLibrary().find(
			(menu) => menu.shape === "code",
		)!;
		expect(
			code.nodes.map((node) => ({ id: node.id, type: node.type })),
		).toEqual([
			{ id: "eng_design", type: "design" },
			{ id: "implement", type: "implement" },
			{ id: "qa", type: "qa" },
			{ id: "founder_gate", type: "gate" },
		]);
		expect(code.edges).toEqual([
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
		]);
		expect(code.loops).toEqual([
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
		]);
		for (const [nodeId, models, defaultModel] of [
			["eng_design", ["fable", "codex", "astra", "opus"], "fable"],
			["implement", ["opus", "sol", "fable", "codex", "astra"], "opus"],
			["qa", ["opus", "sol", "codex"], "opus"],
		] as const) {
			const node = code.nodes.find((candidate) => candidate.id === nodeId)!;
			expect(node.defaultModel).toBe(defaultModel);
			expect(node.models?.map((model) => model.model)).toEqual(models);
			for (const model of node.models ?? []) {
				expect(model.allowedEfforts).toEqual(ALL_EFFORTS);
				expect(model.defaultEffort).toBe(
					node.id === "implement" &&
						["opus", "sol", "codex", "astra"].includes(model.model)
						? "xhigh"
						: "high",
				);
			}
		}
		const qaLoop = compileWorkflowMenuSeed(code).manifest.loops.find(
			(loop) => loop.loop_when === "qa_fail",
		)!;
		expect(qaLoop).not.toHaveProperty("max_iterations");
		expect(qaLoop).not.toHaveProperty("on_limit");
	});

	it("compiles both default Code rework loops without limit pairs", () => {
		const menu = loadWorkflowMenuLibrary().find(
			(candidate) => candidate.shape === "code",
		)!;
		const loops = compileWorkflowMenuSeed(menu).manifest.loops;
		for (const loop of loops) {
			expect(loop).not.toHaveProperty("max_iterations");
			expect(loop).not.toHaveProperty("on_limit");
		}
	});

	it("keeps every single-session menu to one executable node plus founder gate, defaulting to Opus high", () => {
		const menus = loadWorkflowMenuLibrary().filter(
			(menu) => menu.shape !== "code" && menu.shape !== "simple_code",
		);
		expect(
			menus.map((menu) => ({
				shape: menu.shape,
				nodes: menu.nodes.map((node) => node.id),
				types: menu.nodes.map((node) => node.type),
				edges: menu.edges,
			})),
		).toEqual([
			{
				shape: "prd",
				nodes: ["pm", "founder_gate"],
				types: ["generic", "gate"],
				edges: [
					{
						id: "pm_done",
						from: "pm",
						to: "founder_gate",
						condition: "node_done",
					},
				],
			},
			{
				shape: "product_design_flow",
				nodes: ["product_design", "founder_gate"],
				types: ["generic", "gate"],
				edges: [
					{
						id: "product_design_done",
						from: "product_design",
						to: "founder_gate",
						condition: "node_done",
					},
				],
			},
			{
				shape: "prototype",
				nodes: ["proto", "founder_gate"],
				types: ["generic", "gate"],
				edges: [
					{
						id: "proto_done",
						from: "proto",
						to: "founder_gate",
						condition: "node_done",
					},
				],
			},
			{
				shape: "generic",
				nodes: ["general", "founder_gate"],
				types: ["generic", "gate"],
				edges: [
					{
						id: "general_done",
						from: "general",
						to: "founder_gate",
						condition: "node_done",
					},
				],
			},
		]);
		for (const menu of menus) {
			const executable = menu.nodes.find((node) => node.type !== "gate")!;
			expect(executable.defaultModel).toBe("opus");
			expect(executable.models).toEqual([
				{
					model: "opus",
					allowedEfforts: OPUS_EFFORTS,
					defaultEffort: "high",
				},
			]);
			expect(menu.loops).toEqual([]);
		}
	});

	it("loads Lead adoption and resolves every adopted node through the registry", () => {
		const config = loadProjectMenuConfig(REPO_ROOT);
		expect(config.adoption).toEqual({
			"flywheel-eng-lead": ["code", "simple_code", "generic"],
			"flywheel-product-lead": ["prd", "product_design_flow", "prototype"],
		});
		expect(
			resolveLeadMenus({
				projectRoot: REPO_ROOT,
				leadId: "flywheel-eng-lead",
			}).map((menu) => menu.shape),
		).toEqual(["code", "simple_code", "generic"]);
		expect(
			resolveLeadMenus({
				projectRoot: REPO_ROOT,
				leadId: "flywheel-product-lead",
			}).map((menu) => menu.shape),
		).toEqual(["prd", "product_design_flow", "prototype"]);
		const productIdentity = readFileSync(
			`${REPO_ROOT}/.lead/flywheel-product-lead/identity.md`,
			"utf8",
		);
		expect(productIdentity).toContain('"taskCategory":"prd"');
		expect(productIdentity).not.toContain('"taskCategory":"research"');
	});

	it("materializes the FLY-2033 note-taker route as prd + product Lead + founder review", () => {
		const menu = resolveLeadMenus({
			projectRoot: REPO_ROOT,
			leadId: "flywheel-product-lead",
		}).find((candidate) => candidate.shape === "prd");
		expect(menu).toBeDefined();
		const seed = compileWorkflowMenuSeed(menu!);
		expect(seed.templateId).toBe("tpl_prd");
		const producer = seed.manifest.nodes.find((node) => node.id === "pm");
		expect(producer).toMatchObject({
			id: "pm",
			founder_review: true,
		});
		const snapshot = buildWorkflowRunSnapshotV3({
			template: { id: seed.templateId, revision: 1 },
			manifest: seed.manifest,
			canonicalRoot: REPO_ROOT,
		});
		expect(nodeRequiresFounderReview(snapshot, producer!.id)).toBe(true);
	});

	it("compiles every graph into a label-bearing v3 seed with stable handbook refs", () => {
		const registered = new Set(loadBundledWorkflowNodeNames());
		for (const menu of loadWorkflowMenuLibrary()) {
			const seed = compileWorkflowMenuSeed(menu);
			expect(seed.templateId).toBe(workflowMenuTemplateId(menu.shape));
			expect(seed.projectScope).toBe("global");
			expect(seed.manifest.schema_version).toBe(3);
			expect(seed.manifest.nodes.some((node) => node.type === "review")).toBe(
				false,
			);
			const executable = seed.manifest.nodes.filter(
				(node) => node.type !== "gate" && node.type !== "land",
			);
			expect(new Set(executable.map((node) => node.handbook_ref)).size).toBe(
				executable.length,
			);
			for (const node of executable) {
				expect(node.label).toBeTruthy();
				expect(node).not.toHaveProperty("role");
				expect(node.agent_file).toBeUndefined();
				expect(node.handbook_ref).toBe(node.id);
				expect(registered.has(node.handbook_ref!)).toBe(true);
			}
			for (const node of seed.manifest.nodes.filter(
				(candidate) => candidate.type === "gate" || candidate.type === "land",
			)) {
				expect(node).not.toHaveProperty("handbook_ref");
			}
		}
	});

	it("pins founder review only on prd/product-design/prototype nodes", () => {
		for (const menu of loadWorkflowMenuLibrary()) {
			const expected = ["prd", "product_design_flow", "prototype"].includes(
				menu.shape,
			);
			expect(menu.founderReview ?? false, menu.shape).toBe(expected);
			const seed = compileWorkflowMenuSeed(menu);
			const executable = seed.manifest.nodes.find(
				(node) => node.type !== "gate" && node.type !== "land",
			)!;
			expect(executable.founder_review ?? false, menu.shape).toBe(expected);

			const snapshot = buildWorkflowRunSnapshotV3({
				template: { id: seed.templateId, revision: 1 },
				manifest: seed.manifest,
				canonicalRoot: REPO_ROOT,
			});
			expect(
				nodeRequiresFounderReview(snapshot, executable.id),
				menu.shape,
			).toBe(expected);
			for (const other of snapshot.manifest.nodes.filter(
				(node) => node.id !== executable.id,
			)) {
				expect(nodeRequiresFounderReview(snapshot, other.id)).toBe(false);
			}
		}
	});

	it("derives approval and terminal nodes from topology instead of node names", () => {
		const menu = structuredClone(
			loadWorkflowMenuLibrary().find(
				(candidate) => candidate.shape === "generic",
			)!,
		);
		const gate = menu.nodes.find((node) => node.type === "gate")!;
		const oldGateId = gate.id;
		gate.id = "decision";
		for (const edge of menu.edges) {
			if (edge.from === oldGateId) edge.from = gate.id;
			if (edge.to === oldGateId) edge.to = gate.id;
		}

		const seed = compileWorkflowMenuSeed(menu);
		expect(seed.manifest).toMatchObject({
			approval_gate: { node: "decision" },
			terminal_node: { node: expect.any(String) },
		});
		const terminalId = (seed.manifest as { terminal_node: { node: string } })
			.terminal_node.node;
		expect(seed.manifest.nodes.find((node) => node.id === terminalId)).toEqual({
			id: terminalId,
			label: "合入",
			type: "land",
			execution: "engine",
		});
		expect(seed.manifest.edges).toContainEqual({
			id: expect.any(String),
			from: "decision",
			to: terminalId,
			condition: "founder_approved",
		});
	});

	it("resolves coherent gate authority for every compiled menu snapshot", () => {
		for (const menu of loadWorkflowMenuLibrary()) {
			const seed = compileWorkflowMenuSeed(menu);
			const snapshot = buildWorkflowRunSnapshotV3({
				template: { id: seed.templateId, revision: 1 },
				manifest: seed.manifest,
				canonicalRoot: REPO_ROOT,
			});

			expect(resolveWorkflowGateAuthority(snapshot), menu.shape).toEqual({
				mode: "land",
				subjectKind: "git_head",
			});
			for (const node of snapshot.resolved.nodes.filter(
				(candidate) => candidate.dispatch,
			)) {
				expect(node.capabilities, `${menu.shape}:${node.id}`).toMatchObject({
					can_ship: false,
					can_land: false,
					approval_gate_holder: false,
				});
			}
			expect(snapshot.resolved.nodes.at(-1)).toMatchObject({
				type: "land",
				capabilities: { can_ship: true, can_land: true },
			});
		}
	});

	it("imports the six compiled identities into the SQLite registry", async () => {
		const store = await StateStore.create(":memory:");
		importWorkflowMenuSeeds(store);
		for (const binding of workflowMenuBindings()) {
			const row = store.getWorkflowTemplate(binding.templateId);
			expect(row).toMatchObject({
				template_id: binding.templateId,
				current_published_revision: 1,
			});
			expect(
				store.getWorkflowTemplateRevision(binding.templateId, 1)
					?.schema_version,
			).toBe(3);
		}
		store.close();
	});

	it("reconciles missing adopted bindings without overwriting an existing owner", async () => {
		const store = await StateStore.create(":memory:");
		importWorkflowMenuSeeds(store);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "code",
			templateId: "tpl_code",
			updatedBy: "custom-owner",
		});

		const result = reconcileMenuCategoryBindings(store, [
			{ projectName: "flywheel", projectRoot: REPO_ROOT },
		]);

		expect(result).toEqual({ bound: 5, existing: 1, errors: [] });
		expect(
			store.getWorkflowCategoryBindingExact("flywheel", "code"),
		).toMatchObject({ template_id: "tpl_code", updated_by: "custom-owner" });
		expect(
			store.getWorkflowCategoryBindingExact("flywheel", "simple_code"),
		).toMatchObject({
			template_id: "tpl_simple_code",
			updated_by: "system:menu-binding-reconcile",
		});
		expect(
			store.getWorkflowCategoryBindingExact("flywheel", "generic"),
		).toMatchObject({
			template_id: "tpl_generic_menu",
			updated_by: "system:menu-binding-reconcile",
		});
		store.close();
	});

	it("reports an unavailable adopted template without aborting binding reconcile", async () => {
		const store = await StateStore.create(":memory:");
		importWorkflowMenuSeeds(store);
		expect(
			store.retireWorkflowTemplate({
				templateId: "tpl_simple_code",
				actor: "test",
				reason: "exercise fail-loud reconcile",
			}),
		).toMatchObject({ status: "retired" });
		const logs: string[] = [];

		const result = reconcileMenuCategoryBindings(
			store,
			[{ projectName: "flywheel", projectRoot: REPO_ROOT }],
			(message) => logs.push(message),
		);

		expect(result).toMatchObject({ bound: 5, existing: 0 });
		expect(result.errors).toEqual([
			expect.stringMatching(
				/flywheel:simple_code:.*published and not retired/i,
			),
		]);
		expect(logs).toEqual([
			expect.stringMatching(/binding reconcile failed: flywheel:simple_code/i),
		]);
		store.close();
	});

	it("keeps menu seed imports idempotent across repeated boots", async () => {
		const store = await StateStore.create(":memory:");
		for (let boot = 0; boot < 3; boot += 1) {
			importWorkflowMenuSeeds(store);
		}
		expect(
			store.listWorkflowTemplateRevisions("tpl_generic_menu"),
		).toHaveLength(1);
		expect(store.getWorkflowTemplate("tpl_generic_menu")?.name).toBe("通用");
		store.close();
	});

	it("materializes every executable node from its registered markdown file", () => {
		const seed = compileWorkflowMenuSeed(
			loadWorkflowMenuLibrary().find((menu) => menu.shape === "code")!,
		);
		const snapshot = buildWorkflowRunSnapshotV3({
			template: { id: seed.templateId, revision: 1 },
			manifest: seed.manifest,
			canonicalRoot: REPO_ROOT,
		});
		for (const [nodeId, type] of [
			["eng_design", "design"],
			["implement", "implement"],
			["qa", "qa"],
		]) {
			const node = snapshot.resolved.nodes.find(
				(candidate) => candidate.id === nodeId,
			)!;
			const source = readFileSync(
				`${REPO_ROOT}/.flywheel/agents/nodes/${nodeId}.md`,
				"utf8",
			);
			const protocol = `${readFileSync(
				`${REPO_ROOT}/packages/teamlead/phase-protocols/${type}.md`,
				"utf8",
			).replace(/\n+$/, "")}\n`;
			const block = `<!-- FLYWHEEL_PHASE_PROTOCOL:${type}:BEGIN -->\n${protocol}<!-- FLYWHEEL_PHASE_PROTOCOL:${type}:END -->`;
			expect(source.split(block)).toHaveLength(2);
			expect(node.agent?.content).toBe(
				protocol.replace(/\n+$/, "") +
					"\n\n---\n\n" +
					source.replace(block, ""),
			);
			expect(node.agent?.content.split(protocol.trim())).toHaveLength(2);
			expect(node.agent!.content.length).toBeLessThanOrEqual(
				source.length * 1.1,
			);
		}
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
		const firstOverride = resolveMenuOverrides(
			menu,
			{
				eng_design: { model: "astra", effort: "max" },
			},
			{ issueIdentifier: "FLY-803" },
		);
		const ids = ["run-menu", "exec-menu"];
		const first = await resolveWorkflowTemplateSelection(store, {
			project: "flywheel",
			issueId: "FLY-803",
			taskCategory: "code",
			selectedBy: "flywheel-eng-lead",
			actor: "master",
			authKind: "master",
			canonicalRoot: REPO_ROOT,
			idempotencyKey: "menu-start-1",
			candidateSchemaAtEntry: 3,
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
			model: "gpt-6-astra",
			effort: "max",
		});
		await expect(
			resolveWorkflowTemplateSelection(store, {
				project: "flywheel",
				issueId: "FLY-803",
				taskCategory: "code",
				selectedBy: "flywheel-eng-lead",
				actor: "master",
				authKind: "master",
				canonicalRoot: REPO_ROOT,
				idempotencyKey: "menu-start-1",
				candidateSchemaAtEntry: 3,
				workKindEnforced: true,
				categorySource: "task_category",
				entryKind: "workflow_v2",
				override: resolveMenuOverrides(
					menu,
					{
						eng_design: { model: "astra" },
					},
					{ issueIdentifier: "FLY-803" },
				).templateOverride,
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

	it("resolves the Astra alias through the canonical registry and emits truthful receipts", () => {
		const resolved = resolveMenuOverrides(
			code(),
			{
				eng_design: { model: "astra" },
			},
			{ issueIdentifier: "FLY-803" },
		);
		expect(resolved.templateOverride).toEqual({
			reason: "automatic_model_split",
			nodes: {
				eng_design: {
					vendor: "codex",
					model: "gpt-6-astra",
					effort: "high",
				},
			},
		});
		expect(resolved.receipts).toMatchObject({
			eng_design: {
				model: "astra (= gpt-6-astra)",
				effort: "high",
				overridden: true,
			},
			implement: {
				model: "opus (= claude-opus-5-5)",
				effort: "xhigh",
				overridden: false,
			},
			qa: {
				// FLY-2775: the receipt keeps the alias AND the id it resolved to,
				// which is how a run-start response proves which body it will spawn.
				model: "opus (= claude-opus-5-5)",
				effort: "high",
				overridden: false,
			},
		});
	});

	it.each([
		[
			{ missing: { model: "fable" } },
			"MENU_NODE_NOT_FOUND",
			["eng_design", "implement", "qa"],
		],
		[
			{ eng_design: { model: "opus" } },
			"MODEL_SPLIT_OVERRIDE_CONFLICT",
			["fable"],
		],
		[
			{ eng_design: { model: "atsra" } },
			"INVALID_MODEL",
			["fable", "codex", "astra", "opus"],
		],
		[
			{ eng_design: { model: "fable", effort: "ultra" } },
			"EFFORT_NOT_ALLOWED_FOR_MODEL",
			ALL_EFFORTS,
		],
	] as const)(
		"fails loud for invalid override %# with a legal set",
		(overrides, codeName, legal) => {
			try {
				resolveMenuOverrides(code(), overrides, {
					issueIdentifier: "FLY-802",
				});
				throw new Error("expected validation failure");
			} catch (error) {
				expect(error).toBeInstanceOf(WorkflowMenuValidationError);
				expect(error).toMatchObject({ code: codeName, legal });
			}
		},
	);

	it("allows the founder-approved QA-only same-family exemption", () => {
		const simple = loadWorkflowMenuLibrary().find(
			(menu) => menu.shape === "simple_code",
		)!;
		const resolved = resolveMenuOverrides(
			simple,
			{ implement: { model: "fable" } },
			{ issueIdentifier: "FLY-2788" },
		);
		expect(resolved.templateOverride.nodes?.implement?.vendor).toBe("claude");
	});
});

// FLY-2775: the Opus line follows its latest release. A published menu seed
// persists the family alias (`opus`) instead of the id it resolves to today,
// and every run snapshot canonicalizes it against the registry generation live
// at RUN START. So a model-sync advance reaches new runs without a restart or a
// re-seed, while a run already in flight keeps the id it pinned.
describe("FLY-2775 seeds persist the Opus family alias", () => {
	const opusNodes = (
		manifest: ReturnType<typeof loadWorkflowMenuSeeds>[number]["manifest"],
	) =>
		manifest.nodes.filter(
			(node): node is typeof node & { model: string } =>
				"model" in node &&
				typeof node.model === "string" &&
				(node.model === "opus" || node.model.startsWith("claude-opus")),
		);

	it("persists `opus` for every Opus-line node whatever the binding is at compile time", () => {
		for (const snapshot of [
			validateModelConfigDocument({ version: 1 }),
			validateModelConfigDocument({
				version: 1,
				bindings: { opus: "claude-opus-5", opus1m: "claude-opus-5[1m]" },
			}),
		]) {
			const nodes = loadWorkflowMenuSeeds(snapshot).flatMap((seed) =>
				opusNodes(seed.manifest),
			);
			// Guard the guard: an empty set would make the next line vacuous.
			expect(nodes.length).toBeGreaterThan(0);
			expect(nodes.map((node) => node.model)).toEqual(nodes.map(() => "opus"));
		}
	});

	it("boots, persists `opus`, and pins each run to the binding live at its start (criteria 3 + 4)", async () => {
		const opus6 = validateModelConfigDocument({
			version: 1,
			models: [
				{
					id: "claude-opus-6",
					provider: "anthropic",
					runtimeVendor: "claude",
					label: "Opus 6",
					aliases: ["opus-6"],
					dispatch: true,
				},
				{
					id: "claude-opus-6[1m]",
					provider: "anthropic",
					runtimeVendor: "claude",
					label: "Opus 6 (1M)",
					aliases: ["opus-6-1m"],
					dispatch: true,
					contextWindowTokens: 1_000_000,
				},
			],
			bindings: { opus: "claude-opus-6", opus1m: "claude-opus-6[1m]" },
		});
		const builtIn = validateModelConfigDocument({ version: 1 });
		const store = await StateStore.create(":memory:");
		try {
			// The real Bridge boot path: compile → FLY-2121 preflight → apply/import.
			const seeds = loadWorkflowMenuSeeds(builtIn);
			await migrateFly2121WorkflowCatalog(store, seeds, {
				resolvableRoleNames: loadBundledWorkflowNodeNames(),
			});
			const template = store.getWorkflowTemplate("tpl_simple_code")!;
			const revision = store.getWorkflowTemplateRevision(
				"tpl_simple_code",
				template.current_published_revision!,
			)!;
			const persisted = JSON.parse(revision.manifest);
			expect(
				persisted.nodes.find((node: { id: string }) => node.id === "qa").model,
			).toBe("opus");

			const qaDispatch = (
				snapshot: ReturnType<typeof buildWorkflowRunSnapshotV3>,
			) => snapshot.resolved.nodes.find((node) => node.id === "qa");
			// A run started today pins Opus 5.5 ...
			const inFlight = buildWorkflowRunSnapshotV3({
				template: { id: "tpl_simple_code", revision: revision.revision },
				manifest: persisted,
				canonicalRoot: REPO_ROOT,
				modelSnapshot: builtIn,
			});
			const inFlightBytes = JSON.stringify(inFlight);
			expect(qaDispatch(inFlight)).toMatchObject({
				dispatchPinned: true,
				dispatch: { vendor: "claude", model: "claude-opus-5-5" },
			});
			// ... the sync then advances the binding: the SAME persisted revision
			// yields Opus 6 for a new run — no code change, no re-seed, no restart.
			const next = buildWorkflowRunSnapshotV3({
				template: { id: "tpl_simple_code", revision: revision.revision },
				manifest: persisted,
				canonicalRoot: REPO_ROOT,
				modelSnapshot: opus6,
			});
			expect(qaDispatch(next)?.dispatch?.model).toBe("claude-opus-6");
			// ... and the run already in flight is byte-for-byte unchanged.
			expect(JSON.stringify(inFlight)).toBe(inFlightBytes);

			// A second boot under the advanced binding plans NO catalog mutation:
			// compile, preflight and import agree on the persisted alias bytes.
			const again = await migrateFly2121WorkflowCatalog(
				store,
				loadWorkflowMenuSeeds(opus6),
				{ resolvableRoleNames: loadBundledWorkflowNodeNames() },
			);
			expect(again.plan.requiresMutation).toBe(false);
		} finally {
			store.close();
		}
	});

	// Codex code review (rework) B5: between the restart and the first sync, the
	// production models.json still binds `opus` to the retired claude-opus-5 and
	// the dispatch ALIAS is dark by the FLY-1496 contract. Template runs do not use
	// that alias lookup: run start canonicalizes through the registry and pins an
	// exact id, which stays dispatchable. So the window runs Opus 5 — it is not
	// broken — until the sync advances the binding.
	it("in the pre-sync window a template run pins the retired id, which stays dispatchable", () => {
		const stale = validateModelConfigDocument({
			version: 1,
			bindings: { opus: "claude-opus-5" },
		});
		const seed = loadWorkflowMenuSeeds(
			validateModelConfigDocument({ version: 1 }),
		).find((candidate) => candidate.templateId === "tpl_simple_code")!;
		const qa = validateWorkflowManifest(seed.manifest, {
			modelSnapshot: stale,
		}).nodes.find((node) => node.id === "qa")!.model!;
		expect(qa).toBe("claude-opus-5");
		expect(stale.normalizeDispatchModel(qa)).toBe("claude-opus-5");
		// The dispatch alias itself is dark, exactly as FLY-1496 requires.
		expect(stale.normalizeDispatchModel("opus")).toBeNull();
	});

	it("persists all three follow-latest spellings through import byte-for-byte", async () => {
		const builtIn = validateModelConfigDocument({ version: 1 });
		const store = await StateStore.create(":memory:");
		try {
			const base = loadWorkflowMenuSeeds(builtIn).find(
				(candidate) => candidate.templateId === "tpl_simple_code",
			)!;
			for (const [index, spelling] of [
				"opus",
				"opus-1m",
				"opus[1m]",
			].entries()) {
				const manifest = {
					...base.manifest,
					nodes: base.manifest.nodes.map((node) =>
						node.id === "qa" ? { ...node, model: spelling } : node,
					),
				};
				const seed = {
					templateId: `tpl_fly2775_${index}`,
					name: base.name,
					projectScope: base.projectScope,
					manifest,
				};
				store.importWorkflowTemplateSeed({
					...seed,
					contentHash: workflowSeedContentHash({
						...seed,
						manifest: validateManifestForPersistence(manifest, {
							modelSnapshot: builtIn,
						}),
					}),
				});
				const revision = store.getWorkflowTemplateRevision(seed.templateId, 1)!;
				expect(
					JSON.parse(revision.manifest).nodes.find(
						(node: { id: string }) => node.id === "qa",
					).model,
				).toBe(spelling);
			}
		} finally {
			store.close();
		}
	});

	it("does not ship a seed for the retired tpl_eng_heavy (no boot path can advance it)", () => {
		// FLY-1693 retired it; it survives only for historical run references.
		expect(
			loadWorkflowMenuSeeds().map((seed) => seed.templateId),
		).not.toContain("tpl_eng_heavy");
	});
});

describe("Opus 4.6 menu compatibility", () => {
	let root: string;
	let previousPath: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly1674-opus46-menu-"));
		previousPath = process.env.FLYWHEEL_MODELS_CONFIG;
		process.env.FLYWHEEL_MODELS_CONFIG = join(root, "models.json");
		writeFileSync(
			process.env.FLYWHEEL_MODELS_CONFIG,
			JSON.stringify({
				version: 1,
				bindings: { opus: "claude-opus-4-6[1m]" },
			}),
		);
		resetModelConfigCacheForTests();
	});

	afterEach(() => {
		if (previousPath === undefined) {
			delete process.env.FLYWHEEL_MODELS_CONFIG;
		} else {
			process.env.FLYWHEEL_MODELS_CONFIG = previousPath;
		}
		resetModelConfigCacheForTests();
		rmSync(root, { recursive: true, force: true });
	});

	it("fails closed when the retired Opus binding cannot satisfy current policy", () => {
		expect(() => loadWorkflowMenuLibrary()).toThrow(
			/allowedEfforts must be supported.*low, medium, high, max/,
		);
	});

	it("still rejects an effort the bound model cannot run", () => {
		const registryPath = join(root, "registry.yaml");
		cpSync(
			join(REPO_ROOT, ".flywheel", "agents", "registry.yaml"),
			registryPath,
		);
		writeFileSync(
			registryPath,
			readFileSync(registryPath, "utf8").replace(
				"allowedEfforts: [low, medium, high, max]",
				"allowedEfforts: [low, medium, high, xhigh, max]",
			),
		);

		expect(() => loadWorkflowMenuLibrary({ registryPath })).toThrow(
			/allowedEfforts must be supported.*low, medium, high, max/,
		);
	});
});
