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
	WORKFLOW_MENU_BINDINGS,
	workflowMenuTemplateId,
} from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLY1436_TARGET_BINDINGS } from "../bridge/workkind-cutover.js";
import { StateStore } from "../StateStore.js";
import {
	compileWorkflowMenuSeed,
	importWorkflowMenuSeeds,
	loadProjectMenuConfig,
	loadWorkflowMenuLibrary,
	reconcileMenuCategoryBindings,
	resolveLeadMenus,
	resolveMenuOverrides,
	WorkflowMenuValidationError,
} from "../workflow-menu.js";
import {
	buildWorkflowRunSnapshotV2,
	nodeRequiresFounderReview,
	resolveWorkflowGateAuthority,
} from "../workflow-run-snapshot.js";
import { resolveWorkflowTemplateSelection } from "../workflow-template-selection.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const OPUS_EFFORTS = ["low", "medium", "high", "max"];

describe("founder-approved workflow menu source", () => {
	it("loads exactly six shapes and removes research", () => {
		const menus = loadWorkflowMenuLibrary();
		expect(menus.map((menu) => menu.shape)).toEqual([
			"code",
			"simple_code",
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
			{ taskCategory: "simple_code", templateId: "tpl_simple_code" },
			{ taskCategory: "prd", templateId: "tpl_prd" },
			{ taskCategory: "design", templateId: "tpl_design" },
			{ taskCategory: "prototype", templateId: "tpl_prototype" },
			{ taskCategory: "generic", templateId: "tpl_generic_menu" },
		]);
		expect(FLY1436_TARGET_BINDINGS).toBe(WORKFLOW_MENU_BINDINGS);
	});

	it("pins the Simple Code DAG to GPT-5.6 implement then cross-vendor Opus 5 QA", () => {
		const menu = loadWorkflowMenuLibrary().find(
			(candidate) => candidate.shape === "simple_code",
		)!;
		expect(
			menu.nodes.map((node) => ({
				id: node.id,
				role: node.role,
				defaultModel: node.defaultModel,
			})),
		).toEqual([
			{ id: "implement", role: "implement", defaultModel: "codex" },
			{ id: "qa", role: "qa", defaultModel: "opus" },
			{ id: "founder_gate", role: undefined, defaultModel: undefined },
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
					vendor: "codex",
					model: "gpt-5.6-sol",
				}),
				expect.objectContaining({
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "claude-opus-5",
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

	it("rejects simple_code without a QA role", () => {
		const shapes = mkdtempSync(join(tmpdir(), "fly1859-invalid-simple-code-"));
		try {
			cpSync(join(REPO_ROOT, "menus/shapes"), shapes, { recursive: true });
			const filename = join(shapes, "simple_code.yaml");
			writeFileSync(
				filename,
				readFileSync(filename, "utf8").replace(
					"    role: qa",
					"    role: implement",
				),
			);
			expect(() =>
				loadWorkflowMenuLibrary({ shapesDirectory: shapes }),
			).toThrow(
				/simple_code must have implement and QA executable nodes.*QA retry loop/i,
			);
		} finally {
			rmSync(shapes, { recursive: true, force: true });
		}
	});

	it.each([
		["code", 7],
		["simple_code", 12],
	] as const)("accepts a declared positive QA cap for %s", (shape, cap) => {
		const shapes = mkdtempSync(join(tmpdir(), "fly2094-declared-cap-"));
		try {
			cpSync(join(REPO_ROOT, "menus/shapes"), shapes, { recursive: true });
			const filename = join(shapes, `${shape}.yaml`);
			const withoutQaCap = readFileSync(filename, "utf8").replace(
				/ {4}maxIterations: \d+\n {4}onLimit: escalate\n/,
				"",
			);
			writeFileSync(
				filename,
				withoutQaCap.replace(
					"    exitWhen: qa_pass\n",
					`    exitWhen: qa_pass\n    maxIterations: ${cap}\n    onLimit: escalate\n`,
				),
			);

			const menu = loadWorkflowMenuLibrary({ shapesDirectory: shapes }).find(
				(candidate) => candidate.shape === shape,
			)!;
			expect(
				menu.loops.find((loop) => loop.loopWhen === "qa_fail"),
			).toMatchObject({
				maxIterations: cap,
				onLimit: "escalate",
			});
			expect(
				compileWorkflowMenuSeed(menu).manifest.loops.find(
					(loop) => loop.loop_when === "qa_fail",
				),
			).toMatchObject({ max_iterations: cap, on_limit: "escalate" });
		} finally {
			rmSync(shapes, { recursive: true, force: true });
		}
	});

	it.each(["code", "simple_code"] as const)(
		"rejects %s without its QA retry loop",
		(shape) => {
			const shapes = mkdtempSync(join(tmpdir(), "fly2094-missing-qa-loop-"));
			try {
				cpSync(join(REPO_ROOT, "menus/shapes"), shapes, { recursive: true });
				const filename = join(shapes, `${shape}.yaml`);
				writeFileSync(
					filename,
					readFileSync(filename, "utf8").replace(
						"    loopWhen: qa_fail",
						"    loopWhen: founder_feedback_kickback",
					),
				);
				expect(() =>
					loadWorkflowMenuLibrary({ shapesDirectory: shapes }),
				).toThrow(new RegExp(`${shape}.*QA retry loop`, "i"));
			} finally {
				rmSync(shapes, { recursive: true, force: true });
			}
		},
	);

	it("pins the Code DAG, unbounded retry loop, exact models, defaults, and nested efforts", () => {
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
			["design", ["fable", "codex"], "fable"],
			["implement", ["fable", "codex"], "codex"],
			["qa", ["opus"], "opus"],
		] as const) {
			const node = code.nodes.find((candidate) => candidate.id === nodeId)!;
			expect(node.defaultModel).toBe(defaultModel);
			expect(node.models?.map((model) => model.model)).toEqual(models);
			for (const model of node.models ?? []) {
				expect(model.allowedEfforts).toEqual(
					model.model === "opus" ? OPUS_EFFORTS : ALL_EFFORTS,
				);
				expect(model.defaultEffort).toBe(
					model.model === "opus" ? "high" : "xhigh",
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
					allowedEfforts: OPUS_EFFORTS,
					defaultEffort: "high",
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
			"flywheel-eng-lead": ["code", "simple_code", "generic"],
			"flywheel-product-lead": ["prd", "design", "prototype"],
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
		).toEqual(["prd", "design", "prototype"]);
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
		const producer = seed.manifest.nodes.find((node) => node.role === "pm");
		expect(producer).toMatchObject({
			id: "produce",
			role: "pm",
			founder_review: true,
		});
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: seed.templateId, revision: 1 },
			manifest: seed.manifest,
			canonicalRoot: REPO_ROOT,
		});
		expect(nodeRequiresFounderReview(snapshot, producer!.id)).toBe(true);
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
				(candidate) => candidate.type !== "gate" && candidate.type !== "land",
			)) {
				expect(node.role).toBeTruthy();
				expect(node.agent_file).toBeUndefined();
			}
		}
	});

	it("pins founder review only on prd/design/prototype produce nodes", () => {
		for (const menu of loadWorkflowMenuLibrary()) {
			const expected = ["prd", "design", "prototype"].includes(menu.shape);
			expect(menu.founderReview ?? false, menu.shape).toBe(expected);
			const seed = compileWorkflowMenuSeed(menu);
			const executable = seed.manifest.nodes.find(
				(node) => node.type !== "gate" && node.type !== "land",
			)!;
			expect(executable.founder_review ?? false, menu.shape).toBe(expected);

			const snapshot = buildWorkflowRunSnapshotV2({
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
			const snapshot = buildWorkflowRunSnapshotV2({
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
				effort: "high",
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
		[
			{ qa: { model: "opus", effort: "xhigh" } },
			"EFFORT_NOT_ALLOWED_FOR_MODEL",
			OPUS_EFFORTS,
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

	it("fails loud when an override would make producer and QA use one vendor", () => {
		const simple = loadWorkflowMenuLibrary().find(
			(menu) => menu.shape === "simple_code",
		)!;
		try {
			resolveMenuOverrides(simple, { qa: { model: "codex" } });
			throw new Error("expected same-vendor validation failure");
		} catch (error) {
			expect(error).toBeInstanceOf(WorkflowMenuValidationError);
			expect(error).toMatchObject({
				code: "SAME_VENDOR_REVIEW_COMBINATION",
				legal: ["implement:opus", "implement:fable", "qa:opus"],
			});
		}
	});

	it("rejects a same-vendor default combination at compile time", () => {
		const simple = structuredClone(
			loadWorkflowMenuLibrary().find((menu) => menu.shape === "simple_code")!,
		);
		simple.nodes.find((node) => node.id === "qa")!.defaultModel = "codex";
		expect(() => compileWorkflowMenuSeed(simple)).toThrow(
			/simple_code.*qa.*same vendor.*implement/i,
		);
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

	it("compiles all six default-Opus nodes at high without xhigh", () => {
		const opusNodes = loadWorkflowMenuLibrary().flatMap((menu) =>
			menu.nodes
				.filter((node) => node.defaultModel === "opus")
				.map((node) => ({ menu, node })),
		);

		expect(opusNodes).toHaveLength(6);
		for (const { menu, node } of opusNodes) {
			const policy = node.models?.find((model) => model.model === "opus");
			expect(policy?.allowedEfforts, menu.shape).toEqual([
				"low",
				"medium",
				"high",
				"max",
			]);
			expect(policy?.defaultEffort, menu.shape).toBe("high");
			const compiled = compileWorkflowMenuSeed(menu);
			expect(
				compiled.manifest.nodes.find((candidate) => candidate.id === node.id),
				menu.shape,
			).toMatchObject({
				vendor: "claude",
				model: "claude-opus-4-6[1m]",
				effort: "high",
			});
		}
	});

	it("still rejects an effort the bound model cannot run", () => {
		for (const shape of [
			"code",
			"simple_code",
			"prd",
			"design",
			"prototype",
			"generic",
		]) {
			cpSync(
				join(REPO_ROOT, "menus", "shapes", `${shape}.yaml`),
				join(root, `${shape}.yaml`),
			);
		}
		const codePath = join(root, "code.yaml");
		writeFileSync(
			codePath,
			readFileSync(codePath, "utf8").replace(
				"allowedEfforts: [low, medium, high, max]",
				"allowedEfforts: [low, medium, high, xhigh, max]",
			),
		);

		expect(() => loadWorkflowMenuLibrary({ shapesDirectory: root })).toThrow(
			/allowedEfforts must be a subset.*low, medium, high, max/,
		);
	});
});
