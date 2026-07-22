#!/usr/bin/env node
/**
 * FLY-1281 real-machine generalized-template E2E.
 *
 * Runs the production Bridge HTTP stack against an isolated HOME/teamlead.db,
 * drives /api/runs/start through both Lead and category selection, and launches
 * deterministic probe runners through the real TmuxAdapter commit gate. The
 * probe exercises output-before-completion, marker persistence/reconcile, and
 * completion receipt replay without invoking a model or touching production DBs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const ROOT = mkdtempSync(join(tmpdir(), "qa-fly1281-"));
const REAL_HOME = process.env.HOME ?? "";
const ORIGINAL_PATH = process.env.PATH ?? "";
const ORIGINAL_ENV = Object.fromEntries(
	[
		"BRIDGE_DEPT_SCOPE_REJECT",
		"FLYWHEEL_COMM_BACKEND",
		"FLYWHEEL_COMM_ROOT",
		"FLYWHEEL_STATE_DIR",
		"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
		"FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES",
	].map((key) => [key, process.env[key]]),
);
const PROJECT = "flywheel-e2e";
const LEAD = "flywheel-eng-lead";
const OUTPUT_TEMPLATE_ID = "tpl_fly1281_output_probe";
const MASTER_TOKEN = `fly1281-master-${process.pid}`;
const TMUX_SESSION = `qa-fly1281-${process.pid}`;
const EVIDENCE_DIR = join(
	REPO,
	"engineering/doc/FLY-1281-template-generalization/qa",
);
const results = {};

const record = (key, pass) => {
	results[key] = Boolean(pass);
	console.log(`[qa] ${pass ? "PASS" : "FAIL"} ${key}`);
};
const sh = (command, args, cwd = REPO) =>
	execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
const importFile = (path) => import(pathToFileURL(path).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(path, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		await sleep(25);
	}
	return false;
}

function completionBody(
	executionId,
	issueId,
	eventId = `complete-${executionId}`,
) {
	return {
		event_id: eventId,
		execution_id: executionId,
		issue_id: issueId,
		project_name: PROJECT,
		event_type: "session_completed",
		source: "flywheel-comm",
		payload: {
			decision: { route: "no_code" },
			evidence: {},
			sessionRole: "main",
		},
	};
}

let server;
let store;
const spawnedWindows = [];
try {
	if (!process.env.LINEAR_API_KEY) {
		throw new Error(
			"LINEAR_API_KEY is required for the real /api/runs/start preflight",
		);
	}
	process.env.HOME = ROOT;
	process.env.FLYWHEEL_STATE_DIR = join(ROOT, "state");
	process.env.FLYWHEEL_COMM_ROOT = join(ROOT, "comm");
	process.env.FLYWHEEL_COMM_BACKEND = "commdb";
	process.env.FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES = "1";
	process.env.FLYWHEEL_WORKFLOW_CLAIMS_WRITE = "1";
	process.env.BRIDGE_DEPT_SCOPE_REJECT = "0";
	mkdirSync(join(ROOT, ".flywheel"), { recursive: true });
	mkdirSync(process.env.FLYWHEEL_STATE_DIR, { recursive: true });
	mkdirSync(process.env.FLYWHEEL_COMM_ROOT, { recursive: true });
	mkdirSync(EVIDENCE_DIR, { recursive: true });

	const runner = await importFile(
		join(REPO, "packages/claude-runner/dist/index.js"),
	);
	const teamlead = await importFile(
		join(REPO, "packages/teamlead/dist/StateStore.js"),
	);
	const plugin = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/plugin.js"),
	);
	const admissionModule = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/runner-admission.js"),
	);
	const templates = await importFile(
		join(REPO, "packages/teamlead/dist/workflow-template.js"),
	);
	const reconciler = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/complete-marker-reconciler.js"),
	);

	const projectRoot = join(ROOT, "project");
	mkdirSync(join(projectRoot, "agents"), { recursive: true });
	writeFileSync(
		join(projectRoot, "agents", "generic-executor.md"),
		"---\nname: generic-executor\n---\nExecute the pinned generalized task.\n",
	);
	sh("git", ["init", "-q", "-b", "main"], projectRoot);
	sh("git", ["config", "user.email", "qa@flywheel.local"], projectRoot);
	sh("git", ["config", "user.name", "QA FLY-1281"], projectRoot);
	sh("git", ["add", "-A"], projectRoot);
	sh("git", ["commit", "-qm", "initial"], projectRoot);
	const canonicalRoot = realpathSync(projectRoot);

	const binDir = join(ROOT, "bin");
	mkdirSync(binDir, { recursive: true });
	const helperPath = join(ROOT, "runner-helper.mjs");
	writeFileSync(
		helperPath,
		`import { existsSync, mkdirSync, writeFileSync } from "node:fs";\n` +
			`import { dirname, join } from "node:path";\n` +
			`const executionId=process.env.FLYWHEEL_EXEC_ID; const issueId=process.env.FLYWHEEL_ISSUE_ID; const base=process.env.FLYWHEEL_BRIDGE_URL;\n` +
			`const completion={event_id:"complete-"+executionId,execution_id:executionId,issue_id:issueId,project_name:process.env.FLYWHEEL_PROJECT_NAME,event_type:"session_completed",source:"flywheel-comm",payload:{decision:{route:"no_code"},evidence:{},sessionRole:"main"}};\n` +
			`const post=async(path,body)=>{const response=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});let json={};try{json=await response.json();}catch{}return {status:response.status,body:json};};\n` +
			`const first=await post("/events",completion); let markerRetained=false; let output; let second=first;\n` +
			`if(process.env.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL){const marker=join(process.env.HOME,".flywheel","state","complete-failed",executionId+".json");mkdirSync(dirname(marker),{recursive:true});writeFileSync(marker,JSON.stringify(completion));markerRetained=existsSync(marker);output=await post("/api/workflow/output",{credential:process.env.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL,client_request_id:"output-"+executionId,payload:JSON.stringify({artifact:"fresh-spawn",executionId})});second=await post("/events",completion);}\n` +
			`writeFileSync(process.env.QA_FLY1281_RESPONSE,JSON.stringify({first,second,output,markerRetained,outputCredentialPresent:Boolean(process.env.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL)}));\n`,
	);
	const claudeStub = join(binDir, "claude");
	writeFileSync(
		claudeStub,
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "qa-claude-stub"; exit 0; fi\nexec node "$QA_FLY1281_HELPER"\n`,
	);
	chmodSync(claudeStub, 0o755);
	process.env.PATH = `${binDir}:${ORIGINAL_PATH}`;

	const stateDbPath = join(ROOT, "state", "teamlead.db");
	store = await teamlead.StateStore.create(stateDbPath);
	templates.importBundledWorkflowSeeds(store, process.env, () => {});
	const outputSeed = {
		templateId: OUTPUT_TEMPLATE_ID,
		name: "FLY-1281 output reconciliation probe",
		projectScope: "global",
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "produce",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic-executor.md",
					produces_output: true,
					output: { schema: "json_v1", max_bytes: 262144 },
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "produce_done",
					from: "produce",
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["founder_approved"],
		},
	};
	store.importWorkflowTemplateSeed({
		...outputSeed,
		contentHash: templates.workflowSeedContentHash(outputSeed),
	});
	record(
		"v2_seeds_imported_under_flag",
		[
			"tpl_product_v1",
			"tpl_product_designer",
			"tpl_product_prototype",
			"tpl_generic",
		].every(
			(id) => store.getWorkflowTemplate(id)?.current_published_revision === 1,
		) &&
			store.getWorkflowTemplate(OUTPUT_TEMPLATE_ID)
				?.current_published_revision === 1,
	);
	store.bindWorkflowCategory({
		project: PROJECT,
		taskCategory: "research-e2e",
		templateId: OUTPUT_TEMPLATE_ID,
		updatedBy: LEAD,
	});

	const projects = [
		{
			projectName: PROJECT,
			projectRoot: canonicalRoot,
			leads: [
				{
					agentId: LEAD,
					chatChannel: "qa-fly1281",
					match: { labels: [] },
				},
			],
		},
	];
	const config = {
		host: "127.0.0.1",
		port: 0,
		dbPath: stateDbPath,
		apiToken: MASTER_TOKEN,
		linearApiKey: process.env.LINEAR_API_KEY,
		notificationChannel: "qa-fly1281",
		defaultLeadAgentId: LEAD,
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		runnerAdmission: admissionModule.RunnerAdmissionController.alwaysAdmit(),
	};

	const responseByExecution = new Map();
	let physicalSpawnCount = 0;
	const dispatcher = {
		getInflightCount: () => 0,
		validateAgentName: () => ({ ok: true }),
		start: async (request) => {
			const generalized = request.generalizedExecution;
			if (!generalized)
				throw new Error("generalized execution context missing");
			physicalSpawnCount += 1;
			const responsePath = join(
				ROOT,
				`${generalized.executionId}-response.json`,
			);
			const transport = {
				buildRunnerSpawnConfig: () => ({
					args: [],
					env: {
						PATH: process.env.PATH,
						HOME: ROOT,
						QA_FLY1281_HELPER: helperPath,
						QA_FLY1281_RESPONSE: responsePath,
					},
				}),
			};
			const hookServer = {
				getPort: () => 9,
				waitForCompletion: async (token, timeoutMs, expectedSessionId) =>
					(await waitForFile(responsePath, timeoutMs))
						? { token, sessionId: expectedSessionId, issueId: request.issueId }
						: null,
				cancelWait: () => {},
			};
			const adapter = new runner.TmuxAdapter(
				TMUX_SESSION,
				undefined,
				25,
				30_000,
				hookServer,
				transport,
				stateDbPath,
			);
			const outcome = await adapter.execute({
				executionId: generalized.executionId,
				issueId: request.issueId,
				prompt: generalized.agentContent,
				cwd: canonicalRoot,
				label: `${request.issueId}-${generalized.nodeId}`,
				projectName: PROJECT,
				leadId: LEAD,
				agentName: "generic",
				teamName: LEAD,
				vendor: "claude-code",
				bridgeUrl: baseUrl,
				commDbPath: join(ROOT, "comm", PROJECT, "comm.db"),
				stateDbPath,
				workflowOutputCredential: generalized.outputCredential,
				launchCommitPath: join(
					ROOT,
					".flywheel",
					"state",
					"launch-commits",
					generalized.executionId,
				),
				launchGateToken: generalized.launchGateToken,
				commitWorkflowLaunch: generalized.commitWorkflowLaunch,
				timeoutMs: 30_000,
				onTmuxWindowCreated: (info) => spawnedWindows.push(info.windowId),
			});
			if (!outcome.success || !(await waitForFile(responsePath, 1_000))) {
				throw new Error(`fresh spawn failed for ${generalized.executionId}`);
			}
			responseByExecution.set(
				generalized.executionId,
				JSON.parse(readFileSync(responsePath, "utf8")),
			);
			store.upsertSession({
				execution_id: generalized.executionId,
				issue_id: request.issueId,
				project_name: PROJECT,
				status: "running",
				workflow_node_id: generalized.nodeId,
			});
			return {
				executionId: generalized.executionId,
				issueId: request.issueId,
			};
		},
	};

	let baseUrl;
	const startServer = async () => {
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
		baseUrl = `http://127.0.0.1:${address.port}`;
	};
	const stopServer = async () => {
		if (!server) return;
		await new Promise((resolve) => server.close(() => resolve()));
		server = undefined;
	};
	const postStart = async (body) => {
		const response = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${MASTER_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	};

	await startServer();
	const leadStart = await postStart({
		issueId: "FLY-1281",
		projectName: PROJECT,
		leadId: LEAD,
		templateId: "tpl_generic",
		selectionReason: "real-machine lead-selected generic chain",
		idempotencyKey: "fly1281-e2e-lead",
	});
	const bindingStart = await postStart({
		issueId: "FLY-1244",
		projectName: PROJECT,
		leadId: LEAD,
		taskCategory: "research-e2e",
		idempotencyKey: "fly1281-e2e-binding",
	});
	record(
		"lead_and_binding_start_routes",
		leadStart.status === 200 &&
			leadStart.body.generalized === true &&
			bindingStart.status === 200 &&
			bindingStart.body.generalized === true,
	);
	record(
		"real_tmux_fresh_spawn_exactly_once_per_start",
		physicalSpawnCount === 2 && spawnedWindows.length === 2,
	);

	const leadRun = store.getWorkflowRun(leadStart.body.workflowRunId);
	const bindingRun = store.getWorkflowRun(bindingStart.body.workflowRunId);
	record(
		"selection_provenance_persisted",
		leadRun?.selection_source === "lead" &&
			leadRun.selected_by === LEAD &&
			bindingRun?.selection_source === "binding" &&
			bindingRun.selected_by === LEAD,
	);
	const leadSnapshot = JSON.parse(leadRun.snapshot);
	const bindingSnapshot = JSON.parse(bindingRun.snapshot);
	record(
		"typed_snapshot_pins_agent_content",
		leadSnapshot.schema_version === 2 &&
			bindingSnapshot.schema_version === 2 &&
			leadSnapshot.resolved.nodes[0].agent.content.includes(
				"pinned generalized",
			) &&
			bindingSnapshot.resolved.nodes[0].agent.digest.length === 64,
	);

	const leadProbe = responseByExecution.get(leadStart.body.executionId);
	const bindingProbe = responseByExecution.get(bindingStart.body.executionId);
	record(
		"zero_and_output_credential_shapes",
		leadProbe?.outputCredentialPresent === false &&
			bindingProbe?.outputCredentialPresent === true,
	);
	record(
		"missing_output_is_retryable_then_same_event_completes",
		bindingProbe?.first.status === 409 &&
			bindingProbe.first.body.reason === "missing_output" &&
			bindingProbe.first.body.retryable === true &&
			bindingProbe.markerRetained === true &&
			bindingProbe.output?.status === 200 &&
			bindingProbe.second.status === 200,
	);
	record(
		"no_output_completion_receipt_and_projection",
		leadProbe?.first.status === 200 &&
			store.getWorkflowNodeCompletion(
				leadStart.body.workflowRunId,
				leadStart.body.workflowNodeId,
				1,
			)?.execution_id === leadStart.body.executionId &&
			store.getSession(leadStart.body.executionId)?.status === "completed",
	);
	record(
		"blueprint_tail_is_receipt_noop",
		store.observeEnrolledTeardown({ executionId: leadStart.body.executionId })
			.receipt === true &&
			store.observeEnrolledTeardown({
				executionId: bindingStart.body.executionId,
			}).receipt === true,
	);
	record(
		"successor_and_review_dispatch_remain_unreachable",
		store.listWorkflowRunNodes(
			leadStart.body.workflowRunId,
			leadStart.body.workflowNodeId,
		).length === 1 &&
			store.listWorkflowRunNodes(
				bindingStart.body.workflowRunId,
				bindingStart.body.workflowNodeId,
			).length === 1 &&
			store.listWorkflowRunNodes(leadStart.body.workflowRunId, "founder_gate")
				.length === 0 &&
			store.listWorkflowRunNodes(
				bindingStart.body.workflowRunId,
				"founder_gate",
			).length === 0 &&
			physicalSpawnCount === 2,
	);

	const markerPath = join(
		ROOT,
		".flywheel",
		"state",
		"complete-failed",
		`${bindingStart.body.executionId}.json`,
	);
	record("completion_marker_present_before_restart", existsSync(markerPath));
	await stopServer();
	store.close();
	store = await teamlead.StateStore.create(stateDbPath);
	await startServer();
	const reconcileResult = await reconciler.reconcileCompleteFailedMarkers({
		store,
		bridgeBaseUrl: baseUrl,
		markerDir: join(ROOT, ".flywheel", "state", "complete-failed"),
		quarantineDir: join(
			ROOT,
			".flywheel",
			"state",
			"complete-failed-quarantine",
		),
		log: () => {},
	});
	record(
		"restart_reconciles_marker_without_losing_output",
		reconcileResult.reconciled === 1 &&
			!existsSync(markerPath) &&
			store.getWorkflowNodeCompletion(
				bindingStart.body.workflowRunId,
				bindingStart.body.workflowNodeId,
				1,
			)?.execution_id === bindingStart.body.executionId,
	);
	const replayBody = completionBody(
		bindingStart.body.executionId,
		"FLY-1244",
		`complete-restart-${bindingStart.body.executionId}`,
	);
	const restartReplay = await fetch(`${baseUrl}/events`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(replayBody),
	}).then(async (response) => ({
		status: response.status,
		body: await response.json(),
	}));
	const canonicalAudits = store
		.getEventsByExecution(bindingStart.body.executionId)
		.filter((event) => event.source === "workflow-generalized-completion");
	record(
		"restart_completion_replay_is_idempotent_with_one_canonical_audit",
		restartReplay.status === 200 &&
			restartReplay.body.duplicate === true &&
			canonicalAudits.length === 1,
	);

	process.env.FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES = "0";
	const beforeOff = store.getActiveWorkflowRunForIssue("FLY-1232");
	const offLead = await postStart({
		issueId: "FLY-1232",
		projectName: PROJECT,
		leadId: LEAD,
		templateId: "tpl_generic",
		selectionReason: "flag-off sentinel",
		idempotencyKey: "fly1281-e2e-off-lead",
	});
	store.bindWorkflowCategory({
		project: PROJECT,
		taskCategory: "off-binding",
		templateId: OUTPUT_TEMPLATE_ID,
		updatedBy: LEAD,
	});
	const offBinding = await postStart({
		issueId: "FLY-1224",
		projectName: PROJECT,
		leadId: LEAD,
		taskCategory: "off-binding",
		idempotencyKey: "fly1281-e2e-off-binding",
	});
	const offStore = await teamlead.StateStore.create(":memory:");
	templates.importBundledWorkflowSeeds(
		offStore,
		{ FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "0" },
		() => {},
	);
	record(
		"flag_off_rejects_starts_but_keeps_bundled_v2_seeds_dormant",
		beforeOff === undefined &&
			offLead.status === 409 &&
			offBinding.status === 409 &&
			store.getActiveWorkflowRunForIssue("FLY-1232") === undefined &&
			store.getActiveWorkflowRunForIssue("FLY-1224") === undefined &&
			offStore.getWorkflowTemplate("tpl_generic")
				?.current_published_revision === 1 &&
			physicalSpawnCount === 2,
	);
	offStore.close();

	const evidence = {
		issue: "FLY-1281",
		generated_at: new Date().toISOString(),
		harness: {
			bridge: "production createBridgeApp HTTP stack",
			state: "isolated teamlead.db",
			spawn: "real TmuxAdapter gated fresh spawn with deterministic probe",
		},
		observed_flag_names: [
			"FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES",
			"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
		],
		checks: results,
		pass:
			Object.keys(results).length > 0 && Object.values(results).every(Boolean),
	};
	writeFileSync(
		join(EVIDENCE_DIR, "fresh-spawn-e2e.json"),
		`${JSON.stringify(evidence, null, "\t")}\n`,
	);
	if (!evidence.pass) process.exitCode = 1;
} catch (error) {
	console.error(
		`[qa] FAIL harness_error=${error instanceof Error ? error.stack : String(error)}`,
	);
	process.exitCode = 1;
} finally {
	if (server) await new Promise((resolve) => server.close(() => resolve()));
	try {
		store?.close();
	} catch {}
	spawnSync("tmux", ["kill-session", "-t", `=${TMUX_SESSION}`]);
	process.env.HOME = REAL_HOME;
	process.env.PATH = ORIGINAL_PATH;
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(ROOT, { recursive: true, force: true });
}
