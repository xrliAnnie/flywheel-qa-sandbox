#!/usr/bin/env node
/**
 * FLY-1244 real-machine E2E + sanitized OS proof.
 *
 * Uses an isolated HOME/state DB/CommDB/git worktree and real production
 * TmuxAdapter windows. The runner executable is a deterministic local probe:
 * model quality is not under test; the fresh-spawn env boundary, dedicated
 * Bridge decision route, server-owned git head, claims reader, replay rules,
 * and re-QA attempt rollover are. Evidence contains booleans and key names
 * only — never credential values, heads, tokens, argv, or environment bodies.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const EVIDENCE_DIR = join(
	REPO,
	"engineering/doc/FLY-1244-enforcement-claims-templates/qa",
);
const REAL_HOME = process.env.HOME ?? "";
const ORIGINAL_PATH = process.env.PATH ?? "";
const ROOT = mkdtempSync(join(tmpdir(), "qa-fly1244-"));
const TMUX_SESSION = `qa-fly1244-${process.pid}`;
const ISSUE = "FLY-1244-E2E";
const PROJECT = "flywheel-e2e";
const results = {};

const record = (key, pass) => {
	results[key] = Boolean(pass);
	console.log(`[qa] ${pass ? "PASS" : "FAIL"} ${key}`);
};
const sh = (command, args, cwd) =>
	execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const importFile = (path) => import(pathToFileURL(path).href);

function directoryContainsKey(root, keys) {
	if (!root || !existsSync(root)) return false;
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const name of readdirSync(current)) {
			const path = join(current, name);
			let stat;
			try {
				stat = statSync(path);
			} catch {
				continue;
			}
			if (stat.isDirectory()) pending.push(path);
			else if (stat.isFile()) {
				try {
					const body = readFileSync(path, "utf8");
					if (keys.some((key) => body.includes(`${key}=`))) return true;
				} catch {}
			}
		}
	}
	return false;
}

async function waitForFile(path, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		await sleep(25);
	}
	return false;
}

let server;
let store;
try {
	mkdirSync(EVIDENCE_DIR, { recursive: true });

	// Platform/runner pin: if the measured environment changes, this proof must
	// be re-run and consciously re-baselined instead of silently staying green.
	record(
		"platform_macos_26_3_2",
		sh("sw_vers", ["-productVersion"]) === "26.3.2",
	);
	record(
		"runner_claude_2_1_210",
		sh("claude", ["--version"]).includes("2.1.210"),
	);
	record(
		"runner_codex_0_144_4",
		sh("codex", ["--version"]).includes("0.144.4"),
	);
	record("tmux_3_5a", sh("tmux", ["-V"]) === "tmux 3.5a");

	const snapshotRoots = [
		join(REAL_HOME, ".claude", "shell-snapshots"),
		join(REAL_HOME, ".codex", "shell_snapshots"),
	];
	record(
		"shell_snapshot_persists_runner_env_keys",
		snapshotRoots.some((root) =>
			directoryContainsKey(root, ["FLYWHEEL_EXEC_ID", "FLYWHEEL_BRIDGE_URL"]),
		),
	);

	const canary = `qa-fly1244-${process.pid}`;
	const sleeper = spawn("sleep", ["5"], {
		env: { ...process.env, QA_FLY1244_SECRET_CANARY: canary },
		stdio: "ignore",
	});
	await sleep(100);
	const psBody =
		spawnSync("ps", ["Eww", "-p", String(sleeper.pid)], {
			encoding: "utf8",
		}).stdout ?? "";
	sleeper.kill("SIGTERM");
	record("same_uid_ps_hides_spawn_env_value", !psBody.includes(canary));
	record(
		"node_net_has_no_peer_pid_credential",
		!("getPeerCredentials" in (await import("node:net")).Socket.prototype),
	);

	// Everything below is isolated from production state.
	process.env.HOME = ROOT;
	process.env.FLYWHEEL_STATE_DIR = join(ROOT, "state");
	process.env.FLYWHEEL_COMM_BACKEND = "commdb";
	mkdirSync(process.env.FLYWHEEL_STATE_DIR, { recursive: true });

	const runner = await importFile(
		join(REPO, "packages/claude-runner/dist/index.js"),
	);
	const teamlead = await importFile(
		join(REPO, "packages/teamlead/dist/StateStore.js"),
	);
	const template = await importFile(
		join(REPO, "packages/teamlead/dist/workflow-template.js"),
	);
	const routes = await importFile(
		join(REPO, "packages/teamlead/dist/bridge/workflow-decision-routes.js"),
	);
	const ship = await importFile(
		join(REPO, "packages/flywheel-comm/dist/ship-eligibility.js"),
	);
	const require = createRequire(join(REPO, "packages/teamlead/package.json"));
	const express = require("express");

	const repo = join(ROOT, "repo");
	const worktree = join(ROOT, "repo-worktree");
	mkdirSync(repo, { recursive: true });
	sh("git", ["init", "-q", "-b", "main"], repo);
	sh("git", ["config", "user.email", "qa@flywheel.local"], repo);
	sh("git", ["config", "user.name", "QA FLY-1244"], repo);
	writeFileSync(join(repo, "README.md"), "initial\n");
	sh("git", ["add", "-A"], repo);
	sh("git", ["commit", "-qm", "initial"], repo);
	sh("git", ["worktree", "add", "-q", "-b", "e2e", worktree], repo);
	const cwd = realpathSync(worktree);
	const head1 = sh("git", ["rev-parse", "HEAD"], cwd);

	const stateDbPath = join(ROOT, "state", "teamlead.db");
	const commDbPath = join(ROOT, "state", "comm.db");
	store = await teamlead.StateStore.create(stateDbPath);
	template.importBundledWorkflowSeeds(store);
	store.bindWorkflowCategory({
		project: PROJECT,
		taskCategory: "heavy",
		templateId: "tpl_eng_heavy",
		updatedBy: "e2e-lead",
	});
	store.materializeWorkflowRun({
		runId: "run-e2e",
		issueId: ISSUE,
		projectName: PROJECT,
		taskCategory: "heavy",
		claimsReadEnrolled: true,
		actor: "e2e-lead",
	});
	// Production decision routing resolves the reviewed producer from the
	// immutable workflow-run-node mapping, never from ambient session order.
	store.upsertWorkflowRunNode({
		runId: "run-e2e",
		nodeId: "implement",
		attempt: 1,
		state: "awaiting_review",
		executionId: "implement-e2e",
	});
	for (const [executionId, role, adapterType, status] of [
		["design-e2e", "design", "claude-tmux", "completed"],
		["implement-e2e", "implement", "codex-tmux", "awaiting_review"],
		["qa-e2e-1", "qa", "claude-tmux", "running"],
	]) {
		store.upsertSession({
			execution_id: executionId,
			issue_id: ISSUE,
			project_name: PROJECT,
			status,
			session_role: role,
			chat_thread_role: role,
			adapter_type: adapterType,
			runner_model: role === "qa" ? "claude-opus-4-8" : undefined,
			worktree_path: cwd,
			qa_required: role === "qa" ? 0 : undefined,
		});
	}
	const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
	const deadlineAt = new Date(Date.now() + 30 * 60_000).toISOString();
	const firstAdmission = store.admitWorkflowExecution({
		runId: "run-e2e",
		nodeId: "qa",
		executionId: "qa-e2e-1",
		attempt: 1,
		family: "qa_verdict",
		expiresAt,
		absoluteDeadlineAt: deadlineAt,
	});
	if (!firstAdmission.ok) throw new Error(firstAdmission.reason);

	const app = express();
	app.use(express.json());
	app.use("/api/workflow", routes.createWorkflowDecisionRouter({ store }));
	server = app.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const address = server.address();
	const workflowUrl = `http://127.0.0.1:${address.port}/api/workflow`;

	const binDir = join(ROOT, "bin");
	mkdirSync(binDir, { recursive: true });
	const helperPath = join(ROOT, "runner-helper.mjs");
	writeFileSync(
		helperPath,
		`import { writeFileSync } from "node:fs";\n` +
			`const keys=["FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL","FLYWHEEL_BRIDGE_URL","FLYWHEEL_STATE_DB_PATH"];\n` +
			`const proof={observed_keys:keys.filter((key)=>Boolean(process.env[key])),submission_credential_present:Boolean(process.env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL),shared_ingest_token_present:Boolean(process.env.FLYWHEEL_INGEST_TOKEN)};\n` +
			`let status=200; let response={ok:true,phase:process.env.QA_FLY1244_PHASE};\n` +
			`if(process.env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL){const body={credential:process.env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL,client_request_id:process.env.QA_FLY1244_REQUEST_ID,status:"pass",summary:"fresh-spawn qa pass",target_execution_id:"caller-selected-target-is-ignored"};const r=await fetch(process.env.FLYWHEEL_BRIDGE_URL+"/decision",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});status=r.status;response=await r.json();}\n` +
			`writeFileSync(process.env.QA_FLY1244_RESPONSE,JSON.stringify({status,response,proof}));\n`,
	);
	const claudeStub = join(binDir, "claude");
	writeFileSync(
		claudeStub,
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.210 (Claude Code)"; exit 0; fi\nexec node "$QA_FLY1244_HELPER"\n`,
	);
	chmodSync(claudeStub, 0o755);
	process.env.PATH = `${binDir}:${ORIGINAL_PATH}`;

	const spawnedWindows = [];
	async function spawnPhase({ phase, executionId, credential, requestId }) {
		const responsePath = join(ROOT, `${executionId}-response.json`);
		const transport = {
			buildRunnerSpawnConfig: () => ({
				args: [],
				env: {
					PATH: process.env.PATH,
					HOME: ROOT,
					QA_FLY1244_HELPER: helperPath,
					QA_FLY1244_PHASE: phase,
					QA_FLY1244_RESPONSE: responsePath,
					QA_FLY1244_REQUEST_ID: requestId,
				},
			}),
		};
		const hookServer = {
			getPort: () => 9,
			waitForCompletion: async (token, timeoutMs, expectedSessionId) => {
				const found = await waitForFile(responsePath, timeoutMs);
				return found
					? { token, sessionId: expectedSessionId, issueId: ISSUE }
					: null;
			},
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
			executionId,
			issueId: ISSUE,
			prompt: `FLY-1244 deterministic ${phase} fresh-spawn probe`,
			cwd,
			label: `${ISSUE}-${phase}-${executionId}`,
			projectName: PROJECT,
			leadId: "e2e-lead",
			agentName: `${phase}-agent`,
			teamName: "e2e-lead",
			vendor: "claude-code",
			bridgeUrl: workflowUrl,
			commDbPath,
			stateDbPath,
			workflowSubmissionCredential: credential,
			launchCommitPath: join(ROOT, "launch-commits", executionId),
			timeoutMs: 30_000,
			onTmuxWindowCreated: (info) => spawnedWindows.push(info.windowId),
		});
		if (!(await waitForFile(responsePath, 1_000))) {
			throw new Error(`runner response missing: ${phase}`);
		}
		return {
			outcome,
			payload: JSON.parse(readFileSync(responsePath, "utf8")),
		};
	}

	const designSpawn = await spawnPhase({
		phase: "design",
		executionId: "design-e2e",
		requestId: "design-no-verdict",
	});
	const implementSpawn = await spawnPhase({
		phase: "implement",
		executionId: "implement-e2e",
		requestId: "implement-no-verdict",
	});
	const qa1Spawn = await spawnPhase({
		phase: "qa",
		executionId: "qa-e2e-1",
		credential: firstAdmission.credential,
		requestId: "qa-pass-1",
	});
	record(
		"three_phase_real_tmux_fresh_spawn",
		spawnedWindows.length === 3 &&
			designSpawn.outcome.success &&
			implementSpawn.outcome.success &&
			qa1Spawn.outcome.success,
	);
	record(
		"submission_uses_scoped_credential_key",
		qa1Spawn.payload.proof.submission_credential_present &&
			qa1Spawn.payload.proof.observed_keys.includes(
				"FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
			),
	);
	record(
		"submission_omits_shared_ingest_token",
		qa1Spawn.payload.proof.shared_ingest_token_present === false,
	);
	record(
		"qa_claim_written_from_fresh_spawn",
		qa1Spawn.payload.status === 200 && qa1Spawn.payload.response.ok === true,
	);
	const firstClaim = store.getWorkflowClaim(qa1Spawn.payload.response.claimId);
	record(
		"server_selected_real_head_and_ignored_target",
		firstClaim?.subject_digest === head1 &&
			firstClaim?.subject_producer_execution_id === "implement-e2e",
	);

	const gateEnv = {
		FLYWHEEL_QA_DONE_GATE: "1",
		FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
		FLYWHEEL_WORKFLOW_FORCE_LEGACY: "0",
	};
	const h1Gate = ship.evaluateQaShipGate({
		execId: "qa-e2e-1",
		prHead: head1,
		stateDbPath,
		env: gateEnv,
	});
	record(
		"claims_ship_gate_accepts_current_head",
		h1Gate.passed && h1Gate.reason === "qa_claim_ok",
	);

	const exactBody = {
		credential: firstAdmission.credential,
		client_request_id: "qa-pass-1",
		status: "pass",
		summary: "fresh-spawn qa pass",
		target_execution_id: "caller-selected-target-is-ignored",
	};
	const replay = await fetch(`${workflowUrl}/decision`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(exactBody),
	}).then(async (response) => ({
		status: response.status,
		body: await response.json(),
	}));
	record(
		"exact_replay_is_idempotent",
		replay.status === 200 && replay.body.idempotentReplay === true,
	);
	const mismatch = await fetch(`${workflowUrl}/decision`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...exactBody, summary: "different replay payload" }),
	});
	record("mismatched_replay_is_rejected", mismatch.status === 409);
	const absent = await fetch(`${workflowUrl}/decision`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_request_id: "absent", status: "pass" }),
	});
	record(
		"missing_credential_is_rejected",
		absent.status === 400 || absent.status === 401,
	);

	writeFileSync(join(cwd, "head2.txt"), "next\n");
	sh("git", ["add", "head2.txt"], cwd);
	sh("git", ["commit", "-qm", "advance head"], cwd);
	const head2 = sh("git", ["rev-parse", "HEAD"], cwd);
	const staleGate = ship.evaluateQaShipGate({
		execId: "qa-e2e-1",
		prHead: head2,
		stateDbPath,
		env: gateEnv,
	});
	record("head_advance_invalidates_old_claim", !staleGate.passed);

	store.upsertSession({
		execution_id: "qa-e2e-2",
		issue_id: ISSUE,
		project_name: PROJECT,
		status: "running",
		session_role: "qa",
		chat_thread_role: "qa",
		adapter_type: "claude-tmux",
		runner_model: "claude-opus-4-8",
		worktree_path: cwd,
		qa_required: 0,
	});
	const secondAdmission = store.admitWorkflowExecution({
		runId: "run-e2e",
		nodeId: "qa",
		executionId: "qa-e2e-2",
		attempt: 2,
		family: "qa_verdict",
		expiresAt,
		absoluteDeadlineAt: deadlineAt,
	});
	if (!secondAdmission.ok) throw new Error(secondAdmission.reason);
	const fakeHead = "f".repeat(40);
	const headMismatch = await fetch(`${workflowUrl}/decision`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			credential: secondAdmission.credential,
			client_request_id: "qa-pass-2",
			status: "pass",
			client_pr_head_sha: fakeHead,
		}),
	});
	record("caller_selected_head_is_rejected", headMismatch.status === 409);
	const qa2Spawn = await spawnPhase({
		phase: "qa",
		executionId: "qa-e2e-2",
		credential: secondAdmission.credential,
		requestId: "qa-pass-2",
	});
	const h2Gate = ship.evaluateQaShipGate({
		execId: "qa-e2e-2",
		prHead: head2,
		stateDbPath,
		env: gateEnv,
	});
	record(
		"new_qa_attempt_restores_ship_eligibility",
		qa2Spawn.payload.status === 200 &&
			h2Gate.passed &&
			h2Gate.reason === "qa_claim_ok",
	);

	const tmuxEnv = spawnSync(
		"tmux",
		[
			"show-environment",
			"-t",
			`=${TMUX_SESSION}`,
			"FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
		],
		{ encoding: "utf8" },
	);
	record("tmux_session_environment_hides_credential", tmuxEnv.status !== 0);
	const paneCommands = spawnSync(
		"tmux",
		[
			"list-panes",
			"-a",
			"-t",
			`=${TMUX_SESSION}`,
			"-F",
			"#{pane_start_command}",
		],
		{ encoding: "utf8" },
	).stdout;
	record(
		"tmux_pane_argv_hides_credential_value",
		!paneCommands.includes(firstAdmission.credential) &&
			!paneCommands.includes(secondAdmission.credential),
	);

	const checks = Object.values(results);
	const evidence = {
		issue: "FLY-1244",
		generated_at: new Date().toISOString(),
		observed_key_names: [
			"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
			"FLYWHEEL_WORKFLOW_CLAIMS_READ",
			"FLYWHEEL_WORKFLOW_FORCE_LEGACY",
			"FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
		],
		known_accepted_residuals: {
			same_uid_shell_snapshot_can_expose_execution_scoped_credential: true,
			same_uid_active_tmux_injection_not_prevented: true,
			per_execution_bearer_is_not_os_isolation: true,
		},
		checks: results,
		pass: checks.length > 0 && checks.every(Boolean),
	};
	writeFileSync(
		join(EVIDENCE_DIR, "fresh-spawn-e2e.json"),
		`${JSON.stringify(evidence, null, "\t")}\n`,
	);
	if (!evidence.pass) process.exitCode = 1;
} catch (error) {
	console.error(
		`[qa] FAIL harness_error=${error instanceof Error ? error.message : "unknown"}`,
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
	rmSync(ROOT, { recursive: true, force: true });
}
