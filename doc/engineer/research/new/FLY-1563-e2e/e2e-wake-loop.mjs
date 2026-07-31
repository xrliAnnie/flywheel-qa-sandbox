#!/usr/bin/env node
// FLY-1563 real-machine E2E — the full four-step closed loop the founder asked
// for. On the WAKE PATH nothing polls: the runner and the lead block on their
// pane stdin and only the engine doorbell moves them. (This harness itself
// polls log files, and the runner stub waits on a marker file — that is test
// choreography around the scenario, not part of the wake path under test.)
// The four steps:
//
//   1. runner (REAL launcher-spawned tmux pane) sends `ask`
//   2. the engine doorbell WAKES the LEAD (real tmux pane located by the pid
//      its register-lead recorded — the FLY-1563 fix; before it the lead was
//      structurally excluded from the bell query)
//   3. the lead answers (enqueue ask_response, then settles the ask)
//   4. the MID-TASK runner (assignment deliberately unsettled) is woken by its
//      own bell and PULLS the answer — the FLY-1563 beyond-assignment fix;
//      before it this pull died on the "already handed" fence
//
// Plus: a codex-form session (bare TUI paste route, production shape today)
// woken by the same bell. Real pieces: tmux (isolated -L server), the real
// TmuxRunnerLauncher, the real V2Host + coordinator + doorbell, the real v2
// CLI. Only the vendor LLM binary is a stub (it acts through the CLI).
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"..",
);
const kernelMod = await import(`${WT}/packages/v2-kernel/dist/index.js`);
const dagMod = await import(`${WT}/packages/v2-dag/dist/index.js`);
const hostMod = await import(`${WT}/packages/v2-host/dist/index.js`);
const engineMod = await import(`${WT}/packages/v2-engine/dist/index.js`);

const {
	Kernel,
	migrateDatabase,
	seedPreCutoverAuthority,
	armCutoverAuthority,
	publishMigrationCompleteMarker,
	publishLiveCutoverAuthority,
	advanceDatabaseAuthorityStateTx,
} = kernelMod;
const { admitIssueDag } = dagMod;
const { initializeEngineDb, provisionAgentRecipient } = engineMod;
const {
	V2Host,
	TmuxRunnerLauncher,
	createRuntimeDagPorts,
	FileSessionEvidenceProbe,
	sendHostRequest,
} = hostMod;

const results = [];
let pass = true;
function check(name, ok, detail = "") {
	results.push({ name, ok, detail });
	pass = pass && ok;
	console.log(
		`[e2e] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`,
	);
}

const root = mkdtempSync("/tmp/fly1563-e2e-");
const WINDOW = "fly1563-e2e";
const EPOCH = 63;
const HOST_EPOCH = "fly1563-e2e-host";
const LEAD_ID = "e2e-lead";
const dbPath = join(root, "v2.db");
const markerPath = join(root, "marker.json");
const authorityPath = join(root, "authority.json");
const armedPath = join(root, "armed.json");
const socketPath = join(root, "host.sock");
const secretPath = join(root, "host.secret");
const proofRoot = join(root, "proofs");
const logDir = join(root, "logs");
const now = () => new Date().toISOString();
mkdirSync(logDir, { recursive: true });
mkdirSync(join(root, "state"), { recursive: true });

// --- isolated tmux server (NEVER the production one) -----------------------
const realTmux = execFileSync("/bin/sh", ["-c", "command -v tmux"], {
	encoding: "utf8",
}).trim();
const tmuxWrapper = join(root, "tmux-isolated.sh");
writeFileSync(tmuxWrapper, `#!/bin/sh\nexec ${realTmux} -L fly1563e2e "$@"\n`, {
	mode: 0o755,
});
const tmux = (...args) => execFileSync(tmuxWrapper, args, { encoding: "utf8" });
// A crashed previous run leaves the isolated server (and its sessions) alive.
try {
	tmux("kill-server");
} catch {}

// Isolate the v1 cmux side channels away from production.
process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE = join(
	root,
	"cmux-close-requests",
);
process.env.FLY1563_E2E_DIR = root;

// --- project fixture --------------------------------------------------------
const project = join(root, "project");
mkdirSync(join(project, ".flywheel", "agents", "nodes"), { recursive: true });
writeFileSync(
	join(project, ".flywheel", "agents", "nodes", "generic.md"),
	"# Generic e2e node\nAct through the v2 CLI only.\n",
);
for (const args of [
	["init", "-q"],
	["add", "."],
	[
		"-c",
		"user.name=E2E",
		"-c",
		"user.email=e2e@example.invalid",
		"commit",
		"-qm",
		"fixture",
	],
]) {
	execFileSync("/usr/bin/git", ["-C", project, ...args]);
}

// --- database + authority (the FLY-1547 e2e bootstrap pattern) --------------
seedPreCutoverAuthority({
	authorityPath,
	armedPath,
	windowId: WINDOW,
	epoch: EPOCH,
	nowIso: now(),
});
armCutoverAuthority({
	authorityPath,
	armedPath,
	windowId: WINDOW,
	epoch: EPOCH,
	nowIso: now(),
});
migrateDatabase({ path: dbPath });
let kernel = Kernel.open({ path: dbPath });
initializeEngineDb(kernel);
kernel.write("e2e.meta", (tx) => {
	for (const [key, value] of [
		["cutover_window_id", WINDOW],
		["cutover_epoch", String(EPOCH)],
	]) {
		tx.run(
			`INSERT INTO meta(key,value,updated_at) VALUES(@key,@value,@now)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
			{ key, value, now: now() },
		);
	}
});
kernel.close();
chmodSync(dbPath, 0o600);
publishMigrationCompleteMarker({
	dbPath,
	markerPath,
	authorityPath,
	armedPath,
	expectedWindowId: WINDOW,
	expectedEpoch: EPOCH,
	nowIso: now(),
});
kernel = Kernel.open({ path: dbPath });
kernel.write("e2e.live", (tx) =>
	advanceDatabaseAuthorityStateTx(tx, {
		expected: "cutover",
		next: "live",
		nowIso: now(),
	}),
);
kernel.close();
publishLiveCutoverAuthority({
	authorityPath,
	armedPath,
	windowId: WINDOW,
	epoch: EPOCH,
	nowIso: now(),
});

const secret = randomBytes(32);
writeFileSync(secretPath, secret, { mode: 0o600 });

// --- real launcher, stub vendor binaries ------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const stubRunner = join(here, "stub-runner.sh");
const clientCli = `${WT}/packages/v2-cli/dist/cli.js`;
const launcher = new TmuxRunnerLauncher({
	hostEpoch: HOST_EPOCH,
	tmuxBin: tmuxWrapper,
	claudeBin: stubRunner,
	codexBin: stubRunner,
	clientCliPath: clientCli,
	socketPath,
	secretPath,
	sessionProofRoot: proofRoot,
	releaseRoot: join(root, "release"),
	stateRoot: join(root, "runner-state"),
	cmuxEventFilePath: join(root, "cmux-events"),
});

const host = new V2Host({
	database: {
		dbPath,
		markerPath,
		authorityPath,
		armedPath,
		expectedWindowId: WINDOW,
		expectedEpoch: EPOCH,
		allowedAuthorityStates: ["live"],
	},
	socketPath,
	secretPath,
	hostEpoch: HOST_EPOCH,
	sessionProbe: new FileSessionEvidenceProbe(proofRoot),
	coordinator: {
		intervalMs: 1000,
		createPorts: (k) =>
			createRuntimeDagPorts({
				kernel: k,
				hostEpoch: HOST_EPOCH,
				expectedEpoch: EPOCH,
				lockRoot: join(root, "locks"),
				launcher,
				gitBin: "/usr/bin/git",
				ghBin: "/usr/bin/false",
			}),
		activateSession: (sessionRef) => launcher.activate(sessionRef),
	},
});
await host.start();
console.log("[e2e] host up at", socketPath, "root:", root);

// --- the LEAD: a real tmux pane, registered by ITS pid ----------------------
const credFile = join(root, "state", "e2e-lead-credential.json");
tmux(
	"new-session",
	"-d",
	"-s",
	"fly1563-e2e-lead",
	"-e",
	`FLY1563_E2E_DIR=${root}`,
	"-e",
	`FLY1563_E2E_LEAD_CRED=${credFile}`,
	"-e",
	`FLY1563_E2E_LEAD_ID=${LEAD_ID}`,
	"-e",
	`FLYWHEEL_V2_CLIENT_CLI=${clientCli}`,
	"-e",
	`FLYWHEEL_V2_SOCKET=${socketPath}`,
	"-e",
	`FLYWHEEL_V2_SECRET_PATH=${secretPath}`,
	"-e",
	`PATH=${process.env.PATH}`,
	"/bin/bash",
	join(here, "stub-lead.sh"),
);
const leadPanePid = Number(
	tmux(
		"display-message",
		"-p",
		"-t",
		"=fly1563-e2e-lead:0.0",
		"#{pane_pid}",
	).trim(),
);
console.log("[e2e] lead pane pid:", leadPanePid);
// The host lives in THIS process — the registration subprocess must run
// async or the blocked event loop deadlocks its own IPC request.
const registerOut = await execFileAsync(
	process.execPath,
	[
		clientCli,
		"register-lead",
		"--socket",
		socketPath,
		"--secret",
		secretPath,
		"--agent",
		LEAD_ID,
		"--instance",
		"e2e-lead-1",
		"--host-epoch",
		HOST_EPOCH,
		"--session-id",
		"fly1563-e2e-lead",
		"--session-proof-root",
		proofRoot,
		"--pid",
		String(leadPanePid),
		"--delivery-credential-out",
		credFile,
	],
	{ encoding: "utf8" },
);
console.log("[e2e] lead registered:", registerOut.stdout.trim().slice(0, 120));

// --- admit both issues (claude loop + codex wake) ----------------------------
const bootstrap = Kernel.open({ path: dbPath });
provisionAgentRecipient(bootstrap, LEAD_ID, "lead");
const bootstrapPorts = createRuntimeDagPorts({
	kernel: bootstrap,
	hostEpoch: HOST_EPOCH,
	expectedEpoch: EPOCH,
	lockRoot: join(root, "locks"),
	launcher,
	gitBin: "/usr/bin/git",
	ghBin: "/usr/bin/false",
});
function descriptor(issueId, vendor, worktreeId) {
	return {
		admissionUid: `e2e-${issueId}`,
		projectId: "fly1563-e2e",
		issueId,
		issueTitle: `e2e ${vendor} wake`,
		notifyAgentId: LEAD_ID,
		shipWorktreeId: worktreeId,
		worktrees: [
			{
				worktreeId,
				repoIdentity: project,
				worktreePath: project,
				branchRef: "HEAD",
				mergeTargetRef: "HEAD",
			},
		],
		tasks: [
			{
				localId: "work",
				kindLabel: "generic",
				contract: [{ kind: "verdict" }],
				writesRepo: true,
				worktreeId,
				executor: {
					family: vendor,
					vendor,
					model: "e2e-model",
					effort: "high",
				},
			},
		],
		edges: [],
	};
}
await admitIssueDag(
	bootstrap,
	bootstrapPorts,
	descriptor("FLY-E2E-WAKE", "claude", "wt-claude"),
);
await admitIssueDag(
	bootstrap,
	bootstrapPorts,
	descriptor("FLY-E2E-CODEX", "codex", "wt-codex"),
);
bootstrap.close();

// --- wait for the loop to close ----------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + 180_000;
const runnerLog = join(logDir, "runner-claude.log");
const codexLog = join(logDir, "runner-codex.log");
const leadLog = join(logDir, "lead.log");
const readLog = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

// Step-2 hardening: let the lead drain the admission lifecycle mail and go
// fully idle (NEXT_EMPTY, blocked on its pane stdin) BEFORE the runner asks —
// the wake that follows is then attributable to the ask alone.
while (Date.now() < deadline && !readLog(leadLog).includes("NEXT_EMPTY")) {
	await sleep(1000);
}
const leadIdleAt = now();
writeFileSync(join(root, "state", "lead-idle.marker"), leadIdleAt);
console.log("[e2e] lead observed idle at", leadIdleAt, "— releasing the ask");

// Step 4 gate: runner settled its assignment after receiving the reply.
while (
	Date.now() < deadline &&
	!readLog(runnerLog).includes("ASSIGNMENT_SETTLED")
) {
	await sleep(1000);
}
// Codex wake gate needs its session to exist first, then a letter to it.
let codexSessionRef = "";
{
	const inspect = Kernel.open({ path: dbPath });
	codexSessionRef =
		inspect.read((tx) =>
			tx.get(
				`SELECT act.session_ref AS ref FROM activations act
				  JOIN attempts a ON a.id=act.attempt_id
				  JOIN tasks t ON t.id=a.task_id
				 WHERE t.external_issue_id='FLY-E2E-CODEX' AND act.state='active'`,
			),
		)?.ref ?? "";
	inspect.close();
}
if (codexSessionRef) {
	await sendHostRequest({
		socketPath,
		secret,
		action: "enqueue",
		payload: {
			sourceKind: "e2e_codex_wake",
			sourceId: "codex-wake-1",
			payload: JSON.stringify({ v: 1, body: "codex wake probe" }),
			toAgent: codexSessionRef,
			kind: "instruction",
			retentionClass: "business",
		},
	});
	console.log("[e2e] codex wake letter enqueued to", codexSessionRef);
}
while (
	Date.now() < deadline &&
	!readLog(codexLog).includes("CODEX_WAKE_COMPLETE")
) {
	await sleep(1000);
}

// --- assertions ---------------------------------------------------------------
const runner = readLog(runnerLog);
const lead = readLog(leadLog);
const codex = readLog(codexLog);
console.log("\n[e2e] ---- runner-claude.log ----\n" + runner);
console.log("[e2e] ---- lead.log ----\n" + lead);
console.log("[e2e] ---- runner-codex.log ----\n" + codex);

check(
	"step1: runner sent ask while HOLDING its unsettled assignment",
	runner.includes("ASK_SENT") &&
		runner.indexOf("ASSIGNMENT_HELD") < runner.indexOf("ASK_SENT"),
);
const idleIdx = lead.indexOf("NEXT_EMPTY");
const askIdx = lead.indexOf("kind=runner_ask");
check(
	"step2: IDLE lead (drained to NEXT_EMPTY, blocked on stdin) was woken by a fresh bell",
	idleIdx >= 0 &&
		askIdx > idleIdx &&
		lead.slice(idleIdx, askIdx).includes("BELL_SEEN"),
);
check(
	"step2b: lead received the runner_ask only after that post-idle wake",
	askIdx > idleIdx && idleIdx >= 0,
);
check(
	"step3: lead answered (reply enqueued BEFORE settling the ask)",
	lead.includes("REPLY_ENQUEUED") &&
		lead.indexOf("REPLY_ENQUEUED") < lead.indexOf("SETTLED kind=runner_ask"),
);
check(
	"step4: MID-TASK runner was woken and pulled the reply past its open assignment",
	runner.includes("BELL_SEEN") && runner.includes("REPLY_RECEIVED"),
);
check(
	"step4b: runner settled its assignment only AFTER the reply",
	runner.indexOf("REPLY_RECEIVED") < runner.indexOf("ASSIGNMENT_SETTLED"),
);
check(
	"codex: bare-TUI codex-form session woken by the same bell and drained its letter",
	codex.includes("BELL_SEEN") && codex.includes("CODEX_WAKE_COMPLETE"),
);

// Durable wake records: session_bell_rung for lead (lead_paste) AND runners.
const inspect = Kernel.open({ path: dbPath });
const bellEvents = inspect.read((tx) =>
	tx.all(
		`SELECT source_id, payload, created_at FROM events
		  WHERE kind='session_bell_rung' ORDER BY created_at`,
	),
);
inspect.close();
console.log("[e2e] session_bell_rung events:");
for (const event of bellEvents) {
	console.log("   ", event.created_at, event.source_id, event.payload);
}
check(
	"durable wake record: lead bell rung via lead_paste channel",
	bellEvents.some(
		(event) =>
			event.source_id === LEAD_ID && event.payload.includes('"lead_paste"'),
	),
);
check(
	"durable wake record: runner session bells rung via paste_pointer",
	bellEvents.some(
		(event) =>
			event.source_id.startsWith("v2dag:") &&
			event.payload.includes('"paste_pointer"'),
	),
);

// --- timeline -----------------------------------------------------------------
function stamps(text, tag) {
	return text
		.split("\n")
		.filter((line) => line.includes(tag))
		.map((line) => line.slice(0, 24));
}
const timeline = [
	["t0 runner ASK_SENT", stamps(runner, "ASK_SENT")[0]],
	["t1 lead BELL_SEEN (wake)", stamps(lead, "BELL_SEEN")],
	["t2 lead runner_ask RECEIVED", stamps(lead, "kind=runner_ask")[0]],
	["t3 lead REPLY_ENQUEUED", stamps(lead, "REPLY_ENQUEUED")[0]],
	["t4 runner BELL_SEEN (wake)", stamps(runner, "BELL_SEEN")],
	["t5 runner REPLY_RECEIVED", stamps(runner, "REPLY_RECEIVED")[0]],
	["t6 runner ASSIGNMENT_SETTLED", stamps(runner, "ASSIGNMENT_SETTLED")[0]],
	["tc codex CODEX_WAKE_COMPLETE", stamps(codex, "CODEX_WAKE_COMPLETE")[0]],
];
console.log("\n[e2e] ---- timeline ----");
for (const [label, value] of timeline)
	console.log(`  ${label}: ${JSON.stringify(value)}`);

// --- cleanup ------------------------------------------------------------------
try {
	tmux("kill-server");
} catch {}
await host.close();
console.log(pass ? "\n[e2e] ALL PASS" : "\n[e2e] FAILURES PRESENT");
console.log("[e2e] artifacts under", root);
process.exit(pass ? 0 : 1);
