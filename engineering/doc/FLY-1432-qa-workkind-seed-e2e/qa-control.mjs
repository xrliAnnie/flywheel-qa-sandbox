#!/usr/bin/env node
/**
 * FLY-1432 negative control for the flag-off 409 assertion.
 *
 * The main harness asserts that a direct schema-v2 selection over the real
 * Bridge HTTP stack returns 409 GENERALIZED_WORKFLOW_REJECTED while the
 * generalized flag is off. A 409 alone does not prove the flag gate caused it,
 * so this control replays the byte-identical request with the flag ON and
 * requires the outcome to change. It also proves the append-only audit triggers
 * survive the workflow_template_audit CHECK-constraint rebuild.
 */
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoArg = process.argv.indexOf("--repo");
if (repoArg < 0 || !process.argv[repoArg + 1]) {
	throw new Error("usage: qa-control.mjs --repo <detached-pinned-checkout>");
}
const REPO = realpathSync(process.argv[repoArg + 1]);
const PINNED_HEAD = "6a0576bd3ec3e9188ad6c012cfaf89711bf53692";
const PROJECT = "flywheel-e2e";
const LEAD = "flywheel-eng-lead";
const ROOT = mkdtempSync(join(tmpdir(), "qa-fly1432-control-"));
const MASTER_TOKEN = `fly1432-control-${process.pid}`;
const results = {};
const lines = [];

function log(m) {
	lines.push(m);
	console.log(m);
}
function record(key, pass, detail = "") {
	results[key] = Boolean(pass);
	log(`[ctl] ${pass ? "PASS" : "FAIL"} ${key}${detail ? ` — ${detail}` : ""}`);
}
const imp = (p) => import(pathToFileURL(p).href);

let server;
let store;
try {
	const head = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: REPO,
		encoding: "utf8",
	}).trim();
	record("control_runs_on_pinned_head", head === PINNED_HEAD, head);
	if (head !== PINNED_HEAD) throw new Error("pinned head mismatch");

	process.env.HOME = ROOT;
	process.env.FLYWHEEL_STATE_DIR = join(ROOT, "state");
	process.env.FLYWHEEL_COMM_ROOT = join(ROOT, "comm");
	process.env.FLYWHEEL_COMM_BACKEND = "commdb";
	process.env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH = "1";
	process.env.FLYWHEEL_WORKFLOW_CLAIMS_WRITE = "1";
	process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ = "1";
	process.env.BRIDGE_DEPT_SCOPE_REJECT = "0";
	// The control quadrant: generalized flag ON, everything else identical.
	process.env.FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES = "1";
	delete process.env.FLYWHEEL_THREE_STAGE;
	mkdirSync(process.env.FLYWHEEL_STATE_DIR, { recursive: true });
	mkdirSync(process.env.FLYWHEEL_COMM_ROOT, { recursive: true });
	mkdirSync(join(ROOT, ".flywheel"), { recursive: true });

	const teamlead = await imp(
		join(REPO, "packages/teamlead/dist/StateStore.js"),
	);
	const templates = await imp(
		join(REPO, "packages/teamlead/dist/workflow-template.js"),
	);
	const plugin = await imp(
		join(REPO, "packages/teamlead/dist/bridge/plugin.js"),
	);
	const admission = await imp(
		join(REPO, "packages/teamlead/dist/bridge/runner-admission.js"),
	);

	const projectRoot = join(ROOT, "project");
	mkdirSync(join(projectRoot, "agents"), { recursive: true });
	writeFileSync(join(projectRoot, "agents", "generic-executor.md"), "# stub\n");
	const g = (args) =>
		execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" });
	g(["init", "-q", "-b", "main"]);
	g(["config", "user.email", "qa@flywheel.local"]);
	g(["config", "user.name", "QA FLY-1432 control"]);
	g(["add", "-A"]);
	g(["commit", "-qm", "initial"]);
	const canonicalRoot = realpathSync(projectRoot);

	const dbPath = join(ROOT, "state", "control.db");
	store = await teamlead.StateStore.create(dbPath);
	for (const seed of templates.loadBundledWorkflowSeeds()) {
		store.importWorkflowTemplateSeed(seed, process.env);
	}

	// Control B: the audit table CHECK rebuild must not silently drop the
	// append-only triggers. Write one audit row, then attempt UPDATE + DELETE.
	store.bindWorkflowCategory({
		project: PROJECT,
		taskCategory: "*",
		templateId: "tpl_eng_heavy",
		updatedBy: "qa:control",
	});
	const auditRows = store.listWorkflowTemplateAudit();
	let updateBlocked = false;
	let deleteBlocked = false;
	try {
		store.db.run("UPDATE workflow_template_audit SET actor = 'tampered'");
	} catch (e) {
		updateBlocked = /append-only/.test(String(e));
	}
	try {
		store.db.run("DELETE FROM workflow_template_audit");
	} catch (e) {
		deleteBlocked = /append-only/.test(String(e));
	}
	record(
		"audit_append_only_triggers_survive_check_rebuild",
		auditRows.length > 0 && updateBlocked && deleteBlocked,
		`rows=${auditRows.length} update_blocked=${updateBlocked} delete_blocked=${deleteBlocked}`,
	);

	// Control A: byte-identical direct-select request, flag ON.
	let dispatcherStartCalls = 0;
	const dispatcher = {
		getInflightCount: () => 0,
		validateAgentName: () => ({ ok: true }),
		start: async () => {
			dispatcherStartCalls += 1;
			return { ok: true, sessionId: "control-session" };
		},
	};
	const app = plugin.createBridgeApp(
		store,
		[
			{
				projectName: PROJECT,
				projectRoot: canonicalRoot,
				leads: [
					{ agentId: LEAD, chatChannel: "qa-fly1432", match: { labels: [] } },
				],
			},
		],
		{
			host: "127.0.0.1",
			port: 0,
			dbPath,
			apiToken: MASTER_TOKEN,
			linearApiKey: process.env.LINEAR_API_KEY,
			notificationChannel: "qa-fly1432",
			defaultLeadAgentId: LEAD,
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300_000,
			orphanThresholdMinutes: 60,
			runnerAdmission: admission.RunnerAdmissionController.alwaysAdmit(),
		},
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
	await new Promise((r) => server.once("listening", r));
	const { port } = server.address();
	const res = await fetch(`http://127.0.0.1:${port}/api/runs/start`, {
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
			selectionReason: "FLY-1432 flag-ON control probe",
			idempotencyKey: "fly1432-direct-on-control",
		}),
	});
	const body = await res.json();
	record(
		"flag_on_same_request_is_not_generalized_rejected",
		body.code !== "GENERALIZED_WORKFLOW_REJECTED",
		`status=${res.status} code=${body.code ?? "<none>"}`,
	);
	writeFileSync(
		join(ROOT, "control.json"),
		JSON.stringify({ status: res.status, body }, null, 2),
	);
	log(
		`[ctl] flag-on response: ${JSON.stringify({ status: res.status, body })}`,
	);
	log(`[ctl] dispatcher_start_calls=${dispatcherStartCalls}`);

	const pass = Object.values(results).every(Boolean);
	log(`[ctl] control_pass=${pass}`);
	if (!pass) process.exitCode = 1;
} catch (error) {
	console.error(`[ctl] FAIL control_error=${error?.stack ?? error}`);
	process.exitCode = 1;
} finally {
	if (server) await new Promise((r) => server.close(() => r()));
	try {
		store?.close();
	} catch {}
	if (ROOT.startsWith(join(tmpdir(), "qa-fly1432-control-"))) {
		rmSync(ROOT, { recursive: true, force: true });
	}
}
