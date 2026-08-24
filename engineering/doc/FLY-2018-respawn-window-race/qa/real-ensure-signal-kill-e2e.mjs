// FLY-2018 independent QA: real-machine reproduction of the production incident
// (helper prints a success ensure action, then dies by an EXTERNAL signal).
//
// Everything below is real: a real tmux server on an isolated socket, a real
// child process killed by a real SIGTERM, and the real production
// `ensureRunnerTuiWindow` -> `defaultEnsureSessionAsync` -> `spawnCommandAsync`
// -> `tmux has-session` chain loaded from the built dist. Only the rescue CLI
// binary is a stand-in, because the incident's distinguishing input is the
// helper's exit shape, not which binary produced it.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/tmp/f2018q";
const HOME = join(ROOT, "home");
const SOCK = join(ROOT, "s");
const CLI = join(HOME, ".flywheel", "bin", "tmux-server-rescue");
const SESSION = `qa2018-${process.pid}`;

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(HOME, ".flywheel", "bin"), { recursive: true });

process.env.HOME = HOME;
process.env.FLYWHEEL_TMUX_SOCKET_OVERRIDE = SOCK;
process.env.FLYWHEEL_TMUX_ENSURE_DEADLINE_MS = "20000";
process.env.FLYWHEEL_TMUX_ENSURE_ATTEMPT_TIMEOUT_MS = "8000";

// FLY2018_TUI_MODULE lets the SAME harness drive the pre-fix baseline build,
// so the RED/GREEN comparison changes only the code under test.
const MODULE =
  process.env.FLY2018_TUI_MODULE ??
  "../../../../packages/claude-runner/dist/codex-runner-tui-window.js";
console.log(`[harness] module under test: ${MODULE}`);
const { ensureRunnerTuiWindow } = await import(MODULE);

function tmux(args) {
  return spawnSync("tmux", ["-S", SOCK, ...args], { encoding: "utf8" });
}

// A REAL tmux server + session so that the production re-verify
// (`tmux -S <sock> has-session -t =<session>`) has real ground truth to read.
tmux(["new-session", "-d", "-s", SESSION, "sleep", "600"]);
const liveCheck = tmux(["has-session", "-t", `=${SESSION}`]);
if (liveCheck.status !== 0) throw new Error("QA harness could not create a real tmux session");
const serverPid = Number(
  tmux(["display-message", "-p", "#{pid}"]).stdout.trim(),
);
if (!Number.isSafeInteger(serverPid) || serverPid <= 0) {
  throw new Error("QA harness could not read the real tmux server pid");
}
console.log(`[harness] real tmux server pid=${serverPid} socket=${SOCK} session=${SESSION}`);

function writeHelper(kind) {
  // kind=success   : the exact incident stdout, then death by EXTERNAL SIGTERM.
  // kind=garbage   : non-success stdout, then the same external SIGTERM.
  const body =
    kind === "success"
      ? `printf '{"action":"verified","reachablePid":${serverPid}}'\n`
      : `printf 'tmux-server-rescue: unparseable\\n'\n`;
  writeFileSync(
    CLI,
    `#!/bin/sh\n${body}# die by a real external-style signal, NOT by exit code\nkill -TERM $$\nsleep 5\n`,
    { mode: 0o755 },
  );
  chmodSync(CLI, 0o755);
}

async function runCase(name, { helper, session }) {
  writeHelper(helper);
  const logs = [];
  const outcome = await ensureRunnerTuiWindow(
    {
      tmuxSession: session,
      windowName: "FLY-2018-qa",
      codexHome: join(ROOT, "codex-home"),
      socketPath: join(ROOT, "c.sock"),
      cwd: ROOT,
      threadId: "qa-thread",
      executionId: "qa-exec",
    },
    {
      log: (m) => logs.push(m),
      // Window-creation seams are stubbed; the subject under test is the
      // guarded session ensure that precedes them.
      execAsync: async () => ({ ok: true }),
      execOutAsync: async () => "",
      sleepAsync: async () => {},
    },
  );
  const held = logs.some((l) => /guarded tmux session ensure held/.test(l));
  const reverified = logs.some((l) => /succeeded despite exit anomaly/.test(l));
  console.log(`\n=== ${name} ===`);
  for (const l of logs) console.log(`  | ${l}`);
  console.log(`  -> outcome=${JSON.stringify(outcome?.status ?? outcome)} held=${held} reverified=${reverified}`);
  return { held, reverified, logs, outcome };
}

const results = {};
try {
  // A: the production incident, verbatim — helper reported `verified`, then an
  //    external signal killed it. Expect: re-verified, ensure NOT held.
  results.A = await runCase("A incident replay (helper verified + external SIGTERM + live session)", {
    helper: "success",
    session: SESSION,
  });
  // B: negative control — same helper claim, but the session does NOT exist.
  //    Proves the re-verify reads reality instead of trusting stdout.
  results.B = await runCase("B negative control (helper verified + external SIGTERM + NO such session)", {
    helper: "success",
    session: `${SESSION}-absent`,
  });
  // C: regression control — unparseable stdout keeps the pre-fix held path.
  results.C = await runCase("C regression control (garbage stdout + external SIGTERM)", {
    helper: "garbage",
    session: SESSION,
  });
} finally {
  tmux(["kill-server"]);
  rmSync(ROOT, { recursive: true, force: true });
}

const verdict = [
  ["A must re-verify and NOT hold", results.A.reverified && !results.A.held],
  ["B must hold (no live session)", !results.B.reverified && results.B.held],
  ["C must hold (unparseable helper output)", !results.C.reverified && results.C.held],
];
console.log("\n=== VERDICT ===");
let ok = true;
for (const [label, pass] of verdict) {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
