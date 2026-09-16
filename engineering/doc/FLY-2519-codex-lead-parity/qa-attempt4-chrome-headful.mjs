import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { buildBrowserSandboxSpec } from "/Users/xiaorongli/Dev/flywheel-FLY-2519/packages/teamlead/dist/lead-capabilities/browser-sandbox.js";
const require = createRequire("/Users/xiaorongli/Dev/flywheel-FLY-2519/packages/teamlead/package.json");
const root = realpathSync(mkdtempSync("/tmp/fw2519r/headful-"));
const pr = join(root, "project"), pa = join(root, "qa"); mkdirSync(pr, { mode: 0o700 }); mkdirSync(pa, { mode: 0o700 });
const q = mkdtempSync(join(pa, "browser-")); for (const n of ["profile", "tmp", "artifacts"]) mkdirSync(join(q, n), { mode: 0o700 });
const l = buildBrowserSandboxSpec({ packageRoot: dirname(require.resolve("chrome-devtools-mcp/package.json")), nodeExecutable: process.execPath, chromeExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", projectRoot: pr, qaRoot: q, proxyPort: 4311 });
const launcher = join(q, "chrome-arm64"), P = l.policy, ML = "(allow mach-register)(allow mach-lookup)";
const steps = [
  ["final (as shipped)", P, []],
  ["final+ML+nocrash", P + ML, ["--disable-crash-reporter", "--disable-breakpad"]],
  ["final+ML+nocrash+no-sandbox", P + ML, ["--disable-crash-reporter", "--disable-breakpad", "--no-sandbox"]],
  ["allowDefault+no-sandbox", "(version 1)(allow default)", ["--no-sandbox"]],
];
let n = 0;
for (const [name, policy, extra] of steps) {
  const args = ["--user-data-dir=" + join(q, "p" + n++), "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", ...extra, "about:blank"];
  const r = await new Promise((resolve) => {
    const c = spawn(l.command, ["-p", policy, launcher, ...args], { cwd: l.cwd, env: l.env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "", exited = null;
    c.stderr.on("data", (d) => { err += d; });
    c.on("exit", (code, sig) => { exited = code + "/" + sig; });
    setTimeout(() => { try { process.kill(-c.pid, "SIGKILL"); } catch {} resolve({ err, exited }); }, 10000);
  });
  const lines = r.err.split("\n").filter(Boolean).map((x) => x.replace(/^\[[^\]]*\]/, "").slice(0, 130));
  console.log(name.padEnd(30), "exitedWithin10s:", r.exited, "devtoolsListening:", /DevTools listening/.test(r.err), "|", lines.filter((x) => !/DevTools listening/.test(x)).slice(0, 2).join(" || "));
}
rmSync(root, { recursive: true, force: true });
