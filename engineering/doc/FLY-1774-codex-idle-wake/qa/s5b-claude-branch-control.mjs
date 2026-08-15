// Positive control for S5.4: prove the Claude Stop branch WAS reached (emitter leg
// ran) and that only the sweep leg was skipped — so the negative is meaningful.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const { default: Database } = await import("/Users/xiaorongli/Dev/flywheel-FLY-1774/node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3/lib/index.js");
const ROOT = "/Users/xiaorongli/Dev/flywheel-FLY-1774";
const HOOK = `${ROOT}/scripts/hooks/runner-stop-notify.sh`;
const { CommDB } = await import(`${ROOT}/packages/flywheel-comm/dist/db.js`);
const { MailboxQueue } = await import(`${ROOT}/packages/flywheel-comm/dist/mailbox-queue.js`);
const { encodeSenderRef } = await import(`${ROOT}/packages/flywheel-comm/dist/sender-ref.js`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ck = (n, ok, d = "") => { ok ? (pass++, console.log(`  PASS ${n}${d ? " — " + d : ""}`)) : (fail++, console.log(`  FAIL ${n} — ${d}`)); };

const dir = mkdtempSync(join(tmpdir(), "fly1774-ctl-"));
// Trace CLI: records every invocation, then rings nothing.
const trace = join(dir, "trace.log");
const cli = join(dir, "trace-cli.js");
import { writeFileSync } from "node:fs";
writeFileSync(cli, `require("node:fs").appendFileSync(${JSON.stringify(trace)}, process.argv.slice(2).join(" ") + "\\n");\n`);

function run(execId, args, stdin = "") {
  return execFileSync("bash", [HOOK, ...args], { encoding: "utf8", input: stdin, env: {
    ...process.env, FLYWHEEL_EXEC_ID: execId, FLYWHEEL_COMM_CLI: cli,
    FLYWHEEL_COMM_DB: join(dir, "x.db"), FLYWHEEL_RUNNER_STATE_DIR: join(dir, `st-${execId}`), HOME: dir,
  }});
}
const ex = randomUUID();
run(ex, [], JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }));
await sleep(3000);
const t1 = existsSync(trace) ? readFileSync(trace, "utf8") : "";
ck("CTL-1 Claude Stop DID reach the emitter leg (branch executed)", /runner-stopped/.test(t1), JSON.stringify(t1.trim()));
ck("CTL-1 Claude Stop did NOT invoke runner-wake-sweep", !/runner-wake-sweep/.test(t1), JSON.stringify(t1.trim()));

writeFileSync(trace, "");
const ex2 = randomUUID();
run(ex2, ["--codex", JSON.stringify({ type: "agent-turn-complete", client: "codex-tui", "turn-id": "t1" })]);
await sleep(3000);
const t2 = readFileSync(trace, "utf8");
ck("CTL-2 codex notify invokes BOTH legs (ruler is calibrated)", /runner-stopped/.test(t2) && /runner-wake-sweep/.test(t2), JSON.stringify(t2.trim()));
console.log(`\nS5b control: passed=${pass} failed=${fail}`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
