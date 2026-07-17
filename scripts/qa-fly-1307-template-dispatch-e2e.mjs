#!/usr/bin/env node
/**
 * FLY-1307 real-machine template-dispatch E2E.
 *
 * Uses the production Bridge HTTP stack, isolated StateStore + CommDB files,
 * real TmuxAdapter fresh spawns with deterministic probe runners, the real
 * workflow engine dispatcher, the source-outbox projector, and the production
 * docs materializer against a local bare Git remote.
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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const ROOT = mkdtempSync(join(tmpdir(), "qa-fly1307-"));
const REAL_HOME = process.env.HOME ?? "";
const ORIGINAL_PATH = process.env.PATH ?? "";
const MANAGED_ENV = [
	"BRIDGE_DEPT_SCOPE_REJECT",
	"FLYWHEEL_COMM_BACKEND",
	"FLYWHEEL_COMM_ROOT",
	"FLYWHEEL_STATE_DIR",
	"FLYWHEEL_TMUX_RESCUE_CLI",
	"FLYWHEEL_WORKFLOW_CLAIMS_READ",
	"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
	"FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES",
	"FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH",
];
const ORIGINAL_ENV = Object.fromEntries(
	MANAGED_ENV.map((key) => [key, process.env[key]]),
);
const PROJECT = "flywheel-e2e";
const LEAD = "flywheel-eng-lead";
const MASTER_TOKEN = `fly1307-master-${process.pid}`;
const TMUX_SESSION = `qa-fly1307-${process.pid}`;
const EVIDENCE_DIR = join(
	REPO,
	"engineering/doc/FLY-1307-registry-snapshot-dispatch-enable/qa",
);
const FLAGS_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
const results = {};

const record = (key, pass) => {
	results[key] = Boolean(pass);
	console.log(`[qa] ${pass ? "PASS" : "FAIL"} ${key}`);
};
const sh = (command, args, cwd = REPO) =>
	execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
const importFile = (path) => import(pathToFileURL(path).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function waitForFile(path, timeoutMs) {
	return waitFor(() => existsSync(path), timeoutMs, path);
}

let server;
let store;
let workflowEngine;
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
	process.env.BRIDGE_DEPT_SCOPE_REJECT = "0";
	Object.assign(process.env, FLAGS_ON);
	mkdirSync(join(ROOT, ".flywheel"), { recursive: true });
	mkdirSync(join(ROOT, ".flywheel", "bin"), { recursive: true });
	symlinkSync(
		join(REPO, "scripts", "lib", "tmux-server-rescue.sh"),
		join(ROOT, ".flywheel", "bin", "tmux-server-rescue"),
	);
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
	const projector = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/founder-approval-projector.js"),
	);
	const engineDispatcher = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/workflow-engine-dispatcher.js"),
	);
	const materializedAuthority = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/materialized-head-authority.js"),
	);
	const docsMaterializer = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/workflow-docs-materializer.js"),
	);
	const docsGit = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/workflow-docs-git.js"),
	);
	const shipGate = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/merge-ship-gate.js"),
	);
	const commModule = await importFile(
		join(REPO, "packages/flywheel-comm/dist/db.js"),
	);

	const projectRoot = join(ROOT, "project");
	const bareRemote = join(ROOT, "remote.git");
	mkdirSync(join(projectRoot, "agents"), { recursive: true });
	writeFileSync(
		join(projectRoot, "agents", "generic-executor.md"),
		"---\nname: generic-executor\n---\nExecute the pinned workflow node.\n",
	);
	sh("git", ["init", "-q", "--bare", bareRemote], ROOT);
	sh("git", ["init", "-q", "-b", "main"], projectRoot);
	sh("git", ["config", "user.email", "qa@flywheel.local"], projectRoot);
	sh("git", ["config", "user.name", "QA FLY-1307"], projectRoot);
	sh("git", ["add", "-A"], projectRoot);
	sh("git", ["commit", "-qm", "initial"], projectRoot);
	sh("git", ["remote", "add", "origin", bareRemote], projectRoot);
	sh("git", ["push", "-q", "-u", "origin", "main"], projectRoot);
	sh("git", ["symbolic-ref", "HEAD", "refs/heads/main"], bareRemote);
	const canonicalRoot = realpathSync(projectRoot);
	const mainHead = sh("git", ["rev-parse", "HEAD"], canonicalRoot);

	const binDir = join(ROOT, "bin");
	mkdirSync(binDir, { recursive: true });
	const rescueShim = join(binDir, "tmux-rescue-shim.mjs");
	writeFileSync(
		rescueShim,
		`#!/usr/bin/env node\n` +
			`import { spawnSync } from "node:child_process";\n` +
			`const args=process.argv.slice(2); const verifyAt=args.indexOf("--verify"); const createAt=args.indexOf("--create");\n` +
			`if(args[0]!=="ensure"||verifyAt<0||createAt<0) process.exit(64);\n` +
			`const verify=args.slice(verifyAt+1,createAt); const create=args.slice(createAt+1);\n` +
			`let action="verified"; let createStdout=""; let run=spawnSync(verify[0],verify.slice(1),{encoding:"utf8"});\n` +
			`if(run.status!==0){action="created"; run=spawnSync(create[0],create.slice(1),{encoding:"utf8"}); if(run.status!==0){process.stderr.write(run.stderr||"tmux create failed"); process.exit(run.status||1);} createStdout=(run.stdout||"").trim();}\n` +
			`const socket=args[1]; const pid=spawnSync("tmux",["-S",socket,"display-message","-p","#{pid}"],{encoding:"utf8"}); if(pid.status!==0) process.exit(pid.status||1);\n` +
			`process.stdout.write(JSON.stringify({action,createStdout,reachablePid:Number((pid.stdout||"").trim())}));\n`,
	);
	chmodSync(rescueShim, 0o755);
	process.env.FLYWHEEL_TMUX_RESCUE_CLI = rescueShim;
	const helperPath = join(ROOT, "runner-helper.mjs");
	writeFileSync(
		helperPath,
		`import { writeFileSync } from "node:fs";\n` +
			`const base=process.env.FLYWHEEL_BRIDGE_URL; const executionId=process.env.FLYWHEEL_EXEC_ID; const issueId=process.env.FLYWHEEL_ISSUE_ID; const role=process.env.QA_FLY1307_ROLE; const attempt=Number(process.env.QA_FLY1307_ATTEMPT||"1");\n` +
			`const post=async(path,body)=>{const response=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});let json={};try{json=await response.json();}catch{}return {status:response.status,body:json};};\n` +
			`const complete=async(route)=>post("/events",{event_id:"complete-"+executionId,execution_id:executionId,issue_id:issueId,project_name:process.env.FLYWHEEL_PROJECT_NAME,event_type:"session_completed",source:"flywheel-comm",payload:{decision:{route},evidence:{},sessionRole:role}});\n` +
			`let response; let output;\n` +
			`if(role==="qa"){response=await post("/api/workflow/decision",{credential:process.env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL,client_request_id:"qa-"+attempt+"-"+executionId,status:attempt===1?"fail":"pass",summary:attempt===1?"deterministic first-round failure":"deterministic retry pass"});}\n` +
			`else if(process.env.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL){output=await post("/api/workflow/output",{credential:process.env.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL,client_request_id:"output-"+executionId,payload:JSON.stringify({kind:"docs_v1",operations:[{op:"write",path:"product/doc/fly-1307-e2e.md",content:"# FLY-1307 E2E\\n"}]})});response=await complete("no_code");}\n` +
			`else if(process.env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL){response=await post("/api/workflow/decision",{credential:process.env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL,client_request_id:"review-"+executionId,status:"pass",summary:"materialized head reviewed"});}\n` +
			`else {response=await complete(role==="design"?"phase_design_complete":role==="implement"?"needs_review":"no_code");}\n` +
			`writeFileSync(process.env.QA_FLY1307_RESPONSE,JSON.stringify({role,attempt,response,output,submissionCredentialPresent:Boolean(process.env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL),outputCredentialPresent:Boolean(process.env.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL)}));\n`,
	);
	const claudeStub = join(binDir, "claude");
	writeFileSync(
		claudeStub,
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "qa-claude-stub"; exit 0; fi\nexec node "$QA_FLY1307_HELPER"\n`,
	);
	chmodSync(claudeStub, 0o755);
	process.env.PATH = `${binDir}:${ORIGINAL_PATH}`;

	const stateDbPath = join(ROOT, "state", "teamlead.db");
	const commDbPath = join(ROOT, "comm", PROJECT, "comm.db");
	mkdirSync(dirname(commDbPath), { recursive: true });
	store = await teamlead.StateStore.create(stateDbPath);
	templates.importBundledWorkflowSeeds(store, process.env, () => {});
	templates.ensureDefaultWorkflowBindings(store, [PROJECT]);
	const seedIds = templates
		.loadBundledWorkflowSeeds()
		.map((seed) => seed.templateId);
	const importedSeeds = seedIds.map((id) => ({
		id,
		revision: store.getWorkflowTemplate(id)?.current_published_revision,
	}));
	const defaultBindings = store.listWorkflowCategoryBindings(PROJECT);
	const seedsAndBindingsOk =
		seedIds.length === 6 &&
		seedIds.every(
			(id) => store.getWorkflowTemplate(id)?.current_published_revision === 1,
		) &&
		store.getWorkflowCategoryBinding(PROJECT, "*")?.template_id ===
			"tpl_eng_heavy" &&
		store.getWorkflowCategoryBinding(PROJECT, "light")?.template_id ===
			"tpl_eng_light" &&
		store.getWorkflowCategoryBinding(PROJECT, "trivial")?.template_id ===
			"tpl_eng_trivial";
	if (!seedsAndBindingsOk) {
		console.log(
			`[qa] seed diagnostic ${JSON.stringify({ importedSeeds, defaultBindings })}`,
		);
	}
	record("six_seeds_and_engineering_default_bindings", seedsAndBindingsOk);

	const projects = [
		{
			projectName: PROJECT,
			projectRoot: canonicalRoot,
			projectRepo: "qa/flywheel-e2e",
			leads: [
				{
					agentId: LEAD,
					chatChannel: "qa-fly1307",
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
		notificationChannel: "qa-fly1307",
		defaultLeadAgentId: LEAD,
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		runnerAdmission: admissionModule.RunnerAdmissionController.alwaysAdmit(),
	};

	let baseUrl;
	let physicalSpawnCount = 0;
	const spawnRecords = [];
	const responseByExecution = new Map();
	const dispatcher = {
		getInflightCount: () => 0,
		validateAgentName: () => ({ ok: true }),
		start: async (request) => {
			const generalized = request.generalizedExecution;
			if (!generalized)
				throw new Error("generalized execution context missing");
			physicalSpawnCount += 1;
			spawnRecords.push({
				executionId: generalized.executionId,
				runId: generalized.runId,
				nodeId: generalized.nodeId,
				attempt: generalized.attempt,
				role: request.sessionRole,
				dispatch: generalized.dispatch,
			});
			const adapterType =
				generalized.dispatch.vendor === "codex" ? "codex-tmux" : "claude-tmux";
			store.upsertSession({
				execution_id: generalized.executionId,
				issue_id: request.issueId,
				project_name: request.projectName,
				status: "running",
				session_role: request.sessionRole,
				chat_thread_role: request.sessionRole,
				adapter_type: adapterType,
				runner_model: generalized.dispatch.model,
				dispatch_model: generalized.dispatch.model,
				worktree_path: canonicalRoot,
				workflow_node_id: generalized.nodeId,
			});
			if (["design", "implement", "qa"].includes(request.sessionRole)) {
				const comm = new commModule.CommDB(commDbPath);
				comm.grantTurn(
					request.issueId,
					generalized.executionId,
					request.sessionRole,
					Date.now(),
					{
						project: PROJECT,
						sourceEventId: `turn:e2e:${generalized.executionId}`,
						targetRunId: generalized.runId,
					},
				);
				comm.close();
			}
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
						QA_FLY1307_HELPER: helperPath,
						QA_FLY1307_RESPONSE: responsePath,
						QA_FLY1307_ROLE: request.sessionRole,
						QA_FLY1307_ATTEMPT: String(generalized.attempt),
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
				label: `${request.issueId}-${generalized.nodeId}-${generalized.attempt}`,
				projectName: PROJECT,
				leadId: LEAD,
				agentName: "generic",
				teamName: LEAD,
				vendor: "claude-code",
				bridgeUrl: baseUrl,
				commDbPath,
				stateDbPath,
				workflowSubmissionCredential: generalized.submissionCredential,
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
			const probe = responseByExecution.get(generalized.executionId);
			console.log(
				`[qa] probe ${generalized.nodeId}:${generalized.attempt} response=${probe?.response?.status ?? "missing"} reason=${probe?.response?.body?.reason ?? probe?.response?.body?.error ?? "none"} output=${probe?.output?.status ?? "none"}`,
			);
			return {
				executionId: generalized.executionId,
				issueId: request.issueId,
			};
		},
	};

	const startServer = async () => {
		const headAuthority =
			materializedAuthority.receiptBackedMaterializedHeadAuthority(store);
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
			undefined,
			undefined,
			{ materializedHeadAuthority: headAuthority },
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise((resolve) => server.once("listening", resolve));
		const address = server.address();
		baseUrl = `http://127.0.0.1:${address.port}`;
		workflowEngine = new engineDispatcher.WorkflowEngineDispatcher({
			store,
			startDispatcher: dispatcher,
			env: process.env,
			stateRoot: join(ROOT, ".flywheel", "state", "launch-commits"),
			materializedHeadAuthority: headAuthority,
			resolveLeadId: () => LEAD,
			log: (message) => console.warn(`[qa-engine] ${message}`),
		});
		workflowEngine.start(100);
	};
	const stopServer = async () => {
		workflowEngine?.stop();
		workflowEngine = undefined;
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
	const drainSources = () =>
		projector.drainWorkflowSourceEvents({
			projects: [PROJECT],
			openCommDb: () => new commModule.CommDB(commDbPath),
			store,
		});
	const writeFounderSource = (runId, issueId, executionId, head) => {
		const comm = new commModule.CommDB(commDbPath);
		const questionId = comm.insertQuestion(executionId, LEAD, "ship?", {
			checkpoint: "approve_to_ship",
		});
		const payload = {
			schema_version: 1,
			run_id: runId,
			issue_id: issueId,
			question_id: questionId,
			response: { approved: true },
			actor: "bridge",
			approved_head: head,
			classification: "dashboard_founder_action",
			authority_id: questionId,
		};
		const written = comm.insertFounderApprovalResponseWithSource({
			project: PROJECT,
			sourceEventId: `founder-approval:${questionId}`,
			questionId,
			fromAgent: "bridge",
			content: '{"approved":true}',
			expectedOwner: executionId,
			payload,
		});
		comm.close();
		if (!written) throw new Error("founder source write failed");
		return questionId;
	};

	await startServer();
	const engineering = await postStart({
		issueId: "FLY-1307",
		projectName: PROJECT,
		leadId: LEAD,
		taskCategory: "engineering",
		idempotencyKey: "fly1307-e2e-engineering",
	});
	record(
		"engineering_v1_selected_and_materialized",
		engineering.status === 200 && engineering.body.generalized === true,
	);
	if (!(engineering.status === 200 && engineering.body.generalized === true)) {
		console.log(`[qa] engineering diagnostic ${JSON.stringify(engineering)}`);
	}
	const engineeringRunId = engineering.body.workflowRunId;
	try {
		await waitFor(
			() =>
				store.getWorkflowRun(engineeringRunId)?.current_node_id ===
				"founder_gate",
			45_000,
			"engineering founder gate",
		);
	} catch (error) {
		console.log(
			`[qa] engineering hold diagnostic ${JSON.stringify({ run: store.getWorkflowRun(engineeringRunId), spawns: spawnRecords.filter((entry) => entry.runId === engineeringRunId), probes: Object.fromEntries(responseByExecution), events: store.listWorkflowRunEvents(engineeringRunId) })}`,
		);
		throw error;
	}
	const engineeringSpawns = spawnRecords.filter(
		(recorded) => recorded.runId === engineeringRunId,
	);
	record(
		"engineering_full_chain_with_one_qa_loop",
		engineeringSpawns
			.map((entry) => `${entry.nodeId}:${entry.attempt}`)
			.join(",") === "design:1,implement:1,qa:1,implement:2,qa:2",
	);
	record(
		"pinned_explicit_vendor_model_effort_dispatch",
		engineeringSpawns.some(
			(entry) =>
				entry.nodeId === "design" &&
				entry.dispatch.vendor === "claude" &&
				entry.dispatch.model === "claude-fable-5",
		) &&
			engineeringSpawns.some(
				(entry) =>
					entry.nodeId === "implement" &&
					entry.dispatch.vendor === "codex" &&
					entry.dispatch.model === "gpt-5.6-sol" &&
					entry.dispatch.effort === "xhigh",
			) &&
			engineeringSpawns.some(
				(entry) =>
					entry.nodeId === "qa" &&
					entry.dispatch.vendor === "claude" &&
					entry.dispatch.model === "claude-opus-4-8",
			),
	);
	const engineeringRun = store.getWorkflowRun(engineeringRunId);
	record(
		"engineering_snapshot_is_typed_and_engine_owned",
		engineeringRun?.engine_owned === 1 &&
			JSON.parse(engineeringRun.snapshot).schema_version === 1,
	);

	const sourceDrain = drainSources();
	const comm = new commModule.CommDB(commDbPath);
	const engineeringSources = comm
		.listWorkflowSourceEvents()
		.filter((row) => row.kind === "turn_grant");
	const engineeringHistory = comm.listTurnSourceHistory("FLY-1307");
	comm.close();
	record(
		"source_outbox_turns_are_run_attributed_and_projected",
		engineeringSources.length === 5 &&
			engineeringHistory.length === 5 &&
			engineeringHistory.every(
				(row) => row.target_run_id === engineeringRunId,
			) &&
			sourceDrain.deadlettered === 0 &&
			store
				.listWorkflowRunEvents(engineeringRunId)
				.filter((event) => event.kind === "turn_granted").length === 5,
	);

	writeFounderSource(
		engineeringRunId,
		"FLY-1307",
		engineering.body.executionId,
		mainHead,
	);
	drainSources();
	const engineeringSession = store.getSession(engineering.body.executionId);
	const engineeringShip = await shipGate.computeEngineWorkflowShipPrecondition(
		store,
		engineering.body.executionId,
		mainHead,
	);
	record(
		"engineering_founder_claim_and_use_time_ship_gate",
		Boolean(engineeringSession) && engineeringShip.eligible === true,
	);

	const product = await postStart({
		issueId: "FLY-1281",
		projectName: PROJECT,
		leadId: LEAD,
		templateId: "tpl_product_v1",
		selectionReason: "FLY-1307 product materialization E2E",
		idempotencyKey: "fly1307-e2e-product",
	});
	record(
		"product_v2_selected_and_materialized",
		product.status === 200 && product.body.generalized === true,
	);
	const productRunId = product.body.workflowRunId;
	await waitFor(
		() =>
			store
				.listWorkflowMaterializationCandidates()
				.some((candidate) => candidate.runId === productRunId),
		45_000,
		"product output materialization candidate",
	);
	const materializer = new docsMaterializer.WorkflowDocsMaterializer({
		store,
		projects,
		withRepoLock: async (_root, fn) => fn(),
		git: new docsGit.GitWorkflowDocsGit({ remoteUrl: () => bareRemote }),
		log: (message) => console.warn(`[qa-materializer] ${message}`),
	});
	const materialized = await materializer.reconcile();
	record(
		"product_output_materialized_to_real_git_head",
		materialized.materialized === 1,
	);
	await waitFor(
		() =>
			store.getWorkflowRun(productRunId)?.current_node_id === "founder_gate",
		45_000,
		"product founder gate",
	);
	const productHead = store.getWorkflowMaterializedHead(
		productRunId,
		"produce",
	);
	record(
		"product_review_passes_on_exact_materialized_head",
		Boolean(productHead?.head) &&
			store.resolveWorkflowDecisionClaim({
				runId: productRunId,
				nodeId: "review",
				decisionKind: "review_verdict",
				subjectKind: "git_head",
				subjectDigest: productHead.head,
			}).valid === true,
	);
	writeFounderSource(
		productRunId,
		"FLY-1281",
		product.body.executionId,
		productHead.head,
	);
	drainSources();
	record(
		"product_founder_claim_terminalizes_same_head",
		store.getWorkflowRun(productRunId)?.status === "completed",
	);

	process.env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH = "0";
	const v2Off = await postStart({
		issueId: "FLY-1244",
		projectName: PROJECT,
		leadId: LEAD,
		templateId: "tpl_ops_light",
		selectionReason: "dispatch-off fail-closed sentinel",
		idempotencyKey: "fly1307-e2e-off-v2",
	});
	const offStore = await teamlead.StateStore.create(":memory:");
	templates.importBundledWorkflowSeeds(offStore, FLAGS_ON, () => {});
	templates.ensureDefaultWorkflowBindings(offStore, [PROJECT]);
	const v1Off = (
		await importFile(
			join(REPO, "packages/teamlead/dist/workflow-template-selection.js"),
		)
	).resolveWorkflowTemplateSelection(offStore, {
		project: PROJECT,
		issueId: "FLY-OFF-V1",
		taskCategory: "engineering",
		selectedBy: LEAD,
		actor: "master",
		authKind: "master",
		canonicalRoot,
		idempotencyKey: "fly1307-e2e-off-v1",
		env: { ...FLAGS_ON, FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "0" },
	});
	record(
		"dispatch_off_v1_is_exact_legacy_and_v2_is_fail_closed",
		v1Off === null &&
			v2Off.status === 409 &&
			v2Off.body.code === "GENERALIZED_WORKFLOW_REJECTED" &&
			store.getActiveWorkflowRunForIssue("FLY-1244") === undefined &&
			offStore.getActiveWorkflowRunForIssue("FLY-OFF-V1") === undefined,
	);
	offStore.close();
	process.env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH = "1";

	const beforeRestart = {
		engineeringEvents: store.listWorkflowRunEvents(engineeringRunId).length,
		productEvents: store.listWorkflowRunEvents(productRunId).length,
		spawns: physicalSpawnCount,
		cursor: store.getWorkflowSourceCursor(PROJECT),
	};
	await stopServer();
	store.close();
	store = await teamlead.StateStore.create(stateDbPath);
	await startServer();
	await sleep(1_500);
	const afterRestart = {
		engineeringEvents: store.listWorkflowRunEvents(engineeringRunId).length,
		productEvents: store.listWorkflowRunEvents(productRunId).length,
		spawns: physicalSpawnCount,
		cursor: store.getWorkflowSourceCursor(PROJECT),
	};
	record(
		"bridge_restart_replay_converges_without_duplicate_dispatch",
		JSON.stringify(afterRestart) === JSON.stringify(beforeRestart) &&
			store.getWorkflowRun(engineeringRunId)?.current_node_id ===
				"founder_gate" &&
			store.getWorkflowRun(productRunId)?.status === "completed",
	);

	const evidence = {
		issue: "FLY-1307",
		generated_at: new Date().toISOString(),
		harness: {
			bridge: "production createBridgeApp HTTP stack",
			state: "isolated teamlead.db + CommDB",
			spawn: "real TmuxAdapter gated fresh spawn with deterministic probe",
			tmux_rescue:
				"harness-local exact verify/create shim because sandbox denies production ps inspection",
			materialization:
				"production WorkflowDocsMaterializer + real local Git remote",
		},
		observed_flag_names: Object.keys(FLAGS_ON),
		spawn_count: physicalSpawnCount,
		spawn_records: spawnRecords,
		checks: results,
		pass:
			Object.keys(results).length > 0 && Object.values(results).every(Boolean),
	};
	writeFileSync(
		join(EVIDENCE_DIR, "template-dispatch-e2e.json"),
		`${JSON.stringify(evidence, null, "\t")}\n`,
	);
	if (!evidence.pass) process.exitCode = 1;
} catch (error) {
	console.error(
		`[qa] FAIL harness_error=${error instanceof Error ? error.stack : String(error)}`,
	);
	process.exitCode = 1;
} finally {
	workflowEngine?.stop();
	workflowEngine = undefined;
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
