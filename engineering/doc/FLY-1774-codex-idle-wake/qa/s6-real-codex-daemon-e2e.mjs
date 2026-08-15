// FLY-1774 QA S6 — REAL machine acceptance:
//   real `codex app-server` daemon + real CodexDaemonClient + real
//   CodexPhaseLifecycleController + real CommDB + real `flywheel-comm send`
//   + real RunnerMailboxLane batch envelope + real notify-hook sweep.
// Asserts: a Codex runner that finished its goal and parked wakes up BY ITSELF
// and executes the Lead's instruction — zero tmux keystrokes.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
const { default: Database } = await import("/Users/xiaorongli/Dev/flywheel-FLY-1774/node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3/lib/index.js");

const ROOT = "/Users/xiaorongli/Dev/flywheel-FLY-1774";
const D = process.argv[2];
const CODEX_BIN = process.env.CODEX_BIN ?? "/Users/xiaorongli/.local/bin/codex";
const CLI = `${ROOT}/packages/flywheel-comm/dist/index.js`;
const HOOK = process.env.QA_HOOK ?? `${ROOT}/scripts/hooks/runner-stop-notify.sh`;
const BEFORE = process.env.QA_BEFORE === "1";

const { spawnCodexDaemon } = await import(`${ROOT}/packages/claude-runner/dist/codex-daemon-runtime.js`);
const { connectDaemonTransport } = await import(`${ROOT}/packages/claude-runner/dist/codex-daemon-transport.js`);
const { CodexDaemonClient, runGoalToTerminal } = await import(`${ROOT}/packages/claude-runner/dist/codex-daemon-client.js`);
const { CodexPhaseLifecycleController } = await import(`${ROOT}/packages/claude-runner/dist/codex-phase-lifecycle.js`);
const { CommDB } = await import(`${ROOT}/packages/flywheel-comm/dist/db.js`);

let pass = 0, fail = 0;
const ck = (n, ok, d = "") => { ok ? (pass++, console.log(`  PASS ${n}${d ? " — " + d : ""}`)) : (fail++, console.log(`  FAIL ${n} — ${d}`)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

const codexHome = join(D, "ch");
const socketPath = join(D, "sock", "c.sock");
const work = join(D, "work");
const dbPath = join(D, "comm.db");
const statePath = join(D, "session.json");
const execId = randomUUID();
writeFileSync(join(work, "README.md"), "qa scratch\n");
writeFileSync(statePath, JSON.stringify({ v: 1 }));

// ── real CommDB session registration with the phase capability ────────────
{
  const db = new CommDB(dbPath);
  db.registerSession(execId, `qa:${execId}`, "flywheel", "FLY-1774", "qa-lead", "codex", true);
  db.assertPhaseKeepAliveSessionRunning(execId);
  db.close();
}
log("execId", execId);

// ── spawn the REAL codex daemon ───────────────────────────────────────────
log("spawning real codex app-server daemon…");
const daemon = await spawnCodexDaemon({
  codexBin: CODEX_BIN, codexHome, socketPath,
  sandboxWritableRoots: [work, D], sandboxNetworkAccess: true,
  appsDefaultToolsApprovalMode: "approve",
  // Mirrors the production adapter env (CodexTmuxAdapter:1437/1457) so the
  // woken agent can actually read its own mailbox, exactly as in production.
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: join(D, "tmp"),
         FLYWHEEL_EXEC_ID: execId, FLYWHEEL_COMM_DB: dbPath, FLYWHEEL_COMM_CLI: CLI },
  logger: (m) => log("daemon:", m),
});
ck("S6.0 real codex daemon is listening", existsSync(socketPath), socketPath);

const transport = await connectDaemonTransport({ socketPath });
const client = new CodexDaemonClient({ transport, logger: (m) => log("client:", m) });
await client.initialize();
log("daemon client initialized");

const threadId = await client.startThread({ cwd: work, sandbox: "workspace-write", approvalPolicy: "never",
  baseInstructions: `You are a Flywheel Runner. Your mailbox CLI is: node $FLYWHEEL_COMM_CLI <command>. Whenever a message tells you to run 'flywheel-comm <args>', that means: node $FLYWHEEL_COMM_CLI <args>. Your execution id is in $FLYWHEEL_EXEC_ID. Always obey instructions you read from your mailbox.` });
log("threadId", threadId);

// ── real phase lifecycle controller on the real CommDB ────────────────────
const phase = new CodexPhaseLifecycleController({
  executionId: execId, role: "implement", commDbPath: dbPath,
  sessionStatePath: statePath, mailboxAgentName: execId, watcher: null,
});
await phase.start();

// ── observability: watch the real thread for the injected wake turn ───────
const seen = [];
const turnsStarted = [];
const origStartTurn = client.startTurn.bind(client);
client.startTurn = async (tid, text, timeout) => { turnsStarted.push(text); log("turn/start <-", String(text).slice(0, 160)); return origStartTurn(tid, text, timeout); };

let runResult = null, runErr = null;
const goal = "Your only objective: create a file named done.txt in the current directory containing the single word READY, then stop. Do not do anything else.";
const runP = runGoalToTerminal(client, {
  threadId, objective: goal,
  kickText: "Begin now. Create done.txt with READY, then end your turn.",
  overallTimeoutMs: 12 * 60_000,
  phaseLifecycle: phase,
  phaseControlPollIntervalMs: 3_000,
  pollIntervalMs: 5_000,
}, { onEvent: (e) => { seen.push(e); if (seen.length < 40) log("evt:", JSON.stringify(e).slice(0, 400)); } })
  .then(r => { runResult = r; log("run finished", JSON.stringify(r)); }).catch(e => { runErr = e; log("run error", e.message); });

// ── wait for the runner to finish its goal and PARK (phase hold) ──────────
log("waiting for goal completion -> phase hold…");
const holdDeadline = Date.now() + 10 * 60_000;
let held = false;
while (Date.now() < holdDeadline && !runResult && !runErr) {
  const st = JSON.parse(readFileSync(statePath, "utf8"));
  if (st.phaseHold && st.phaseHold.state !== "reactivating") { held = true; break; }
  await sleep(2000);
}
ck("S6.1 real Codex runner completed its goal and PARKED (phase hold)", held,
   held ? JSON.stringify(JSON.parse(readFileSync(statePath, "utf8")).phaseHold) : `runResult=${JSON.stringify(runResult)} err=${runErr?.message}`);
if (!held) { await teardown(); process.exit(1); }

const turnsBefore = turnsStarted.length;
const doneBefore = existsSync(join(work, "wake-proof.txt"));
ck("S6.1b negative precondition: no wake-proof file yet", !doneBefore);

// ── NEGATIVE CONTROL: parked with an EMPTY mailbox, nothing must happen ───
log("negative control: 45s parked with no unread mail…");
runHook();
await sleep(45_000);
{
  const d = new Database(dbPath);
  const w = d.prepare("SELECT COUNT(*) n FROM runner_phase_wakes WHERE execution_id = ?").get(execId).n;
  d.close();
  ck("S6.2 NEGATIVE: parked Codex with no unread mail is never disturbed", w === 0 && turnsStarted.length === turnsBefore,
     `wakes=${w} turnsDelta=${turnsStarted.length - turnsBefore}`);
}

// ── THE ACCEPTANCE: Lead sends mail; runner must wake by itself ───────────
log("Lead sends a real `flywheel-comm send` instruction…");
const t0 = Date.now();
const { resolveLeadIdentity } = await import(`${ROOT}/packages/flywheel-comm/dist/lead-identity.js`);
const leadHome = join(D, "lead-home");
const projectsPath = join(D, "projects.json");
const leadIdentity = resolveLeadIdentity({ projectsPath, projectName: "qa1774", leadId: "qa1774-lead", homeDir: leadHome });
const leadEnv = {
  PATH: process.env.PATH, HOME: leadHome,
  FLYWHEEL_PROJECTS_FILE: projectsPath,
  FLYWHEEL_PROJECT_NAME: "qa1774",
  FLYWHEEL_LEAD_ID: "qa1774-lead",
  FLYWHEEL_LEAD_KEY: leadIdentity.leadKey,
  FLYWHEEL_LEAD_BACKEND: leadIdentity.backend,
  DISCORD_STATE_DIR: leadIdentity.discordStateDir,
  DISCORD_EXPECTED_BOT_USER_ID: leadIdentity.botUserId ?? "",
  FLYWHEEL_LEAD_IDENTITY_DIGEST: leadIdentity.identityDigest,
  FLYWHEEL_COMM_DB: dbPath,
};
const sendOut = execFileSync("node", [CLI, "send", "--db", dbPath, "--to", execId, "--from", "qa1774-lead",
  "--", "New instruction from your Lead: create a file named wake-proof.txt in the current working directory containing the single word WOKE. Do it now, then end your turn."],
  { encoding: "utf8", env: leadEnv });
log("send ->", sendOut.trim());
// The Bridge lane leg is a separate process in production; here the durable row
// exists and the turn-end notify sweep is what a parked runner has available.
runHook();

log("waiting for the runner to wake up BY ITSELF…");
let wokeMs = null;
const wakeDeadline = Date.now() + (BEFORE ? 90_000 : 5 * 60_000);
while (Date.now() < wakeDeadline) {
  if (turnsStarted.length > turnsBefore && /\[phase-wake doorbell:/.test(turnsStarted[turnsStarted.length - 1] ?? "")) { wokeMs = Date.now() - t0; break; }
  await sleep(1000);
}
ck(BEFORE ? "B1 BEFORE-BASELINE: pre-fix hook leaves the parked Codex asleep (the bug)" : "S6.3 ACCEPTANCE: parked Codex woke itself and was handed the doorbell (zero tmux input)",
   BEFORE ? wokeMs === null : wokeMs !== null, wokeMs !== null ? `woke in ${(wokeMs / 1000).toFixed(1)}s: ${turnsStarted[turnsStarted.length - 1].slice(0, 120)}` : "never woke");
if (!BEFORE) ck("S6.3b woke within the 60s acceptance budget", wokeMs !== null && wokeMs <= 60_000, `${wokeMs === null ? "n/a" : (wokeMs / 1000).toFixed(1) + "s"}`);

// ── the runner must actually EXECUTE the instruction it fetched itself ────
log("waiting for the runner to execute the instruction (reads its own mailbox)…");
let executed = false;
const execDeadline = Date.now() + (BEFORE ? 60_000 : 6 * 60_000);
while (Date.now() < execDeadline) {
  if (existsSync(join(work, "wake-proof.txt"))) { executed = true; break; }
  await sleep(2000);
}
ck(BEFORE ? "B1b BEFORE-BASELINE: instruction is never executed (human /goal poke required)" : "S6.4 the woken runner READ its own mailbox and executed the Lead instruction", BEFORE ? !executed : executed,
   executed ? readFileSync(join(work, "wake-proof.txt"), "utf8").trim() : "wake-proof.txt never appeared");
{
  const d = new Database(dbPath);
  const mb = d.prepare("SELECT state, acked_at FROM mailbox WHERE to_agent = ?").all(execId);
  const wk = d.prepare("SELECT message_id, state FROM runner_phase_wakes WHERE execution_id = ?").all(execId);
  d.close();
  console.log("  mailbox:", JSON.stringify(mb));
  console.log("  wakes  :", JSON.stringify(wk));
  ck("S6.5 the AGENT is the only ACKer (mailbox settled by the runner, not the doorbell leg)",
     BEFORE ? mb.every(m => m.state === "QUEUED") : (executed ? mb.some(m => m.state === "ACKED") : true), JSON.stringify(mb));
  ck(BEFORE ? "B1c BEFORE-BASELINE: zero wakes were ever enqueued" : "S6.5b exactly one doorbell wake was ever created", BEFORE ? wk.length === 0 : wk.length === 1, `n=${wk.length}`);
}

function runHook() {
  try {
    execFileSync("bash", [HOOK, "--codex", JSON.stringify({ type: "agent-turn-complete", client: "codex-tui", "turn-id": randomUUID() })],
      { encoding: "utf8", env: { ...process.env, FLYWHEEL_EXEC_ID: execId, FLYWHEEL_COMM_CLI: CLI, FLYWHEEL_COMM_DB: dbPath,
        FLYWHEEL_RUNNER_STATE_DIR: join(D, "rstate"), HOME: D } });
  } catch (e) { log("hook error (fail-open)", e.message); }
}
async function teardown() {
  try { await phase.stop(); } catch {}
  try { transport.close?.(); } catch {}
  try { daemon.stop(); await daemon.ensureDead(); } catch {}
}
console.log(`\nS6 real-codex-e2e: passed=${pass} failed=${fail}`);
await teardown();
process.exit(fail === 0 ? 0 : 1);
