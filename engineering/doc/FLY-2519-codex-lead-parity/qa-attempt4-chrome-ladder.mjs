import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { buildBrowserSandboxSpec } from "/Users/xiaorongli/Dev/flywheel-FLY-2519/packages/teamlead/dist/lead-capabilities/browser-sandbox.js";
const require = createRequire("/Users/xiaorongli/Dev/flywheel-FLY-2519/packages/teamlead/package.json");
const root = realpathSync(mkdtempSync("/tmp/fw2519r/ladder-"));
const pr = join(root, "project"), pa = join(root, "qa"); mkdirSync(pr, { mode: 0o700 }); mkdirSync(pa, { mode: 0o700 });
const q = mkdtempSync(join(pa, "browser-")); for (const n of ["profile", "tmp", "artifacts"]) mkdirSync(join(q, n), { mode: 0o700 });
const l = buildBrowserSandboxSpec({ packageRoot: dirname(require.resolve("chrome-devtools-mcp/package.json")), nodeExecutable: process.execPath, chromeExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", projectRoot: pr, qaRoot: q, proxyPort: 4311 });
const launcher = join(q, "chrome-arm64");
const P = l.policy;
const ML = "(allow mach-register)(allow mach-lookup)";
const steps = [
  ["allowDefault+no-sandbox", "(version 1)(allow default)", ["--no-sandbox"]],
  ["final+ML+nosb+nocrash", P + ML, ["--no-sandbox", "--disable-crash-reporter", "--disable-breakpad"]],
  ["final+nosb+nocrash", P, ["--no-sandbox", "--disable-crash-reporter", "--disable-breakpad"]],
  ["final+ML+nocrash(chrome sb on)", P + ML, ["--disable-crash-reporter", "--disable-breakpad"]],
];
let n = 0;
for (const [name, policy, extra] of steps) {
  const args = ["--user-data-dir=" + join(q, "p" + n++), "--no-first-run", "--no-default-browser-check", ...(process.env.HEADFUL ? ["--remote-debugging-port=0", "about:blank"] : ["--headless=new", "--dump-dom", "about:blank"]), ...extra];
  const t = Date.now();
  const r = spawnSync(l.command, ["-p", policy, launcher, ...args], { cwd: l.cwd, env: l.env, encoding: "utf8", timeout: process.env.HEADFUL ? 12000 : 30000, maxBuffer: 1 << 20 });
  const err = (r.stderr || "").split("\n").filter(Boolean).map(x => x.replace(/^\[[^\]]*\]/, "").slice(0, 140));
  console.log(name.padEnd(24), "status", r.status, "signal", r.signal, (Date.now()-t)+"ms", "dom:", /<html>/.test(r.stdout||""), "devtools:", /DevTools listening/.test(r.stderr||""), "| stderr:", err.slice(0, 3).join(" || "));
}
rmSync(root, { recursive: true, force: true });
