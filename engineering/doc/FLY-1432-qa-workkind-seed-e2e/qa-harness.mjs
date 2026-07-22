#!/usr/bin/env node
/**
 * FLY-1432 real-machine QA for PR #678 at pinned head 6a0576bd.
 *
 * This harness imports the built production modules from a detached checkout,
 * boots the production Bridge HTTP application on an ephemeral loopback port,
 * and keeps every mutable path under a fresh temporary HOME. It never invokes
 * the production Bridge, production StateStore, or production comm root.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function runTmuxRescueShim(args) {
	const verifyAt = args.indexOf("--verify");
	const createAt = args.indexOf("--create");
	if (args[0] !== "ensure" || verifyAt < 0 || createAt < 0) process.exit(64);
	const verify = args.slice(verifyAt + 1, createAt);
	const create = args.slice(createAt + 1);
	let action = "verified";
	let createStdout = "";
	let run = spawnSync(verify[0], verify.slice(1), { encoding: "utf8" });
	if (run.status !== 0) {
		action = "created";
		run = spawnSync(create[0], create.slice(1), { encoding: "utf8" });
		if (run.status !== 0) {
			process.stderr.write(run.stderr || "tmux create failed");
			process.exit(run.status || 1);
		}
		createStdout = (run.stdout || "").trim();
	}
	const socket = args[1];
	const pid = spawnSync(
		"tmux",
		["-S", socket, "display-message", "-p", "#{pid}"],
		{ encoding: "utf8" },
	);
	if (pid.status !== 0) process.exit(pid.status || 1);
	process.stdout.write(
		JSON.stringify({
			action,
			createStdout,
			reachablePid: Number((pid.stdout || "").trim()),
		}),
	);
}

if (process.argv[2] === "ensure") {
	runTmuxRescueShim(process.argv.slice(2));
	process.exit(0);
}

const PINNED_HEAD = "6a0576bd3ec3e9188ad6c012cfaf89711bf53692";
const TARGET_SEEDS = [
	"tpl_eng",
	"tpl_eng_land_v1",
	"tpl_product_designer",
	"tpl_product_prototype",
	"tpl_generic",
	"tpl_product_v1",
];
const REMOVED_SEEDS = ["tpl_ops_light", "tpl_research_light"];
const PROJECT = "flywheel-e2e";
const LEAD = "flywheel-eng-lead";
const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(HERE, "evidence");
const repoArg = process.argv.indexOf("--repo");
if (repoArg < 0 || !process.argv[repoArg + 1]) {
	throw new Error("usage: qa-harness.mjs --repo <detached-pinned-checkout>");
}
const REPO = realpathSync(process.argv[repoArg + 1]);
const ROOT = mkdtempSync(join(tmpdir(), "qa-fly1432-room-"));
const STATE_DB = join(ROOT, "state", "teamlead.db");
const MASTER_TOKEN = `fly1432-master-${process.pid}`;
const TMUX_SESSION = `qa-fly1432-${process.pid}`;
const MANAGED_ENV = [
	"HOME",
	"BRIDGE_DEPT_SCOPE_REJECT",
	"FLYWHEEL_COMM_BACKEND",
	"FLYWHEEL_COMM_ROOT",
	"FLYWHEEL_STATE_DIR",
	"FLYWHEEL_THREE_STAGE",
	"FLYWHEEL_WORKFLOW_CLAIMS_READ",
	"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
	"FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES",
	"FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH",
];
const ORIGINAL_ENV = Object.fromEntries(
	MANAGED_ENV.map((key) => [key, process.env[key]]),
);
const FLAGS_OFF = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};
const FLAGS_ON = {
	...FLAGS_OFF,
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};

const results = {};
const logLines = [];
let server;
let store;
let baselineStore;
let flagOnStore;
let tmuxCreated = false;

function log(message) {
	logLines.push(message);
	console.log(message);
}

function record(key, pass, detail = "") {
	results[key] = Boolean(pass);
	log(`[qa] ${pass ? "PASS" : "FAIL"} ${key}${detail ? ` — ${detail}` : ""}`);
}

function sh(command, args, cwd = REPO) {
	return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

function importFile(path) {
	return import(pathToFileURL(path).href);
}

function writeEvidence(name, content) {
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	writeFileSync(
		join(EVIDENCE_DIR, name),
		content.endsWith("\n") ? content : `${content}\n`,
	);
}

function writeJson(name, value) {
	writeEvidence(name, JSON.stringify(value, null, 2));
}

function logicalBindings(rows) {
	return rows
		.map((row) => ({
			project: row.project,
			task_category: row.task_category,
			template_id: row.template_id,
			updated_by: row.updated_by,
		}))
		.sort((a, b) =>
			`${a.project}\0${a.task_category}\0${a.template_id}`.localeCompare(
				`${b.project}\0${b.task_category}\0${b.template_id}`,
			),
		);
}

function workflowRunCount(targetStore) {
	const rows = targetStore.db.exec("SELECT COUNT(*) AS n FROM workflow_run");
	return Number(rows[0]?.values[0]?.[0] ?? 0);
}

function tmuxWindowIds() {
	return sh("tmux", [
		"list-windows",
		"-t",
		`=${TMUX_SESSION}`,
		"-F",
		"#{window_id}",
	])
		.split("\n")
		.filter(Boolean);
}

async function resolveV1Selection(selectionModule, targetStore, input) {
	const selection = await selectionModule.resolveWorkflowTemplateSelection(
		targetStore,
		{
			project: PROJECT,
			issueId: input.issueId,
			taskCategory: "code",
			selectedBy: LEAD,
			actor: "master",
			authKind: "master",
			canonicalRoot: input.canonicalRoot,
			idempotencyKey: input.idempotencyKey,
			allowSchemaV1Dispatch: true,
			env: FLAGS_OFF,
		},
	);
	if (!selection) throw new Error("expected schema-v1 selection, got null");
	const run = targetStore.getWorkflowRun(selection.runId);
	if (!run) throw new Error(`workflow run missing: ${selection.runId}`);
	return {
		templateId: run.template_id,
		revision: run.template_revision,
		selectionSource: selection.selectionSource,
		snapshotDigest: selection.snapshotDigest,
	};
}

try {
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	const observedHead = sh("git", ["rev-parse", "HEAD"]);
	record("pinned_pr_head", observedHead === PINNED_HEAD, observedHead);
	if (observedHead !== PINNED_HEAD) {
		throw new Error(
			`pinned head mismatch: expected ${PINNED_HEAD}, got ${observedHead}`,
		);
	}
	if (!process.env.LINEAR_API_KEY) {
		throw new Error(
			"LINEAR_API_KEY is required for the real Bridge start preflight",
		);
	}

	process.env.HOME = ROOT;
	process.env.FLYWHEEL_STATE_DIR = join(ROOT, "state");
	process.env.FLYWHEEL_COMM_ROOT = join(ROOT, "comm");
	process.env.FLYWHEEL_COMM_BACKEND = "commdb";
	process.env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH = "1";
	process.env.FLYWHEEL_WORKFLOW_CLAIMS_WRITE = "1";
	process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ = "1";
	delete process.env.FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES;
	delete process.env.FLYWHEEL_THREE_STAGE;
	process.env.BRIDGE_DEPT_SCOPE_REJECT = "0";
	mkdirSync(join(ROOT, ".flywheel"), { recursive: true });
	mkdirSync(process.env.FLYWHEEL_STATE_DIR, { recursive: true });
	mkdirSync(process.env.FLYWHEEL_COMM_ROOT, { recursive: true });
	record(
		"isolated_mutable_roots",
		process.env.HOME === ROOT &&
			process.env.FLYWHEEL_STATE_DIR.startsWith(ROOT) &&
			process.env.FLYWHEEL_COMM_ROOT.startsWith(ROOT),
		ROOT,
	);

	sh("tmux", ["new-session", "-d", "-s", TMUX_SESSION, "-n", "baseline"]);
	tmuxCreated = true;
	const windowsBefore = tmuxWindowIds();

	const teamlead = await importFile(
		join(REPO, "packages/teamlead/dist/StateStore.js"),
	);
	const templates = await importFile(
		join(REPO, "packages/teamlead/dist/workflow-template.js"),
	);
	const selectionModule = await importFile(
		join(REPO, "packages/teamlead/dist/workflow-template-selection.js"),
	);
	const workKind = await importFile(
		join(REPO, "packages/teamlead/dist/work-kind.js"),
	);
	const dispatchFlags = await importFile(
		join(REPO, "packages/teamlead/dist/workflow-template-dispatch.js"),
	);
	const plugin = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/plugin.js"),
	);
	const admissionModule = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/runner-admission.js"),
	);

	const projectRoot = join(ROOT, "project");
	mkdirSync(join(projectRoot, "agents"), { recursive: true });
	writeFileSync(
		join(projectRoot, "agents", "generic-executor.md"),
		readFileSync(join(REPO, "agents", "generic-executor.md"), "utf8"),
	);
	sh("git", ["init", "-q", "-b", "main"], projectRoot);
	sh("git", ["config", "user.email", "qa@flywheel.local"], projectRoot);
	sh("git", ["config", "user.name", "QA FLY-1432"], projectRoot);
	sh("git", ["add", "-A"], projectRoot);
	sh("git", ["commit", "-qm", "initial"], projectRoot);
	const canonicalRoot = realpathSync(projectRoot);

	// Phase A: real file-backed StateStore boot #1 under production-shape flags.
	const bundledSeeds = templates.loadBundledWorkflowSeeds();
	store = await teamlead.StateStore.create(STATE_DB);
	const boot1Results = bundledSeeds.map((seed) => ({
		templateId: seed.templateId,
		...store.importWorkflowTemplateSeed(seed, FLAGS_OFF),
	}));
	const templatesAfterBoot1 = store.listWorkflowTemplates();
	const storedIds = templatesAfterBoot1.map((row) => row.template_id);
	const bundledIds = bundledSeeds.map((seed) => seed.templateId).sort();
	const allTargetPublished = TARGET_SEEDS.every(
		(id) => store.getWorkflowTemplate(id)?.current_published_revision != null,
	);
	record(
		"boot1_six_target_identities_installed_and_published",
		allTargetPublished && TARGET_SEEDS.length === 6,
	);
	record(
		"boot1_bundle_matches_production_seed_list",
		JSON.stringify([...storedIds].sort()) === JSON.stringify(bundledIds),
		`${storedIds.length} identities`,
	);
	record(
		"removed_dormant_seeds_absent",
		REMOVED_SEEDS.every((id) => !storedIds.includes(id)),
	);
	writeEvidence(
		"templates-after-boot1.txt",
		[
			`pinned_head=${observedHead}`,
			`generalized_flag=${process.env.FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES ?? "<unset>"}`,
			`boot1_results=${JSON.stringify(boot1Results)}`,
			...templatesAfterBoot1.map(
				(row) =>
					`${row.template_id}\tcurrent_published_revision=${row.current_published_revision}\tretired_at=${row.retired_at ?? "NULL"}\tseed_owner=${row.seed_owner}`,
			),
		].join("\n"),
	);

	// Production-shape fixture: exactly one wildcard binding to incumbent heavy.
	store.bindWorkflowCategory({
		project: PROJECT,
		taskCategory: "*",
		templateId: "tpl_eng_heavy",
		updatedBy: "qa:production-shape",
	});
	const bindingsPreWarm = logicalBindings(
		store.listWorkflowCategoryBindings(PROJECT),
	);
	const auditsPreWarm = store.listWorkflowTemplateAudit();
	writeJson("bindings-pre-warm.txt", bindingsPreWarm);
	store.close();
	store = undefined;

	// Warm boot #2 on the same DB. Existing authority must suppress defaults.
	store = await teamlead.StateStore.create(STATE_DB);
	const boot2Results = bundledSeeds.map((seed) => ({
		templateId: seed.templateId,
		...store.importWorkflowTemplateSeed(seed, FLAGS_OFF),
	}));
	templates.ensureDefaultWorkflowBindings(store, [PROJECT]);
	const bindingsPostWarm = logicalBindings(
		store.listWorkflowCategoryBindings(PROJECT),
	);
	const auditsPostWarm = store.listWorkflowTemplateAudit();
	const workKindBindings = bindingsPostWarm.filter((row) =>
		workKind.WORK_KIND_CATEGORIES.includes(row.task_category),
	);
	record(
		"warm_boot_all_seed_imports_unchanged",
		boot2Results.every((result) => result.status === "unchanged"),
	);
	record(
		"warm_boot_binding_logical_rowset_unchanged",
		JSON.stringify(bindingsPreWarm) === JSON.stringify(bindingsPostWarm),
	);
	record(
		"warm_boot_template_and_binding_audit_zero_increment",
		auditsPreWarm.length === auditsPostWarm.length &&
			auditsPreWarm.filter((row) => row.action === "rebind").length ===
				auditsPostWarm.filter((row) => row.action === "rebind").length,
	);
	record(
		"work_kind_categories_have_zero_bindings",
		workKindBindings.length === 0,
	);
	writeJson("bindings-post-warm.txt", bindingsPostWarm);
	writeJson("audit-counts.txt", {
		before_warm: {
			total: auditsPreWarm.length,
			rebind: auditsPreWarm.filter((row) => row.action === "rebind").length,
		},
		after_warm: {
			total: auditsPostWarm.length,
			rebind: auditsPostWarm.filter((row) => row.action === "rebind").length,
		},
		boot2_results: boot2Results,
		work_kind_binding_count: workKindBindings.length,
	});

	// B2: compare selection before and after the six identities are present.
	baselineStore = await teamlead.StateStore.create(
		join(ROOT, "state", "baseline.db"),
	);
	const legacyHeavySeed = bundledSeeds.find(
		(seed) => seed.templateId === "tpl_eng_heavy",
	);
	if (!legacyHeavySeed) throw new Error("tpl_eng_heavy missing from bundle");
	baselineStore.importWorkflowTemplateSeed(legacyHeavySeed, FLAGS_OFF);
	baselineStore.bindWorkflowCategory({
		project: PROJECT,
		taskCategory: "*",
		templateId: "tpl_eng_heavy",
		updatedBy: "qa:pre-workkind-baseline",
	});
	const beforeSeedSelection = await resolveV1Selection(
		selectionModule,
		baselineStore,
		{
			issueId: "FLY-QA-BEFORE-SEED",
			idempotencyKey: "fly1432-before-seed",
			canonicalRoot,
		},
	);
	const afterSeedSelection = await resolveV1Selection(selectionModule, store, {
		issueId: "FLY-QA-AFTER-SEED",
		idempotencyKey: "fly1432-after-seed",
		canonicalRoot,
	});
	record(
		"category_selection_remains_tpl_eng_heavy",
		beforeSeedSelection.templateId === "tpl_eng_heavy" &&
			afterSeedSelection.templateId === beforeSeedSelection.templateId &&
			afterSeedSelection.revision === beforeSeedSelection.revision,
	);
	writeJson("routing-selection.txt", {
		before_work_kind_seed_presence: beforeSeedSelection,
		after_work_kind_seed_presence: afterSeedSelection,
	});

	// B3: production Bridge HTTP stack, flag off, direct v2 selection => 409.
	let dispatcherStartCalls = 0;
	const dispatcher = {
		getInflightCount: () => 0,
		validateAgentName: () => ({ ok: true }),
		start: async () => {
			dispatcherStartCalls += 1;
			throw new Error(
				"dispatcher must remain unreachable in flag-off quadrant",
			);
		},
	};
	const projects = [
		{
			projectName: PROJECT,
			projectRoot: canonicalRoot,
			leads: [
				{
					agentId: LEAD,
					chatChannel: "qa-fly1432",
					match: { labels: [] },
				},
			],
		},
	];
	const config = {
		host: "127.0.0.1",
		port: 0,
		dbPath: STATE_DB,
		apiToken: MASTER_TOKEN,
		linearApiKey: process.env.LINEAR_API_KEY,
		notificationChannel: "qa-fly1432",
		defaultLeadAgentId: LEAD,
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		runnerAdmission: admissionModule.RunnerAdmissionController.alwaysAdmit(),
	};
	const app = plugin.createBridgeApp(
		store,
		projects,
		config,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		dispatcher,
	);
	server = app.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Bridge did not bind a TCP address");
	}
	const baseUrl = `http://127.0.0.1:${address.port}`;
	record(
		"bridge_uses_ephemeral_nonproduction_port",
		address.port !== 9876,
		baseUrl,
	);
	const workflowRowsBeforeDirect = workflowRunCount(store);
	const directResponse = await fetch(`${baseUrl}/api/runs/start`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${MASTER_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			issueId: "FLY-1432",
			projectName: PROJECT,
			leadId: LEAD,
			templateId: "tpl_generic",
			selectionReason: "FLY-1432 flag-off direct-selection probe",
			idempotencyKey: "fly1432-direct-off",
		}),
	});
	const directBody = await directResponse.json();
	const workflowRowsAfterDirect = workflowRunCount(store);
	const windowsAfter = tmuxWindowIds();
	const blockReason = dispatchFlags.workflowTemplateDispatchBlockReason(
		2,
		process.env,
	);
	record(
		"flag_off_direct_v2_returns_generalized_disabled_409",
		directResponse.status === 409 &&
			directBody.code === "GENERALIZED_WORKFLOW_REJECTED" &&
			blockReason === "generalized_disabled",
	);
	record(
		"flag_off_direct_v2_creates_zero_runs_and_zero_spawns",
		workflowRowsAfterDirect === workflowRowsBeforeDirect &&
			dispatcherStartCalls === 0 &&
			JSON.stringify(windowsAfter) === JSON.stringify(windowsBefore),
	);
	writeJson("direct-select-409.json", {
		bridge_url: baseUrl,
		status: directResponse.status,
		body: directBody,
		shared_dispatch_predicate: blockReason,
		workflow_run_rows_before: workflowRowsBeforeDirect,
		workflow_run_rows_after: workflowRowsAfterDirect,
		dispatcher_start_calls: dispatcherStartCalls,
		tmux_windows_before: windowsBefore,
		tmux_windows_after: windowsAfter,
	});
	await new Promise((resolve) => server.close(() => resolve()));
	server = undefined;

	// B4: separate flag-on quadrant. Direct v2 works; category stays on v1.
	flagOnStore = await teamlead.StateStore.create(
		join(ROOT, "state", "flag-on.db"),
	);
	for (const seed of bundledSeeds) {
		flagOnStore.importWorkflowTemplateSeed(seed, FLAGS_ON);
	}
	flagOnStore.bindWorkflowCategory({
		project: PROJECT,
		taskCategory: "*",
		templateId: "tpl_eng_heavy",
		updatedBy: "qa:flag-on-production-shape",
	});
	const directOn = await selectionModule.resolveWorkflowTemplateSelection(
		flagOnStore,
		{
			project: PROJECT,
			issueId: "FLY-QA-DIRECT-ON",
			leadTemplateId: "tpl_generic",
			leadReason: "FLY-1432 allowed lead override",
			selectedBy: LEAD,
			actor: "master",
			authKind: "master",
			canonicalRoot,
			idempotencyKey: "fly1432-direct-on",
			env: FLAGS_ON,
		},
	);
	const categoryOn = await selectionModule.resolveWorkflowTemplateSelection(
		flagOnStore,
		{
			project: PROJECT,
			issueId: "FLY-QA-CATEGORY-ON",
			taskCategory: "code",
			selectedBy: LEAD,
			actor: "master",
			authKind: "master",
			canonicalRoot,
			idempotencyKey: "fly1432-category-on",
			allowSchemaV1Dispatch: true,
			env: FLAGS_ON,
		},
	);
	if (!directOn || !categoryOn) {
		throw new Error("flag-on quadrant unexpectedly resolved to null");
	}
	const directOnRun = flagOnStore.getWorkflowRun(directOn.runId);
	const categoryOnRun = flagOnStore.getWorkflowRun(categoryOn.runId);
	record(
		"flag_on_direct_v2_allowed_while_category_stays_v1",
		directOnRun?.template_id === "tpl_generic" &&
			directOn.selectionSource === "lead" &&
			categoryOnRun?.template_id === "tpl_eng_heavy" &&
			categoryOn.selectionSource === "default",
	);
	writeJson("flag-on-quadrant.txt", {
		direct: {
			template_id: directOnRun?.template_id,
			selection_source: directOn.selectionSource,
			run_id: directOn.runId,
		},
		category: {
			template_id: categoryOnRun?.template_id,
			selection_source: categoryOn.selectionSource,
			run_id: categoryOn.runId,
		},
	});

	const pass =
		Object.keys(results).length > 0 && Object.values(results).every(Boolean);
	writeJson("harness-summary.json", {
		issue: "FLY-1432",
		pinned_head: observedHead,
		generated_at: new Date().toISOString(),
		room_root: ROOT,
		mutable_state: "isolated temporary HOME/state/comm roots",
		bridge: "production createBridgeApp HTTP stack on ephemeral loopback port",
		checks: results,
		pass,
	});
	if (!pass) process.exitCode = 1;
} catch (error) {
	const detail = error instanceof Error ? error.stack : String(error);
	logLines.push(`[qa] FAIL harness_error=${detail}`);
	console.error(`[qa] FAIL harness_error=${detail}`);
	process.exitCode = 1;
} finally {
	if (server) {
		await new Promise((resolve) => server.close(() => resolve()));
	}
	for (const targetStore of [store, baselineStore, flagOnStore]) {
		try {
			targetStore?.close();
		} catch {}
	}
	if (tmuxCreated) {
		spawnSync("tmux", ["kill-session", "-t", `=${TMUX_SESSION}`]);
	}
	writeEvidence("harness-stdout.log", logLines.join("\n"));
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (existsSync(ROOT) && ROOT.startsWith(join(tmpdir(), "qa-fly1432-room-"))) {
		rmSync(ROOT, { recursive: true, force: true });
	}
}
